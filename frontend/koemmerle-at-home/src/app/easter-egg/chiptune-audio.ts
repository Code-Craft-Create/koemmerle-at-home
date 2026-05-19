/**
 * Layered chiptune-style background loop over a 32-step (two-bar) pattern
 * driving four voices, all synthesised from the Web Audio API — no samples:
 *
 *   • Bass   — square + sub-octave triangle, short punchy decay (mono feel)
 *   • Arp    — fake polyphonic "chord" via fast arpeggio through chord tones,
 *              sub-divided 4× per step for that classic NES shimmer
 *   • Lead   — square-wave melody with 16th-note rests, an octave above the arp
 *   • Drums  — kick (sine sweep), snare + hihat (filtered white noise)
 *
 * Chord progression is I–V–vi–IV in C major (one chord per half-bar). Lead
 * pattern is hand-crafted to follow the chord changes with passing tones.
 *
 * Designed to be started after a user gesture and stopped on game close.
 */
export type ChiptuneVoice = 'bass' | 'arp' | 'lead' | 'drums';

export class Chiptune {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  // Per-voice gain stages so each instrument can be muted independently.
  // SFX (catchBlip, victoryFanfare) bypass these and run straight to master.
  private buses: Record<ChiptuneVoice, GainNode | null> = {
    bass: null, arp: null, lead: null, drums: null,
  };
  private voiceMuted: Record<ChiptuneVoice, boolean> = {
    bass: false, arp: false, lead: false, drums: false,
  };
  private timer: number | null = null;
  private step = 0;
  private muted = false;
  private noiseBuffer: AudioBuffer | null = null;

  // ~136 BPM in 16th notes: 60_000 / (136 * 4) ≈ 110ms per step.
  private readonly normalStepMs = 110;
  /** ~185 BPM (16th = 80 ms) used from stage 5 onwards. */
  private readonly fastStepMs = 80;
  /** Slow finale tempo for the celebration loop — ~83 BPM (16th = 180 ms).
   *  Slower than anything used during play so the success scene reads as a
   *  wind-down, not a victory sprint. */
  private readonly victoryStepMs = 180;
  /** Current step rate — switched by setStage(). */
  private stepMs = 110;
  private readonly steps = 32;

  /**
   * Music progression stage (1..6). Set by the game whenever an item is
   * caught so the loop builds up across the run:
   *   1 = bass only
   *   2 = bass + drums
   *   3 = bass + drums + arp
   *   4 = full mix (bass + drums + arp + lead)
   *   5 = full mix, faster tempo
   *   6 = full mix, faster tempo, lead transposed up one octave
   */
  private stage = 1;

  // vi–IV–I–V progression (same notes as I–V–vi–IV but starting on minor) →
  // moody first chord, classic chiptune anthem feel. 8 steps per chord.
  // Each entry is [root, third, fifth, octave] in semitones from C.
  private readonly chords: ReadonlyArray<readonly number[]> = [
    [-3, 0,  4,  9],   // A minor (i in A-min view, vi in C-maj view)
    [-7,-3,  0,  5],   // F major
    [ 0, 4,  7, 12],   // C major
    [-5,-1,  2,  7],   // G major
  ];

  private readonly bassBase = 36;  // MIDI C2
  private readonly arpBase  = 60;  // MIDI C4
  // Lead lives a fifth below the previous C5 anchor — with the +7..+21 pattern
  // offsets that places the melody between C5 and D6 instead of the piercing
  // A5–A6 it previously occupied. Still safely above the arp's top (C5).
  private readonly leadBase = 65;  // MIDI F4

  // 32-step lead melody (semitones from leadBase, null = rest). Climbs through
  // the progression with the high point on the C chord and a tense descent on
  // the V (G) to set up the loop back to Am — gives the line a clear arc.
  private readonly leadPattern: ReadonlyArray<number | null> = [
    // Am: A5–C6–E6 around the chord
     9, null, 12,   16,    12,   9,   7,    9,
    // F: F6 / A5 / C6 — chord tones with a 16th lift
    17, null, 12,    9,    14,  12,   9,   12,
    // C: rising to the climax on G6
    12, null, 16,   19,    21,  19,  16,   12,
    // G: tense step-down with a leading-tone push back to A
    14, null, 11,    7,     9,  11,  14, null,
  ];

  // ── Victory loop ─────────────────────────────────────────────────────────
  // 16-step major-key fanfare looped after the player wins. Major progression
  // I–IV–V–I (4 steps per chord) with an ascending lead that resolves up high.
  private victoryMode = false;
  private readonly victoryChords: ReadonlyArray<readonly number[]> = [
    [ 0,  4,  7, 12],   // C
    [-7, -3,  0,  5],   // F
    [-5, -1,  2,  7],   // G
    [ 0,  4,  7, 12],   // C
  ];
  // 16 steps, 4 per chord. Ascending arpeggios per chord with a triumphant
  // octave peak on the final C.
  private readonly victoryLead: ReadonlyArray<number | null> = [
     0,  4,  7, 12,
     5,  9, 12, 14,
     7, 11, 14, 17,
    12, 16, 19, 12,
  ];

  start() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.12;
    this.master.connect(ctx.destination);
    // One gain stage per voice — each note connects through its bus.
    for (const v of ['bass', 'arp', 'lead', 'drums'] as ChiptuneVoice[]) {
      const g = ctx.createGain();
      g.gain.value = this.voiceMuted[v] ? 0 : 1;
      g.connect(this.master);
      this.buses[v] = g;
    }
    this.step = 0;
    this.timer = window.setInterval(() => this.tick(), this.stepMs);
  }

  stop() {
    if (this.timer != null) { clearInterval(this.timer); this.timer = null; }
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
      this.master = null;
      this.buses = { bass: null, arp: null, lead: null, drums: null };
      this.noiseBuffer = null;
    }
  }

  /** Toggle one voice on/off. State persists across stop/start. */
  setVoiceMuted(voice: ChiptuneVoice, muted: boolean) {
    this.voiceMuted[voice] = muted;
    const bus = this.buses[voice];
    if (bus && this.ctx) {
      bus.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
    }
  }

  isVoiceMuted(voice: ChiptuneVoice): boolean { return this.voiceMuted[voice]; }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.14, this.ctx.currentTime, 0.02);
    }
  }

  /** Trigger a short "got it!" arpeggio when an item is caught. */
  catchBlip() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12].forEach((semi, i) =>
      this.tone('square', this.leadBase + 12 + semi, t + i * 0.045, 0.08, 0.2));
  }

  /**
   * Triumphant little fanfare on success. Plays solo (the game pauses the
   * main loop just before triggering this), so peaks are pushed high and
   * notes ring a bit longer than a chord blip would.
   */
  victoryFanfare() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    [0, 4, 7, 12, 7, 12, 16, 19].forEach((semi, i) =>
      this.tone('square', this.leadBase + semi, t + i * 0.13, 0.22, 0.45));
  }

  /** Approximate total duration in ms of the fanfare — used by callers to
   * schedule what plays next. 8 notes × 0.13 s + tail ≈ 1.1 s. */
  readonly victoryFanfareMs = 1150;

  /**
   * "Wah wah wah" fail fanfare — three descending heavy notes for runs that
   * end with packages still missing. Each beat stacks a sawtooth lead with
   * a sub-octave triangle so it lands as a thudding "baam" rather than the
   * bright sparkle of the victory fanfare.
   */
  failFanfare() {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    // High → mid → low, descending major sixth → minor seventh shape.
    const semis = [12, 5, -3];
    semis.forEach((semi, i) => {
      const when = t + i * 0.30;
      const midi = this.leadBase + semi;
      this.tone('sawtooth', midi,      when, 0.32, 0.32);
      this.tone('triangle', midi - 12, when, 0.36, 0.28);
    });
  }

  /** 3 notes × 0.30 s spacing + ~0.36 s tail on the last note ≈ 1.25 s. */
  readonly failFanfareMs = 1250;

  /**
   * Pause the main music loop without tearing down the AudioContext. Used to
   * make room for the one-shot victoryFanfare to land cleanly before the
   * celebration loop kicks in.
   */
  pauseLoop() {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Switch the running loop into "victory" mode — a major-key fanfare that
   * loops over a 16-step bar. Sets the tempo to {@link victoryStepMs} (slower
   * than anything used during play) and (re)starts the interval if needed —
   * the loop may have been paused via {@link pauseLoop} between the fanfare
   * and this call.
   */
  playVictoryLoop() {
    if (!this.ctx) return;
    this.victoryMode = true;
    this.step = 0;
    this.stepMs = this.victoryStepMs;
    if (this.timer != null) clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), this.stepMs);
  }

  /**
   * Set the music progression stage (1..6). Voice gating happens inside
   * tick() via isStageVoiceActive(); tempo changes are applied here by
   * recreating the interval if needed. Calling with the current stage is
   * a no-op so this can be invoked liberally from the game side.
   */
  setStage(stage: number) {
    const clamped = Math.max(1, Math.min(6, stage | 0));
    if (clamped === this.stage) return;
    this.stage = clamped;
    const desired = clamped >= 5 ? this.fastStepMs : this.normalStepMs;
    if (desired !== this.stepMs) {
      this.stepMs = desired;
      if (this.timer != null) {
        clearInterval(this.timer);
        this.timer = window.setInterval(() => this.tick(), this.stepMs);
      }
    }
  }

  /** Whether a given voice should sound at the current stage. */
  private isStageVoiceActive(voice: ChiptuneVoice): boolean {
    switch (this.stage) {
      case 1: return voice === 'bass';
      case 2: return voice === 'bass' || voice === 'drums';
      case 3: return voice !== 'lead';
      default: return true;  // stages 4, 5, 6 — full mix (tempo/lead vary)
    }
  }

  /** Octave shift applied to the lead in stage 6 ("more high pitched"). */
  private get leadStageShift(): number {
    return this.stage === 6 ? 12 : 0;
  }

  // ── Sequencer ──

  private tick() {
    if (!this.ctx || !this.master) return;
    if (this.victoryMode) { this.victoryTick(); return; }
    const now = this.ctx.currentTime;
    const s = this.step % this.steps;
    const chord = this.chords[Math.floor(s / 8) % this.chords.length];
    const localStep = s % 8;

    // Bass — driving 8th-note pattern (every other 16th). Root on the beat,
    // octave-up on beat 2 of each half-bar, fifth pickup right before the
    // chord change. Far more momentum than the old half-note pattern.
    if (this.isStageVoiceActive('bass') && s % 2 === 0) {
      const beat = (localStep / 2) | 0;       // 0..3 within the chord segment
      let note = chord[0];                    // root
      if (beat === 1) note = chord[0] + 12;   // octave bump on beat 2
      else if (beat === 3 && localStep === 6) note = chord[2];  // fifth pickup
      this.bass(this.bassBase + note, now);
    }

    // Arp — fake polyphonic chord with body + bite.
    //   Body: long triangle note (5× sub-step), so 4+ chord tones overlap
    //         continuously and read as a held chord.
    //   Bite: a short square transient on each note's onset, sharp envelope.
    //         Adds the rhythmic "edge" that triangle alone is too soft for —
    //         you can feel the chord move without it sounding clicky.
    if (this.isStageVoiceActive('arp')) {
      const subDur = (this.stepMs / 1000) / 4;
      const noteDur = subDur * 5;
      for (let sub = 0; sub < 4; sub++) {
        const subTime = now + sub * subDur;
        const note = chord[(s * 4 + sub) % chord.length];
        const bodyPeak  = sub === 0 ? 0.18 : 0.13;
        const transient = sub === 0 ? 0.07 : 0.05;
        this.tone('triangle', this.arpBase + note, subTime, noteDur,    bodyPeak,  this.buses.arp, 0.015);
        this.tone('square',   this.arpBase + note, subTime, subDur * 1.6, transient, this.buses.arp, 0.004);
      }
    }

    // Lead — two slightly detuned squares stack into a fatter, more aggressive
    // tone (chiptune "chorus" trick). Longer envelope so notes ring through.
    // Boosted compared to the other voices because the high register tends
    // to get masked by the busy arp + bass beneath it. Stage 6 lifts the
    // entire melody one octave so the climax feels brighter.
    if (this.isStageVoiceActive('lead')) {
      const leadOffset = this.leadPattern[s];
      if (leadOffset != null) {
        const lead = this.leadBase + this.leadStageShift + leadOffset;
        this.tone('square', lead,        now, 0.20, 0.15, this.buses.lead);
        this.tone('square', lead + 0.07, now, 0.20, 0.12, this.buses.lead);
      }
    }

    // Drums — busier groove:
    //   kick on every beat
    //   snare on backbeats + a ghost on the "and" of beat 4 (chord change push)
    //   hihat on every 8th, open accent on the "and" of beat 2
    if (this.isStageVoiceActive('drums')) {
      if (s % 4 === 0) this.kick(now);
      if (s % 8 === 4) this.snare(now);
      if (s % 8 === 7) this.snare(now, /* ghost */ true);
      if (s % 2 === 0) this.hihat(now, s % 8 === 6);
    }

    this.step++;
  }

  /**
   * Victory loop tick — 16-step major-key fanfare, simpler than the main loop:
   *   • bass on beats 1 and 3 with octave-up bumps for sparkle
   *   • arp keeps the same overlap shimmer as the main loop (it sounds happy
   *     enough on a major progression without re-tuning)
   *   • lead plays the ascending fanfare melody
   *   • drums: kick on every beat, snare on every off-beat (busy "yay!" feel),
   *     open hihat on the last beat of the bar to mark the loop
   */
  private victoryTick() {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const steps = 16;
    const s = this.step % steps;
    const chord = this.victoryChords[Math.floor(s / 4) % this.victoryChords.length];
    const beat = s % 4;

    if (beat === 0) this.bass(this.bassBase + chord[0],      now);
    if (beat === 2) this.bass(this.bassBase + chord[0] + 12, now);

    // Arp — half-beat rhythm (one note every two 16th-note steps = 8th notes).
    // Cycles through the chord tones across the bar with long sustain so the
    // notes blend into a relaxed, ringing chord pad instead of the busy
    // shimmer used in the game loop.
    if (s % 2 === 0) {
      const stepSec = this.stepMs / 1000;
      const idx = ((s / 2) | 0) % chord.length;
      const note = chord[idx];
      this.tone('triangle', this.arpBase + note,      now, stepSec * 3.5, 0.16, this.buses.arp, 0.025);
      this.tone('square',   this.arpBase + note + 12, now, stepSec * 0.9, 0.04, this.buses.arp, 0.008);
    }

    const leadOffset = this.victoryLead[s];
    if (leadOffset != null) {
      this.tone('square', this.leadBase + leadOffset,        now, 0.20, 0.18, this.buses.lead);
      this.tone('square', this.leadBase + leadOffset + 0.07, now, 0.20, 0.14, this.buses.lead);
    }

    if (beat === 0 || beat === 2) this.kick(now);
    if (beat === 1 || beat === 3) this.snare(now);
    this.hihat(now, beat === 3);

    this.step++;
  }

  // ── Voices ──

  /**
   * One-shot envelope tone. Exponential attack/decay so notes never click.
   * Frequency from MIDI via the standard formula. `dest` selects which voice
   * bus the tone is routed through (so the debug menu can mute it). `attack`
   * defaults to 8 ms for a snappy chiptune feel — callers like the arp can
   * pass a longer attack to soften the leading edge of overlapping notes.
   */
  private tone(
    type: OscillatorType,
    midi: number,
    when: number,
    dur: number,
    peak: number,
    dest?: GainNode | null,
    attack = 0.008,
  ) {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(env);
    env.connect(dest ?? this.master);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  /**
   * Punchy bass stacked across three octaves:
   *   • triangle one octave below — sub-thump felt on real speakers
   *   • square at written pitch    — body
   *   • square one octave above    — cuts through laptop / phone speakers
   *     that can't reproduce the sub. This layer is what makes the bass
   *     actually audible on small playback.
   */
  private bass(midi: number, when: number) {
    this.tone('triangle', midi - 12, when, 0.22, 0.44, this.buses.bass);
    this.tone('square',   midi,      when, 0.18, 0.44, this.buses.bass);
    this.tone('square',   midi + 12, when, 0.14, 0.28, this.buses.bass);
  }

  // ── Drums ──

  /** Lazy-allocated 0.5s mono white-noise buffer reused by snare + hihat. */
  private ensureNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.noiseBuffer) return this.noiseBuffer;
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 0.5);
    const buf = this.ctx.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return buf;
  }

  /**
   * Kick: pitched sine sweep (160 → 40 Hz) for the body, plus a very short
   * high-pass noise burst on top that gives the attack its "click". Without
   * the click the kick reads as a soft thump and gets buried under the bass.
   */
  private kick(when: number) {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const dest = this.buses.drums ?? this.master;

    // ── Body: sine sweep ──
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, when);
    osc.frequency.exponentialRampToValueAtTime(40, when + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(0.7, when + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.14);
    osc.connect(env); env.connect(dest);
    osc.start(when);
    osc.stop(when + 0.16);

    // ── Click: very short HP noise burst on the attack ──
    const buf = this.ensureNoiseBuffer();
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const clickEnv = ctx.createGain();
    clickEnv.gain.setValueAtTime(0.0001, when);
    clickEnv.gain.exponentialRampToValueAtTime(0.22, when + 0.001);
    clickEnv.gain.exponentialRampToValueAtTime(0.0001, when + 0.025);
    src.connect(hp); hp.connect(clickEnv); clickEnv.connect(dest);
    src.start(when);
    src.stop(when + 0.04);
  }

  /**
   * Layered snare: filtered noise (sizzle) + pitched triangle sweep (body).
   * The previous noise-only snare came out as "soft brush stick" because the
   * 1200 Hz highpass removed everything below the sizzle range. The pitched
   * sweep (220→100 Hz triangle) adds the drum-shell thwack a real snare has,
   * while the noise layer keeps the snare-wire fizz on top.
   *
   * `ghost` produces a quieter, shorter, noise-only variant used as a fill
   * before chord changes.
   */
  private snare(when: number, ghost = false) {
    if (!this.ctx || !this.master) return;
    const buf = this.ensureNoiseBuffer();
    if (!buf) return;
    const ctx = this.ctx;
    const dest = this.buses.drums ?? this.master;

    // ── Sizzle layer (filtered white noise) ──
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    // Drop the corner a bit so mid content survives — gives the noise body.
    hp.frequency.value = ghost ? 1200 : 600;
    const noiseEnv = ctx.createGain();
    const noisePeak = ghost ? 0.12 : 0.42;
    const noiseDur  = ghost ? 0.06 : 0.14;
    noiseEnv.gain.setValueAtTime(0.0001, when);
    noiseEnv.gain.exponentialRampToValueAtTime(noisePeak, when + 0.002);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, when + noiseDur);
    src.connect(hp); hp.connect(noiseEnv); noiseEnv.connect(dest);
    src.start(when);
    src.stop(when + noiseDur + 0.03);

    // ── Pitched body layer (skip for ghost notes, which want to stay
    // soft / pure-noise to read as filler rather than a beat) ──
    if (!ghost) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(220, when);
      osc.frequency.exponentialRampToValueAtTime(95, when + 0.09);
      const bodyEnv = ctx.createGain();
      bodyEnv.gain.setValueAtTime(0.0001, when);
      bodyEnv.gain.exponentialRampToValueAtTime(0.34, when + 0.003);
      bodyEnv.gain.exponentialRampToValueAtTime(0.0001, when + 0.10);
      osc.connect(bodyEnv); bodyEnv.connect(dest);
      osc.start(when);
      osc.stop(when + 0.12);
    }
  }

  /** Very-high-pass noise tick. `open` lengthens the envelope for an off-beat accent. */
  private hihat(when: number, open: boolean) {
    if (!this.ctx || !this.master) return;
    const buf = this.ensureNoiseBuffer();
    if (!buf) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const env = ctx.createGain();
    const dur = open ? 0.09 : 0.03;
    const peak = open ? 0.10 : 0.07;
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + 0.001);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(hp);
    hp.connect(env);
    env.connect(this.buses.drums ?? this.master);
    src.start(when);
    src.stop(when + dur + 0.02);
  }
}
