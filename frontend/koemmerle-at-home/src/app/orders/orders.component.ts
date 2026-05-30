import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { ScanApiService, Order, OrderProductSyncProgress } from '../services/scan-api.service';
import { OrderImportPhase, OrderImportService } from '../services/order-import.service';

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
  syncAllPhase: OrderImportPhase = null;
  syncAllCurrent = 0;
  syncAllTotal = 0;
  syncAllAvailabilityTotal = 0;
  syncProgress: { [orderId: number]: OrderProductSyncProgress } = {};
  message = '';
  autoUpdateOrders = false;
  autoUpdateSaving = false;

  private sub?: Subscription;
  private importSub?: Subscription;
  private importDoneSub?: Subscription;

  constructor(private api: ScanApiService, private orderImport: OrderImportService) {}

  ngOnInit() {
    this.load();
    this.api.getSettings().subscribe(s => this.autoUpdateOrders = s.autoUpdateOrders);
    this.importSub = this.orderImport.state$.subscribe(s => {
      this.syncingAll = s.active;
      this.syncAllPhase = s.phase;
      this.syncAllCurrent = s.current;
      this.syncAllTotal = s.total;
      if (s.phase === 'availability' && s.total > 0) this.syncAllAvailabilityTotal = s.total;
      if (s.phase !== 'availability') this.syncAllAvailabilityTotal = 0;
      if (s.message) this.message = s.message;
    });
    this.importDoneSub = this.orderImport.completed$.subscribe(count => {
      if (count > 0) this.load();
    });
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
    this.importSub?.unsubscribe();
    this.importDoneSub?.unsubscribe();
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
    this.orderImport.start();
  }

  stopSyncAll() {
    this.orderImport.cancel();
  }

  syncAllAvailabilityLabel(): string {
    const total = this.syncAllTotal > 0 ? this.syncAllTotal : this.syncAllAvailabilityTotal;
    return total > 0
      ? `Verfügbarkeit ${this.syncAllCurrent}/${total}`
      : 'Verfügbarkeit prüfen…';
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

  toggleAutoUpdateOrders(enabled: boolean) {
    this.autoUpdateOrders = enabled;
    this.autoUpdateSaving = true;
    this.api.setAutoUpdateOrders(enabled).subscribe({
      next: s => {
        this.autoUpdateOrders = s.autoUpdateOrders;
        this.autoUpdateSaving = false;
      },
      error: () => {
        this.autoUpdateOrders = !enabled;
        this.autoUpdateSaving = false;
        this.message = 'Auto-Update konnte nicht gespeichert werden';
      }
    });
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
