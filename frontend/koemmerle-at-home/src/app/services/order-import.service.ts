import { Injectable } from '@angular/core';
import { BehaviorSubject, EMPTY, Subscription, from, of } from 'rxjs';
import { concatMap, finalize, switchMap, tap, toArray } from 'rxjs/operators';
import { Order, OrderProductSyncProgress, PromotionSyncProgress, ScanApiService } from './scan-api.service';

export type OrderImportPhase = 'headers' | 'details' | 'products' | 'promotions' | null;

export interface OrderImportState {
  active: boolean;
  phase: OrderImportPhase;
  current: number;
  total: number;
  message: string;
  progress: { [orderId: number]: OrderProductSyncProgress };
  promotionProgress?: PromotionSyncProgress | null;
}

const initialState: OrderImportState = {
  active: false,
  phase: null,
  current: 0,
  total: 0,
  message: '',
  progress: {},
  promotionProgress: null
};

@Injectable({ providedIn: 'root' })
export class OrderImportService {
  private stateSubject = new BehaviorSubject<OrderImportState>(initialState);
  readonly state$ = this.stateSubject.asObservable();

  private completedSubject = new BehaviorSubject<number>(0);
  readonly completed$ = this.completedSubject.asObservable();

  private ordersSubject = new BehaviorSubject<Order[]>([]);
  readonly orders$ = this.ordersSubject.asObservable();

  private syncAllSub?: Subscription;
  private progressSub: Subscription;
  private promotionProgressSub: Subscription;
  private stopRequested = false;

  constructor(private api: ScanApiService) {
    this.progressSub = this.api.orderSyncProgress$Obs.subscribe(p => this.applyProductProgress(p));
    this.promotionProgressSub = this.api.promotionSyncProgress$Obs.subscribe(p => this.applyPromotionProgress(p));
  }

  get state() {
    return this.stateSubject.value;
  }

  get orders() {
    return this.ordersSubject.value;
  }

  loadOrders() {
    this.api.getOrders().subscribe(o => this.ordersSubject.next(o));
  }

  start() {
    if (this.state.active) return;

    this.syncAllSub?.unsubscribe();
    this.stopRequested = false;
    this.update({
      active: true,
      phase: 'headers',
      current: 0,
      total: 0,
      message: 'Migros-Sync läuft...',
      progress: {},
      promotionProgress: null
    });

    this.syncAllSub = this.api.getOrders().pipe(
      tap(existing => {
        this.ordersSubject.next(existing);
        this.update({
          phase: 'headers',
          current: existing.length,
          total: existing.length,
          message: existing.length > 0
            ? 'Vorhandene Bestellungen werden geprüft.'
            : 'Bestellungen werden gesucht.'
        });
      }),
      switchMap(() => this.stopRequested ? EMPTY : this.api.syncOrderHeaders()),
      tap(r => {
        if (!this.stopRequested) {
          const nextTotal = this.state.total + r.synced;
          this.update({
            current: nextTotal,
            total: nextTotal,
            message: r.synced > 0
              ? `${r.synced} neue Bestellungen gefunden.`
              : 'Alle Bestellungen waren bereits bekannt.'
          });
        }
      }),
      switchMap(() => this.stopRequested ? EMPTY : this.api.getOrders()),
      switchMap(fresh => {
        this.ordersSubject.next(fresh);
        const toDetail = fresh.filter(o => o.status === 'HeaderFetched');
        const alreadyDetailed = fresh.filter(o => o.status === 'DetailFetched' || o.status === 'FullySynced').length;
        this.update({
          phase: 'details',
          current: alreadyDetailed,
          total: fresh.length,
          message: toDetail.length > 0
            ? 'Bestelldetails werden geladen.'
            : 'Alle Bestelldetails sind bereits geladen.'
        });

        if (toDetail.length === 0) return of(null);

        return from(toDetail).pipe(
          concatMap(order =>
            this.stopRequested ? EMPTY : this.api.syncOrderDetail(order.id).pipe(
              tap(() => {
                this.update({ current: this.state.current + 1 });
                this.api.getOrder(order.id).subscribe(o => this.replaceOrder(o));
              })
            )
          ),
          toArray()
        );
      }),
      switchMap(() => this.stopRequested ? EMPTY : this.api.getOrders()),
      switchMap(fresh => {
        this.ordersSubject.next(fresh);
        const toSync = fresh.filter(o => o.status === 'DetailFetched');
        const alreadySynced = fresh.filter(o => o.status === 'FullySynced').length;
        this.update({
          phase: 'products',
          current: alreadySynced,
          total: fresh.length,
          message: toSync.length > 0
            ? 'Produkte aus deinen Bestellungen werden verknüpft.'
            : 'Alle Bestellungen sind bereits synchronisiert.'
        });

        if (toSync.length === 0) return of(null);

        return from(toSync).pipe(
          concatMap(order => {
            if (this.stopRequested) return EMPTY;

            this.update({
              progress: {
                ...this.state.progress,
                [order.id]: { orderId: order.id, done: 0, total: 0 }
              }
            });

            return this.api.syncOrderProducts(order.id).pipe(
              tap(() => this.update({ current: this.state.current + 1 }))
            );
          })
        );
      }),
      switchMap(() => {
        if (this.stopRequested) return EMPTY;

        this.update({
          phase: 'promotions',
          current: 0,
          total: 0,
          message: 'Bestehende Aktionen werden entfernt.',
          promotionProgress: null
        });

        return this.api.syncPromotions().pipe(
          tap(result => {
            if (this.stopRequested) return;
            this.update({
              current: 1,
              total: 1,
              message: result.alreadyRunning
                ? 'Aktions-Sync läuft bereits.'
                : `${result.promotionsStored} Aktionen aktualisiert.`,
              promotionProgress: {
                stage: 'complete',
                done: result.promotionUids,
                total: result.promotionUids,
                productCards: result.productCards,
                promotionsStored: result.promotionsStored
              }
            });
          })
        );
      }),
      finalize(() => {
        this.update({ active: false, phase: null, current: 0, total: 0 });
      })
    ).subscribe({
      complete: () => this.finish(this.stopRequested ? 'Migros-Sync gestoppt' : 'Migros-Sync abgeschlossen'),
      error: () => this.finish(this.stopRequested ? 'Migros-Sync gestoppt' : 'Fehler beim Migros-Sync')
    });
  }

  cancel() {
    if (!this.state.active) return;

    this.stopRequested = true;
    this.api.cancelProductSync().subscribe();
    this.syncAllSub?.unsubscribe();
    this.update({
      active: false,
      phase: null,
      current: 0,
      total: 0,
      progress: {},
      promotionProgress: null,
      message: 'Migros-Sync gestoppt'
    });
    this.loadOrders();
  }

  progressPercent(orderId: number): number {
    const p = this.state.progress[orderId];
    if (!p || p.total === 0) return 0;
    return Math.round((p.done / p.total) * 100);
  }

  private finish(message: string) {
    this.loadOrders();
    this.update({ message });
    this.completedSubject.next(this.completedSubject.value + 1);
  }

  private applyProductProgress(p: OrderProductSyncProgress) {
    const previous = this.state.progress[p.orderId];
    const currentProduct = p.currentProduct?.trim()
      ? p.currentProduct
      : previous?.currentProduct;
    const progress = {
      ...this.state.progress,
      [p.orderId]: { ...p, currentProduct }
    };
    this.update({ progress });

    if (p.linkedProductUrl) {
      const order = this.orders.find(o => o.id === p.orderId);
      const item = order?.items.find(i => i.migrosProductUrl === p.linkedProductUrl);
      if (item && !item.productId) item.productId = -1;
    }

    if (p.done === p.total && p.total > 0) {
      setTimeout(() => {
        const nextProgress = { ...this.state.progress };
        delete nextProgress[p.orderId];
        this.update({ progress: nextProgress });
        this.api.getOrder(p.orderId).subscribe(o => this.replaceOrder(o));
      }, 800);
    }
  }

  private applyPromotionProgress(p: PromotionSyncProgress) {
    if (!this.state.active || this.state.phase !== 'promotions') return;

    const rawTotal = Math.max(p.total, 0);
    const rawProgress = rawTotal > 0
      ? Math.min(Math.max(p.done / rawTotal, 0), 1)
      : 0;
    const weightedProgress = this.weightedPromotionProgress(p.stage, rawProgress);
    const total = 1000;
    const current = Math.round(total * weightedProgress);
    this.update({
      current,
      total,
      message: this.promotionStageMessage(p),
      promotionProgress: p
    });
  }

  private promotionStageMessage(progress: PromotionSyncProgress): string {
    switch (progress.stage) {
      case 'clear':
        return 'Bestehende Aktionen werden entfernt.';
      case 'search':
        return 'Aktuelle Migros-Aktionen werden gesucht.';
      case 'cards':
        return 'Aktions-Produkte werden aktualisiert.';
      case 'complete':
        return `${progress.promotionsStored} Aktionen aktualisiert.`;
      default:
        return this.state.message;
    }
  }

  private weightedPromotionProgress(stage: string, rawProgress: number): number {
    switch (stage) {
      case 'clear':
        return 0;
      case 'search':
        return rawProgress * 0.25;
      case 'cards':
        return 0.25 + rawProgress * 0.70;
      case 'complete':
        return 1;
      default:
        return rawProgress;
    }
  }

  private replaceOrder(order: Order) {
    const orders = [...this.orders];
    const idx = orders.findIndex(x => x.id === order.id);
    if (idx >= 0) {
      orders[idx] = order;
      this.ordersSubject.next(orders);
    }
  }

  private update(patch: Partial<OrderImportState>) {
    this.stateSubject.next({ ...this.stateSubject.value, ...patch });
  }
}
