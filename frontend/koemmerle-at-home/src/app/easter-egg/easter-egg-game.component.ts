import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import type { StickerItem } from '../stickers/stickers.component';
import { ScanBridgeService } from '../services/scan-bridge.service';
import { GAME_CONFIG, GamePhase } from './easter-egg-game.config';
import { DEFAULT_MASK, makeProductSprite, ProductSprite } from './product-sprite-generator';
import { Chiptune, ChiptuneVoice } from './chiptune-audio';

interface Runner {
  item: StickerItem;
  sprite: ProductSprite | null;
  // World-space position of the runner's feet (ground line).
  x: number;
  baseY: number;
  /**
   * Signed running speed in px/sec along x, *relative to the van*. Positive
   * means sprinting ahead, negative means falling behind. Legs always animate
   * the same way (we don't render them running backwards).
   */
  speed: number;
  /** Original (unsigned) speed magnitude — restored when a scare wears off. */
  baseSpeedMag: number;
  /** Milliseconds remaining of the "scared by van" state; 0 = calm. */
  scareTimer: number;
  phase: number;          // bob phase offset
  caught: boolean;
  // For the reel-in animation when caught.
  netT?: number;          // 0..1 progress
  netStart?: { x: number; y: number };
  // Intro: each runner has its own delay + jump target so they pop out one by one.
  introDelayMs: number;
  targetX: number;
  targetY: number;
  /**
   * Hint mechanic: total number of clicks the player has spent on this runner.
   * First click activates the hover tooltip (without revealing any letter);
   * each subsequent click reveals one more letter. Each click also costs one
   * score point at the end.
   */
  hintClicks: number;
}

// Soft boundaries for runner X movement: never let a runner leave the screen.
const RUNNER_LEFT_MARGIN = 220;   // keep them right of the van
const RUNNER_RIGHT_MARGIN = 80;   // px from right edge

// Intro pacing.
const INTRO_STAGGER_MS = 280;     // gap between consecutive runner pops
const INTRO_HOP_MS = 700;         // single runner's hop duration

@Component({
  selector: 'app-easter-egg-game',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './easter-egg-game.component.html',
  styleUrl: './easter-egg-game.component.scss',
})
export class EasterEggGameComponent implements OnInit, AfterViewInit, OnDestroy {
  @Input({ required: true }) items: StickerItem[] = [];
  @Output() readonly close = new EventEmitter<void>();

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  phase: GamePhase = 'intro';
  caughtCount = 0;
  elapsedMs = 0;
  totalItems = 0;
  finalScore = 0;
  scoreBreakdown: {
    itemPoints: number;
    timePenalty: number;
    hintPenalty: number;
    missedCount: number;
    missedPenalty: number;
    total: number;
  } = { itemPoints: 0, timePenalty: 0, hintPenalty: 0, missedCount: 0, missedPenalty: 0, total: 0 };
  totalHintClicks = 0;
  finalSeconds = 0;
  musicMuted = !GAME_CONFIG.musicEnabledDefault;
  /** Standalone banner visibility — outlives the intro phase so it reads as 5s. */
  showIntroBanner = true;
  private introBannerTimer: ReturnType<typeof setTimeout> | null = null;
  /** Holds the timeout that hands control from the fanfare to the celebration loop. */
  private victoryHandoffTimer: ReturnType<typeof setTimeout> | null = null;

  /** Player-driven van offset, applied on top of the default parked position. */
  private vanOffsetX = 0;
  private vanOffsetY = 0;
  /** Pixel-per-second van move speed when an arrow key is held. */
  private readonly vanMoveSpeed = 240;
  /** Arrow keys currently held down — sampled in update() for smooth motion. */
  private keysDown = new Set<string>();

  // Debug: per-voice audio mute toggles. Off by default; not persisted.
  // Flip showAudioDebug to true to expose the 🎛 toggle (and the panel it
  // opens) in the topbar — useful for tuning, hidden in normal play.
  readonly showAudioDebug = false;
  audioDebugOpen = false;
  readonly audioVoices: ReadonlyArray<{ id: ChiptuneVoice; label: string }> = [
    { id: 'bass',  label: 'Bass' },
    { id: 'arp',   label: 'Arp' },
    { id: 'lead',  label: 'Lead' },
    { id: 'drums', label: 'Drums' },
  ];
  voiceMuted: Record<ChiptuneVoice, boolean> = {
    bass: false, arp: false, lead: false, drums: false,
  };

  // Lead melody A/B tester.
  // `leadSelection` mirrors the combobox state — either 'auto' (rotate through
  // favourites every 4 passes) or a specific 0-based variation index.
  // `currentPlayingVariation` is the variation actually sounding right now;
  // in auto mode it changes every few seconds.
  leadSelection: string = 'auto';
  currentPlayingVariation = 0;
  get leadVariationIndices(): number[] {
    return Array.from({ length: this.chiptune.leadVariationCount }, (_, i) => i);
  }
  /** Pretty label for a variation index — defers to Chiptune so #100 maps correctly. */
  leadVariationLabel(idx: number): string {
    return this.chiptune.getLeadVariationLabel(idx);
  }

  // Debug: live mask tuning sliders. Hidden by default — flip this to true
  // to expose the brightness/chroma sliders in the debug panel for tuning.
  readonly showMaskSliders = false;
  maskBrightness = DEFAULT_MASK.brightness;
  maskChroma = DEFAULT_MASK.chroma;
  private maskRegenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Generation counter — ignores stale regenerate-all results from earlier slider positions. */
  private maskRegenGen = 0;

  private ctx2d!: CanvasRenderingContext2D;
  private rafId: number | null = null;
  private startMs = 0;
  private lastFrameMs = 0;
  private streetImg: HTMLImageElement | null = null;
  private vanImg: HTMLImageElement | null = null;
  /** Sky color sampled from street.png so the area above the street matches. */
  private skyColor = '#5fb3ff';
  private scrollX = 0;
  private frame = 0;
  /** 0..1 progress of the van's drive-off animation during the success phase. */
  private vanExitT = 0;
  private readonly vanExitMs = 2500;
  /** Runner currently under the mouse pointer — drives the hint tooltip. */
  private hoveredRunner: Runner | null = null;
  private runners: Runner[] = [];
  private barcodeSub: Subscription | null = null;
  private chiptune = new Chiptune();
  private destroyed = false;

  // Local scanner buffer — we suppress the global handler in app.component
  // while the game is open, so we have to capture scanner keystrokes here.
  private scanBuffer = '';
  private scanBufferTimer: ReturnType<typeof setTimeout> | null = null;

  // Index for fast lookup by barcode (a.k.a. gtin from the loaded sticker products).
  private barcodeIndex = new Map<string, Runner>();

  constructor(private bridge: ScanBridgeService) {}

  ngOnInit() {
    // Keep only items with at least one usable barcode — that's the catch mechanic.
    const eligible = this.items.filter(i => !!collectGtins(i).length);
    this.totalItems = eligible.length;

    this.runners = eligible.map((item, idx) => this.createRunner(item, idx, eligible.length));
    // Products can have multiple GTINs (comma-separated in StickerItem.barcodes).
    // Any of them should trigger a catch.
    for (const r of this.runners) {
      for (const code of collectGtins(r.item)) this.barcodeIndex.set(code, r);
    }

    // Prevent the global scan handler in AppComponent from firing api.scan()
    // for in-game scans. Side-effect: it also stops buffering keystrokes,
    // which is why we install our own document keydown handler above.
    this.bridge.suppressGlobal();

    // Still subscribe to bridge.barcode$ in case scans arrive via the nav
    // input (which calls bridge.submit() even with global suppressed).
    this.barcodeSub = this.bridge.barcode$.subscribe(b => {
      console.debug('[easter-egg] bridge barcode received:', b);
      this.onBarcode(b);
    });

    console.debug('[easter-egg] game started with', this.totalItems, 'items. Known GTINs:',
      [...this.barcodeIndex.keys()]);
  }

  ngAfterViewInit() {
    const canvas = this.canvasRef.nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) { this.exit(); return; }
    this.ctx2d = ctx;
    this.applyCanvasDpr();

    // Kick off async asset loading + sprite generation. The render loop draws
    // graceful fallbacks until they're ready, so we don't need to block.
    this.loadAssets();
    this.generateSprites();

    // Audio after user gesture (the watermark click that opened the game counts).
    if (!this.musicMuted) this.chiptune.start();

    this.startMs = performance.now();
    this.lastFrameMs = this.startMs;
    this.rafId = requestAnimationFrame(this.loop);

    // If the default van position from the config sits outside the road
    // clamp, snap it back inside on the first frame.
    this.clampVanOffsets();

    // Banner sticks around for 5s regardless of when the intro hops finish.
    this.introBannerTimer = setTimeout(() => { this.showIntroBanner = false; }, 5000);
  }

  ngOnDestroy() {
    this.destroyed = true;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    if (this.introBannerTimer) clearTimeout(this.introBannerTimer);
    if (this.maskRegenTimer) clearTimeout(this.maskRegenTimer);
    if (this.victoryHandoffTimer) clearTimeout(this.victoryHandoffTimer);
    this.barcodeSub?.unsubscribe();
    this.clearScanBuffer();
    this.chiptune.stop();
    this.bridge.unsuppressGlobal();
  }

  @HostListener('window:resize')
  onResize() { this.applyCanvasDpr(); }

  @HostListener('document:keydown.escape')
  onEsc() { this.exit(); }

  /**
   * Capture scanner keystrokes ourselves. We can't rely on AppComponent's
   * global listener because we suppress it (we don't want api.scan() to fire
   * mid-game). Mirrors AppComponent.onGlobalKey: fast accumulator that
   * flushes on Enter, with a 100ms idle timeout for stuck partials.
   */
  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') return; // handled above
    // Arrow keys steer the van. Only intercept during play so we don't fight
    // the success card's focus. preventDefault stops the page from scrolling
    // when the user holds Up/Down.
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (this.phase === 'play') {
        this.keysDown.add(event.key);
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'Enter') {
      const barcode = this.scanBuffer.trim();
      this.clearScanBuffer();
      if (/^[a-zA-Z0-9\-]{6,}$/.test(barcode)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        console.debug('[easter-egg] scan received:', barcode);
        this.onBarcode(barcode);
      }
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.scanBuffer += event.key;
      if (this.scanBufferTimer) clearTimeout(this.scanBufferTimer);
      this.scanBufferTimer = setTimeout(() => this.clearScanBuffer(), 100);
    }
  }

  private clearScanBuffer() {
    this.scanBuffer = '';
    if (this.scanBufferTimer) { clearTimeout(this.scanBufferTimer); this.scanBufferTimer = null; }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(event: KeyboardEvent) {
    this.keysDown.delete(event.key);
  }

  @HostListener('window:blur')
  onWindowBlur() {
    // Releases all keys when the window loses focus — otherwise the van could
    // keep coasting because we never received the keyup.
    this.keysDown.clear();
  }

  exit() { this.close.emit(); }

  toggleMute() {
    this.musicMuted = !this.musicMuted;
    if (this.musicMuted) this.chiptune.stop();
    else this.chiptune.start();
  }

  toggleAudioDebug() { this.audioDebugOpen = !this.audioDebugOpen; }

  toggleVoiceMute(voice: ChiptuneVoice) {
    this.voiceMuted[voice] = !this.voiceMuted[voice];
    this.chiptune.setVoiceMuted(voice, this.voiceMuted[voice]);
  }

  onLeadVariationChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    this.leadSelection = value;
    if (value === 'auto') {
      this.chiptune.setLeadAutoRotate(true);
    } else {
      const idx = parseInt(value, 10);
      if (Number.isFinite(idx)) this.chiptune.setLeadVariation(idx);
    }
  }

  // ── Hint mechanic (click to reveal letters of a product name) ────────────

  onCanvasClick(event: MouseEvent) {
    if (this.phase !== 'play') return;
    const world = this.eventToWorld(event);
    const target = this.findRunnerAt(world.x, world.y);
    if (!target) return;
    // Cheat (testing only): shift-click on a product fires the same path as
    // a successful barcode scan for that item — handy for verifying catch
    // animations and end-screen logic without a physical scanner. Uses the
    // runner's primary barcode; onBarcode handles the rest.
    if (event.shiftKey) {
      const code = target.item.barcode;
      if (code) {
        console.debug('[easter-egg] cheat shift-click → simulating scan', code);
        this.onBarcode(code);
      }
      return;
    }
    // Normal click: reveal one more letter of the name. First click activates
    // the hover tooltip (no letter yet); each further click reveals one more
    // letter. Cap at name.length + 1 so over-clicking doesn't keep racking up
    // score penalty past full reveal.
    const cap = target.item.name.length + 1;
    if (target.hintClicks < cap) target.hintClicks++;
  }

  onCanvasMouseMove(event: MouseEvent) {
    if (this.phase !== 'play') {
      this.hoveredRunner = null;
      this.updateCanvasCursor(false);
      return;
    }
    const world = this.eventToWorld(event);
    this.hoveredRunner = this.findRunnerAt(world.x, world.y);
    this.updateCanvasCursor(!!this.hoveredRunner);
  }

  onCanvasMouseLeave() {
    this.hoveredRunner = null;
    this.updateCanvasCursor(false);
  }

  private updateCanvasCursor(pointer: boolean) {
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) canvas.style.cursor = pointer ? 'pointer' : 'default';
  }

  /** Map a pointer event to world-space coords using the canvas' CSS bounds. */
  private eventToWorld(event: MouseEvent): { x: number; y: number } {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (GAME_CONFIG.width  / rect.width),
      y: (event.clientY - rect.top)  * (GAME_CONFIG.height / rect.height),
    };
  }

  /**
   * Find the nearest visible runner whose hit-box contains (x, y). The hit-box
   * is derived from the sprite's detected content bounds, padded slightly so
   * the legs and eye area are also clickable. Caught / fully-reeled-in
   * runners are excluded.
   */
  private findRunnerAt(x: number, y: number): Runner | null {
    let best: Runner | null = null;
    let bestDist = Infinity;
    for (const r of this.runners) {
      if (r.caught) continue;
      if (!r.sprite) continue;
      // Skip runners that haven't popped out of the van yet during intro.
      if (this.phase === 'intro' && this.elapsedMs < r.introDelayMs) continue;
      const b = r.sprite.bounds;
      const legLength = Math.max(14, Math.round(b.h * 0.35));
      const cx = r.x;
      const cy = r.baseY - legLength - b.h / 2;
      const halfW = b.w / 2 + 12;
      const halfH = b.h / 2 + 20;
      if (Math.abs(x - cx) > halfW || Math.abs(y - cy) > halfH) continue;
      const dx = x - cx, dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = r; }
    }
    return best;
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  private createRunner(item: StickerItem, idx: number, total: number): Runner {
    // Lay runners out across a fan of lanes so they don't overlap visually.
    // X: stratified into evenly-spaced "lane columns" with light jitter.
    // Y: stratified into a few depth lanes (each lane offsets the ground line
    //    by a constant). Closer runners (higher baseY) render in front.
    const lanes = Math.min(4, Math.max(2, total));
    const lane = idx % lanes;
    const groundY = GAME_CONFIG.height - GAME_CONFIG.vanBottomPad;
    const laneDepth = lane * 18;  // each lane sits 18px further back
    const targetY = groundY - 4 - laneDepth + (Math.random() * 6 - 3);

    const slot = total <= 1 ? 0.6 : idx / (total - 1);
    const xJitter = (Math.random() * 40 - 20);
    const targetX = RUNNER_LEFT_MARGIN +
      slot * (GAME_CONFIG.width - RUNNER_LEFT_MARGIN - RUNNER_RIGHT_MARGIN) + xJitter;

    // Mixed signed speed: ~30% chance to start "falling behind" so the herd
    // doesn't immediately drift one direction in unison.
    const fallBehind = Math.random() < 0.3;
    const mag = GAME_CONFIG.productSpeed * 0.4 + Math.random() * GAME_CONFIG.productSpeedJitter;
    const speed = fallBehind ? -mag : mag;

    return {
      item,
      sprite: null,
      // Start parked at the van — the intro update reveals them on schedule.
      x: 0,
      baseY: 0,
      speed,
      baseSpeedMag: mag,
      scareTimer: 0,
      phase: Math.random() * Math.PI * 2,
      caught: false,
      introDelayMs: idx * INTRO_STAGGER_MS,
      targetX,
      targetY,
      hintClicks: 0,
    };
  }

  private async generateSprites() {
    await this.regenerateSpritesWith(this.maskBrightness, this.maskChroma);
  }

  /**
   * Regenerate every runner's sprite using the given mask thresholds.
   * Used by the initial render and re-fired whenever the debug sliders
   * change. A generation counter guards against races: if the user drags
   * the slider while a previous regeneration is still in flight, the older
   * result is discarded once it finishes.
   */
  private async regenerateSpritesWith(brightness: number, chroma: number) {
    const gen = ++this.maskRegenGen;
    await Promise.all(this.runners.map(async runner => {
      const src = runner.item.imageData || runner.item.imageUrl;
      if (!src) return;
      try {
        const sprite = await makeProductSprite(src, { brightness, chroma });
        if (gen !== this.maskRegenGen || this.destroyed) return;
        runner.sprite = sprite;
      } catch { /* tainted canvas / load error — runner stays sprite-less */ }
    }));
  }

  // ── Mask debug sliders ───────────────────────────────────────────────────

  onMaskBrightnessChange(event: Event) {
    this.maskBrightness = +((event.target as HTMLInputElement).value);
    this.scheduleMaskRegen();
  }
  onMaskChromaChange(event: Event) {
    this.maskChroma = +((event.target as HTMLInputElement).value);
    this.scheduleMaskRegen();
  }

  private scheduleMaskRegen() {
    if (this.maskRegenTimer) clearTimeout(this.maskRegenTimer);
    // Small debounce so the user can drag without firing dozens of regens.
    this.maskRegenTimer = setTimeout(
      () => this.regenerateSpritesWith(this.maskBrightness, this.maskChroma),
      120,
    );
  }

  private loadAssets() {
    const street = new Image();
    street.src = 'assets/street.png';
    street.onload = () => {
      if (this.destroyed) return;
      this.streetImg = street;
      this.skyColor = sampleTopColor(street) ?? this.skyColor;
    };

    const van = new Image();
    van.src = 'assets/deliveryvan.png';
    van.onload = () => { if (!this.destroyed) this.vanImg = van; };
  }

  private applyCanvasDpr() {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    // We draw in world coords (GAME_CONFIG.width x .height) — set a transform
    // that maps that onto the actual canvas pixel size.
    const sx = canvas.width / GAME_CONFIG.width;
    const sy = canvas.height / GAME_CONFIG.height;
    this.ctx2d.setTransform(sx, 0, 0, sy, 0, 0);
    this.ctx2d.imageSmoothingEnabled = false;
  }

  // ── Game loop ────────────────────────────────────────────────────────────

  private loop = (now: number) => {
    if (this.destroyed) return;
    const dt = Math.min(50, now - this.lastFrameMs) / 1000;
    this.lastFrameMs = now;
    // Freeze elapsed time once the run is won — the success card should show
    // the final time, not keep ticking.
    if (this.phase !== 'success') this.elapsedMs = now - this.startMs;
    this.frame++;
    // Mirror the chiptune's current lead variation into a template-bound
    // field so the debug panel reflects auto-rotate switches.
    this.currentPlayingVariation = this.chiptune.currentLeadVariation;

    this.update(dt);
    this.render();

    this.rafId = requestAnimationFrame(this.loop);
  };

  private update(dt: number) {
    // Scroll the street during intro + play. On success the world halts so
    // the celebration scene feels still / framed — except the van itself,
    // which drives off-screen to the right as a victory lap.
    if (this.phase !== 'success') {
      this.scrollX = (this.scrollX + GAME_CONFIG.scrollSpeed * dt) % 10_000;
    } else {
      this.vanExitT = Math.min(1, this.vanExitT + dt / (this.vanExitMs / 1000));
      return;
    }

    if (this.phase === 'intro') {
      // Runners pop out of the van one after another. Each has its own
      // introDelayMs; before that they're invisible (drawRunners filters them).
      // Once active, they hop on an arc from the van's rear to their gameplay
      // slot over INTRO_HOP_MS.
      const vanRearX = this.vanLeft() + this.vanWidth() * 0.85;
      const vanMidY = this.vanTop() + this.vanHeight() * 0.55;
      let allLanded = true;
      for (const r of this.runners) {
        const local = this.elapsedMs - r.introDelayMs;
        if (local < 0) { allLanded = false; continue; }
        const t = Math.min(1, local / INTRO_HOP_MS);
        if (t < 1) allLanded = false;
        const eased = easeOutCubic(t);
        const arc = Math.sin(t * Math.PI) * 90;
        r.x = vanRearX + (r.targetX - vanRearX) * eased;
        r.baseY = vanMidY + (r.targetY - vanMidY) * eased - arc;
      }
      if (allLanded) {
        this.phase = 'play';
        for (const r of this.runners) {
          r.x = r.targetX;
          r.baseY = r.targetY;
        }
      }
      return;
    }

    if (this.phase === 'play') {
      // Drive the van — held arrow keys translate into a per-frame offset
      // applied on top of the parked default position. Clamped to the canvas
      // horizontally and to the road surface vertically.
      const dx = (this.keysDown.has('ArrowRight') ? 1 : 0) - (this.keysDown.has('ArrowLeft') ? 1 : 0);
      const dy = (this.keysDown.has('ArrowDown')  ? 1 : 0) - (this.keysDown.has('ArrowUp')   ? 1 : 0);
      if (dx !== 0 || dy !== 0) {
        this.vanOffsetX += dx * this.vanMoveSpeed * dt;
        this.vanOffsetY += dy * this.vanMoveSpeed * dt;
        this.clampVanOffsets();
      }

      const leftBound = RUNNER_LEFT_MARGIN;
      const rightBound = GAME_CONFIG.width - RUNNER_RIGHT_MARGIN;
      // Scare parameters: any runner inside this radius around the van centre
      // sprints away at SCARE_SPEED_MUL × its normal speed. The cooldown keeps
      // the boost active for a beat after the van leaves so the herd
      // genuinely scatters instead of snapping back as soon as it can.
      const SCARE_RADIUS = 120;
      const SCARE_SPEED_MUL = 2.6;
      const SCARE_COOLDOWN_MS = 900;
      const vanCenterX = this.vanLeft() + this.vanWidth() / 2;
      const vanCenterY = this.vanTop() + this.vanHeight() / 2;

      for (const r of this.runners) {
        if (r.caught) {
          // Reel-in animation: lerp from netStart to van.
          if (r.netT == null) continue;
          r.netT = Math.min(1, r.netT + dt / (GAME_CONFIG.netReelMs / 1000));
          continue;
        }

        // ── Scare check ──
        const ddx = r.x - vanCenterX;
        const ddy = r.baseY - vanCenterY;
        const dist = Math.hypot(ddx, ddy);
        if (dist < SCARE_RADIUS) {
          // Inside the van's panic radius — flee in the direction that points
          // away from the van centre (signX from ddx). Speed magnitude boosted.
          r.scareTimer = SCARE_COOLDOWN_MS;
          const signX = ddx >= 0 ? 1 : -1;
          r.speed = signX * r.baseSpeedMag * SCARE_SPEED_MUL;
        } else if (r.scareTimer > 0) {
          r.scareTimer = Math.max(0, r.scareTimer - dt * 1000);
          if (r.scareTimer === 0) {
            // Settle back to a normal pace, preserving current direction so
            // the runner doesn't snap-flip when calming down.
            const dir = Math.sign(r.speed) || 1;
            r.speed = dir * r.baseSpeedMag;
          }
        }

        r.x += r.speed * dt;
        // Soft bounce at both edges. The runner stays on screen at all times,
        // but a runner near the right edge reverses to "fall behind" the van,
        // and one near the left edge speeds up to "catch up".
        if (r.x > rightBound) {
          r.x = rightBound;
          if (r.speed > 0) r.speed = -Math.abs(r.speed) * (0.6 + Math.random() * 0.4);
        } else if (r.x < leftBound) {
          r.x = leftBound;
          if (r.speed < 0) r.speed = Math.abs(r.speed) * (0.6 + Math.random() * 0.4);
        }
      }

      if (this.runners.every(r => r.caught && (r.netT ?? 0) >= 1)) {
        this.transitionToSuccess();
      }
    }
  }

  /**
   * Move the game into the success phase. Shared between the natural finish
   * (all items caught) and the user-triggered "Beenden" button. The success
   * card and music handoff are identical; only `computeScore()` differs in
   * what it sees (caught vs. uncaught counts).
   */
  private transitionToSuccess() {
    if (this.phase === 'success') return;
    this.phase = 'success';
    const score = this.computeScore();
    this.scoreBreakdown = {
      itemPoints:    score.itemPoints,
      timePenalty:   score.timePenalty,
      hintPenalty:   score.hintPenalty,
      missedCount:   score.missedCount,
      missedPenalty: score.missedPenalty,
      total:         score.total,
    };
    this.finalScore = score.total;
    this.totalHintClicks = score.hints;
    this.finalSeconds = score.seconds;
    // Cleanly hand the audio off in three steps so the fanfare reads:
    //   1. pause the dense game music so the channel is clear,
    //   2. play the one-shot fanfare loud and solo — bright if everything
    //      was caught, the descending "wah wah wah" if anything was missed,
    //   3. once it finishes, start the slower celebration loop.
    this.chiptune.pauseLoop();
    const failed = score.missedCount > 0;
    const handoffMs = failed
      ? (this.chiptune.failFanfare(), this.chiptune.failFanfareMs)
      : (this.chiptune.victoryFanfare(), this.chiptune.victoryFanfareMs);
    if (this.victoryHandoffTimer) clearTimeout(this.victoryHandoffTimer);
    this.victoryHandoffTimer = setTimeout(() => {
      if (!this.destroyed) this.chiptune.playVictoryLoop();
    }, handoffMs);
  }

  /** User-triggered early finish — applies the same success flow as a natural win. */
  finishEarly() {
    if (this.phase !== 'play') return;
    this.transitionToSuccess();
  }

  /** Heading shown on the success card — adapts to how many packages got away. */
  get successTitle(): string {
    const missed = this.scoreBreakdown.missedCount;
    if (missed === 0) return '🎉 Alle Pakete gerettet!';
    if (missed >= this.totalItems) return '📦 Alle Pakete entwischt!';
    return missed === 1
      ? '📦 1 Paket ist entwischt'
      : `📦 ${missed} Pakete sind entwischt`;
  }

  /**
   * Score breakdown:
   *   +15 per caught item
   *   −1 per elapsed second (rounded)
   *   −1 per hint click summed across all runners
   *   −15 per uncaught item (applies when the player finishes early)
   * Total can go negative — a bad run earns a deservedly bad number.
   */
  private computeScore() {
    const itemPoints    = this.caughtCount * 15;
    const seconds       = Math.round(this.elapsedMs / 1000);
    const timePenalty   = seconds;
    const hintPenalty   = this.runners.reduce((sum, r) => sum + r.hintClicks, 0);
    const missedCount   = Math.max(0, this.totalItems - this.caughtCount);
    const missedPenalty = missedCount * 15;
    const total = itemPoints - timePenalty - hintPenalty - missedPenalty;
    return {
      itemPoints, timePenalty, hintPenalty,
      missedCount, missedPenalty,
      total, seconds, hints: hintPenalty,
    };
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private render() {
    const ctx = this.ctx2d;
    if (!ctx) return;
    ctx.clearRect(0, 0, GAME_CONFIG.width, GAME_CONFIG.height);

    this.drawSky(ctx);
    this.drawStreet(ctx);
    // Depth-sort the van against runners: items in lanes further back (smaller
    // baseY) render behind the van; items in the front lane render on top of it.
    this.drawRunners(ctx, r => r.baseY < this.vanDepthY());
    this.drawVan(ctx);
    this.drawRunners(ctx, r => r.baseY >= this.vanDepthY());
    this.drawHintTooltip(ctx);
    this.drawHud(ctx);
  }

  /**
   * The depth line where the van "sits". Runners with baseY below this are
   * further away (behind the van), at or above are closer (in front).
   * Tracks the van's current bottom so the depth sort stays correct when
   * the player drives the van up/down the road.
   */
  private vanDepthY(): number {
    return this.vanTop() + this.vanHeight() - 12;
  }

  /**
   * Vertical bounds for the van's *bottom* (wheels), as fractions of canvas
   * height. Constrain to the paved area of street.png — anything above the
   * top ratio puts the van on the upper sidewalk, anything below the bottom
   * ratio puts it on the bottom curb. Tweak these here if the road artwork
   * is ever swapped out.
   */
  private readonly vanRoadTopRatio    = 0.61;
  private readonly vanRoadBottomRatio = 0.89;

  /**
   * Clamp the player's van offsets so the van never leaves the canvas and
   * never drives off the road. Horizontally the bounds are simply the canvas
   * edges; vertically the van's wheels are kept inside the paved strip of
   * the street artwork (see {@link vanRoadTopRatio}, {@link vanRoadBottomRatio}).
   */
  private clampVanOffsets() {
    const vw = this.vanWidth();
    const vh = this.vanHeight();
    // Horizontal: vanLeft in [0, canvas.width - vw].
    const minX = -GAME_CONFIG.vanLeftPad;
    const maxX = GAME_CONFIG.width - vw - GAME_CONFIG.vanLeftPad;
    this.vanOffsetX = Math.max(minX, Math.min(maxX, this.vanOffsetX));
    // Vertical: van *bottom* (wheels) constrained to the paved road area.
    const defaultTop = GAME_CONFIG.height - GAME_CONFIG.vanBottomPad - vh;
    const minBottom = GAME_CONFIG.height * this.vanRoadTopRatio;
    const maxBottom = GAME_CONFIG.height * this.vanRoadBottomRatio;
    const minOffsetY = (minBottom - vh) - defaultTop;
    const maxOffsetY = (maxBottom - vh) - defaultTop;
    this.vanOffsetY = Math.max(minOffsetY, Math.min(maxOffsetY, this.vanOffsetY));
  }

  private drawSky(ctx: CanvasRenderingContext2D) {
    // Backdrop matches the sky region of street.png — sampled on load. Used
    // as a fallback wherever the street image doesn't cover.
    ctx.fillStyle = this.skyColor;
    ctx.fillRect(0, 0, GAME_CONFIG.width, GAME_CONFIG.height);
  }

  private drawStreet(ctx: CanvasRenderingContext2D) {
    const img = this.streetImg;
    if (!img) {
      // Placeholder ground so the world doesn't look empty while loading.
      ctx.fillStyle = '#9aa0a6';
      ctx.fillRect(0, GAME_CONFIG.height - 160, GAME_CONFIG.width, 160);
      return;
    }
    // Stretch street.png to fill the full canvas height — its built-in sky
    // becomes the backdrop, so we never see a color mismatch above it.
    const aspect = img.naturalWidth / img.naturalHeight;
    const targetH = GAME_CONFIG.height;
    const targetW = targetH * aspect;

    const offset = ((this.scrollX % targetW) + targetW) % targetW;
    let x = -offset;
    while (x < GAME_CONFIG.width) {
      ctx.drawImage(img, x, 0, targetW, targetH);
      x += targetW;
    }
  }

  private vanWidth() {
    const img = this.vanImg;
    if (!img) return 220;
    return img.naturalWidth * GAME_CONFIG.vanScale;
  }
  private vanHeight() {
    const img = this.vanImg;
    if (!img) return 130;
    return img.naturalHeight * GAME_CONFIG.vanScale;
  }
  private vanLeft() { return GAME_CONFIG.vanLeftPad + this.vanOffsetX; }
  private vanTop()  {
    return GAME_CONFIG.height - GAME_CONFIG.vanBottomPad - this.vanHeight() + this.vanOffsetY;
  }

  private drawVan(ctx: CanvasRenderingContext2D) {
    const img = this.vanImg;
    // Idle "driving in place" wobble — gentle cruise on a smooth road. Slow
    // sine pair at unrelated frequencies so the motion never feels repetitive,
    // amplitudes kept small so the van just breathes rather than bounces.
    const bobY = Math.sin(this.frame * 0.18) * 1.4 + Math.sin(this.frame * 0.07) * 0.7;
    const bobX = Math.sin(this.frame * 0.11) * 0.6;
    const vw = this.vanWidth();
    const vh = this.vanHeight();
    // On the success screen the van accelerates off the right edge. ease-in
    // (cubic) makes it look like it's stepping on the gas after the delivery.
    const exitDistance = GAME_CONFIG.width - this.vanLeft() + vw + 20;
    const exitOffset = this.vanExitT > 0 ? easeInCubic(this.vanExitT) * exitDistance : 0;
    const vx = this.vanLeft() + bobX + exitOffset;
    const vy = this.vanTop() + bobY;

    if (img) ctx.drawImage(img, vx, vy, vw, vh);
    else {
      ctx.fillStyle = '#facc15';
      ctx.fillRect(vx, vy, vw, vh);
    }
  }

  private drawRunners(ctx: CanvasRenderingContext2D, filter: (r: Runner) => boolean) {
    // Sort by Y so closer (lower) items render on top — a tiny 2.5D feel.
    const order = this.runners.filter(filter).sort((a, b) => a.baseY - b.baseY);
    for (const r of order) {
      if (r.caught && (r.netT ?? 0) >= 1) continue;  // already in van
      // During intro, hide runners that haven't popped out yet.
      if (this.phase === 'intro' && this.elapsedMs < r.introDelayMs) continue;

      const bob = Math.sin(this.frame * 0.25 + r.phase) * GAME_CONFIG.productBobAmp;
      let drawX = r.x;
      let drawY = r.baseY + bob;

      if (r.caught && r.netT != null && r.netStart) {
        const t = easeOutCubic(r.netT);
        const targetX = this.vanLeft() + this.vanWidth() * 0.45;
        const targetY = this.vanTop() + this.vanHeight() * 0.45;
        drawX = r.netStart.x + (targetX - r.netStart.x) * t;
        drawY = r.netStart.y + (targetY - r.netStart.y) * t;
      }

      if (r.sprite) {
        r.sprite.draw(ctx, drawX, drawY, this.frame, r.phase, r.caught);
      } else {
        // Sprite still loading or failed: draw a placeholder so the
        // catch mechanic still works visually.
        this.drawPlaceholder(ctx, drawX, drawY, r.caught);
      }
    }
  }

  private drawPlaceholder(ctx: CanvasRenderingContext2D, x: number, y: number, faded: boolean) {
    ctx.save();
    if (faded) ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#e0e0e0';
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.fillRect(x - 24, y - 70, 48, 60);
    ctx.strokeRect(x - 24, y - 70, 48, 60);
    ctx.restore();
  }

  /**
   * Hint tooltip: shown above whichever runner the mouse is over. Letters are
   * progressively revealed by clicking — unrevealed positions render as
   * underscores so the player sees the name's length up front. Spaces are
   * preserved as gaps so multi-word names read sensibly.
   */
  private drawHintTooltip(ctx: CanvasRenderingContext2D) {
    const r = this.hoveredRunner;
    if (!r || r.caught || !r.sprite) return;
    // Hover-tooltip is opt-in: only shown after the player has spent at least
    // one click on this runner (which is also when the score penalty starts).
    if (r.hintClicks <= 0) return;

    const text = this.hintText(r);
    if (!text) return;

    ctx.save();
    ctx.font = 'bold 14px "Courier New", monospace';
    ctx.textBaseline = 'top';
    const padX = 8, padY = 4;
    const metrics = ctx.measureText(text);
    const w = Math.ceil(metrics.width) + padX * 2;
    const h = 22;

    const b = r.sprite.bounds;
    const legLength = Math.max(14, Math.round(b.h * 0.35));
    const topY = r.baseY - legLength - b.h - 10;
    let x = Math.round(r.x - w / 2);
    // Clamp so the tooltip never escapes the canvas horizontally.
    x = Math.max(8, Math.min(GAME_CONFIG.width - w - 8, x));
    const y = Math.max(8, topY - h);

    // Caret / arrow not drawn — keep it minimal at this canvas size.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + padX, y + padY);
    ctx.restore();
  }

  /**
   * Build the masked-name string. The first click "activates" the hover only
   * (revealed = 0), so:
   *   hintClicks = 1 → all underscores
   *   hintClicks = 2 → first letter visible, rest underscored
   *   hintClicks = name.length + 1 → fully revealed
   * Spaces are preserved as gaps so multi-word names read sensibly.
   */
  private hintText(r: Runner): string {
    const name = (r.item.name ?? '').trim();
    if (!name) return '';
    const revealed = Math.max(0, r.hintClicks - 1);
    if (revealed >= name.length) return name;
    const shown = name.substring(0, revealed);
    const hidden = [...name.substring(revealed)].map(c => (c === ' ' ? ' ' : '_')).join('');
    return shown + hidden;
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#ffffffcc';
    ctx.font = 'bold 20px "Courier New", monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(`Gefangen: ${this.caughtCount}/${this.totalItems}`, 16, 14);
    ctx.fillText(`Zeit: ${(this.elapsedMs / 1000).toFixed(1)}s`, 16, 40);
  }

  // ── Catch mechanic ───────────────────────────────────────────────────────

  private onBarcode(barcode: string) {
    if (this.phase !== 'play') {
      console.debug('[easter-egg] ignoring scan — phase is', this.phase);
      return;
    }
    const runner = this.barcodeIndex.get(barcode);
    if (!runner) {
      console.debug('[easter-egg] no runner matches barcode', barcode,
        '— known barcodes:', [...this.barcodeIndex.keys()]);
      return;
    }
    if (runner.caught) {
      console.debug('[easter-egg] runner already caught:', barcode);
      return;
    }
    console.debug('[easter-egg] caught runner:', barcode, runner.item.name);
    runner.caught = true;
    runner.netT = 0;
    runner.netStart = { x: runner.x, y: runner.baseY };
    this.caughtCount++;
    this.chiptune.catchBlip();
    // Music progression: stage is proportional to overall progress, so the
    // 6 stages always span the full run regardless of item count:
    //   stage = floor(caught * 6 / total) + 1, clamped to 1..6.
    // 6 items → 1 stage per catch; 12 items → 1 stage per 2 catches; etc.
    const total = Math.max(1, this.totalItems);
    const stage = Math.min(6, Math.max(1, Math.floor((this.caughtCount * 6) / total) + 1));
    this.chiptune.setStage(stage);
  }
}

/**
 * Pull all GTINs for an item out of the comma-separated raw list (products
 * with aliases) plus the primary barcode. Trims, dedupes, drops empties.
 */
function collectGtins(item: StickerItem): string[] {
  const set = new Set<string>();
  if (item.barcode) set.add(item.barcode.trim());
  if (item.barcodes) {
    for (const code of item.barcodes.split(',')) {
      const trimmed = code.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  return [...set];
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeInCubic(t: number): number {
  return t * t * t;
}

/** Read a pixel near the top of an image to use as the sky/background color. */
function sampleTopColor(img: HTMLImageElement): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const cx = c.getContext('2d');
    if (!cx) return null;
    cx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, 0, 0, 1, 1);
    // Re-draw a 1px slice from just the top strip to favor the sky region.
    cx.clearRect(0, 0, 1, 1);
    cx.drawImage(img, Math.floor(img.naturalWidth / 2), 4, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  } catch {
    return null;
  }
}
