import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Bridge between the global version watermark click and the StickersComponent,
 * which actually knows whether any sticker products are currently loaded.
 */
@Injectable({ providedIn: 'root' })
export class EasterEggService {
  readonly triggerRequest$ = new Subject<void>();

  request() { this.triggerRequest$.next(); }
}
