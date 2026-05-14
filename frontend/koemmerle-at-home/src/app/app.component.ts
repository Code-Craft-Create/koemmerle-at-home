import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ScanBridgeService } from './services/scan-bridge.service';
import { LatestRelease, MigrosSessionStatus, ScanApiService } from './services/scan-api.service';
import { OrderImportService, OrderImportState } from './services/order-import.service';
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
  isOrdersRoute = false;
  navBarcode = '';
  queueOpen = false;
  settingsOpen = false;
  pendingCount = 0;
  failedCount = 0;
  sessionStatus: MigrosSessionStatus | null = null;
  loginStarting = false;
  loginMessage = '';
  appVersion = '';
  latestRelease: LatestRelease | null = null;
  showReleaseBanner = false;
  autoUpdateOrders = false;
  promptAutoUpdateOrders = true;
  autoUpdateSaving = false;
  showOrderImportPrompt = false;
  orderImportTrackerCollapsed = false;
  orderImportState: OrderImportState = {
    active: false,
    phase: null,
    current: 0,
    total: 0,
    message: '',
    progress: {}
  };

  private globalBuffer = '';
  private globalTimer: any = null;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
  private startupOrderCheckDone = false;
  private settingsLoaded = false;
  private orderImportCollapsedByOrdersRoute = false;
  private orderImportCollapsePendingForOrdersRoute = false;
  private readonly orderImportSnoozeMs = 10 * 60 * 1000;
  private readonly orderImportSnoozeUntilKey = 'orderImportSnoozeUntil';
  private readonly releaseStorageVersionKey = 'availableNewerRelease';
  private readonly releaseStorageAfterKey = 'showSeenReleaseInfoAgainAfter';

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event) {
    this.settingsOpen = false;
  }

  @HostListener('document:keydown', ['$event'])
  onGlobalKey(event: KeyboardEvent) {
    if (this.showLoginOverlay) return;
    if (document.activeElement === this.navScanInput?.nativeElement) return;
    if (this.bridge.globalScanSuppressed) return;

    if (event.key === 'Enter') {
      const barcode = this.globalBuffer.trim();
      this.clearGlobalBuffer();
      if (/^[a-zA-Z0-9\-]{6,}$/.test(barcode)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.submitGlobal(barcode);
      }
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
  private queueSub!: Subscription;
  private sessionSub!: Subscription;
  private orderImportSub!: Subscription;

  constructor(
    private router: Router,
    private bridge: ScanBridgeService,
    private api: ScanApiService,
    private orderImport: OrderImportService
  ) {}

  get showLoginOverlay() {
    return this.sessionStatus !== null && !this.sessionStatus.isLoggedIn;
  }

  ngOnInit() {
    this.routerSub = this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe((e: any) => {
      this.applyRouteState(e.urlAfterRedirects);
      if (this.isScanRoute) setTimeout(() => this.focusNav(), 100);
    });
    this.focusSub = this.bridge.focusRequest$.subscribe(() => this.focusNav());
    this.applyRouteState(this.router.url);
    if (this.isScanRoute) setTimeout(() => this.focusNav(), 100);

    // Drive badges from SignalR pushes; seed with the current queue on load.
    const applyBadges = (items: { status: string }[]) => {
      this.pendingCount = items.filter(i => i.status === 'Pending' || i.status === 'Processing').length;
      this.failedCount  = items.filter(i => i.status === 'Failed').length;
    };
    this.api.getQueue().subscribe(q => applyBadges(q));
    this.queueSub = this.api.queueUpdated$Obs.subscribe(q => applyBadges(q));

    this.sessionSub = this.api.migrosSessionUpdated$Obs.subscribe(status => this.applySessionStatus(status));
    this.orderImportSub = this.orderImport.state$.subscribe(s => {
      this.orderImportState = s;
      if (s.active && this.isOrdersRoute && this.orderImportCollapsePendingForOrdersRoute && !this.orderImportTrackerCollapsed) {
        this.forceCollapseOrderImportForOrdersRoute();
      }
    });
    this.refreshSessionStatus();
    this.api.getSettings().subscribe(s => {
      this.autoUpdateOrders = s.autoUpdateOrders;
      this.settingsLoaded = true;
      this.maybeHandleStartupOrders();
    });
    this.sessionTimer = setInterval(() => this.refreshSessionStatus(), 60000);
    this.api.getVersion().subscribe({
      next: info => {
        this.appVersion = info.displayVersion || info.version;
        this.applyLatestRelease(info.latestRelease ?? null);
      },
      error: () => this.appVersion = ''
    });
  }

  ngOnDestroy() {
    this.routerSub.unsubscribe();
    this.focusSub.unsubscribe();
    this.queueSub.unsubscribe();
    this.sessionSub.unsubscribe();
    this.orderImportSub.unsubscribe();
    if (this.sessionTimer) clearInterval(this.sessionTimer);
  }

  onNavKey(event: Event) {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === 'Enter') {
      keyboardEvent.preventDefault();
      keyboardEvent.stopImmediatePropagation();
      this.submitNav();
    }
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

  private applyRouteState(url: string) {
    const wasOrdersRoute = this.isOrdersRoute;
    this.isScanRoute = url === '/scan';
    this.isOrdersRoute = url === '/orders';

    if (!wasOrdersRoute && this.isOrdersRoute) {
      if (this.orderImportTrackerCollapsed) {
        this.orderImportCollapsePendingForOrdersRoute = false;
        this.orderImportCollapsedByOrdersRoute = false;
      } else if (this.orderImportState.active) {
        this.forceCollapseOrderImportForOrdersRoute();
      } else {
        this.orderImportCollapsePendingForOrdersRoute = true;
      }
    } else if (wasOrdersRoute && !this.isOrdersRoute) {
      if (this.orderImportCollapsedByOrdersRoute) {
        this.orderImportTrackerCollapsed = false;
      }
      this.orderImportCollapsedByOrdersRoute = false;
      this.orderImportCollapsePendingForOrdersRoute = false;
    }
  }

  refreshSessionStatus() {
    this.api.getMigrosSession().subscribe({
      next: status => this.applySessionStatus(status),
      error: () => {
        this.sessionStatus = { isLoggedIn: false, expiresAt: null, expiresInSec: null };
        this.loginMessage = 'Backend-Verbindung konnte nicht geprüft werden.';
      }
    });
  }

  private applySessionStatus(status: MigrosSessionStatus) {
    this.sessionStatus = status;
    if (status.isLoggedIn) {
      this.loginStarting = false;
      this.loginMessage = '';
      this.maybeHandleStartupOrders();
    }
  }

  private maybeHandleStartupOrders() {
    if (this.startupOrderCheckDone || !this.settingsLoaded || !this.sessionStatus?.isLoggedIn) return;

    this.startupOrderCheckDone = true;
    this.api.getOrders().subscribe({
      next: orders => {
        if (this.autoUpdateOrders && !this.isOrderImportSnoozed()) {
          this.orderImport.start();
          return;
        }

        if (orders.length === 0) {
          this.showOrderImportPrompt = true;
        }
      },
      error: () => {}
    });
  }

  startOrderImportFromPrompt() {
    this.showOrderImportPrompt = false;
    if (this.promptAutoUpdateOrders && !this.autoUpdateOrders) {
      this.autoUpdateOrders = true;
      this.api.setAutoUpdateOrders(true).subscribe({
        next: s => this.autoUpdateOrders = s.autoUpdateOrders,
        error: () => this.autoUpdateOrders = false
      });
    }
    this.orderImport.start();
  }

  closeOrderImportPrompt() {
    this.showOrderImportPrompt = false;
  }

  cancelOrderImport() {
    this.snoozeOrderImport();
    this.orderImport.cancel();
  }

  collapseOrderImportTracker() {
    this.orderImportTrackerCollapsed = true;
    this.orderImportCollapsedByOrdersRoute = false;
    this.orderImportCollapsePendingForOrdersRoute = false;
  }

  expandOrderImportTracker() {
    this.orderImportTrackerCollapsed = false;
    this.orderImportCollapsedByOrdersRoute = false;
    this.orderImportCollapsePendingForOrdersRoute = false;
  }

  private forceCollapseOrderImportForOrdersRoute() {
    this.orderImportTrackerCollapsed = true;
    this.orderImportCollapsedByOrdersRoute = true;
    this.orderImportCollapsePendingForOrdersRoute = false;
  }

  private snoozeOrderImport() {
    localStorage.setItem(this.orderImportSnoozeUntilKey, String(Date.now() + this.orderImportSnoozeMs));
  }

  private isOrderImportSnoozed(): boolean {
    const snoozeUntil = Number(localStorage.getItem(this.orderImportSnoozeUntilKey) ?? '0');
    return Number.isFinite(snoozeUntil) && Date.now() < snoozeUntil;
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
      }
    });
  }

  togglePromptAutoUpdateOrders(enabled: boolean) {
    this.promptAutoUpdateOrders = enabled;
  }

  orderImportProgressPercent(): number {
    const state = this.orderImportState;
    if (!state.total) return state.active ? 8 : 100;

    return Math.max(8, Math.round((state.current / state.total) * 100));
  }

  currentProductSyncProgress() {
    const entries = Object.values(this.orderImportState.progress);
    return entries.find(p => p.total > 0 && p.done < p.total)
      ?? entries.find(p => p.total > 0)
      ?? null;
  }

  currentProductSyncProgressPercent(): number {
    const progress = this.currentProductSyncProgress();
    if (!progress?.total) return 0;

    return Math.round((progress.done / progress.total) * 100);
  }

  orderImportPhaseLabel(): string {
    switch (this.orderImportState.phase) {
      case 'headers': return 'Bestellungen suchen';
      case 'details': return 'Details laden';
      case 'products': return 'Produkte verknüpfen';
      default: return 'Bestellungen importieren';
    }
  }

  orderImportCountLabel(): string {
    const state = this.orderImportState;
    if (state.total <= 0) return 'läuft...';

    switch (state.phase) {
      case 'headers':
        return `${state.current} / ${state.total} Bestellungen gefunden`;
      case 'details':
        return `${state.current} / ${state.total} Bestelldetails geladen`;
      case 'products':
        return `${state.current} / ${state.total} Bestellungen synchronisiert`;
      default:
        return `${state.current} / ${state.total}`;
    }
  }

  private applyLatestRelease(release: LatestRelease | null) {
    this.latestRelease = release;
    this.showReleaseBanner = false;
    if (!release?.version) return;

    const storedVersion = localStorage.getItem(this.releaseStorageVersionKey);
    const showAgainAfter = Number(localStorage.getItem(this.releaseStorageAfterKey) ?? '0');
    this.showReleaseBanner = storedVersion !== release.version || !Number.isFinite(showAgainAfter) || Date.now() >= showAgainAfter;
  }

  dismissReleaseBanner() {
    this.storeReleaseBannerSnooze(12 * 60 * 60 * 1000);
  }

  hideReleaseBannerLongTerm() {
    this.storeReleaseBannerSnooze(365 * 24 * 60 * 60 * 1000);
  }

  private storeReleaseBannerSnooze(durationMs: number) {
    if (!this.latestRelease?.version) return;

    localStorage.setItem(this.releaseStorageVersionKey, this.latestRelease.version);
    localStorage.setItem(this.releaseStorageAfterKey, String(Date.now() + durationMs));
    this.showReleaseBanner = false;
  }

  startMigrosLogin() {
    this.loginStarting = true;
    this.loginMessage = '';
    const unlockTimer = setTimeout(() => {
      this.loginStarting = false;
      if (!this.loginMessage)
        this.loginMessage = 'Falls das Login-Fenster bereits offen ist, wechsle dorthin und melde dich bei Migros an.';
    }, 3000);

    this.api.startMigrosLogin().subscribe({
      next: () => {
        clearTimeout(unlockTimer);
        this.loginStarting = false;
        this.loginMessage = 'Das Login-Fenster ist offen. Melde dich dort bei Migros an; diese Ansicht verschwindet automatisch danach.';
        setTimeout(() => this.refreshSessionStatus(), 1500);
      },
      error: () => {
        clearTimeout(unlockTimer);
        this.loginStarting = false;
        this.loginMessage = 'Login-Fenster konnte nicht geöffnet werden.';
      }
    });
  }
}
