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
  private pendingUnitQuantity = 1;
  private locallyCountedResults = new Map<string, number>();

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
  onEnter(event: Event) {
    if (this.state !== 'confirming' && this.state !== 'done') return;
    if (this.isEditableTarget(event.target)) return;
    event.preventDefault();
    if (this.state === 'confirming') this.confirmNow();
    else this.dismissDone();
  }

  private handleResult(result: ScanResult) {
    this.clearConfirmTimer();
    this.clearSearchTimer();
    this.searchingBarcode = '';
    const matchingConfirmation = this.state === 'confirming'
      && this.confirming
      && this.confirming.barcode === result.barcode;
    const wasLocallyCounted = this.consumeLocallyCountedResult(result.barcode);

    if (wasLocallyCounted && !matchingConfirmation) {
      return;
    }

    if (!result.recognized) {
      if (wasLocallyCounted && matchingConfirmation) {
        this.restartConfirmTimer();
        return;
      }

      if (result.alternatives && result.alternatives.length > 0) {
        this.confirming = result;
        this.pendingUnitQuantity = result.quantity ?? 1;
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

    if (matchingConfirmation) {
      this.pendingUnitQuantity = result.quantity ?? this.pendingUnitQuantity;
      if (!wasLocallyCounted) {
        this.confirming!.quantity = (this.confirming!.quantity ?? 1) + (result.quantity ?? 1);
        this.animKey++;
      }
    } else {
      this.confirming = result;
      this.confirming.quantity = this.confirming.quantity ?? 1;
      this.pendingUnitQuantity = this.confirming.quantity;
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

    this.restartConfirmTimer();
  }

  confirmNow() {
    this.clearConfirmTimer();
    const barcodeToEnqueue = this.confirming?.barcode;
    const quantityToEnqueue = this.confirming?.quantity ?? 1;

    this.state = 'done';
    this.cartQtyInMigros = null;
    this.focusDoneButton();
    this.computeFlyTarget();

    if (barcodeToEnqueue) {
      this.api.enqueue(barcodeToEnqueue, quantityToEnqueue).subscribe({ error: err => console.error(err) });
    }

    this.confirmTimer = setTimeout(() => {
      this.state = 'idle';
      this.confirming = null;
      this.pendingUnitQuantity = 1;
    }, 1500);
  }

  cancel() {
    this.clearConfirmTimer();
    this.state = 'idle';
    this.confirming = null;
    this.pendingUnitQuantity = 1;
    this.locallyCountedResults.clear();
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
      this.confirming.imageUrl = alt.imageUrl;
      this.confirming.productName = alt.name;
      this.confirming.multiplier = alt.multiplier;

      this.api.enqueue(barcodeToEnqueue, 1, alt.migrosUid).subscribe({ error: err => console.error(err) });

      this.state = 'done';
      this.focusDoneButton();
      this.computeFlyTarget();
      
      this.confirmTimer = setTimeout(() => {
        this.state = 'idle';
        this.confirming = null;
        this.pendingUnitQuantity = 1;
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
      // Same item scanned again. Count it immediately while the lookup catches up.
      this.clearConfirmTimer();
      this.confirming.quantity = (this.confirming.quantity ?? 1) + this.pendingUnitQuantity;
      this.rememberLocallyCountedResult(barcode);
      this.animKey++;
      this.restartConfirmTimer();
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
      this.pendingUnitQuantity = 1;
    } else if (this.state === 'choosing') {
      this.state = 'idle';
      this.confirming = null;
      this.pendingUnitQuantity = 1;
      this.loadingMoreAlternatives = false;
      this.loadMoreError = '';
    } else if (this.state === 'done') {
      this.clearConfirmTimer();
      this.confirming = null;
      this.pendingUnitQuantity = 1;
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

  private computeFlyTarget() {
    setTimeout(() => {
      const layer = document.querySelector('.product-visual-layer') as HTMLElement | null;
      const target = document.querySelector('.nav-queue-btn') as HTMLElement | null;
      if (!layer || !target) return;
      const layerRect = layer.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const dx = (targetRect.left + targetRect.width / 2) - (layerRect.left + layerRect.width / 2);
      const dy = (targetRect.top + targetRect.height / 2) - (layerRect.top + layerRect.height / 2);
      layer.style.setProperty('--fly-dx', `${dx}px`);
      layer.style.setProperty('--fly-dy', `${dy}px`);
    }, 0);
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

  private isEditableTarget(target: EventTarget | null) {
    return target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target instanceof HTMLSelectElement
      || target instanceof HTMLButtonElement
      || (target instanceof HTMLElement && target.isContentEditable);
  }

  private restartConfirmTimer() {
    this.clearConfirmTimer();
    this.confirmTimer = setTimeout(() => this.confirmNow(), CONFIRM_MS);
  }

  private rememberLocallyCountedResult(barcode: string) {
    this.locallyCountedResults.set(barcode, (this.locallyCountedResults.get(barcode) ?? 0) + 1);
  }

  private consumeLocallyCountedResult(barcode: string) {
    const count = this.locallyCountedResults.get(barcode) ?? 0;
    if (count <= 0) return false;
    if (count === 1) this.locallyCountedResults.delete(barcode);
    else this.locallyCountedResults.set(barcode, count - 1);
    return true;
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
