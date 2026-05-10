import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ScanBridgeService } from './services/scan-bridge.service';
import { ScanApiService } from './services/scan-api.service';
import { QueueSidebarComponent } from './shared/queue-sidebar.component';
import { ScanComponent } from './scan/scan.component';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule, FormsModule, QueueSidebarComponent, ScanComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('navScanInput') navScanInput?: ElementRef<HTMLInputElement>;

  isScanRoute = false;
  navBarcode = '';
  queueOpen = false;
  settingsOpen = false;
  pendingCount = 0;
  failedCount = 0;

  private globalBuffer = '';
  private globalTimer: any = null;

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event) {
    this.settingsOpen = false;
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKey(event: KeyboardEvent) {
    if (document.activeElement === this.navScanInput?.nativeElement) return;
    if (this.bridge.globalScanSuppressed) return;

    if (event.key === 'Enter') {
      const barcode = this.globalBuffer.trim();
      this.clearGlobalBuffer();
      if (/^[a-zA-Z0-9\-]{6,}$/.test(barcode)) this.submitGlobal(barcode);
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.globalBuffer += event.key;
      clearTimeout(this.globalTimer);
      this.globalTimer = setTimeout(() => this.clearGlobalBuffer(), 100);
    }
  }

  private clearGlobalBuffer() {
    this.globalBuffer = '';
    clearTimeout(this.globalTimer);
    this.globalTimer = null;
  }

  private submitGlobal(barcode: string) {
    this.bridge.submit(barcode);
    this.api.scan(barcode).subscribe({ error: err => console.error(err) });
  }

  private routerSub!: Subscription;
  private focusSub!: Subscription;

  constructor(private router: Router, private bridge: ScanBridgeService, private api: ScanApiService) {}

  ngOnInit() {
    this.routerSub = this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe((e: any) => {
      this.isScanRoute = e.urlAfterRedirects === '/scan';
      if (this.isScanRoute) setTimeout(() => this.focusNav(), 100);
    });
    this.focusSub = this.bridge.focusRequest$.subscribe(() => this.focusNav());
    this.isScanRoute = this.router.url === '/scan';
    if (this.isScanRoute) setTimeout(() => this.focusNav(), 100);

    // Drive badges from SignalR pushes; seed with the current queue on load.
    const applyBadges = (items: { status: string }[]) => {
      this.pendingCount = items.filter(i => i.status === 'Pending' || i.status === 'Processing').length;
      this.failedCount  = items.filter(i => i.status === 'Failed').length;
    };
    this.api.getQueue().subscribe(q => applyBadges(q));
    this.api.queueUpdated$Obs.subscribe(q => applyBadges(q));
  }

  ngOnDestroy() {
    this.routerSub.unsubscribe();
    this.focusSub.unsubscribe();
  }

  onNavKey(event: KeyboardEvent) {
    if (event.key === 'Enter') this.submitNav();
  }

  submitNav() {
    const barcode = this.navBarcode.trim();
    this.navBarcode = '';
    if (!barcode) return;
    this.bridge.submit(barcode);  // lets scan component show searching state if active
    this.api.scan(barcode).subscribe({ error: err => console.error(err) });
  }

  onNavBlur(event: FocusEvent) {
    const rt = event.relatedTarget as HTMLElement | null;
    if (rt instanceof HTMLInputElement || rt instanceof HTMLButtonElement || rt instanceof HTMLTextAreaElement) return;
    if (this.isScanRoute) setTimeout(() => this.focusNav(), 50);
  }

  private focusNav() {
    this.navScanInput?.nativeElement.focus();
  }
}
