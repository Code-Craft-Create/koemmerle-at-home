import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { EMPTY, Subscription, from, of } from 'rxjs';
import { concatMap, finalize, switchMap, tap, toArray } from 'rxjs/operators';
import { ScanApiService, Order, OrderProductSyncProgress } from '../services/scan-api.service';

@Component({
  selector: 'app-orders',
  imports: [CommonModule, RouterModule],
  templateUrl: './orders.component.html',
  styleUrl: './orders.component.scss'
})
export class OrdersComponent implements OnInit, OnDestroy {
  orders: Order[] = [];
  expandedId: number | null = null;
  syncingHeadersInProgress = false;
  syncingDetailId: number | null = null;
  syncingProductsId: number | null = null;
  syncingAll = false;
  syncAllPhase: 'headers' | 'details' | 'products' | null = null;
  syncAllCurrent = 0;
  syncAllTotal = 0;
  syncProgress: { [orderId: number]: OrderProductSyncProgress } = {};
  message = '';

  private sub?: Subscription;
  private syncAllSub?: Subscription;
  private stopSyncRequested = false;

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.load();
    this.sub = this.api.orderSyncProgress$Obs.subscribe(p => {
      this.syncProgress[p.orderId] = p;

      // Mark the just-linked item immediately so the ✓ badge appears without waiting
      if (p.linkedProductUrl) {
        const order = this.orders.find(o => o.id === p.orderId);
        if (order?.items) {
          const item = order.items.find(i => i.migrosProductUrl === p.linkedProductUrl);
          if (item && !item.productId) item.productId = -1; // sentinel — linked but id not yet known
        }
      }

      if (p.done === p.total && p.total > 0) {
        // Sync complete — refresh order and clear progress after a brief moment
        setTimeout(() => {
          delete this.syncProgress[p.orderId];
          this.api.getOrder(p.orderId).subscribe(o => {
            const idx = this.orders.findIndex(x => x.id === o.id);
            if (idx >= 0) this.orders[idx] = o;
          });
          if (this.syncingProductsId === p.orderId) this.syncingProductsId = null;
        }, 800);
      }
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    this.syncAllSub?.unsubscribe();
  }

  load() {
    this.api.getOrders().subscribe(o => this.orders = o);
  }

  syncHeaders() {
    this.syncingHeadersInProgress = true;
    this.api.syncOrderHeaders().subscribe({
      next: r => {
        this.syncingHeadersInProgress = false;
        this.message = `${r.synced} neue Bestellungen gefunden`;
        this.load();
      },
      error: () => { this.syncingHeadersInProgress = false; this.message = 'Fehler beim Laden der Bestellungen'; }
    });
  }

  syncDetail(order: Order) {
    this.syncingDetailId = order.id;
    this.api.syncOrderDetail(order.id).subscribe({
      next: () => {
        this.syncingDetailId = null;
        this.message = `Bestelldetails für ${order.migrosOrderId} geladen`;
        this.api.getOrder(order.id).subscribe(o => {
          const idx = this.orders.findIndex(x => x.id === o.id);
          if (idx >= 0) this.orders[idx] = o;
        });
      },
      error: () => { this.syncingDetailId = null; this.message = 'Fehler beim Laden der Details'; }
    });
  }

  syncProducts(order: Order) {
    this.syncingProductsId = order.id;
    this.syncProgress[order.id] = { orderId: order.id, done: 0, total: 0 };
    this.api.syncOrderProducts(order.id).subscribe({
      next: () => {
        this.message = `Produkte für Bestellung ${order.migrosOrderId} verknüpft`;
        // Progress cleanup is handled by the SignalR subscriber above
        // but handle the case where SignalR didn't fire (e.g. 0 items)
        if (!this.syncProgress[order.id] || this.syncProgress[order.id].total === 0) {
          this.syncingProductsId = null;
          delete this.syncProgress[order.id];
          this.api.getOrder(order.id).subscribe(o => {
            const idx = this.orders.findIndex(x => x.id === o.id);
            if (idx >= 0) this.orders[idx] = o;
          });
        }
      },
      error: () => {
        this.syncingProductsId = null;
        delete this.syncProgress[order.id];
        this.message = 'Fehler beim Sync der Produkte';
      }
    });
  }

  cancelProductSync() {
    if (this.syncingAll) {
      this.stopSyncAll();
      return;
    }
    this.api.cancelProductSync().subscribe();
  }

  syncAll() {
    if (this.syncingAll) return;

    this.syncAllSub?.unsubscribe();
    this.stopSyncRequested = false;
    this.syncingAll = true;
    this.syncAllPhase = 'headers';
    this.syncAllCurrent = 0;
    this.syncAllTotal = 0;
    this.message = 'Bestellungen werden importiert…';

    this.syncAllSub = this.api.syncOrderHeaders().pipe(
      tap(r => {
        if (!this.stopSyncRequested) this.message = `${r.synced} neue Bestellungen gefunden`;
      }),
      switchMap(() => this.stopSyncRequested ? EMPTY : this.api.getOrders()),
      switchMap(fresh => {
        this.orders = fresh;
        const toDetail = fresh.filter(o => o.status === 'HeaderFetched');
        this.syncAllPhase = 'details';
        this.syncAllCurrent = 0;
        this.syncAllTotal = toDetail.length;

        if (toDetail.length === 0) return of(null);

        return from(toDetail).pipe(
          concatMap(order =>
            this.stopSyncRequested ? EMPTY : this.api.syncOrderDetail(order.id).pipe(
              tap(() => {
                this.syncAllCurrent++;
                this.api.getOrder(order.id).subscribe(o => this.replaceOrder(o));
              })
            )
          ),
          toArray()
        );
      }),
      switchMap(() => this.stopSyncRequested ? EMPTY : this.api.getOrders()),
      switchMap(fresh => {
        this.orders = fresh;
        const toSync = fresh.filter(o => o.status === 'DetailFetched');
        this.syncAllPhase = 'products';
        this.syncAllCurrent = 0;
        this.syncAllTotal = toSync.length;

        if (toSync.length === 0) return of(null);

        return from(toSync).pipe(
          concatMap(order => {
            if (this.stopSyncRequested) return EMPTY;

            this.syncingProductsId = order.id;
            this.syncProgress[order.id] = { orderId: order.id, done: 0, total: 0 };
            return this.api.syncOrderProducts(order.id).pipe(
              tap(() => this.syncAllCurrent++)
            );
          })
        );
      }),
      finalize(() => {
        this.syncingAll = false;
        this.syncAllPhase = null;
        this.syncingProductsId = null;
        this.syncAllTotal = 0;
        this.syncAllCurrent = 0;
      })
    ).subscribe({
      complete: () => {
        this.load();
        this.message = this.stopSyncRequested
          ? 'Import gestoppt'
          : 'Alle Bestellungen synchronisiert';
      },
      error: () => {
        this.load();
        this.message = this.stopSyncRequested
          ? 'Import gestoppt'
          : 'Fehler beim Sync aller Bestellungen';
      }
    });
  }

  stopSyncAll() {
    if (!this.syncingAll) return;
    this.stopSyncRequested = true;
    this.api.cancelProductSync().subscribe();
    this.syncAllSub?.unsubscribe();
    this.syncingAll = false;
    this.syncAllPhase = null;
    this.syncingProductsId = null;
    this.syncAllCurrent = 0;
    this.syncAllTotal = 0;
    this.syncProgress = {};
    this.message = 'Import gestoppt';
    this.load();
  }

  private replaceOrder(order: Order) {
    const idx = this.orders.findIndex(x => x.id === order.id);
    if (idx >= 0) this.orders[idx] = order;
  }

  progressPercent(orderId: number): number {
    const p = this.syncProgress[orderId];
    if (!p || p.total === 0) return 0;
    return Math.round((p.done / p.total) * 100);
  }

  toggleExpand(id: number) {
    if (this.expandedId === id) {
      this.expandedId = null;
    } else {
      this.expandedId = id;
      const order = this.orders.find(o => o.id === id);
      if (order && order.status !== 'HeaderFetched' && (!order.items || order.items.length === 0)) {
        this.api.getOrder(id).subscribe(o => {
          const idx = this.orders.findIndex(x => x.id === o.id);
          if (idx >= 0) this.orders[idx] = o;
        });
      }
    }
  }

  statusLabel(status: string): string {
    switch (status) {
      case 'HeaderFetched': return 'Gefunden';
      case 'DetailFetched': return 'Details geladen';
      case 'FullySynced':   return 'Vollständig';
      default: return status;
    }
  }

  statusClass(status: string): string {
    switch (status) {
      case 'HeaderFetched': return 'pending';
      case 'DetailFetched': return 'partial';
      case 'FullySynced':   return 'done';
      default: return '';
    }
  }
}
