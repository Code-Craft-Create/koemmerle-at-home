import { GAME_CONFIG } from './easter-egg-game.config';

/**
 * A pre-rendered, pixelated product sprite with detected non-background bounds.
 * The sprite is drawn via {@link ProductSprite.draw}, which composites the
 * pixelated product, googly eyes, and animated legs into a destination canvas.
 *
 * The class deliberately keeps draw() side-effect free w.r.t. the input ctx
 * other than the pixel writes — no global ctx state changes leak out.
 */
export class ProductSprite {
  readonly width: number;
  readonly height: number;
  /** Tight bounds of the visible product within the pixelated canvas (canvas-space px). */
  readonly bounds: { x: number; y: number; w: number; h: number };

  constructor(
    private readonly pixelCanvas: HTMLCanvasElement,
    bounds: { x: number; y: number; w: number; h: number },
  ) {
    this.width = pixelCanvas.width;
    this.height = pixelCanvas.height;
    this.bounds = bounds;
  }

  /**
   * Draw the character at world position (x, y) — interpreted as the *bottom-center*
   * of the feet (so y is essentially the ground line). The body floats above this point.
   *
   * `frame` is an integer frame counter used to animate eyes and legs.
   * `phase` is a per-runner offset (0..2π) so different runners are out of sync.
   */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, frame: number, phase = 0, faded = false) {
    const b = this.bounds;
    // Total visible character height = product visible height + leg length.
    const legLength = Math.max(14, Math.round(b.h * 0.35));
    const productDrawX = Math.round(x - b.w / 2 - b.x);
    const productDrawY = Math.round(y - legLength - b.h - b.y);

    ctx.save();
    if (faded) ctx.globalAlpha = 0.35;

    // 1) Pixelated product itself.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.pixelCanvas, productDrawX, productDrawY);

    // Anchor for decorations: center of the visible bounds (in world space).
    const productCenterX = productDrawX + b.x + b.w / 2;
    const productTopY = productDrawY + b.y;
    const productBottomY = productTopY + b.h;

    // 2) Googly eyes — slightly overlapping the top edge. Phase offsets the
    // pupil wiggle so different runners glance around independently.
    drawEyes(ctx, productCenterX, productTopY, b.w, frame, phase);

    // 3) Long line-art legs with feet, anchored at the bottom-center.
    drawLegs(ctx, productCenterX, productBottomY, legLength, frame, phase);

    ctx.restore();
  }
}

/**
 * Tunable parameters for the white-background flood-fill mask. Defaults are
 * what the game ships with; the debug panel lets the user override them
 * live to test alternative values.
 */
export interface MaskOptions {
  /** Min per-channel brightness to count as "white-ish" (0–255). */
  brightness?: number;
  /** Max max(R,G,B) − min(R,G,B) to count as neutral (0–255). */
  chroma?: number;
}

export const DEFAULT_MASK: Required<MaskOptions> = { brightness: 242, chroma: 20 };

/**
 * Build a {@link ProductSprite} from an image source URL. The pipeline:
 *   1. Load the image (with crossOrigin attempt for remote URLs).
 *   2. Render at a high "source" resolution (512 px) and flood-fill the white
 *      catalog background to transparent there. Doing this *before* down-
 *      sampling is key: at full resolution the boundary pixels are still
 *      cleanly white, so the flood test catches them. If we masked after
 *      downsampling, the anti-aliased boundary pixels would already be off-
 *      white grays and would survive as speckles around the silhouette.
 *   3. Downsample the masked source into a tiny canvas at `productPixelSize`.
 *      Soft alpha along the edge is preserved for a smoother silhouette.
 *   4. Detect tight content bounds from the tiny canvas.
 *   5. Quantize remaining color channels into a flatter 8-bit feel.
 *   6. Scale up with smoothing disabled into `productDisplaySize`.
 *   7. Translate detected bounds into the up-scaled canvas coords.
 */
export async function makeProductSprite(imageSrc: string, mask: MaskOptions = {}): Promise<ProductSprite> {
  const brightness = mask.brightness ?? DEFAULT_MASK.brightness;
  const chroma     = mask.chroma     ?? DEFAULT_MASK.chroma;
  const img = await loadImage(imageSrc);

  const tinySize = GAME_CONFIG.productPixelSize;
  const targetSize = GAME_CONFIG.productDisplaySize;

  // 1) Render the source at high resolution (512 px on the long side) so the
  // flood-fill test sees crisp white background pixels — at this size the
  // catalog backdrop has barely any anti-aliasing tint along edges. Flood
  // fill on ~260k pixels is still fast (a few ms worst case).
  const sourceMax = 512;
  const aspect = img.naturalWidth / img.naturalHeight || 1;
  const source = document.createElement('canvas');
  source.width = sourceMax;
  source.height = sourceMax;
  const sctx = source.getContext('2d', { willReadFrequently: true })!;
  sctx.imageSmoothingEnabled = true;
  let sdw: number = sourceMax;
  let sdh: number = sourceMax;
  if (aspect > 1) sdh = Math.round(sourceMax / aspect);
  else sdw = Math.round(sourceMax * aspect);
  sctx.drawImage(
    img,
    Math.floor((sourceMax - sdw) / 2),
    Math.floor((sourceMax - sdh) / 2),
    sdw, sdh,
  );

  // 2) Mask out the white catalog background at full resolution. Flood-fill
  // from the canvas edges through near-white pixels — only the background
  // (connected to the boundary) becomes transparent; interior whites such
  // as box labels and packaging highlights stay opaque because they're not
  // connected to the boundary.
  //
  // brightness/chroma come from the caller (defaulted via DEFAULT_MASK) so
  // the in-game debug sliders can drive a live re-mask without rebuilding.
  maskWhiteBackgroundFromEdges(sctx, sourceMax, sourceMax, brightness, chroma);

  // 3) Downsample into the chunky tiny canvas with a 1-px transparent border
  // on all sides. The border guarantees the outline pass below always has
  // room to draw, even when the source image runs all the way to the edge
  // (e.g. tightly cropped product photos). The actual content region is
  // still tinySize × tinySize, just offset into a slightly larger canvas.
  const tinyPad = 1;
  const tinyTotal = tinySize + tinyPad * 2;
  const tiny = document.createElement('canvas');
  tiny.width = tinyTotal;
  tiny.height = tinyTotal;
  const tctx = tiny.getContext('2d', { willReadFrequently: true })!;
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(source, 0, 0, sourceMax, sourceMax, tinyPad, tinyPad, tinySize, tinySize);

  // 4) Add a 1-px black outline around the silhouette (chunky-pixel level).
  // When upscaled with smoothing off, each tiny pixel becomes a 2x2 block,
  // so this reads as a 2-px outline at display size — matching the van's
  // black border. Done before bounds detection so the eyes/legs anchor to
  // the outlined silhouette rather than the bare product.
  addPixelOutline(tctx, tinyTotal, tinyTotal, 128);

  // 5) Detect bounds across the whole padded canvas (outline counts as content).
  const tinyBounds = detectContentBounds(tctx, tinyTotal, tinyTotal);

  // 6) Light color quantization — snap channels to a 5-step ramp to flatten
  // gradients into a flatter 8-bit feel. Cheap, effective, preserves alpha.
  quantize(tctx, tinyTotal, tinyTotal, 5);

  // 7) Scale up with smoothing disabled — the actual pixel-art look. Scale
  // factor is based on tinySize (the inner content region), so the final
  // chunky-pixel size matches what we'd get without padding.
  const scale = targetSize / tinySize;
  const bigTotal = Math.round(tinyTotal * scale);
  const big = document.createElement('canvas');
  big.width = bigTotal;
  big.height = bigTotal;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(tiny, 0, 0, bigTotal, bigTotal);

  // 8) Translate detected bounds from tiny-space to big-space. The eye/leg
  // anchoring in ProductSprite.draw() reads bounds.x/y so the transparent
  // border around the canvas doesn't affect on-screen positioning.
  const bounds = {
    x: Math.round(tinyBounds.x * scale),
    y: Math.round(tinyBounds.y * scale),
    w: Math.round(tinyBounds.w * scale),
    h: Math.round(tinyBounds.h * scale),
  };

  return new ProductSprite(big, bounds);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Best-effort CORS for remote URLs; falls back gracefully if the server
    // doesn't allow it (we just won't be able to read the pixels, but the
    // upstream code catches that and skips the item).
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Walk alpha to find the smallest rectangle that contains all "content" pixels
 * (alpha above a small noise threshold). Falls back to the full canvas if empty.
 */
function detectContentBounds(ctx: CanvasRenderingContext2D, w: number, h: number) {
  let data: ImageData;
  try { data = ctx.getImageData(0, 0, w, h); }
  catch { return { x: 0, y: 0, w, h }; }
  const px = data.data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = px[(y * w + x) * 4 + 3];
      if (a < 12) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Treat *connected* near-white regions touching the canvas border as background
 * and erase their alpha. Pixels that are near-white but enclosed by colored
 * pixels (e.g. white label text inside a colored box) are preserved.
 *
 * Background test: a pixel qualifies only when *every* channel is at or above
 * `brightness` AND the channels are within `chroma` of each other. The chroma
 * bound rejects faintly-tinted near-whites (a slight cream or pale blue that
 * would otherwise pass a brightness-only check), keeping the mask tight to
 * "actually pure white".
 *
 * 4-connected flood fill seeded from every edge pixel; Uint8Array visited map
 * + explicit stack to stay allocation-light on the 36x36 tiny canvas.
 */
function maskWhiteBackgroundFromEdges(ctx: CanvasRenderingContext2D, w: number, h: number, brightness: number, chroma: number) {
  let data: ImageData;
  try { data = ctx.getImageData(0, 0, w, h); }
  catch { return; }
  const px = data.data;

  const isBackground = (i: number) => {
    if (px[i + 3] === 0) return true;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (r < brightness || g < brightness || b < brightness) return false;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max - min <= chroma;
  };

  const visited = new Uint8Array(w * h);
  const stack: number[] = [];

  const seed = (x: number, y: number) => {
    const idx = y * w + x;
    if (visited[idx]) return;
    if (!isBackground(idx * 4)) return;
    visited[idx] = 1;
    stack.push(idx);
  };

  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0)     seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0)     seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  for (let i = 0; i < visited.length; i++) {
    if (visited[i]) px[i * 4 + 3] = 0;
  }
  ctx.putImageData(data, 0, 0);
}

/**
 * Stamp opaque-black pixels into every transparent pixel that has at least
 * one opaque (alpha ≥ threshold) 8-connected neighbour. Snapshots the alpha
 * channel first so we don't grow the outline beyond a single layer when
 * iterating in place. Pixels outside the canvas naturally count as transparent.
 */
function addPixelOutline(ctx: CanvasRenderingContext2D, w: number, h: number, threshold: number) {
  let data: ImageData;
  try { data = ctx.getImageData(0, 0, w, h); }
  catch { return; }
  const px = data.data;

  // Snapshot of alpha at function entry — outline decisions read from this,
  // writes go to px. Otherwise the newly-stamped black pixels would qualify
  // their neighbours as well and we'd inflate by multiple pixels.
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = px[i * 4 + 3];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (alpha[idx] >= threshold) continue;  // already content
      let hit = false;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1 && !hit; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (alpha[ny * w + nx] >= threshold) hit = true;
        }
      }
      if (!hit) continue;
      const i = idx * 4;
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255;
    }
  }

  ctx.putImageData(data, 0, 0);
}

/** Snap each channel to a coarse ramp so gradient regions become flat color blocks. */
function quantize(ctx: CanvasRenderingContext2D, w: number, h: number, levels: number) {
  let data: ImageData;
  try { data = ctx.getImageData(0, 0, w, h); }
  catch { return; }
  const px = data.data;
  const step = 255 / (levels - 1);
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 12) continue;
    px[i]     = Math.round(px[i]     / step) * step;
    px[i + 1] = Math.round(px[i + 1] / step) * step;
    px[i + 2] = Math.round(px[i + 2] / step) * step;
  }
  ctx.putImageData(data, 0, 0);
}

/** Two cartoon eyes with jittering pupils, drawn directly into the world canvas. */
function drawEyes(ctx: CanvasRenderingContext2D, cx: number, topY: number, productW: number, frame: number, phase: number) {
  // Eye size scales with product width so small items don't get giant eyes.
  const eyeR = Math.max(6, Math.min(11, Math.round(productW * 0.13)));
  const gap = eyeR * 2.2;
  // Overlap the top edge slightly so eyes "perch" on the product.
  const eyeY = topY + Math.max(2, Math.round(eyeR * 0.4));

  // Pupil wiggle on a slow cycle, decoupled per eye for personality.
  const wig = Math.max(1, Math.round(eyeR * 0.25));
  const lpx = Math.round(Math.sin(frame * 0.18 + phase) * wig);
  const lpy = Math.round(Math.cos(frame * 0.14 + phase) * wig);
  const rpx = Math.round(Math.sin(frame * 0.16 + 1.2 + phase) * wig);
  const rpy = Math.round(Math.cos(frame * 0.17 + 0.8 + phase) * wig);

  for (const [ex, px, py] of [[cx - gap / 2, lpx, lpy], [cx + gap / 2, rpx, rpy]] as const) {
    // Sclera.
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Pupil.
    ctx.fillStyle = '#111';
    ctx.beginPath();
    ctx.arc(ex + px, eyeY + py, Math.max(2, Math.round(eyeR * 0.45)), 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Two thin pixel-art legs with a proper running cycle.
 *
 * Per leg, one signed phase value drives both:
 *   - horizontal swing  = -cos(phase) · stride      (forward when in air, backward when planted)
 *   - vertical lift     =  max(0,sin(phase)) · liftMax
 *
 * That gives the classic alternating "front leg up, back leg planted" gait
 * instead of a flat zigzag. Legs are drawn back-to-front by current lift so
 * the swinging leg overlaps the planted one cleanly.
 *
 * `phase` is per-runner: it offsets the cycle position and adds tiny per-runner
 * cadence variance so the herd doesn't run in lockstep.
 */
function drawLegs(ctx: CanvasRenderingContext2D, cx: number, topY: number, length: number, frame: number, phase: number) {
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Slight per-runner cadence variance keeps the gait from feeling synchronized
  // even at long viewing distances.
  const rate = 0.3 + (Math.sin(phase * 7.1) * 0.5 + 0.5) * 0.08;
  const t = frame * rate + phase;

  const stride = Math.max(10, length * 0.5);
  const liftMax = Math.max(6, length * 0.45);
  const hipGap = Math.max(3, length * 0.15);
  const standLen = length;
  const groundY = topY + standLen;

  // Compute both legs first so we can render the higher-lifted one last (on top).
  type Leg = { side: number; swing: number; lift: number };
  const legs: Leg[] = [-1, 1].map(side => {
    const lp = t + (side > 0 ? Math.PI : 0);
    return { side, swing: -Math.cos(lp), lift: Math.max(0, Math.sin(lp)) };
  });
  legs.sort((a, b) => a.lift - b.lift);

  for (const { side, swing, lift } of legs) {
    const hipX = cx + side * hipGap;
    const hipY = topY;
    const footX = hipX + swing * stride;
    const footY = groundY - lift * liftMax;

    // Knee bends forward in the air phase and tucks slightly under the hip
    // when planted, giving the leg a natural angle instead of a flat dogleg.
    const kneeX = hipX + swing * stride * 0.42;
    const kneeY = hipY + length * 0.55 - lift * (length * 0.18);

    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(footX, footY);
    ctx.stroke();

    // Foot: short flat segment pointing in the direction of swing so the
    // toes lead the motion. Looks more "running" than a centered stub.
    const dir = swing >= 0 ? 1 : -1;
    ctx.beginPath();
    ctx.moveTo(footX - 3, footY);
    ctx.lineTo(footX + 5 * dir, footY);
    ctx.stroke();
  }
}
