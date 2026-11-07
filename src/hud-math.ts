export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function getBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function angleDiff(target: number, current: number): number {
  return ((target - current + 540) % 360) - 180;
}

const CARDINALS: Record<number, string> = {
  0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
  180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
};

/** Generates a 2-line compass tape that never drops ticks on odd degrees */
export function buildHeadingTape(
  heading: number,
  currentLat: number,
  currentLon: number,
  waypoints: Waypoint[]
): string {
  const widthChars = 29; // Center index is 14
  const fovDeg = 58;     // 2 degrees per slot
  const halfFov = fovDeg / 2;
  const NBSP = '\u00A0';

  const tape = new Array(widthChars).fill('-');
  const markerRow = new Array(widthChars).fill(NBSP);

  // Iterate degree-by-degree across the FOV so odd/even headings never skip ticks!
  for (let d = -halfFov; d <= halfFov; d++) {
    const deg = ((Math.round(heading + d) % 360) + 360) % 360;
    const charIdx = Math.round(((d + halfFov) / fovDeg) * (widthChars - 1));

    if (charIdx >= 0 && charIdx < widthChars) {
      if (CARDINALS[deg]) {
        const label = CARDINALS[deg];
        for (let c = 0; c < label.length && charIdx + c < widthChars; c++) {
          tape[charIdx + c] = label[c];
        }
      } else if (deg % 15 === 0 && tape[charIdx] === '-') {
        tape[charIdx] = '|';
      }
    }
  }

  // Project each waypoint tag character around its true screen center,
  // then clip each character to the tape bounds. This keeps left/right
  // entry symmetric instead of anchored to a single start index.
  for (const wp of waypoints) {
    const wpBearing = getBearingDeg(currentLat, currentLon, wp.lat, wp.lon);
    const diff = angleDiff(wpBearing, heading);

    if (Math.abs(diff) <= halfFov) {
      const tag = `v${wp.name.slice(0, 3).toUpperCase()}`;
      const centerX = ((diff + halfFov) / fovDeg) * (widthChars - 1);
      const halfTag = (tag.length - 1) / 2;

      for (let i = 0; i < tag.length; i++) {
        const idx = Math.round(centerX + i - halfTag);
        if (idx >= 0 && idx < widthChars) {
          markerRow[idx] = tag[i];
        }
      }
    }
  }

  // Strictly 2 lines (Row 1: Waypoints, Row 2: Tape) — NO 3rd line here!
  return `${NBSP}${markerRow.join('')}\n[${tape.join('')}]`;
}
