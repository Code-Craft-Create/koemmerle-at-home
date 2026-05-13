import { Component, OnInit, OnDestroy, ViewChild, ElementRef, HostListener } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { ScanBridgeService } from './services/scan-bridge.service';
import { LatestRelease, MigrosSessionStatus, ScanApiService } from './services/scan-api.service';
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
  sessionStatus: MigrosSessionStatus | null = null;
  loginStarting = false;
  loginMessage = '';
  appVersion = '';
  latestRelease: LatestRelease | null = null;
  showReleaseBanner = false;

  private globalBuffer = '';
  private globalTimer: any = null;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;
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
  private queueSub!: Subscription;
  private sessionSub!: Subscription;

  constructor(private router: Router, private bridge: ScanBridgeService, private api: ScanApiService) {}

  get showLoginOverlay() {
    return this.sessionStatus !== null && !this.sessionStatus.isLoggedIn;
  }

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
    this.queueSub = this.api.queueUpdated$Obs.subscribe(q => applyBadges(q));

    this.sessionSub = this.api.migrosSessionUpdated$Obs.subscribe(status => this.applySessionStatus(status));
    this.refreshSessionStatus();
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
    if (this.sessionTimer) clearInterval(this.sessionTimer);
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
