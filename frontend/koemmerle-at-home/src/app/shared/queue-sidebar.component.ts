import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { ScanApiService, ScanQueueItem, CartStatus } from '../services/scan-api.service';

@Component({
  selector: 'app-queue-sidebar',
  imports: [CommonModule, RouterModule],
  templateUrl: './queue-sidebar.component.html',
  styleUrl: './queue-sidebar.component.scss'
})
export class QueueSidebarComponent implements OnInit, OnDestroy {
  @Input() open = false;
  @Output() closePanel = new EventEmitter<void>();

  items: ScanQueueItem[] = [];
  status: CartStatus = { isPaused: false, isLoggedIn: false };
  private pollSub!: Subscription;

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    // Initial load via HTTP, then stay in sync via SignalR pushes.
    this.api.getQueue().subscribe(all => this.applyQueue(all));
    this.api.getCartStatus().subscribe(s => this.status = s);

    this.pollSub = this.api.queueUpdated$Obs.subscribe(all => this.applyQueue(all));
  }

  ngOnDestroy() { this.pollSub.unsubscribe(); }

  private applyQueue(all: ScanQueueItem[]) {
    this.items = all
      .filter(i => i.status !== 'Done' && i.status !== 'UnknownBarcode')
      .sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
  }

  togglePause() {
    const call = this.status.isPaused ? this.api.resumeCart() : this.api.pauseCart();
    call.subscribe(() => this.api.getCartStatus().subscribe(s => this.status = s));
  }

  retry(id: number) { this.api.retryQueueItem(id).subscribe(); }
  delete(id: number) { this.api.deleteQueueItem(id).subscribe(); }

  label(status: ScanQueueItem['status']): string {
    switch (status) {
      case 'Pending':    return 'Wartend';
      case 'Processing': return 'Läuft';
      case 'Failed':     return 'Fehler';
      default:           return status;
    }
  }
}
