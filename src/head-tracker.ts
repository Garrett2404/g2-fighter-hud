/*
 * Head pitch and roll from the G2's IMU.
 *
 * The G2 reports a 3-axis accelerometer (imuData x/y/z is the gravity vector, about 1 g long), not angles,
 * and exposes no gyro or compass, so pitch and roll can be measured but head yaw cannot. The sensor sits
 * rotated inside the frame and every face holds the glasses at its own tilt, so the head's axes in sensor
 * coordinates come from a two-pose LEVEL calibration: look at the horizon, then look up.
 */

export type Vec3 = [number, number, number];

interface HeadAxes {
  /** Reading direction with the head level. */
  up: Vec3;
  /** Direction the reading tips toward when looking up. */
  fwd: Vec3;
  /** Direction the reading tips toward when the right ear goes down. */
  side: Vec3;
}

export type LevelStep = 'horizon' | 'up';

// Measured on a G2 by the open-source level-even-g2 app: with the head level the reading points along
// VERT, and it tips toward LAT when the right ear goes down.
const VERT: Vec3 = [-0.07, -0.133, 0.988];
const LAT: Vec3 = [0.46, 0.88, 0.15];

const SMOOTHING = 0.3; // Weight of each new sample (about 10 a second).
const STILL_SAMPLES = 8;
const STILL_DEG = 2;
const MIN_NOD_DEG = 12;
const DEG = 180 / Math.PI;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1));
const angleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * DEG;
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

function makeAxes(up: Vec3, fwd: Vec3): HeadAxes {
  const u = unit(up);
  const f = unit(cross(cross(u, fwd), u)); // fwd with its component along u removed
  // The cross product's sign depends on the sensor's axis conventions; the measured LAT settles it.
  const side = cross(u, f);
  return { up: u, fwd: f, side: dot(side, LAT) < 0 ? scale(side, -1) : side };
}

/** Best guess until the wearer runs LEVEL; assumes a standard right-handed accelerometer. */
const DEFAULT_AXES = makeAxes(VERT, cross(LAT, VERT));

/** The reading the sensor gives at this head pitch and roll (degrees), for the simulator. */
export function readingFor(pitch: number, roll: number): Vec3 {
  const p = pitch / DEG;
  const r = roll / DEG;
  const { up, fwd, side } = DEFAULT_AXES;
  return [0, 1, 2].map(
    (i) => Math.sin(p) * fwd[i] + Math.cos(p) * (Math.cos(r) * up[i] + Math.sin(r) * side[i])
  ) as Vec3;
}

export class HeadTracker {
  leveled = false;
  /** The LEVEL calibration step waiting for the wearer, or null when none is running. */
  step: LevelStep | null = null;
  private axes = DEFAULT_AXES;
  private reading: Vec3 | null = null;
  private recent: Vec3[] = [];
  private horizon: Vec3 = VERT;
  private notBefore = 0;

  /** Feeds one accelerometer sample; returns the LEVEL step it completed, if any. */
  push(sample: Vec3, nowMs: number): LevelStep | null {
    // Units don't matter (g or m/s²), only direction.
    if (!(Math.hypot(...sample) > 0)) return null;
    const s = unit(sample);
    const prev = this.reading;
    this.reading = prev ? unit([0, 1, 2].map((i) => prev[i] + (s[i] - prev[i]) * SMOOTHING) as Vec3) : s;
    this.recent.push(s);
    if (this.recent.length > STILL_SAMPLES || nowMs < this.notBefore) this.recent.shift();

    const held = this.step && this.heldReading();
    if (!held) return null;
    if (this.step === 'horizon') {
      this.horizon = held;
      this.step = 'up';
      return 'horizon';
    }
    if (angleDeg(held, this.horizon) < MIN_NOD_DEG) return null;
    this.axes = makeAxes(this.horizon, held);
    this.leveled = true;
    this.step = null;
    return 'up';
  }

  /** Degrees: pitch positive looking up, roll positive right ear down. Null before the first sample. */
  attitude(): { pitch: number; roll: number } | null {
    const a = this.reading;
    if (!a) return null;
    const { up, fwd, side } = this.axes;
    return {
      pitch: Math.asin(Math.max(-1, Math.min(1, dot(a, fwd)))) * DEG,
      roll: Math.atan2(dot(a, side), dot(a, up)) * DEG,
    };
  }

  /** Starts LEVEL; the head must then be still for a moment at each pose, starting `delayMs` from now. */
  startLevel(nowMs: number, delayMs = 0) {
    this.step = 'horizon';
    this.notBefore = nowMs + delayMs;
    this.recent = [];
  }

  cancelLevel() {
    this.step = null;
  }

  /** The calibration as a string for storage. */
  save(): string {
    return JSON.stringify({ up: this.axes.up, fwd: this.axes.fwd });
  }

  /** Restores a saved calibration; returns false when the text isn't one. */
  restore(text: string): boolean {
    const saved = JSON.parse(text) as { up?: unknown; fwd?: unknown };
    if (!isVec3(saved.up) || !isVec3(saved.fwd)) return false;
    this.axes = makeAxes(saved.up, saved.fwd);
    this.leveled = true;
    return true;
  }

  /** The mean reading over the last moment, when the head has been still for all of it. */
  private heldReading(): Vec3 | null {
    if (this.recent.length < STILL_SAMPLES) return null;
    const mean = unit(this.recent.reduce<Vec3>((sum, v) => [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]], [0, 0, 0]));
    return this.recent.every((v) => angleDeg(v, mean) < STILL_DEG) ? mean : null;
  }
}
