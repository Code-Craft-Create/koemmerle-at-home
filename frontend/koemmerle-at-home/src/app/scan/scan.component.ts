import { Component, ElementRef, HostListener, Input, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Subscription } from 'rxjs';
import { ScanApiService, ScanChoice, ScanResult } from '../services/scan-api.service';
import { ScanBridgeService } from '../services/scan-bridge.service';

type ScanState = 'idle' | 'searching' | 'confirming' | 'done' | 'unknown' | 'choosing';

const CONFIRM_MS = 3000;
const ALTERNATIVES_PAGE_SIZE = 20;

@Component({
  selector: 'app-scan',
  imports: [CommonModule, RouterModule],
  templateUrl: './scan.component.html',
  styleUrl: './scan.component.scss'
})
export class ScanComponent implements OnInit, OnDestroy {
  @Input() isGlobalOverlay = false;
  private confirmButton?: ElementRef<HTMLButtonElement>;
  private doneButton?: ElementRef<HTMLButtonElement>;

  @ViewChild('confirmButton')
  set confirmButtonRef(button: ElementRef<HTMLButtonElement> | undefined) {
    this.confirmButton = button;
    if (button && this.state === 'confirming') {
      button.nativeElement.focus();
    }
  }

  @ViewChild('doneButton')
  set doneButtonRef(button: ElementRef<HTMLButtonElement> | undefined) {
    this.doneButton = button;
    if (button && this.state === 'done') {
      button.nativeElement.focus();
    }
  }

  state: ScanState = 'idle';
  confirming: ScanResult | null = null;
  selectedProductName: string | null = null;  // name of the product chosen from alternatives
  searchingBarcode = '';
  animKey = 0;
  cartQtyInMigros: number | null = null;
  loadingMoreAlternatives = false;
  loadMoreError = '';

  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private resultSub!: Subscription;
  private barcodeSub!: Subscription;

  constructor(private api: ScanApiService, private bridge: ScanBridgeService) {}

  ngOnInit() {
    this.resultSub = this.api.scanResults$.subscribe(result => this.handleResult(result));
    this.barcodeSub = this.bridge.barcode$.subscribe(barcode => this.beginSearch(barcode));
  }

  ngOnDestroy() {
    this.resultSub.unsubscribe();
    this.barcodeSub.unsubscribe();
    this.clearConfirmTimer();
    this.clearSearchTimer();
  }

  @HostListener('document:keydown.enter', ['$event'])
  onEnter(event: KeyboardEvent) {
    if (this.state !== 'confirming' && this.state !== 'done') return;
    event.preventDefault();
    if (this.state === 'confirming') this.confirmNow();
    else this.dismissDone();
  }

  private handleResult(result: ScanResult) {
    this.clearConfirmTimer();
    this.clearSearchTimer();
    this.searchingBarcode = '';

    if (!result.recognized) {
      if (result.alternatives && result.alternatives.length > 0) {
        this.confirming = result;
        this.state = 'choosing';
        this.loadingMoreAlternatives = false;
        this.loadMoreError = '';
        this.playSound('success');
        return;
      }
      this.confirming = null;
      this.state = 'unknown';
      this.playSound('error');
      setTimeout(() => { if (this.state === 'unknown') this.state = 'idle'; }, 2000);
      return;
    }

    if (this.state === 'confirming' && this.confirming && this.confirming.barcode === result.barcode) {
      this.confirming.quantity = (this.confirming.quantity ?? 1) + (result.quantity ?? 1);
      this.animKey++;
    } else {
      this.confirming = result;
      this.confirming.quantity = this.confirming.quantity ?? 1;
      this.animKey++;
      this.cartQtyInMigros = null;
      this.api.getCartQuantity(result.barcode).subscribe({
        next: r => { this.cartQtyInMigros = r.currentQuantity; },
        error: () => { /* silently ignore — projected total just won't show */ }
      });
    }
    
    this.state = 'confirming';
    this.focusConfirmButton();
    this.playSound('success');

    this.confirmTimer = setTimeout(() => this.confirmNow(), CONFIRM_MS);
  }

  confirmNow() {
    this.clearConfirmTimer();
    const barcodeToEnqueue = this.confirming?.barcode;
    const quantityToEnqueue = this.confirming?.quantity ?? 1;

    this.state = 'done';
    this.cartQtyInMigros = null;
    this.focusDoneButton();

    if (barcodeToEnqueue) {
      this.api.enqueue(barcodeToEnqueue, quantityToEnqueue).subscribe({ error: err => console.error(err) });
    }

    this.confirmTimer = setTimeout(() => {
      this.state = 'idle';
      this.confirming = null;
    }, 1500);
  }

  cancel() {
    this.clearConfirmTimer();
    this.state = 'idle';
    this.confirming = null;
    this.cartQtyInMigros = null;
    this.loadingMoreAlternatives = false;
    this.loadMoreError = '';
  }

  cancelSearch() {
    this.clearSearchTimer();
    this.state = 'idle';
    this.searchingBarcode = '';
  }

  chooseAlternative(alt: ScanChoice) {
    if (this.state === 'choosing' && this.confirming) {
      const barcodeToEnqueue = this.confirming.barcode;
      this.selectedProductName = alt.name;

      this.api.enqueue(barcodeToEnqueue, 1, alt.migrosUid).subscribe({ error: err => console.error(err) });
      
      this.state = 'done';
      this.focusDoneButton();
      
      this.confirmTimer = setTimeout(() => {
        this.state = 'idle';
        this.confirming = null;
        this.selectedProductName = null;
      }, 1500);
    }
  }

  get alternativesLoaded(): number {
    return this.confirming?.alternatives?.length ?? 0;
  }

  get hasMoreAlternatives(): boolean {
    return !!this.confirming?.totalAlternatives && this.alternativesLoaded < this.confirming.totalAlternatives;
  }

  loadMoreAlternatives() {
    if (!this.confirming?.barcode || this.loadingMoreAlternatives || !this.hasMoreAlternatives) return;

    const barcode = this.confirming.barcode;
    const offset = this.alternativesLoaded;
    this.loadingMoreAlternatives = true;
    this.loadMoreError = '';

    this.api.getScanAlternatives(barcode, offset, ALTERNATIVES_PAGE_SIZE).subscribe({
      next: result => {
        if (!this.confirming || this.confirming.barcode !== barcode) {
          this.loadingMoreAlternatives = false;
          return;
        }

        const existing = new Set((this.confirming.alternatives ?? []).map(a => a.migrosUid));
        const nextChoices = result.choices.filter(choice => !existing.has(choice.migrosUid));
        this.confirming.alternatives = [...(this.confirming.alternatives ?? []), ...nextChoices];
        this.confirming.totalAlternatives = result.total;
        this.loadingMoreAlternatives = false;
      },
      error: err => {
        console.error(err);
        this.loadingMoreAlternatives = false;
        this.loadMoreError = 'Weitere Ergebnisse konnten nicht geladen werden.';
      }
    });
  }

  markImageLoaded(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    image.classList.add('loaded');
    image.parentElement?.classList.add('image-loaded');
  }

  markImageFailed(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    image.classList.add('failed');
    image.parentElement?.classList.add('image-failed');
    image.removeAttribute('src');
  }

  private beginSearch(barcode: string) {
    if (this.state === 'confirming' && this.confirming?.barcode === barcode) {
      // Same item scanned again. Pause timer, let handleResult increment quantity.
      this.clearConfirmTimer();
      return;
    } else if (this.state === 'confirming' && this.confirming) {
      // Different item scanned! Enqueue the previous one immediately.
      const barcodeToEnqueue = this.confirming.barcode;
      const quantityToEnqueue = this.confirming.quantity ?? 1;
      if (barcodeToEnqueue) {
        this.api.enqueue(barcodeToEnqueue, quantityToEnqueue).subscribe({ error: err => console.error(err) });
      }
      this.clearConfirmTimer();
      this.confirming = null;
    } else if (this.state === 'choosing') {
      this.state = 'idle';
      this.confirming = null;
      this.loadingMoreAlternatives = false;
      this.loadMoreError = '';
    } else if (this.state === 'done') {
      this.clearConfirmTimer();
      this.confirming = null;
    }

    this.clearSearchTimer();
    this.state = 'searching';
    this.searchingBarcode = barcode;
    this.loadMoreError = '';
    this.searchTimer = setTimeout(() => {
      if (this.state === 'searching') {
        this.state = 'unknown';
        this.searchingBarcode = '';
        setTimeout(() => { if (this.state === 'unknown') this.state = 'idle'; }, 2000);
      }
    }, 30_000);
    // api.scan() is called by AppComponent — we only manage state here
  }

  requestFocus() { this.bridge.requestFocus(); }

  private focusConfirmButton() {
    setTimeout(() => this.confirmButton?.nativeElement.focus(), 0);
  }

  private focusDoneButton() {
    setTimeout(() => this.doneButton?.nativeElement.focus(), 0);
  }

  dismissDone() {
    if (this.state !== 'done') return;
    this.clearConfirmTimer();
    this.state = 'idle';
    this.confirming = null;
    this.selectedProductName = null;
    this.cartQtyInMigros = null;
  }

  private clearSearchTimer() {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
  }

  private clearConfirmTimer() {
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
  }

  private playSound(type: 'success' | 'error') {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = type === 'success' ? 880 : 220;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  }
}
