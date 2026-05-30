import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ScanBridgeService } from './services/scan-bridge.service';
import { LatestRelease, MigrosSessionStatus, RecipeDto, ScanApiService } from './services/scan-api.service';
import { OrderImportService, OrderImportState } from './services/order-import.service';
import { QueueSidebarComponent } from './shared/queue-sidebar.component';
import { ScanComponent } from './scan/scan.component';
import { ConfirmDialogComponent } from './shared/confirm-dialog.component';
import { ToastContainerComponent } from './shared/toast-container.component';
import { EasterEggService } from './easter-egg/easter-egg.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule, FormsModule, QueueSidebarComponent, ScanComponent, ConfirmDialogComponent, ToastContainerComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit, OnDestroy {
  @ViewChild('navScanInput') navScanInput?: ElementRef<HTMLInputElement>;

  isScanRoute = false;
  isOrdersRoute = false;
  isPromotionsRoute = false;
  isStickersRoute = false;
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
  hasRecipePromotions = false;
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
  private orderImportCollapsedByStowRoute = false;
  private orderImportCollapsePendingForStowRoute = false;
  private lastOrderImportProgress = 0;
  private lastAvailabilitySyncTotal = 0;
  private wasOrderImportActive = false;
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
    private orderImport: OrderImportService,
    private easterEgg: EasterEggService,
  ) {}

  onVersionWatermarkClick() {
    if (!this.isStickersRoute) return;
    this.easterEgg.request();
  }

  get showLoginOverlay() {
    return this.sessionStatus !== null && !this.sessionStatus.isLoggedIn;
  }

  ngOnInit() {
    this.routerSub = this.router.events.pipe(
      filter(e => e instanceof NavigationEnd)
    ).subscribe((e: any) => {
      this.applyRouteState(e.urlAfterRedirects);
      this.refreshRecipePromotionFlag();
      if (this.isScanRoute) setTimeout(() => this.focusNav(), 100);
    });
    this.focusSub = this.bridge.focusRequest$.subscribe(() => this.focusNav());
    this.applyRouteState(this.router.url);
    this.refreshRecipePromotionFlag();
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
      const wasActive = this.orderImportState.active;
      this.orderImportState = s;
      if (!wasActive && s.active) {
        this.wasOrderImportActive = true;
        this.lastOrderImportProgress = 0;
      } else if (!s.active) {
        this.wasOrderImportActive = false;
        this.lastOrderImportProgress = 0;
      }
      if (s.active && this.isOrderImportStowRoute() && this.orderImportCollapsePendingForStowRoute && !this.orderImportTrackerCollapsed) {
        this.forceCollapseOrderImportForStowRoute();
      }
      if (s.phase !== 'availability') {
        this.lastAvailabilitySyncTotal = 0;
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
    const wasStowRoute = this.isOrderImportStowRoute();
    this.isScanRoute = url === '/scan';
    this.isOrdersRoute = url === '/orders';
    this.isPromotionsRoute = url === '/promotions';
    this.isStickersRoute = url === '/stickers';
    const isStowRoute = this.isOrderImportStowRoute();

    if (!wasStowRoute && isStowRoute) {
      if (this.orderImportTrackerCollapsed) {
        this.orderImportCollapsePendingForStowRoute = false;
        this.orderImportCollapsedByStowRoute = false;
      } else if (this.orderImportState.active) {
        this.forceCollapseOrderImportForStowRoute();
      } else {
        this.orderImportCollapsePendingForStowRoute = true;
      }
    } else if (wasStowRoute && !isStowRoute) {
      if (this.orderImportCollapsedByStowRoute) {
        this.orderImportTrackerCollapsed = false;
      }
      this.orderImportCollapsedByStowRoute = false;
      this.orderImportCollapsePendingForStowRoute = false;
    }
  }

  private isOrderImportStowRoute(): boolean {
    return this.isOrdersRoute || this.isPromotionsRoute;
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

  private refreshRecipePromotionFlag() {
    this.api.getRecipes().subscribe({
      next: recipes => this.hasRecipePromotions = recipes.some(recipe => this.recipeHasPromotion(recipe)),
      error: () => this.hasRecipePromotions = false
    });
  }

  private recipeHasPromotion(recipe: RecipeDto): boolean {
    return recipe.items.some(item =>
      item.promotionPrice != null && (item.price == null || item.promotionPrice < item.price));
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
    this.orderImportCollapsedByStowRoute = false;
    this.orderImportCollapsePendingForStowRoute = false;
  }

  expandOrderImportTracker() {
    this.orderImportTrackerCollapsed = false;
    this.orderImportCollapsedByStowRoute = false;
    this.orderImportCollapsePendingForStowRoute = false;
  }

  private forceCollapseOrderImportForStowRoute() {
    this.orderImportTrackerCollapsed = true;
    this.orderImportCollapsedByStowRoute = true;
    this.orderImportCollapsePendingForStowRoute = false;
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
    if (!state.active) {
      this.wasOrderImportActive = false;
      this.lastOrderImportProgress = 0;
      return 100;
    }

    if (!this.wasOrderImportActive) {
      this.wasOrderImportActive = true;
      this.lastOrderImportProgress = 0;
    }

    const segment = this.orderImportPhaseSegment();
    if (!segment) return 0;

    const phaseProgress = state.total > 0
      ? Math.min(Math.max(state.current / state.total, 0), 1)
      : 0;

    const progress = Math.round(segment.start + (segment.end - segment.start) * phaseProgress);
    if (this.lastOrderImportProgress > segment.end) {
      this.lastOrderImportProgress = segment.start;
    }
    this.lastOrderImportProgress = Math.max(this.lastOrderImportProgress, progress);
    return this.lastOrderImportProgress;
  }

  private orderImportPhaseSegment(): { start: number; end: number } | null {
    switch (this.orderImportState.phase) {
      case 'headers': return { start: 0, end: 18 };
      case 'details': return { start: 18, end: 40 };
      case 'products': return { start: 40, end: 72 };
      case 'availability': return { start: 72, end: 84 };
      case 'promotions': return { start: 84, end: 100 };
      default: return null;
    }
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
      case 'availability': return 'Verfügbarkeit prüfen';
      case 'promotions': return 'Aktionen aktualisieren';
      default: return 'Migros-Sync';
    }
  }

  orderImportCountLabel(): string {
    const state = this.orderImportState;
    if (state.total <= 0 && state.phase !== 'availability') return 'läuft...';

    switch (state.phase) {
      case 'headers':
        return `${state.current} / ${state.total} Bestellungen gefunden`;
      case 'details':
        return `${state.current} / ${state.total} Bestelldetails geladen`;
      case 'products':
        return `${state.current} / ${state.total} Bestellungen synchronisiert`;
      case 'availability':
        if (state.availabilityProgress) {
          const total = state.availabilityProgress.total;
          if (total > 0) this.lastAvailabilitySyncTotal = total;
          if (total <= 0 && this.lastAvailabilitySyncTotal <= 0) return 'Produkte werden geprüft';
          if (total <= 0) return `0 / ${this.lastAvailabilitySyncTotal} Produkte geprüft`;
          return `${state.availabilityProgress.done} / ${total} Produkte geprüft`;
        }
        if (state.unavailableRefresh) {
          this.lastAvailabilitySyncTotal = state.unavailableRefresh.checked;
          return `${state.unavailableRefresh.checked} / ${state.unavailableRefresh.checked} Produkte geprüft`;
        }
        return this.lastAvailabilitySyncTotal > 0
          ? `0 / ${this.lastAvailabilitySyncTotal} Produkte geprüft`
          : 'Produkte werden geprüft';
      case 'promotions':
        return this.promotionProgressLabel();
      default:
        return `${state.current} / ${state.total}`;
    }
  }

  private promotionProgressLabel(): string {
    const progress = this.orderImportState.promotionProgress;
    if (!progress) return 'läuft...';

    switch (progress.stage) {
      case 'search':
        return `${progress.done} / ${progress.total} Aktionen gefunden`;
      case 'cards':
        return `${progress.done} / ${progress.total} Aktionen verarbeitet`;
      case 'complete':
        return `${progress.promotionsStored} Aktionen aktualisiert`;
      default:
        return 'läuft...';
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
