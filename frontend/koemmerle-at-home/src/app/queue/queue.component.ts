import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { ScanApiService, CartStatus, ScanQueueItem } from '../services/scan-api.service';

@Component({
  selector: 'app-queue',
  imports: [CommonModule],
  templateUrl: './queue.component.html',
  styleUrl: './queue.component.scss'
})
export class QueueComponent implements OnInit, OnDestroy {
  queue: ScanQueueItem[] = [];
  status: CartStatus = { isPaused: false, isLoggedIn: false };
  private subs: Subscription[] = [];

  constructor(private api: ScanApiService) {}

  ngOnInit() {
    this.api.getQueue().subscribe(q => this.queue = q);
    this.subs.push(this.api.queueUpdated$Obs.subscribe(q => this.queue = q));

    this.subs.push(interval(5000).pipe(
      startWith(0),
      switchMap(() => this.api.getCartStatus())
    ).subscribe(s => this.status = s));
  }

  ngOnDestroy() { this.subs.forEach(s => s.unsubscribe()); }

  togglePause() {
    const action = this.status.isPaused ? this.api.resumeCart() : this.api.pauseCart();
    action.subscribe(() => this.status.isPaused = !this.status.isPaused);
  }

  delete(id: number) { this.api.deleteQueueItem(id).subscribe(); }
  clearCompleted()   { this.api.clearCompletedQueue().subscribe(); }
  clearAll()         { this.api.clearAllQueue().subscribe(); }
  retry(id: number)  { this.api.retryQueueItem(id).subscribe(); }

  statusLabel(status: ScanQueueItem['status']): string {
    const labels: Record<ScanQueueItem['status'], string> = {
      Pending: 'Ausstehend',
      Processing: 'In Bearbeitung',
      Done: 'Erledigt',
      Failed: 'Fehler',
      UnknownBarcode: 'Unbekannt'
    };
    return labels[status];
  }
}
