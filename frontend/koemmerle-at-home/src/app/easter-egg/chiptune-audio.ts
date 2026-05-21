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
  private readonly leadBase = 53;  // MIDI F4

  /**
   * Lead-melody variations, all 32 steps long and pitched in A minor over the
   * existing Am–F–C–G progression (8 steps per chord). Offsets are semitones
   * from {@link leadBase}; `null` is a rest. The active variation is selected
   * at runtime via {@link setLeadVariation}.
   *
   * Each entry tries to *be a motif* — recognisable rhythmic shape, mix of
   * short and long notes, real use of register (sometimes the line dips low,
   * sometimes it leaps high). Variation 1 is the original line the loop
   * shipped with; the rest are written-by-hand hooks. Test them in-game with
   * the combobox in the audio debug panel and we'll promote the keepers.
   */
  private readonly leadVariations: ReadonlyArray<ReadonlyArray<number | null>> = [
    // 1 — original climbing arc (kept as reference)
    [  9, null, 12,  16,    12,   9,   7,    9,
      17, null, 12,   9,    14,  12,   9,   12,
      12, null, 16,  19,    21,  19,  16,   12,
      14, null, 11,   7,     9,  11,  14, null ],

    // 2 — "Falling sigh": a long held high note that gives way to a slow
    //     descending lament. Stark register drop, repeats with each chord.
    [ 28, null, null, null,   23, null, 19, null,
      24, null, null, null,   19, null, 17, null,
      26, null, null, null,   19, null, 14, null,
      26, null, null, null,   18, null, 14, null ],

    // 3 — "Hopping bunny": tight off-beat hop, then a sudden octave leap,
    //     then space. Bouncy and memorable.
    [  4, 11, null, 23,   11, null,  4, null,
       0,  7, null, 24,    7, null,  0, null,
       7, 11, null, 26,   11, null,  7, null,
       2,  9, null, 26,    9, null,  2, null ],

    // 4 — Anthem: bold held opening, then a quick stepwise run-down to land
    //     on the resolution. Mix of one whole-note + four 16ths.
    [ 16, null, null, null,   14, 12, 11, null,
      17, null, null, null,   16, 14, 12, null,
      19, null, null, null,   16, 14, 12, null,
      18, null, null, null,   14, 12,  9, null ],

    // 5 — "Tetris sigh": classic descending three-note sigh, twice per chord
    //     with the second pass leaping up before falling.
    [ 23, 19, 11, null,   23, 19, 11, null,
      19, 16, 12, null,   24, 19, 12, null,
      23, 19, 14, null,   26, 23, 19, null,
      21, 18, 14, null,   26, 21, 14, null ],

    // 6 — "Mario short-short-long": two pickups into a long landing, twice
    //     with the second landing leaping an octave up.
    [ 11, 11, 16, null,   11, 11, 23, null,
      12, 12, 17, null,   12, 12, 24, null,
      14, 14, 19, null,   14, 14, 26, null,
      14, 14, 18, null,   14, 14, 26, null ],

    // 7 — "Star Wars opening leap": two repeated low chord tones, then a
    //     huge octave-plus leap to a held high note. Big, dramatic.
    [  4, null,  4, null,   16, null, null, null,
       0, null,  0, null,   17, null, null, null,
       7, null,  7, null,   19, null, null, null,
       2, null,  2, null,   18, null, null, null ],

    // 8 — "Imperial dotted": long-short-short marching rhythm, each beat
    //     resolving a step lower than the last.
    [ 16, null, null, 14,   12, null, null, 11,
      17, null, null, 16,   14, null, null, 12,
      19, null, null, 16,   14, null, null, 12,
      18, null, null, 14,   11, null, null,  6 ],

    // 9 — Punchy riff: stab on the down, rest, stab again, walk to top.
    [ 11, null, 16, 11,   23, null, 16, 11,
      12, null, 17, 12,   24, null, 17, 12,
      14, null, 19, 14,   26, null, 19, 14,
      14, null, 18, 14,   26, null, 18, 14 ],

    // 10 — Aggressive descent: stepwise drop with rest spaces between, like
    //      a chromatic-feel chase line.
    [ 16, null, 14, null,   12, null, 11, null,
      17, null, 14, null,   12, null,  9, null,
      19, null, 16, null,   14, null, 11, null,
      18, null, 14, null,   11, null,  9, null ],

    // 11 — Sneak-then-pounce: three soft low notes, then a sudden high
    //      surprise on the last 16th. Lots of dynamic range.
    [  4, null,  7, null,   11, null, null, 23,
       0, null,  4, null,    7, null, null, 24,
       7, null, 11, null,   14, null, null, 26,
       2, null,  6, null,    9, null, null, 26 ],

    // 12 — Pop chorus hook: high note, hold, then a chord-tone run down
    //      with rests carving the rhythm.
    [ 23, null, null, 16,   14, 12, 11, null,
      24, null, null, 17,   16, 14, 12, null,
      26, null, null, 19,   16, 14, 12, null,
      26, null, null, 18,   14, 11,  9, null ],

    // 13 — Pickup-and-land: 2 short pickups on the last beat of the bar
    //      lead into a held high downbeat. Strong forward motion.
    [ null, null, 11, 14,   23, null, null, null,
      null, null, 12, 17,   24, null, null, null,
      null, null, 14, 19,   26, null, null, null,
      null, null,  9, 14,   26, null, null, null ],

    // 14 — Stair-step climb with rests: 3 ascending notes evenly spaced,
    //      each chord climbing higher than the last.
    [  4, null, 11, null,   16, null, 23, null,
       0, null,  7, null,   12, null, 24, null,
       7, null, 11, null,   19, null, 26, null,
       2, null,  9, null,   18, null, 26, null ],

    // 15 — Sparse hum: two memorable notes per bar with empty space — the
    //      sort of line you'd find yourself whistling.
    [ 16, null, 23, null,   16, null, null, null,
      17, null, 24, null,   17, null, null, null,
      26, null, 23, null,   19, null, null, null,
      18, null, 26, null,   14, null, null, null ],

    // 16 — Triumphant walk-up: clear ascending phrase per chord, each
    //      landing on a higher target note. Stadium-anthem feel.
    [ 11, null, 14, null,   16, null, null, null,
      12, null, 16, null,   19, null, null, null,
      14, null, 19, null,   23, null, null, null,
      14, null, 21, null,   26, null, null, null ],

    // 17 (displayed as #100) — "The Yellow Van Ballad". A proper hook:
    // a repeating "la-la-LONG" motif over Am and F, lifted into a soaring
    // climax on C (reaching A6, the highest note in the set), then a
    // tumbling descent over G that runs straight back into the loop's
    // downbeat. Mix of 16th-note pickups, held landings, and rests so the
    // line breathes. This is the one that should sound like an actual tune.
    [ 11, 14, 16, null,    14, 16, 23, null,
      12, 14, 17, null,    14, 17, 24, null,
      14, 16, 19, null,    19, 23, 28, null,
      21, 18, 14, 11,       9, null, null, null ],

    // 18 (displayed as #101) — "Klaxon Klimb". A single quick two-note tag
    // at the top of bars 1-3 (a chord tone followed by its octave-and-fifth
    // a beat later) is just enough to flag the bar; the rest of the line is
    // simple stepwise scale motion. Bars 1-3 each begin with that one tag
    // then walk through the A-minor scale (descending in bar 1, ascending
    // through bars 2-3 to peak on C7); bar 4 drops the tag entirely and is
    // pure stepwise tumble all the way down to low A — strong identity
    // break right before the loop point.
    [ 16, 23, null, null,    19, 16, 14, 11,
      17, 24, null, null,    14, 16, 19, 21,
      19, 26, null, null,    23, 26, 28, 31,
      26, 21, 18, 14,        11,  9,  6,    4 ],

    // 19 (displayed as #102) — "Skippy". A compact, cartoon-like skipping
    // motif. Every bar uses the same "hop-hop-REST-LONG" rhythm so it feels
    // like a little character bouncing along — bars 1-3 only swap the
    // landing note to match each chord, bar 4 then breaks the pattern with a
    // tumble of quick repeats and a long held B (the leading tone over G)
    // for a comic "ta-da!" ending. Stays within a single octave (E5-C6 plus
    // one B5/D5) — deliberately no register fireworks, just play.
    [ 11, 14, null, 16,    14, 11, null, 14,
      12, 14, null, 17,    14, 12, null, 14,
      14, 16, null, 19,    16, 14, 16, null,
      11, 14, 11, 14,      18, 14, 11, null ],

    // 20 (displayed as #200) — "Egg Hop Hook". A bright answer to #1:
    // same singable arc, but cleaner chord tones and a tiny pause after
    // every hop so the hook has room to stick. The last bar walks down the
    // G chord, then winks back up into the loop.
    [ 16, null, 19, 23,    19, 16, 14, null,
      12, null, 16, 19,    16, 12, 14, null,
      19, null, 23, 26,    23, 19, 16, null,
      21, 18, 14, 11,      14, null, 16, null ],

    // 21 (displayed as #201) — "Rubber Duck". A deliberately goofy
    // call-and-squawk rhythm: three little notes, one held chirp, repeat.
    // It stays friendly and round, mostly avoiding the top octave fireworks.
    [ 16, 19, 16, null,    23, null, 19, 16,
      12, 16, 12, null,    24, null, 19, 16,
      19, 23, 19, null,    26, null, 23, 19,
      14, 18, 21, null,    18, 14, 11, null ],

    // 22 (displayed as #202) — "Candy Steps". A sugar-rush scale climb:
    // low-to-high motion over the first three chords, then a neat little
    // staircase down on G. Less anthem, more arcade bonus room.
    [  4,  7,  9, 11,      14, null, 16, null,
      12, 14, 16, 19,      21, null, 19, null,
      19, 21, 23, 26,      28, null, 26, null,
      26, 24, 21, 18,      14, 11,  9, null ],

    // 23 (displayed as #203) — "Calliope Wink". High-low call response,
    // almost like a tiny circus organ: every bar starts with a shiny bell,
    // then answers with a compact falling tag.
    [ 23, null, 16, null,    19, 16, 11, null,
      24, null, 16, null,    19, 16, 12, null,
      26, null, 19, null,    23, 19, 14, null,
      26, null, 18, null,    21, 18, 14, null ],

    // 24 (displayed as #204) — "Pocket Carnival". Triads as a chant:
    // short, stacked, and rhythmically obvious. It is busier than #200 but
    // should still read as one hummable phrase, not noodling.
    [ 11, 16, 19, null,    16, 19, 23, null,
      12, 16, 19, null,    16, 19, 24, null,
      14, 19, 23, null,    19, 23, 26, null,
      14, 18, 21, null,    18, 21, 26, null ],

    // 25 (displayed as #205) — "Bubble Bounce". A playful neighbor-note
    // loop: bounce, bounce, tumble. The repeated turns make it sticky while
    // the fourth bar gives it a little slapstick landing.
    [ 16, 14, 16, null,    19, 16, 14, 11,
      12, 14, 16, null,    19, 16, 14, 12,
      19, 16, 19, null,    23, 19, 16, 14,
      21, 18, 21, null,    26, 21, 18, 14 ],

    // 26 (displayed as #206) — "Wink and Sprint". Starts low and sneaky,
    // flashes high at the end of each half-bar, then sprints down into the
    // loop point. Good candidate if the lead should feel like a character.
    [  4, null,  7, 11,    16, null, 23, null,
       0, null,  4,  7,    12, null, 24, null,
       7, null, 11, 14,    19, null, 26, 28,
      21, 18, 14, 11,       9, 11, 14, null ],

    // 27 (displayed as #207) — "Confetti Ladder". Big upward ladders with
    // tidy rests after each peak. The final bar refuses to fully resolve,
    // giving the restart a little extra pull.
    [ 11, 14, 16, 19,      16, null, 14, null,
      12, 16, 19, 24,      19, null, 16, null,
      14, 16, 19, 23,      26, null, 23, null,
      21, 18, 16, 14,      18, null, 21, null ],
  ];

  /**
   * Optional display labels. Any index missing here renders as `#${idx + 1}`.
   * Indices 16..18 and 19..26 are shown as #100..#102 and #200..#207 for
   * curated melody batches.
   */
  private readonly leadVariationLabels: Record<number, string> = {
    16: '#100',
    17: '#101',
    18: '#102',
    19: '#200',
    20: '#201',
    21: '#202',
    22: '#203',
    23: '#204',
    24: '#205',
    25: '#206',
    26: '#207',
  };

  /** Label for a variation index, used by the debug combobox + status line. */
  getLeadVariationLabel(idx: number): string {
    return this.leadVariationLabels[idx] ?? `#${idx + 1}`;
  }

  /** Index into {@link leadVariations}; 0 is the original line. */
  private leadVariationIdx = 0;
  /** Number of available variations — exposed for the UI combobox. */
  get leadVariationCount(): number { return this.leadVariations.length; }

  /**
   * 0-based indices of the player-curated favourite variations to cycle
   * through when {@link leadAutoRotate} is on. Current rotation favours the
   * new #200 batch plus #102 as the previous best compact hook.
   * Edit this array to add/remove favourites — labels come from the combobox.
   */
  private readonly favoriteLeadIndices = [24];
  /** Full 32-step passes played before the auto-rotate picks a new favourite. */
  private readonly passesPerVariation = 4;
  /** Auto-rotate state — on by default; a manual setLeadVariation() turns it off. */
  private leadAutoRotate = true;
  private leadPassesPlayed = 0;
  /** Active lead pattern — recomputed via getter so changes take effect immediately. */
  private get leadPattern(): ReadonlyArray<number | null> {
    return this.leadVariations[this.leadVariationIdx];
  }

  /**
   * Extra upper lead for #205 / index 24 only. It plays a quieter square-wave
   * harmony above the selected "Bubble Bounce" motif, mostly on chord tones,
   * with a tiny delay so it reads as a second chip voice instead of a louder
   * single note.
   */
  private readonly bubbleBounceSecondLead: ReadonlyArray<number | null> = [
    23, null, 19, 23,    23, null, 19, null,
    19, null, 16, 19,    24, null, 19, null,
    26, null, 23, 26,    26, null, 23, null,
    26, null, 21, 26,    30, null, 26, null,
  ];

  private get secondLeadPattern(): ReadonlyArray<number | null> | null {
    return this.leadVariationIdx === 24 ? this.bubbleBounceSecondLead : null;
  }

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
    this.leadPassesPlayed = 0;
    // Start with a random favourite when in auto mode so each run feels fresh.
    if (this.leadAutoRotate) this.pickRandomFavoriteLead();
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

  /**
   * Switch to a specific lead-melody variation (0-based index). Disables
   * auto-rotate — the player explicitly picked something, so we shouldn't
   * surprise them by changing it.
   */
  setLeadVariation(idx: number) {
    const clamped = Math.max(0, Math.min(this.leadVariations.length - 1, idx | 0));
    this.leadAutoRotate = false;
    this.leadPassesPlayed = 0;
    this.leadVariationIdx = clamped;
  }

  /**
   * Enable / disable auto-rotation through {@link favoriteLeadIndices}. Each
   * pass through the 32-step lead pattern counts as one "pass"; after
   * {@link passesPerVariation} passes the loop randomises to a different
   * favourite.
   */
  setLeadAutoRotate(enabled: boolean) {
    if (enabled === this.leadAutoRotate) return;
    this.leadAutoRotate = enabled;
    this.leadPassesPlayed = 0;
    if (enabled) this.pickRandomFavoriteLead();
  }

  /** True when the loop is auto-rotating through the favourites list. */
  get isLeadAutoRotate(): boolean { return this.leadAutoRotate; }

  /** Current playing variation (0-based). */
  get currentLeadVariation(): number { return this.leadVariationIdx; }

  /** Pick a random favourite that isn't the one currently playing. */
  private pickRandomFavoriteLead() {
    const others = this.favoriteLeadIndices.filter(i => i !== this.leadVariationIdx);
    const pool = others.length > 0 ? others : this.favoriteLeadIndices;
    this.leadVariationIdx = pool[Math.floor(Math.random() * pool.length)];
  }

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

      const secondLeadOffset = this.secondLeadPattern?.[s];
      if (secondLeadOffset != null) {
        const secondLead = this.leadBase + this.leadStageShift + secondLeadOffset;
        this.tone('square', secondLead + 0.04, now + 0.006, 0.16, 0.065, this.buses.lead);
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
    // After every full 32-step pass, count it; once we've played the
    // configured number of passes on the current variation, switch to a
    // random other favourite. Only happens in auto-rotate mode.
    if (this.leadAutoRotate && this.step % this.steps === 0) {
      this.leadPassesPlayed++;
      if (this.leadPassesPlayed >= this.passesPerVariation) {
        this.leadPassesPlayed = 0;
        this.pickRandomFavoriteLead();
      }
    }
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
