import { Injectable } from '@angular/core';
import { Subject, BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ScanBridgeService {
  readonly barcode$ = new Subject<string>();
  readonly focusRequest$ = new Subject<void>();
  readonly pendingCount$ = new BehaviorSubject<number>(0);

  private suppressCount = 0;
  get globalScanSuppressed() { return this.suppressCount > 0; }
  suppressGlobal()   { this.suppressCount++; }
  unsuppressGlobal() { if (this.suppressCount > 0) this.suppressCount--; }

  submit(barcode: string) { this.barcode$.next(barcode); }
  requestFocus() { this.focusRequest$.next(); }
}
