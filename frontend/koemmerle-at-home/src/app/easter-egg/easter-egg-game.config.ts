export const GAME_CONFIG = {
  // Logical (pre-DPR) canvas resolution. The canvas element scales to fit
  // its container; the world coordinates stay constant.
  width: 960,
  height: 540,

  // Pixel-art scale factor applied to the offscreen product render.
  // Smaller = chunkier pixels. 48 keeps a clear chunky look while showing
  // enough detail to recognize most products.
  productPixelSize: 48,
  productDisplaySize: 96,

  // Van placement (in world coords).
  vanScale: 0.22,           // multiplier vs. raw deliveryvan.png height
  vanLeftPad: 36,           // px from left edge during gameplay
  vanBottomPad: 80,         // px from bottom edge (above the curb)

  // Street scrolling speed in px/sec (world units).
  scrollSpeed: 140,

  // Escaped product motion.
  productSpeed: 60,          // base px/sec
  productSpeedJitter: 40,    // random extra
  productBobAmp: 6,          // vertical bob amplitude in px

  // Intro timing.
  introMs: 2800,

  // Fishing net.
  netExtendMs: 200,
  netReelMs: 450,

  // Music defaults.
  musicEnabledDefault: true,
} as const;

export type GamePhase = 'intro' | 'play' | 'success';
