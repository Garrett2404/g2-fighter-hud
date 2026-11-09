import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk';
import {
  FT_PER_M,
  MPH_PER_MPS,
  Waypoint,
  angleDiff,
  formatDuration,
  formatRange,
  getBearingDeg,
  getDistanceMeters,
  normalizeDeg,
} from './hud-math';
import type { LevelStep } from './head-tracker';

export type GpsState = 'waiting' | 'live' | 'unavailable';

/**
 * The glasses can't sense yaw, so heading is the GPS track while moving (then held when you stop),
 * set by facing the align point, or set by the simulator's slider.
 */
export type HeadingSource = 'none' | 'track' | 'held' | 'aligned' | 'sim';

export const HEADING_TAG: Record<HeadingSource, string> = { none: '', track: 'TRK', held: 'HLD', aligned: 'ALN', sim: 'SIM' };

export interface GlassesStatus {
  connected: boolean;
  battery: number | null;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Sensor and link health, shown on the phone because there are no devtools there. */
export interface Diagnostics {
  /** 'none' when the host has no IMU (the simulator). */
  imu: 'starting' | 'live' | 'silent' | 'none';
  imuHz: number;
  /** Last raw accelerometer sample. */
  raw: [number, number, number] | null;
  /** Duration of the last HUD image send. */
  frameMs: number | null;
  imageFailures: number;
}

export interface HudState {
  /** True-north degrees; meaningless while headingSource is 'none'. */
  heading: number;
  headingSource: HeadingSource;
  /** Distant landmark the wearer faces to set the heading. */
  alignPoint: LatLon | null;
  /** Degrees, positive = looking up. */
  pitch: number;
  /** Degrees, positive = right ear down. */
  roll: number;
  /** Whether pitch and roll use a LEVEL calibration rather than the default guess. */
  leveled: boolean;
  levelStep: LevelStep | null;
  lat: number;
  lon: number;
  gps: GpsState;
  /** Horizontal GPS accuracy in meters, when the phone reports it. */
  accuracyM: number | null;
  speedMps: number;
  altitudeM: number | null;
  waypoints: Waypoint[];
  /** Index into `waypoints`, -1 when the list is empty. */
  selected: number;
  message: string;
  showHints: boolean;
  glasses: GlassesStatus | null;
  diag: Diagnostics;
}

interface Box {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const HUD_IMAGE: Box = { id: 1, name: 'hud_img', x: 144, y: 0, w: 288, h: 144 };

const TEXT = {
  input: { id: 2, name: 'hud_input', x: 0, y: 0, w: 576, h: 288 },
  gs: { id: 3, name: 'hud_gs', x: 24, y: 70, w: 100, h: 40 },
  gsLabel: { id: 4, name: 'hud_gs_lbl', x: 24, y: 112, w: 120, h: 32 },
  alt: { id: 5, name: 'hud_alt', x: 452, y: 70, w: 100, h: 40 },
  altLabel: { id: 6, name: 'hud_alt_lbl', x: 452, y: 112, w: 120, h: 32 },
  steer: { id: 7, name: 'hud_steer', x: 24, y: 212, w: 528, h: 34 },
  status: { id: 8, name: 'hud_status', x: 24, y: 248, w: 528, h: 34 },
} satisfies Record<string, Box>;

export const MENU = { mark: 1, next: 2, prev: 3, delete: 4, align: 5, level: 6 } as const;

// Closer than this, GPS noise makes the bearing to a waypoint meaningless.
export const ARRIVED_M = 10;
const BRIGHT = 4;
const DIM = 2;
const VALUE_BORDER = 2;
const VALUE_PADDING = 4;
const IMAGE_FAILURE_WARN = 3;
const LEVEL_PROMPT: Record<LevelStep, string> = {
  horizon: 'LEVEL 1/2  ·  LOOK AT THE HORIZON, HOLD STILL',
  up: 'LEVEL 2/2  ·  NOW LOOK UP, HOLD STILL',
};

export function buildPageLayout(): Partial<CreateStartUpPageContainer> {
  const text = (box: Box, content: string, extra: Partial<TextContainerProperty> = {}) =>
    new TextContainerProperty({
      containerID: box.id,
      containerName: box.name,
      xPosition: box.x,
      yPosition: box.y,
      width: box.w,
      height: box.h,
      isEventCapture: 0,
      content,
      ...extra,
    });
  const valueBox = { borderWidth: VALUE_BORDER, borderColor: 12, borderRadius: 6, paddingLength: VALUE_PADDING };

  return {
    containerTotalNum: 8,
    textObject: [
      // Invisible full-screen container that receives all touchpad input.
      text(TEXT.input, ' ', { isEventCapture: 1 }),
      text(TEXT.gs, '---', valueBox),
      text(TEXT.gsLabel, 'GS  MPH', { textColor: DIM }),
      text(TEXT.alt, '---', valueBox),
      text(TEXT.altLabel, 'ALT  FT', { textColor: DIM }),
      text(TEXT.steer, ' '),
      text(TEXT.status, ' '),
    ],
    imageObject: [
      new ImageContainerProperty({
        containerID: HUD_IMAGE.id,
        containerName: HUD_IMAGE.name,
        xPosition: HUD_IMAGE.x,
        yPosition: HUD_IMAGE.y,
        width: HUD_IMAGE.w,
        height: HUD_IMAGE.h,
      }),
    ],
    menuObject: new MenuContainerProperty({
      menuItems: [
        new MenuItemProperty({ itemName: 'Mark position', itemID: MENU.mark }),
        new MenuItemProperty({ itemName: 'Next waypoint', itemID: MENU.next }),
        new MenuItemProperty({ itemName: 'Previous waypoint', itemID: MENU.prev }),
        new MenuItemProperty({ itemName: 'Delete waypoint', itemID: MENU.delete }),
        new MenuItemProperty({ itemName: 'Align heading', itemID: MENU.align }),
        new MenuItemProperty({ itemName: 'Level HUD', itemID: MENU.level }),
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Text containers
// ---------------------------------------------------------------------------

export interface TextUpdate {
  id: number;
  name: string;
  content: string;
  textColor: number;
}

// The glasses font is proportional. Advances measured in the simulator; most glyphs are ~12 px.
const GLYPH_PX: Record<string, number> = { ' ': 5.1, '.': 5, '1': 7, '2': 11, '-': 10 };

function centerText(text: string, widthPx: number): string {
  const textPx = [...text].reduce((sum, ch) => sum + (GLYPH_PX[ch] ?? 12), 0);
  const pad = Math.max(0, Math.round((widthPx - textPx) / 2 / GLYPH_PX[' ']));
  return ' '.repeat(pad) + text;
}

export interface SteerInfo {
  waypoint: Waypoint;
  index: number;
  count: number;
  distM: number;
  bearing: number;
  /** Turn from the current heading, -180..180 (positive = right); null without a heading. */
  turn: number | null;
  /** Seconds to arrive at the current ground speed; null when stopped. */
  eteS: number | null;
}

export function steerInfo(s: HudState): SteerInfo | null {
  const waypoint = s.waypoints[s.selected];
  if (!waypoint) return null;
  const distM = getDistanceMeters(s.lat, s.lon, waypoint.lat, waypoint.lon);
  const bearing = getBearingDeg(s.lat, s.lon, waypoint.lat, waypoint.lon);
  const eteS = s.speedMps > 0.5 && distM / s.speedMps < 100 * 3600 ? distM / s.speedMps : null;
  const turn = s.headingSource === 'none' ? null : angleDiff(bearing, s.heading);
  return { waypoint, index: s.selected, count: s.waypoints.length, distM, bearing, turn, eteS };
}

function steerLine(s: HudState): string {
  const info = steerInfo(s);
  if (!info) return 'NO WAYPOINTS  ·  HOLD TO MARK';

  const head = `▶ ${info.waypoint.name}  ${info.index + 1}/${info.count}`;
  if (s.gps === 'waiting') return `${head}   NO GPS FIX`;

  const range = formatRange(info.distM);
  const sim = s.gps === 'unavailable' ? '   SIM' : '';
  if (info.distM < ARRIVED_M) return `${head}   ${range}   ARRIVED${sim}`;
  const brg = String(Math.round(info.bearing) % 360).padStart(3, '0');
  const ete = info.eteS === null ? '--:--' : formatDuration(info.eteS);
  return `${head}   ${range}   BRG ${brg}°   ETE ${ete}${sim}`;
}

/** Dynamic text content; the static labels are only sent at page creation. */
export function hudTexts(s: HudState): TextUpdate[] {
  const ref = (box: Box) => ({ id: box.id, name: box.name });
  const valueWidth = TEXT.gs.w - 2 * (VALUE_BORDER + VALUE_PADDING);
  const live = s.gps === 'live';
  const mph = s.speedMps * MPH_PER_MPS;
  const gs = live ? (mph < 10 ? mph.toFixed(1) : String(Math.round(mph))) : '---';
  const alt = live && s.altitudeM !== null ? String(Math.round(s.altitudeM * FT_PER_M)) : '---';

  let status = { content: ' ', textColor: DIM };
  if (s.message) status = { content: s.message, textColor: BRIGHT };
  else if (s.levelStep) status = { content: LEVEL_PROMPT[s.levelStep], textColor: BRIGHT };
  else if (s.diag.imageFailures >= IMAGE_FAILURE_WARN) {
    status = { content: 'HUD IMAGE NOT UPDATING  ·  RESTART APP', textColor: BRIGHT };
  } else if (s.showHints) status = { content: 'TAP  NEXT WPT  ·  HOLD  MARK  ·  DOUBLE-TAP  EXIT', textColor: DIM };
  else if (!s.leveled) status = { content: 'HUD NOT LEVELED  ·  MENU > LEVEL HUD', textColor: DIM };
  else if (s.headingSource === 'none') {
    const how = s.alignPoint ? 'WALK, OR MENU > ALIGN HEADING' : 'WALK, OR SET ALIGN POINT';
    status = { content: `NO HEADING  ·  ${how}`, textColor: DIM };
  }

  return [
    { ...ref(TEXT.gs), content: centerText(gs, valueWidth), textColor: BRIGHT },
    { ...ref(TEXT.alt), content: centerText(alt, valueWidth), textColor: BRIGHT },
    { ...ref(TEXT.steer), content: steerLine(s), textColor: BRIGHT },
    { ...ref(TEXT.status), ...status },
  ];
}

// ---------------------------------------------------------------------------
// Image container: heading tape, pitch ladder, waterline and bank scale
// ---------------------------------------------------------------------------

export interface TapeMarker {
  name: string;
  /** Relative bearing in degrees, -180..180 (positive = right of heading). */
  rel: number;
  selected: boolean;
}

export interface HudImageView {
  /** Null when there is no heading source yet. */
  heading: number | null;
  /** Where the heading comes from, e.g. TRK; empty when there is none. */
  headingTag: string;
  pitch: number;
  roll: number;
  markers: TapeMarker[];
  /** Relative bearing to the align point, -180..180, or null when there is none. */
  alignRel: number | null;
}

/** Closer than this, GPS error makes the bearing too uncertain to align on. */
export const MIN_ALIGN_M = 30;

/** Bearing and distance from the current position to the align point, when it's usable. */
export function alignTarget(s: HudState): { bearing: number; distM: number } | null {
  const p = s.alignPoint;
  if (!p || s.gps === 'waiting') return null;
  return { bearing: getBearingDeg(s.lat, s.lon, p.lat, p.lon), distM: getDistanceMeters(s.lat, s.lon, p.lat, p.lon) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Everything the image depends on, rounded so identical frames can be skipped. */
export function hudImageView(s: HudState): HudImageView {
  const known = s.headingSource !== 'none';
  const markers: TapeMarker[] = [];
  if (known && s.gps !== 'waiting') {
    s.waypoints.forEach((wp, i) => {
      if (getDistanceMeters(s.lat, s.lon, wp.lat, wp.lon) < ARRIVED_M) return;
      const rel = angleDiff(getBearingDeg(s.lat, s.lon, wp.lat, wp.lon), s.heading);
      markers.push({ name: wp.name, rel: round1(rel), selected: i === s.selected });
    });
  }
  const target = known ? alignTarget(s) : null;
  const alignRel = target && target.distM >= ARRIVED_M ? round1(angleDiff(target.bearing, s.heading)) : null;
  return {
    heading: known ? round1(normalizeDeg(s.heading)) : null,
    headingTag: HEADING_TAG[s.headingSource],
    pitch: round1(s.pitch),
    roll: round1(s.roll),
    markers,
    alignRel,
  };
}

const W = HUD_IMAGE.w;
const H = HUD_IMAGE.h;
const CX = W / 2;
const RAD = Math.PI / 180;
const FG = '#ffffff';
const FG_DIM = '#808080';
const FONT = 'bold 14px Helvetica, Arial, sans-serif';
const FONT_SMALL = 'bold 12px Helvetica, Arial, sans-serif';
const FONT_TINY = 'bold 10px Helvetica, Arial, sans-serif';

const TAPE_PX_PER_DEG = 4;
export const TAPE_HALF_DEG = CX / TAPE_PX_PER_DEG;
export const BORESIGHT_Y = 90;
// Leaves a gap under the heading box so clipped ladder lines don't read as tape marks.
const LADDER_TOP = 44;
/** Rungs farther than this from the boresight are hidden rather than clipped mid-label. */
const LADDER_WINDOW_PX = 44;
const PITCH_PX_PER_DEG = 3;
const BANK_RADIUS = 42;

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function triangle(ctx: CanvasRenderingContext2D, pts: [number, number][], fill: boolean) {
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  ctx.lineTo(...pts[1]);
  ctx.lineTo(...pts[2]);
  ctx.closePath();
  if (fill) ctx.fill();
  else ctx.stroke();
}

function tapeLabel(deg: number): string {
  const cardinal: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  return cardinal[deg] ?? String(deg / 10).padStart(2, '0');
}

function drawTape(ctx: CanvasRenderingContext2D, heading: number | null, tag: string) {
  ctx.lineWidth = 1;
  ctx.font = FONT_SMALL;
  ctx.textAlign = 'center';
  if (heading !== null) {
    const first = Math.ceil((heading - TAPE_HALF_DEG) / 5) * 5;
    for (let d = first; d <= heading + TAPE_HALF_DEG; d += 5) {
      const x = Math.round(CX + (d - heading) * TAPE_PX_PER_DEG) + 0.5;
      const major = normalizeDeg(d) % 10 === 0;
      line(ctx, x, 12, x, major ? 20 : 16);
      if (major && Math.abs(x - CX) > 32 && Math.abs(x - CX) < CX - 10) {
        ctx.fillText(tapeLabel(normalizeDeg(d)), x, 29);
      }
    }
  }

  // Digital heading box with a caret pointing up at the tape.
  ctx.font = FONT;
  ctx.strokeRect(CX - 21.5, 21.5, 43, 17);
  ctx.fillText(heading === null ? '- - -' : String(Math.round(heading) % 360).padStart(3, '0'), CX, 30.5);
  triangle(ctx, [[CX, 13], [CX - 4, 21], [CX + 4, 21]], true);
  // Sits in the gap between the ladder's left and right rungs.
  ctx.font = FONT_TINY;
  ctx.fillStyle = FG_DIM;
  ctx.fillText(tag, CX, 48);
  ctx.fillStyle = FG;
}

function drawMarkers(ctx: CanvasRenderingContext2D, markers: TapeMarker[]) {
  const limit = TAPE_HALF_DEG - 1.5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = FG_DIM;
  for (const m of markers) {
    if (m.selected || Math.abs(m.rel) > limit) continue;
    const x = CX + m.rel * TAPE_PX_PER_DEG;
    triangle(ctx, [[x - 4, 2.5], [x + 4, 2.5], [x, 9.5]], false);
  }
  ctx.strokeStyle = FG;

  const sel = markers.find((m) => m.selected);
  if (!sel) return;
  ctx.font = FONT_SMALL;
  if (Math.abs(sel.rel) <= limit) {
    const x = CX + sel.rel * TAPE_PX_PER_DEG;
    triangle(ctx, [[x - 5, 1], [x + 5, 1], [x, 11]], true);
    const labelRight = x < W - 60;
    ctx.textAlign = labelRight ? 'left' : 'right';
    ctx.fillText(sel.name, labelRight ? x + 8 : x - 8, 6);
    return;
  }

  // Off the tape: pin an arrow to the edge it's on, with how far to turn.
  const label = `${sel.name} ${Math.round(Math.abs(sel.rel))}°`;
  if (sel.rel < 0) {
    triangle(ctx, [[1, 6], [9, 1], [9, 11]], true);
    ctx.textAlign = 'left';
    ctx.fillText(label, 13, 6);
  } else {
    triangle(ctx, [[W - 1, 6], [W - 9, 1], [W - 9, 11]], true);
    ctx.textAlign = 'right';
    ctx.fillText(label, W - 13, 6);
  }
}

function drawLadder(ctx: CanvasRenderingContext2D, pitch: number, roll: number) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, LADDER_TOP, W, H - LADDER_TOP);
  ctx.clip();
  ctx.translate(CX, BORESIGHT_Y);
  // The world appears to rotate opposite to the head.
  ctx.rotate(-roll * RAD);
  ctx.font = FONT_SMALL;
  ctx.textAlign = 'center';

  for (let p = -90; p <= 90; p += 10) {
    const y = (pitch - p) * PITCH_PX_PER_DEG;
    if (Math.abs(y) > LADDER_WINDOW_PX) continue;

    if (p === 0) {
      ctx.lineWidth = 2;
      line(ctx, -110, y, -40, y);
      line(ctx, 40, y, 110, y);
      continue;
    }

    // Climb rungs are solid, dive rungs dashed; the tips point toward the horizon.
    const tip = p > 0 ? 5 : -5;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(p > 0 ? [] : [5, 3]);
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 22, y);
      ctx.lineTo(side * 56, y);
      ctx.lineTo(side * 56, y + tip);
      ctx.stroke();
      ctx.fillText(String(p), side * 71, y);
    }
    ctx.setLineDash([]);
  }
  ctx.restore();
}

function drawWaterline(ctx: CanvasRenderingContext2D) {
  const y = BORESIGHT_Y;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(CX - 34, y);
  ctx.lineTo(CX - 14, y);
  ctx.lineTo(CX - 7, y + 7);
  ctx.lineTo(CX, y);
  ctx.lineTo(CX + 7, y + 7);
  ctx.lineTo(CX + 14, y);
  ctx.lineTo(CX + 34, y);
  ctx.stroke();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.stroke();
}

// Rides the horizon so it sits where a distant landmark would. Only the center of the
// display is to scale with the real world, so align with the landmark behind the waterline.
function drawAlignDiamond(ctx: CanvasRenderingContext2D, rel: number, pitch: number) {
  const y = Math.max(LADDER_TOP + 8, Math.min(H - 8, BORESIGHT_Y + pitch * PITCH_PX_PER_DEG));
  ctx.lineWidth = 1.5;
  const limit = TAPE_HALF_DEG - 3;
  if (Math.abs(rel) <= limit) {
    diamond(ctx, CX + rel * TAPE_PX_PER_DEG, y, 7);
    return;
  }
  // Off-screen: pin a small diamond to the edge with how far to turn.
  const right = rel > 0;
  const x = right ? W - 6 : 6;
  diamond(ctx, x, y, 5);
  ctx.font = FONT_SMALL;
  ctx.textAlign = right ? 'right' : 'left';
  ctx.fillText(`${Math.round(Math.abs(rel))}°`, right ? x - 8 : x + 8, y);
}

function drawBankScale(ctx: CanvasRenderingContext2D, roll: number) {
  const polar = (r: number, deg: number): [number, number] => [
    CX + r * Math.sin(deg * RAD),
    BORESIGHT_Y + r * Math.cos(deg * RAD),
  ];
  ctx.lineWidth = 1.5;
  for (const a of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
    const len = a === 0 ? 8 : Math.abs(a) === 30 ? 7 : 4;
    line(ctx, ...polar(BANK_RADIUS, a), ...polar(BANK_RADIUS + len, a));
  }
  // Pointer marks where "down" is, so it swings right when the head rolls right.
  const a = Math.max(-60, Math.min(60, roll));
  triangle(ctx, [polar(BANK_RADIUS - 1, a), polar(BANK_RADIUS - 9, a - 6), polar(BANK_RADIUS - 9, a + 6)], true);
}

export function drawHudImage(ctx: CanvasRenderingContext2D, v: HudImageView) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = FG;
  ctx.strokeStyle = FG;
  ctx.textBaseline = 'middle';
  drawLadder(ctx, v.pitch, v.roll);
  drawWaterline(ctx);
  drawBankScale(ctx, v.roll);
  if (v.alignRel !== null) drawAlignDiamond(ctx, v.alignRel, v.pitch);
  drawTape(ctx, v.heading, v.headingTag);
  drawMarkers(ctx, v.markers);
}

let canvas: HTMLCanvasElement | null = null;

/** Draws the HUD image and returns it as PNG bytes for `updateImageRawData`. */
export async function renderHudImage(v: HudImageView): Promise<number[]> {
  canvas ??= Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  drawHudImage(ctx, v);
  const blob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG encoding failed');
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}
