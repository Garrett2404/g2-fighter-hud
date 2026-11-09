import { BORESIGHT_Y, HUD_IMAGE, type LatLon } from './hud-display';
import { readingFor, type Vec3 } from './head-tracker';
import { angleDiff, getBearingDeg, getDistanceMeters } from './hud-math';

/*
 * Test-only stand-in for real glasses in the real world, so LEVEL and heading alignment can be practised
 * on the phone page or in the simulator:
 * - the glasses sit at a random, unknown tilt on the nose, and the accelerometer is slightly noisy;
 * - like the real G2, nothing senses which way the head turns;
 * - reported GPS wanders around the true position by roughly the chosen accuracy;
 * - the mirror shows the "real world" at the G2's true scale, with a tower at the align point.
 */

const DISPLAY_W = 576;
// G2: 27.5° diagonal field of view on a 2:1 display ≈ 24.6° across.
export const WORLD_PX_PER_DEG = DISPLAY_W / ((27.5 * 2) / Math.sqrt(5));
const HORIZON_Y = HUD_IMAGE.y + BORESIGHT_Y;
const EDGE_HINT_Y = 160;
const M_PER_DEG_LAT = 111_320;
const GPS_CORRELATION = 0.9; // Per 1 s fix: GPS error wanders slowly rather than jumping.
const FIT_PITCH_DEG = 10;
const FIT_ROLL_DEG = 3;
const ACCEL_NOISE_G = 0.004;

function gauss(): number {
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

export class AlignSim {
  running = false;
  /** Where the head really points, degrees from true north. */
  trueHeading = 0;
  truePos: LatLon = { lat: 0, lon: 0 };
  gpsErrorM = 5;
  /** How the glasses happen to sit on the nose, in degrees. */
  fit = { pitch: 0, roll: 0 };
  private err = { n: 0, e: 0 };

  start(pos: LatLon, trueHeading: number) {
    this.running = true;
    this.truePos = { ...pos };
    this.trueHeading = trueHeading;
    this.fit = { pitch: (Math.random() * 2 - 1) * FIT_PITCH_DEG, roll: (Math.random() * 2 - 1) * FIT_ROLL_DEG };
    const sigma = this.sigma();
    this.err = { n: gauss() * sigma, e: gauss() * sigma };
  }

  stop() {
    this.running = false;
  }

  /** What the glasses' accelerometer would report with the head really at this pitch and roll. */
  reading(pitch: number, roll: number): Vec3 {
    return readingFor(pitch + this.fit.pitch, roll + this.fit.roll).map((v) => v + gauss() * ACCEL_NOISE_G) as Vec3;
  }

  /** Next once-a-second GPS fix: the true position plus slowly wandering error. */
  nextFix(): LatLon {
    const sigma = this.sigma();
    const keep = GPS_CORRELATION;
    const fresh = Math.sqrt(1 - keep * keep) * sigma;
    this.err = { n: keep * this.err.n + fresh * gauss(), e: keep * this.err.e + fresh * gauss() };
    const { lat, lon } = this.truePos;
    return {
      lat: lat + this.err.n / M_PER_DEG_LAT,
      lon: lon + this.err.e / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)),
    };
  }

  /** Paints the outside world into the 576×288 mirror, before the HUD is drawn over it. */
  drawWorld(ctx: CanvasRenderingContext2D, landmark: LatLon | null, pitch: number) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const cx = w / 2;
    // Looking up moves the horizon down the display.
    const horizon = HORIZON_Y + pitch * WORLD_PX_PER_DEG;

    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Rolling hills fixed to true bearings, so turning the head visibly moves the world.
    ctx.fillStyle = '#262626';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const b = ((this.trueHeading + (x - cx) / WORLD_PX_PER_DEG) * Math.PI) / 180;
      const hill = 6 + 5 * Math.sin(b * 7) + 4 * Math.sin(b * 17 + 1) + 2 * Math.sin(b * 41 + 2);
      ctx.lineTo(x, horizon - hill);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();

    if (landmark) this.drawLandmark(ctx, landmark, horizon);
    ctx.restore();
  }

  private drawLandmark(ctx: CanvasRenderingContext2D, p: LatLon, horizon: number) {
    const w = ctx.canvas.width;
    const dist = getDistanceMeters(this.truePos.lat, this.truePos.lon, p.lat, p.lon);
    if (dist < 1) return;
    const rel = angleDiff(getBearingDeg(this.truePos.lat, this.truePos.lon, p.lat, p.lon), this.trueHeading);
    const x = w / 2 + rel * WORLD_PX_PER_DEG;
    ctx.fillStyle = '#8c8c8c';
    ctx.font = 'bold 13px Helvetica, Arial, sans-serif';
    ctx.textBaseline = 'middle';

    if (x < -10 || x > w + 10) {
      // Peripheral vision: you'd know roughly which way the landmark is. Kept below the GS/ALT boxes.
      const right = rel > 0;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.fillText(right ? 'LANDMARK ▶' : '◀ LANDMARK', right ? w - 6 : 6, Math.max(horizon + 22, EDGE_HINT_Y));
      return;
    }

    // A lattice radio tower; nearer towers look taller.
    const tall = Math.max(22, Math.min(80, 6000 / dist));
    const top = horizon - tall;
    const half = Math.max(2, tall / 10);
    ctx.strokeStyle = '#8c8c8c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - half, horizon);
    ctx.lineTo(x, top);
    ctx.lineTo(x + half, horizon);
    for (let y = horizon - tall / 4; y > top + 2; y -= tall / 4) {
      const span = (half * (y - top)) / tall;
      ctx.moveTo(x - span, y);
      ctx.lineTo(x + span, y);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, top - 2, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillText('LANDMARK', x, horizon + 22);
  }

  private sigma(): number {
    // Phone "accuracy" is roughly a 68% radius; per-axis sigma is about two-thirds of it.
    return this.gpsErrorM / 1.5;
  }
}
