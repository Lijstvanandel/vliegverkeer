import { FlightPassage, PositionPoint, TrafficCategory } from '../types/radar';

export function roundCoord6(val: number): number {
  return Math.round(val * 1_000_000) / 1_000_000;
}

export function feetToMeters(ft: number): number {
  return Math.round(ft * 0.3048);
}

export function metersToFeet(m: number): number {
  return Math.round(m / 0.3048);
}

export function knotsToKmh(kts: number): number {
  return Math.round(kts * 1.852);
}

/**
 * Exact altitude color scale specified in Section 4.5:
 * - 0 m – 1.000 m (laagvliegend / traumaheli / sport): Amber-oranje (#f59e0b)
 * - 1.000 m – 5.000 m (stijgend/dalend): Smaragdgroen/Cyaan (#10b981)
 * - > 5.000 m (kruishoogte): Helderblauw tot Indigo (#38bdf8 -> #818cf8)
 * - Hoogte onbekend / op grond: Neutraal grijs (#94a3b8)
 */
export function getAltitudeColor(altM: number | null, onGround = false): string {
  if (onGround || altM === null || !Number.isFinite(altM)) {
    return '#94a3b8';
  }
  if (altM <= 1000) return '#f59e0b';
  if (altM <= 5000) return '#10b981';
  if (altM <= 9500) return '#38bdf8';
  return '#818cf8';
}

export function isHelicopterPassage(passage: FlightPassage): boolean {
  if (passage.adsb_category === 'A7') return true;
  if (passage.traffic_category === 'hems_police_sar') return true;
  const typeCode = (passage.icao_type_code || '').toUpperCase();
  const model = (passage.model_name || '').toUpperCase();
  const heliTypes = ['EC35', 'H135', 'EC45', 'H145', 'AW139', 'A139', 'NH90', 'H64', 'AH64', 'CH47', 'H47', 'AS55', 'AS32', 'H532', 'B412', 'MD52', 'R44', 'R22', 'R66', 'S76', 'S92', 'EC20'];
  if (heliTypes.some((t) => typeCode.includes(t))) return true;
  if (model.includes('HELI') || model.includes('H135') || model.includes('EC135') || model.includes('EC-135') || model.includes('AW139') || model.includes('APACHE') || model.includes('CHINOOK') || model.includes('COUGAR') || model.includes('NH90')) {
    return true;
  }
  return false;
}

export function computeBearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/**
 * Fallback on last known non-null track (or computed bearing between two last points)
 * so military MLAT aircraft never snap to 0° north.
 */
export function resolveTrackAtIndex(positions: PositionPoint[], index: number): number {
  if (positions.length === 0) return 0;
  const clampedIdx = Math.max(0, Math.min(index, positions.length - 1));

  for (let i = clampedIdx; i >= 0; i--) {
    const tr = positions[i].track;
    if (tr !== null && tr !== undefined && Number.isFinite(tr)) {
      return ((tr % 360) + 360) % 360;
    }
  }

  for (let i = clampedIdx; i > 0; i--) {
    const p1 = positions[i - 1];
    const p2 = positions[i];
    if (Math.abs(p2.lat - p1.lat) > 1e-6 || Math.abs(p2.lon - p1.lon) > 1e-6) {
      return computeBearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);
    }
  }

  if (positions.length >= 2) {
    const p1 = positions[0];
    const p2 = positions[1];
    if (Math.abs(p2.lat - p1.lat) > 1e-6 || Math.abs(p2.lon - p1.lon) > 1e-6) {
      return computeBearingDeg(p1.lat, p1.lon, p2.lat, p2.lon);
    }
  }

  return 0;
}

/**
 * Shortest-path angular interpolation between two bearings (0..360)
 */
export function interpolateAngleDeg(a: number, b: number, ratio: number): number {
  const diff = ((b - a + 540) % 360) - 180;
  return ((a + diff * ratio) % 360 + 360) % 360;
}

export function normalizeSignedAngleDeg(deg: number): number {
  return ((deg + 540) % 360) - 180;
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Fallback speed estimation (in knots) from the last two recorded points
 * when a transponder/MLAT report omits `gs`.
 */
export function estimateSpeedKnotsFromTrack(positions: PositionPoint[]): number | null {
  if (positions.length < 2) return null;
  for (let i = positions.length - 1; i > 0; i--) {
    const p1 = positions[i - 1];
    const p2 = positions[i];
    const dtSec = (p2.t - p1.t) / 1000;
    if (dtSec >= 2 && dtSec <= 45) {
      const distM = haversineMeters(p1.lat, p1.lon, p2.lat, p2.lon);
      const kts = (distM / dtSec) / 0.5144444;
      if (Number.isFinite(kts) && kts >= 10 && kts <= 700) {
        return Math.round(kts);
      }
    }
  }
  return null;
}

/**
 * Factual speed-based displacement (dead reckoning) along current heading.
 * Capped strictly at 15s since last real measurement so stalled aircraft never drift endlessly.
 */
export function projectPositionBySpeed(
  lat: number,
  lon: number,
  trackDeg: number,
  gsKts: number | null,
  elapsedSec: number,
  onGround = false
): { lat: number; lon: number } {
  if (
    onGround ||
    gsKts === null ||
    !Number.isFinite(gsKts) ||
    gsKts < 5 ||
    elapsedSec <= 0
  ) {
    return { lat, lon };
  }

  const clampedSec = Math.min(15, Math.max(0, elapsedSec));
  const speedMetersPerSec = gsKts * 0.5144444; // 1852 / 3600
  const distMeters = speedMetersPerSec * clampedSec;
  if (distMeters < 0.5) {
    return { lat, lon };
  }

  const trackRad = (trackDeg * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const cosLat = Math.max(0.2, Math.cos(latRad));

  const nextLat = lat + (distMeters * Math.cos(trackRad)) / 111_320;
  const nextLon = lon + (distMeters * Math.sin(trackRad)) / (111_320 * cosLat);

  return { lat: nextLat, lon: nextLon };
}

export interface InterpolatedAircraftState {
  point: PositionPoint;
  resolvedTrack: number;
  trailPositions: PositionPoint[];
}

/**
 * Smooth 60 fps interpolation at playheadMs between two recorded 10s points
 * + slicing trail strictly up to playheadMs.
 */
export function interpolatePassageAtTime(
  positions: PositionPoint[],
  playheadMs: number
): InterpolatedAircraftState | null {
  if (positions.length === 0) return null;

  const first = positions[0];
  const last = positions[positions.length - 1];

  // Not yet entered at playheadMs
  if (playheadMs < first.t) return null;
  // Already exited (allow 15s grace only if single point, otherwise exited)
  if (playheadMs > last.t) return null;

  if (positions.length === 1) {
    return {
      point: first,
      resolvedTrack: resolveTrackAtIndex(positions, 0),
      trailPositions: [first],
    };
  }

  // Find bracketing points [i, i+1]
  let idx = 0;
  for (let i = 0; i < positions.length - 1; i++) {
    if (positions[i].t <= playheadMs && playheadMs <= positions[i + 1].t) {
      idx = i;
      break;
    }
  }

  const p0 = positions[idx];
  const p1 = positions[idx + 1];
  const span = Math.max(1, p1.t - p0.t);
  const ratio = Math.max(0, Math.min(1, (playheadMs - p0.t) / span));

  const lat = roundCoord6(p0.lat + (p1.lat - p0.lat) * ratio);
  const lon = roundCoord6(p0.lon + (p1.lon - p0.lon) * ratio);

  const lerpOpt = (v0: number | null, v1: number | null): number | null => {
    if (v0 !== null && v1 !== null) return Math.round(v0 + (v1 - v0) * ratio);
    return v0 ?? v1 ?? null;
  };

  const alt_m = lerpOpt(p0.alt_m, p1.alt_m);
  const alt_ft = lerpOpt(p0.alt_ft, p1.alt_ft);
  const alt_baro_m = lerpOpt(p0.alt_baro_m, p1.alt_baro_m);
  const alt_baro_ft = lerpOpt(p0.alt_baro_ft, p1.alt_baro_ft);
  const alt_geom_m = lerpOpt(p0.alt_geom_m, p1.alt_geom_m);
  const alt_geom_ft = lerpOpt(p0.alt_geom_ft, p1.alt_geom_ft);
  const gs = lerpOpt(p0.gs, p1.gs);
  const vrate = lerpOpt(p0.vrate, p1.vrate);

  const tr0 = resolveTrackAtIndex(positions, idx);
  const tr1 = resolveTrackAtIndex(positions, idx + 1);
  const resolvedTrack = Math.round(interpolateAngleDeg(tr0, tr1, ratio));

  const interpPoint: PositionPoint = {
    t: playheadMs,
    lat,
    lon,
    alt_m,
    alt_ft,
    alt_baro_m,
    alt_baro_ft,
    alt_geom_m,
    alt_geom_ft,
    on_ground: ratio < 0.5 ? p0.on_ground : p1.on_ground,
    gs,
    track: resolvedTrack,
    vrate,
    src: ratio < 0.5 ? p0.src : p1.src,
  };

  const trailPositions = positions.slice(0, idx + 1);
  trailPositions.push(interpPoint);

  return {
    point: interpPoint,
    resolvedTrack,
    trailPositions,
  };
}

export function getCompassDirection(deg: number | null): string {
  if (deg === null || !Number.isFinite(deg)) return '—';
  const directions = [
    'N', 'NNO', 'NO', 'ONO',
    'O', 'OZO', 'ZO', 'ZZO',
    'Z', 'ZZW', 'ZW', 'WZW',
    'W', 'WNW', 'NW', 'NNW',
  ];
  const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return directions[idx];
}

export function formatAltitudeLabel(altFt: number | null, altM: number | null, onGround = false): string {
  if (onGround) return 'Op de grond';
  if (altFt === null && altM === null) return 'Hoogte onbekend';
  const ft = altFt !== null ? altFt : metersToFeet(altM!);
  const m = altM !== null ? altM : feetToMeters(altFt!);
  return `${ft.toLocaleString('nl-NL')} ft / ${m.toLocaleString('nl-NL')} m`;
}

export function formatDateTimeNL(iso: string | null | undefined, includeSeconds = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
  });
}

export function formatTimeNL(iso: string | null | undefined, includeSeconds = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
  });
}

export function formatTimeUTC(iso: string | null | undefined, includeSeconds = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return (
    d.toLocaleTimeString('nl-NL', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      ...(includeSeconds ? { second: '2-digit' } : {}),
    }) + ' UTC'
  );
}

export function formatDurationSeconds(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (isNaN(start) || isNaN(end)) return '—';
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec} sec`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m ${String(remSec).padStart(2, '0')}s`;
}

export const TRAFFIC_CATEGORY_LABELS: Record<TrafficCategory, string> = {
  commercial: 'Commercieel',
  general_aviation: 'General Aviation / Sport',
  hems_police_sar: 'Traumaheli / Politie / SAR',
  military: 'Defensie / Militair',
  unknown: 'Onbekend',
};

export const TRAFFIC_CATEGORY_SHORT: Record<TrafficCategory, string> = {
  commercial: 'Lijnvlucht',
  general_aviation: 'Sport / VFR',
  hems_police_sar: 'HEMS / Politie / SAR',
  military: 'Defensie',
  unknown: 'Onbekend',
};

const NL_MONTHS_SHORT = [
  'jan',
  'feb',
  'mrt',
  'apr',
  'mei',
  'jun',
  'jul',
  'aug',
  'sep',
  'okt',
  'nov',
  'dec',
];

function getTimeZoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const hr = map.hour === 24 ? 0 : map.hour;
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, hr, map.minute, map.second);
  return asUtc - utcMs;
}

function localMidnightToUtcMs(year: number, monthIndex: number, day: number): number {
  const approx = Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
  const offset = getTimeZoneOffsetMs('Europe/Amsterdam', approx);
  return approx - offset;
}

export interface IsoWeekInfo {
  weekKey: string;
  year: number;
  weekNumber: number;
  label: string;
  startMs: number;
  endMs: number;
}

export function getIsoWeekBoundsFromKey(weekKey: string): IsoWeekInfo | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const weekNumber = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(weekNumber) || weekNumber < 1 || weekNumber > 53) {
    return null;
  }

  // ISO week 1 always contains Jan 4
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Monday=1 .. Sunday=7
  const week1MondayUtc = new Date(Date.UTC(year, 0, 4 - (jan4Day - 1)));
  const targetMondayUtc = new Date(
    week1MondayUtc.getTime() + (weekNumber - 1) * 7 * 86_400_000
  );
  const targetSundayUtc = new Date(targetMondayUtc.getTime() + 6 * 86_400_000);

  const startMs = localMidnightToUtcMs(
    targetMondayUtc.getUTCFullYear(),
    targetMondayUtc.getUTCMonth(),
    targetMondayUtc.getUTCDate()
  );
  const nextMondayUtc = new Date(targetMondayUtc.getTime() + 7 * 86_400_000);
  const endMs =
    localMidnightToUtcMs(
      nextMondayUtc.getUTCFullYear(),
      nextMondayUtc.getUTCMonth(),
      nextMondayUtc.getUTCDate()
    ) - 1;

  const monDay = targetMondayUtc.getUTCDate();
  const monMon = NL_MONTHS_SHORT[targetMondayUtc.getUTCMonth()];
  const sunDay = targetSundayUtc.getUTCDate();
  const sunMon = NL_MONTHS_SHORT[targetSundayUtc.getUTCMonth()];

  return {
    weekKey: `${year}-W${String(weekNumber).padStart(2, '0')}`,
    year,
    weekNumber,
    label: `Week ${weekNumber} · ${year} (${monDay} ${monMon} – ${sunDay} ${sunMon})`,
    startMs,
    endMs,
  };
}

export function getAmsterdamIsoWeekInfo(input: Date | number | string): IsoWeekInfo {
  const d = input instanceof Date ? input : new Date(input);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(isNaN(d.getTime()) ? new Date() : d);

  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }

  const utcDate = new Date(Date.UTC(map.year, map.month - 1, map.day));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const isoYear = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const key = `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
  return (
    getIsoWeekBoundsFromKey(key) || {
      weekKey: key,
      year: isoYear,
      weekNumber: weekNo,
      label: `Week ${weekNo} · ${isoYear}`,
      startMs: d.getTime(),
      endMs: d.getTime(),
    }
  );
}
