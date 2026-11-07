export interface Waypoint {
  name: string;
  lat: number;
  lon: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export const FT_PER_M = 3.28084;
export const M_PER_MI = 1609.344;
export const MPH_PER_MPS = 2.23694;

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

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
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

/** Signed shortest turn from `current` to `target`, in -180..180 (positive = right). */
export function angleDiff(target: number, current: number): number {
  return normalizeDeg(target - current + 180) - 180;
}

export function isValidWaypoint(value: unknown): value is Waypoint {
  const wp = value as Waypoint;
  return (
    typeof wp === 'object' && wp !== null &&
    typeof wp.name === 'string' && wp.name.length > 0 &&
    Number.isFinite(wp.lat) && Math.abs(wp.lat) <= 90 &&
    Number.isFinite(wp.lon) && Math.abs(wp.lon) <= 180
  );
}

export const MAX_NAME_LENGTH = 8;

export function cleanName(name: string): string {
  return name.trim().toUpperCase().slice(0, MAX_NAME_LENGTH);
}

export function formatRange(meters: number): string {
  const feet = meters * FT_PER_M;
  if (feet < 1000) return `${Math.round(feet / 10) * 10} FT`;
  const miles = meters / M_PER_MI;
  if (miles < 10) return `${miles.toFixed(2)} MI`;
  if (miles < 100) return `${miles.toFixed(1)} MI`;
  return `${Math.round(miles)} MI`;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const NUM = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
const LAT_LON_PATTERNS = [
  new RegExp(String.raw`@${NUM},${NUM}`), // Google Maps links: .../@36.95,-93.92,15z
  new RegExp(String.raw`[?&](?:q|ll|query|daddr)=${NUM},\s*${NUM}`),
  new RegExp(String.raw`${NUM}\s*[,;\s]\s*${NUM}`),
];

/** Reads "lat, lon", "lat lon", or a map link that contains coordinates. */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
  let s = text.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // Not URL-encoded; use it as typed.
  }
  for (const pattern of LAT_LON_PATTERNS) {
    const match = pattern.exec(s);
    if (!match) continue;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

