import {
  AllHistoryHeatmapResponse,
  HeatmapCell,
  MunicipalityBoundaryFeature,
} from '../types/radar';
import { roundCoord6 } from './geoUtils';

export const HEATMAP_ORIGIN_LAT = 52.6;
export const HEATMAP_ORIGIN_LON = 5.75;
export const HEATMAP_CELL_LAT = 0.0036; // ~400.7 m N-S
export const HEATMAP_CELL_LON = 0.006; // ~403.5 m O-W rond 52.76°N
export const HEATMAP_CELL_SIZE_M = 400;

export function latLonToHeatmapCell(
  lat: number,
  lon: number
): { r: number; c: number; key: string } {
  const r = Math.floor((lat - HEATMAP_ORIGIN_LAT) / HEATMAP_CELL_LAT);
  const c = Math.floor((lon - HEATMAP_ORIGIN_LON) / HEATMAP_CELL_LON);
  return { r, c, key: `${r}:${c}` };
}

export function heatmapCellBounds(r: number, c: number) {
  const south = roundCoord6(HEATMAP_ORIGIN_LAT + r * HEATMAP_CELL_LAT);
  const north = roundCoord6(south + HEATMAP_CELL_LAT);
  const west = roundCoord6(HEATMAP_ORIGIN_LON + c * HEATMAP_CELL_LON);
  const east = roundCoord6(west + HEATMAP_CELL_LON);
  const centerLat = roundCoord6(HEATMAP_ORIGIN_LAT + (r + 0.5) * HEATMAP_CELL_LAT);
  const centerLon = roundCoord6(HEATMAP_ORIGIN_LON + (c + 0.5) * HEATMAP_CELL_LON);
  return { south, north, west, east, centerLat, centerLon };
}

export function heatmapCellPolygonGeoJson(r: number, c: number) {
  const { south, north, west, east } = heatmapCellBounds(r, c);
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { r, c },
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}

export function buildHeatmapFromTracks(
  tracks: Array<{ id: string; positions: Array<{ lat: number; lon: number }> }>,
  totalPassagesOverride?: number
): AllHistoryHeatmapResponse {
  const globalCounts = new Map<string, { r: number; c: number; count: number }>();
  let totalPositions = 0;

  for (const track of tracks) {
    const pts = track.positions;
    if (!pts || pts.length === 0) continue;
    totalPositions += pts.length;

    const visitedCells = new Set<string>();
    const markPoint = (lat: number, lon: number) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      const cell = latLonToHeatmapCell(lat, lon);
      if (!visitedCells.has(cell.key)) {
        visitedCells.add(cell.key);
        const existing = globalCounts.get(cell.key);
        if (existing) {
          existing.count++;
        } else {
          globalCounts.set(cell.key, { r: cell.r, c: cell.c, count: 1 });
        }
      }
    };

    if (pts.length === 1) {
      markPoint(pts[0].lat, pts[0].lon);
      continue;
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const pA = pts[i];
      const pB = pts[i + 1];
      const dLat = Math.abs(pB.lat - pA.lat) / HEATMAP_CELL_LAT;
      const dLon = Math.abs(pB.lon - pA.lon) / HEATMAP_CELL_LON;
      const steps = Math.max(1, Math.min(250, Math.ceil(Math.max(dLat, dLon) * 3)));
      for (let s = 0; s <= steps; s++) {
        const ratio = s / steps;
        const lat = pA.lat + (pB.lat - pA.lat) * ratio;
        const lon = pA.lon + (pB.lon - pA.lon) * ratio;
        markPoint(lat, lon);
      }
    }
  }

  let maxCount = 0;
  const cells: HeatmapCell[] = [];
  for (const entry of globalCounts.values()) {
    if (entry.count > maxCount) maxCount = entry.count;
    const { centerLat, centerLon } = heatmapCellBounds(entry.r, entry.c);
    cells.push({
      r: entry.r,
      c: entry.c,
      lat: centerLat,
      lon: centerLon,
      count: entry.count,
    });
  }

  return {
    totalPassages: totalPassagesOverride ?? tracks.length,
    totalPositions,
    maxCount,
    originLat: HEATMAP_ORIGIN_LAT,
    originLon: HEATMAP_ORIGIN_LON,
    cellLatDeg: HEATMAP_CELL_LAT,
    cellLonDeg: HEATMAP_CELL_LON,
    cellSizeM: HEATMAP_CELL_SIZE_M,
    cells,
  };
}

function isPointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointInsideBoundary(
  lon: number,
  lat: number,
  boundary: MunicipalityBoundaryFeature
): boolean {
  for (const polygon of boundary.geometry.coordinates) {
    if (polygon.length === 0) continue;
    if (!isPointInRing(lon, lat, polygon[0])) continue;
    let inHole = false;
    for (let h = 1; h < polygon.length; h++) {
      if (isPointInRing(lon, lat, polygon[h])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}
