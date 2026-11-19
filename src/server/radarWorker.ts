import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point } from '@turf/helpers';
import { RadarDatabase } from './radarDb';
import {
  AdjacentBoundariesCollection,
  AdjacentMunicipalityFeature,
  MunicipalityBoundaryFeature,
  PassageWithTrack,
  PositionPoint,
  RouteStatus,
  TrafficCategory,
} from '../types/radar';
import { computeBearingDeg, feetToMeters, roundCoord6 } from '../lib/geoUtils';

const PDOK_GM1708_URL =
  'https://api.pdok.nl/kadaster/brk-bestuurlijke-gebieden/ogc/v1/collections/gemeentegebied/items?identificatie=GM1708';

const HELI_REG_OR_CALLSIGN = [
  'PH-TTR',
  'PH-LLN',
  'PH-UMC',
  'PH-DOC',
  'PH-HLP',
  'PH-HOW',
  'PH-OOP',
  'PH-PXX',
  'PH-PXA',
  'PH-PXB',
  'PH-PXC',
  'PH-PXD',
  'PH-PXE',
  'PH-PXF',
  'LIFELN',
  'ZULU',
  'RSQ',
  'CHX2',
  'SAR',
  'MEDEVAC',
  'POLIT',
];

const MIL_CALLSIGN_PREFIXES = [
  'NAF',
  'RCH',
  'NATO',
  'GAF',
  'BAF',
  'FAF',
  'RRR',
  'ASY',
  'MMF',
  'SHF',
  'KAF',
  'DRK',
  'ORION',
  'REDSC',
];

const AIRLINE_CALLSIGN_RE = /^[A-Z]{3}[0-9]{1,4}[A-Z]{0,2}$/;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R_KM = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distKm = R_KM * c;
  return distKm / 1.852;
}

function computeCentroidAndRadiusNm(coords: number[][][][]): {
  centroidLat: number;
  centroidLon: number;
  pollRadiusNm: number;
} {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;

  const allPts: Array<[number, number]> = [];
  for (const poly of coords) {
    for (const ring of poly) {
      for (const pt of ring) {
        const lon = Number(pt[0]);
        const lat = Number(pt[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          allPts.push([lat, lon]);
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
        }
      }
    }
  }

  const centroidLat = allPts.length ? Number(((minLat + maxLat) / 2).toFixed(5)) : 52.766;
  const centroidLon = allPts.length ? Number(((minLon + maxLon) / 2).toFixed(5)) : 6.062;

  let maxNm = 15;
  for (const [lat, lon] of allPts) {
    const d = haversineNm(centroidLat, centroidLon, lat, lon);
    if (d > maxNm) maxNm = d;
  }

  // Max radius + 10 NM buffer per blueprint, clamped safely between 20 and 45 NM
  const pollRadiusNm = Math.max(20, Math.min(45, Math.ceil(maxNm + 10)));
  return { centroidLat, centroidLon, pollRadiusNm };
}

interface NeighborTrackState {
  icao24: string;
  municipalityCode: string;
  municipalityName: string;
  callsign: string | null;
  registration: string | null;
  icao_type_code: string | null;
  adsb_category: string | null;
  is_military: boolean;
  has_mlat_positions: boolean;
  positions: PositionPoint[];
  lastSeenMs: number;
  etaSeconds: number | null;
}

function computePolygonBbox(coords: number[][][][]): {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
} {
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  for (const poly of coords) {
    for (const ring of poly) {
      for (const pt of ring) {
        if (pt[0] < minLon) minLon = pt[0];
        if (pt[0] > maxLon) maxLon = pt[0];
        if (pt[1] < minLat) minLat = pt[1];
        if (pt[1] > maxLat) maxLat = pt[1];
      }
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

export class RadarWorker {
  private db: RadarDatabase;
  private boundary: MunicipalityBoundaryFeature;
  private boundaryBbox: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  private adjacentBoundaries: AdjacentBoundariesCollection;
  private adjacentWithBbox: Array<{
    feature: AdjacentMunicipalityFeature;
    bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number };
  }> = [];
  private neighborTracks = new Map<string, NeighborTrackState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private failoverUntilMs = 0;
  private backoffUntilMs = 0;
  private enrichmentInFlight = new Set<string>();
  private enrichmentQueue: string[] = [];
  private isEnriching = false;

  constructor(
    db: RadarDatabase,
    fallbackPolygonPath: string,
    adjacentPolygonPath?: string
  ) {
    this.db = db;
    this.boundary = this.loadInitialBoundary(fallbackPolygonPath);
    this.boundaryBbox = computePolygonBbox(this.boundary.geometry.coordinates);
    this.adjacentBoundaries = this.loadAdjacentBoundaries(adjacentPolygonPath);
    this.adjacentWithBbox = this.adjacentBoundaries.features.map((feature) => ({
      feature,
      bbox: computePolygonBbox(feature.geometry.coordinates),
    }));
  }

  private loadAdjacentBoundaries(adjacentPolygonPath?: string): AdjacentBoundariesCollection {
    if (!adjacentPolygonPath) {
      return { type: 'FeatureCollection', features: [] };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(adjacentPolygonPath, 'utf-8'));
      if (raw?.type === 'FeatureCollection' && Array.isArray(raw.features)) {
        return raw as AdjacentBoundariesCollection;
      }
    } catch (err) {
      console.warn('[Radar] Kon aangrenzende gemeenten niet laden:', err);
    }
    return { type: 'FeatureCollection', features: [] };
  }

  public getAdjacentBoundaries(): AdjacentBoundariesCollection {
    return this.adjacentBoundaries;
  }

  public getApproachingPassages(): PassageWithTrack[] {
    const now = Date.now();
    const out: PassageWithTrack[] = [];
    for (const st of this.neighborTracks.values()) {
      if (now - st.lastSeenMs > 45_000 || st.positions.length === 0) continue;
      if (st.etaSeconds === null) continue;

      const first = st.positions[0];
      const last = st.positions[st.positions.length - 1];
      const altsM = st.positions.map((p) => p.alt_m).filter((v): v is number => v !== null);
      const altsFt = st.positions.map((p) => p.alt_ft).filter((v): v is number => v !== null);
      const registry = this.db.getAircraftRegistry(st.icao24);
      const category = this.classifyTraffic({
        callsign: st.callsign,
        registration: st.registration || registry?.registration || null,
        icaoTypeCode: st.icao_type_code || registry?.icao_type_code || null,
        operatorName: registry?.operator_name || null,
        adsbCategory: st.adsb_category,
        isMilitary: st.is_military || Boolean(registry?.is_military),
      });

      out.push({
        passage: {
          id: `approach-${st.icao24}`,
          municipality_code: st.municipalityCode,
          icao24: st.icao24,
          callsign: st.callsign,
          flight_number_iata: null,
          registration: st.registration || registry?.registration || null,
          icao_type_code: st.icao_type_code || registry?.icao_type_code || null,
          model_name: registry?.model_name || null,
          operator_name: registry?.operator_name || null,
          traffic_category: category,
          adsb_category: st.adsb_category,
          is_military: st.is_military || Boolean(registry?.is_military),
          has_mlat_positions: st.has_mlat_positions,
          entry_time: new Date(first.t).toISOString(),
          last_seen_time: new Date(last.t).toISOString(),
          exit_time: null,
          is_active: true,
          entry_lat: first.lat,
          entry_lon: first.lon,
          exit_lat: null,
          exit_lon: null,
          min_alt_m: altsM.length ? Math.min(...altsM) : null,
          max_alt_m: altsM.length ? Math.max(...altsM) : null,
          min_alt_ft: altsFt.length ? Math.min(...altsFt) : null,
          max_alt_ft: altsFt.length ? Math.max(...altsFt) : null,
          point_count: st.positions.length,
          dep_icao: null,
          dep_iata: null,
          dep_airport_name: null,
          arr_icao: null,
          arr_iata: null,
          arr_airport_name: null,
          scheduled_departure: null,
          actual_departure: null,
          scheduled_arrival: null,
          estimated_arrival: null,
          route_status: 'not_applicable_vfr_mil',
          enrichment_source: 'visual_approach',
          visual_only: true,
          neighbor_municipality: st.municipalityName,
          eta_seconds: st.etaSeconds,
        },
        positions: st.positions,
      });
    }
    return out;
  }

  private findAdjacentMunicipality(
    lat: number,
    lon: number
  ): { code: string; name: string } | null {
    const pt = point([lon, lat]);
    for (const item of this.adjacentWithBbox) {
      const { bbox, feature } = item;
      if (
        lon < bbox.minLon ||
        lon > bbox.maxLon ||
        lat < bbox.minLat ||
        lat > bbox.maxLat
      ) {
        continue;
      }
      try {
        if (booleanPointInPolygon(pt, feature as any)) {
          return { code: feature.properties.code, name: feature.properties.name };
        }
      } catch {
        // Negeer ongeldige geometrie
      }
    }
    return null;
  }

  /**
   * Controleert of een toestel in een aangrenzende gemeente op basis van zijn actuele koers
   * naar verwachting binnen ~35 km over Gemeente Steenwijkerland (GM1708) zal vliegen.
   * Geeft de geschatte ETA in seconden terug, of null als het toestel NIET naar GM1708 vliegt.
   */
  private projectEntryEtaSeconds(
    lat: number,
    lon: number,
    trackDeg: number | null,
    gsKts: number | null
  ): number | null {
    if (trackDeg === null || !Number.isFinite(trackDeg)) return null;
    if (gsKts !== null && gsKts < 25) return null;

    const latRad = (lat * Math.PI) / 180;
    const cosLat = Math.max(0.2, Math.cos(latRad));
    const speedKts = gsKts !== null && gsKts > 25 ? gsKts : 120;
    const speedKmPerSec = (speedKts * 1.852) / 3600;

    // Test exacte koers (0°) en minimale koersmarge (±2.5°) tot max 36 km vooruit
    const angleOffsets = [0, -2.5, 2.5];
    for (let distKm = 0.5; distKm <= 36; distKm += 1.0) {
      for (const offset of angleOffsets) {
        const bearingRad = (((trackDeg + offset) % 360) * Math.PI) / 180;
        const projLat = lat + (distKm * Math.cos(bearingRad)) / 111.32;
        const projLon = lon + (distKm * Math.sin(bearingRad)) / (111.32 * cosLat);

        if (
          projLon < this.boundaryBbox.minLon ||
          projLon > this.boundaryBbox.maxLon ||
          projLat < this.boundaryBbox.minLat ||
          projLat > this.boundaryBbox.maxLat
        ) {
          continue;
        }
        if (this.isInsideGM1708(projLat, projLon)) {
          return Math.max(1, Math.round(distKm / speedKmPerSec));
        }
      }
    }
    return null;
  }

  private loadInitialBoundary(fallbackPolygonPath: string): MunicipalityBoundaryFeature {
    const existing = this.db.getMunicipalityBoundary('GM1708');
    if (existing && existing.geometry?.coordinates?.length) {
      return existing;
    }

    let coordinates: number[][][][] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(fallbackPolygonPath, 'utf-8'));
      if (raw?.type === 'MultiPolygon' && Array.isArray(raw.coordinates)) {
        coordinates = raw.coordinates;
      } else if (raw?.type === 'Polygon' && Array.isArray(raw.coordinates)) {
        coordinates = [raw.coordinates];
      }
    } catch (err) {
      console.warn('Kon fallback GM1708 polygoon niet laden:', err);
    }

    const { centroidLat, centroidLon, pollRadiusNm } = computeCentroidAndRadiusNm(coordinates);
    const feature: MunicipalityBoundaryFeature = {
      type: 'Feature',
      properties: {
        code: 'GM1708',
        cbs_code: '1708',
        name: 'Steenwijkerland',
        centroid_lat: centroidLat,
        centroid_lon: centroidLon,
        poll_radius_nm: pollRadiusNm,
        source_url: PDOK_GM1708_URL,
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates,
      },
    };
    this.db.upsertMunicipality(feature, pollRadiusNm);
    return feature;
  }

  public getBoundary(): MunicipalityBoundaryFeature {
    return this.boundary;
  }

  public async refreshBoundaryFromPDOK(): Promise<void> {
    try {
      const res = await fetch(PDOK_GM1708_URL, {
        headers: { Accept: 'application/geo+json, application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return;
      const json: any = await res.json();
      const firstFeature = Array.isArray(json?.features) ? json.features[0] : json;
      const geom = firstFeature?.geometry;
      if (!geom) return;

      let coords: number[][][][] | null = null;
      if (geom.type === 'MultiPolygon' && Array.isArray(geom.coordinates)) {
        coords = geom.coordinates;
      } else if (geom.type === 'Polygon' && Array.isArray(geom.coordinates)) {
        coords = [geom.coordinates];
      }
      if (!coords || coords.length === 0) return;

      const { centroidLat, centroidLon, pollRadiusNm } = computeCentroidAndRadiusNm(coords);
      const updated: MunicipalityBoundaryFeature = {
        type: 'Feature',
        properties: {
          code: 'GM1708',
          cbs_code: '1708',
          name: 'Steenwijkerland',
          centroid_lat: centroidLat,
          centroid_lon: centroidLon,
          poll_radius_nm: pollRadiusNm,
          source_url: PDOK_GM1708_URL,
        },
        geometry: {
          type: 'MultiPolygon',
          coordinates: coords,
        },
      };
      this.boundary = updated;
      this.boundaryBbox = computePolygonBbox(coords);
      this.db.upsertMunicipality(updated, pollRadiusNm);
      console.log(
        `[Radar] PDOK GM1708 polygoon bijgewerkt (centroid ${centroidLat}, ${centroidLon}, radius ${pollRadiusNm} NM)`
      );
    } catch {
      // Blijf veilig op lokaal gecachete GM1708-polygoon draaien
    }
  }

  public isInsideGM1708(lat: number, lon: number): boolean {
    if (!this.boundary?.geometry?.coordinates?.length) return false;
    try {
      return booleanPointInPolygon(point([lon, lat]), this.boundary as any);
    } catch {
      return false;
    }
  }

  public start() {
    this.refreshBoundaryFromPDOK().catch(() => {});
    setTimeout(() => {
      this.pollOnce().catch(() => {});
    }, 800);

    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, 5_000);

    this.pruneTimer = setInterval(() => {
      try {
        this.db.pruneOldPositions(90);
      } catch (err) {
        console.warn('[Radar] Prune fout:', err);
      }
    }, 24 * 60 * 60 * 1000);
  }

  public stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private async fetchFeed(): Promise<{ source: string; aircraft: any[] }> {
    const lat = this.boundary.properties.centroid_lat;
    const lon = this.boundary.properties.centroid_lon;
    const dist = this.boundary.properties.poll_radius_nm ?? 25;
    const flyItalyKey = process.env.FLYITALY_API_KEY;

    const endpoints: Array<{ name: string; url: string; headers?: Record<string, string> }> = [];
    const preferFailover = Date.now() < this.failoverUntilMs;

    if (!preferFailover) {
      endpoints.push({
        name: 'adsb.fi',
        url: `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`,
      });
    }
    endpoints.push({
      name: 'adsb.lol',
      url: `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    });
    if (preferFailover) {
      endpoints.push({
        name: 'adsb.fi',
        url: `https://opendata.adsb.fi/api/v3/lat/${lat}/lon/${lon}/dist/${dist}`,
      });
    }
    if (flyItalyKey) {
      endpoints.push({
        name: 'flyitalyadsb',
        url: `https://api.flyitalyadsb.com/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
        headers: { 'X-API-Key': flyItalyKey },
      });
    }

    let lastErr = 'Geen actieve ADS-B feed bereikbaar';
    for (const ep of endpoints) {
      try {
        const res = await fetch(ep.url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'SteenwijkerlandLuchtverkeerRadar/1.0 (+https://lijstvanandel.nl)',
            ...(ep.headers || {}),
          },
          signal: AbortSignal.timeout(6500),
        });

        if (res.status === 429) {
          this.backoffUntilMs = Date.now() + 15_000;
          if (ep.name === 'adsb.fi') {
            this.failoverUntilMs = Date.now() + 60_000;
          }
          lastErr = `HTTP 429 van ${ep.name} (15s backoff)`;
          continue;
        }

        if (!res.ok) {
          if (ep.name === 'adsb.fi') {
            this.failoverUntilMs = Date.now() + 60_000;
          }
          lastErr = `HTTP ${res.status} van ${ep.name}`;
          continue;
        }

        const data: any = await res.json();
        const ac = Array.isArray(data?.ac)
          ? data.ac
          : Array.isArray(data?.aircraft)
          ? data.aircraft
          : [];
        return { source: ep.name, aircraft: ac };
      } catch (err: any) {
        if (ep.name === 'adsb.fi') {
          this.failoverUntilMs = Date.now() + 60_000;
        }
        lastErr = err?.message || `Timeout op ${ep.name}`;
      }
    }

    throw new Error(lastErr);
  }

  public async pollOnce(): Promise<{ ok: boolean; inRadius: number; inGm1708: number; error?: string }> {
    if (this.isPolling) {
      const h = this.db.getHealth();
      return { ok: true, inRadius: h.aircraft_in_radius, inGm1708: h.aircraft_in_gm1708 };
    }
    if (Date.now() < this.backoffUntilMs) {
      const h = this.db.getHealth();
      return { ok: false, inRadius: h.aircraft_in_radius, inGm1708: h.aircraft_in_gm1708, error: 'Backoff actief' };
    }

    this.isPolling = true;
    const pollIso = new Date().toISOString();

    try {
      const { source, aircraft } = await this.fetchFeed();
      const nowMs = Date.now();
      const activeIcaosInGm1708 = new Set<string>();
      const activeIcaosInNeighbors = new Set<string>();
      const newPassagesToEnrich: string[] = [];

      for (const raw of aircraft) {
        const hex = raw?.hex ? String(raw.hex).trim().toLowerCase() : '';
        if (!hex) continue;

        const lat = Number(raw?.lat);
        const lon = Number(raw?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

        // Negeer stale ADS-B posities > 45 seconden
        if (raw?.seen_pos !== undefined && Number(raw.seen_pos) > 45) continue;

        const seenPosOffsetSec =
          raw?.seen_pos !== undefined && Number.isFinite(Number(raw.seen_pos))
            ? Math.max(0, Math.min(45, Number(raw.seen_pos)))
            : 0;
        const recordedMs = Math.round(nowMs - seenPosOffsetSec * 1000);
        const recordedAtIso = new Date(recordedMs).toISOString();

        // Defensieve parsing alt_baro (number | 'ground' | undefined)
        let onGround = false;
        let altBaroFt: number | null = null;
        let altBaroM: number | null = null;

        if (raw?.alt_baro === 'ground') {
          onGround = true;
          altBaroFt = 0;
          altBaroM = 0;
        } else if (typeof raw?.alt_baro === 'number' && Number.isFinite(raw.alt_baro)) {
          altBaroFt = Math.round(raw.alt_baro);
          altBaroM = feetToMeters(altBaroFt);
        }

        let altGeomFt: number | null = null;
        let altGeomM: number | null = null;
        if (typeof raw?.alt_geom === 'number' && Number.isFinite(raw.alt_geom)) {
          altGeomFt = Math.round(raw.alt_geom);
          altGeomM = feetToMeters(altGeomFt);
        }

        const gs =
          typeof raw?.gs === 'number' && Number.isFinite(raw.gs)
            ? Number(raw.gs.toFixed(1))
            : null;
        // Track blijft null als de transponder of MLAT geen koers uitzendt!
        const trackDeg =
          typeof raw?.track === 'number' && Number.isFinite(raw.track)
            ? Number(((raw.track % 360) + 360) % 360)
            : null;
        const vrate =
          typeof raw?.baro_rate === 'number' && Number.isFinite(raw.baro_rate)
            ? Math.round(raw.baro_rate)
            : typeof raw?.geom_rate === 'number' && Number.isFinite(raw.geom_rate)
            ? Math.round(raw.geom_rate)
            : null;

        const posSource = raw?.type ? String(raw.type) : 'adsb_icao';
        const isMlat = posSource === 'mlat';
        const isMilitary = Boolean((Number(raw?.dbFlags || 0) & 1) !== 0);

        const callsign = raw?.flight ? String(raw.flight).trim() || null : null;
        const registration = raw?.r ? String(raw.r).trim() || null : null;
        const icaoTypeCode = raw?.t ? String(raw.t).trim() || null : null;
        const adsbCategory = raw?.category ? String(raw.category).trim() || null : null;
        const cleanLat = roundCoord6(lat);
        const cleanLon = roundCoord6(lon);

        // 1. Check strikt Gemeente Steenwijkerland (GM1708) — ENIGE bron voor DB-metingen & CSV!
        if (!this.isInsideGM1708(lat, lon)) {
          // 2. Buiten GM1708: controleer ALLEEN de 7 direct aangrenzende gemeenten voor visuele vooraankondiging
          if (!onGround) {
            const neighbor = this.findAdjacentMunicipality(lat, lon);
            if (neighbor) {
              activeIcaosInNeighbors.add(hex);
              const existing = this.neighborTracks.get(hex);
              const newPos: PositionPoint = {
                t: recordedMs,
                lat: cleanLat,
                lon: cleanLon,
                alt_m: altBaroM ?? altGeomM,
                alt_ft: altBaroFt ?? altGeomFt,
                alt_baro_m: altBaroM,
                alt_baro_ft: altBaroFt,
                alt_geom_m: altGeomM,
                alt_geom_ft: altGeomFt,
                on_ground: onGround,
                gs,
                track: trackDeg,
                vrate,
                src: posSource,
              };

              let resolvedForForecast = trackDeg;
              const prevPts = existing ? existing.positions : [];
              if (resolvedForForecast === null && prevPts.length > 0) {
                const prevPt = prevPts[prevPts.length - 1];
                if (
                  Math.abs(cleanLat - prevPt.lat) > 1e-4 ||
                  Math.abs(cleanLon - prevPt.lon) > 1e-4
                ) {
                  resolvedForForecast = computeBearingDeg(
                    prevPt.lat,
                    prevPt.lon,
                    cleanLat,
                    cleanLon
                  );
                } else if (prevPt.track !== null) {
                  resolvedForForecast = prevPt.track;
                }
              }

              const etaSec = this.projectEntryEtaSeconds(
                cleanLat,
                cleanLon,
                resolvedForForecast,
                gs
              );

              const nextPositions = [...prevPts.slice(-17), newPos];
              this.neighborTracks.set(hex, {
                icao24: hex,
                municipalityCode: neighbor.code,
                municipalityName: neighbor.name,
                callsign: callsign || existing?.callsign || null,
                registration: registration || existing?.registration || null,
                icao_type_code: icaoTypeCode || existing?.icao_type_code || null,
                adsb_category: adsbCategory || existing?.adsb_category || null,
                is_military: isMilitary || Boolean(existing?.is_military),
                has_mlat_positions: isMlat || Boolean(existing?.has_mlat_positions),
                positions: nextPositions,
                lastSeenMs: nowMs,
                etaSeconds: etaSec,
              });
            }
          }
          continue;
        }

        // Zodra het toestel GM1708 binnenkomt, stopt het tijdelijke buurspoor; alleen GM1708 telt voor metingen
        this.neighborTracks.delete(hex);
        activeIcaosInGm1708.add(hex);

        const openPassage = this.db.findOpenPassageForIcao(hex, nowMs - 180_000);

        const posPayload = {
          alt_baro_ft: altBaroFt,
          alt_baro_m: altBaroM,
          alt_geom_ft: altGeomFt,
          alt_geom_m: altGeomM,
          on_ground: onGround,
          ground_speed_kts: gs,
          track_deg: trackDeg,
          vertical_rate_fpm: vrate,
          position_source: posSource,
          is_mlat: isMlat,
        };

        if (openPassage) {
          const hadCallsign = Boolean(openPassage.callsign);
          this.db.appendPositionToPassage(
            openPassage,
            {
              icao24: hex,
              callsign,
              registration,
              icao_type_code: icaoTypeCode,
              adsb_category: adsbCategory,
              is_military: isMilitary,
              has_mlat_positions: isMlat,
              recordedAtIso,
              recordedMs,
              lat: cleanLat,
              lon: cleanLon,
            },
            posPayload
          );
          if (
            (!hadCallsign && callsign) ||
            openPassage.route_status === 'pending'
          ) {
            newPassagesToEnrich.push(openPassage.id);
          }
        } else {
          const passageId = `pass-${hex}-${recordedMs}-${crypto.randomBytes(2).toString('hex')}`;
          this.db.createPassageAndFirstPosition(
            {
              id: passageId,
              icao24: hex,
              callsign,
              registration,
              icao_type_code: icaoTypeCode,
              adsb_category: adsbCategory,
              is_military: isMilitary,
              has_mlat_positions: isMlat,
              recordedAtIso,
              recordedMs,
              lat: cleanLat,
              lon: cleanLon,
            },
            posPayload
          );
          newPassagesToEnrich.push(passageId);
        }
      }

      // Schoon verouderde buurgemeente-tracks op die niet langer in de 7 buurgemeenten vliegen
      for (const [hexKey, st] of this.neighborTracks.entries()) {
        if (!activeIcaosInNeighbors.has(hexKey) || nowMs - st.lastSeenMs > 45_000) {
          this.neighborTracks.delete(hexKey);
        }
      }

      // Sluit passages af als vliegtuig gemeente GM1708 verlaten heeft of >90s niet gezien is
      this.db.closeExitedPassages(activeIcaosInGm1708, nowMs - 90_000);

      this.db.updateHealth({
        active_feed_source: source,
        last_poll_at: pollIso,
        last_success_at: pollIso,
        last_error: null,
        aircraft_in_radius: aircraft.length,
        aircraft_in_gm1708: activeIcaosInGm1708.size,
      });

      for (const pid of newPassagesToEnrich) {
        this.enqueueEnrichment(pid);
      }

      return {
        ok: true,
        inRadius: aircraft.length,
        inGm1708: activeIcaosInGm1708.size,
      };
    } catch (err: any) {
      const msg = err?.message || 'Onbekende poll-fout';
      this.db.updateHealth({
        last_poll_at: pollIso,
        last_error: msg,
        aircraft_in_gm1708: 0,
      });
      return { ok: false, inRadius: 0, inGm1708: 0, error: msg };
    } finally {
      this.isPolling = false;
    }
  }

  private enqueueEnrichment(passageId: string) {
    if (this.enrichmentInFlight.has(passageId)) return;
    this.enrichmentInFlight.add(passageId);
    this.enrichmentQueue.push(passageId);
    if (!this.isEnriching) {
      this.processEnrichmentQueue().catch(() => {});
    }
  }

  private async processEnrichmentQueue() {
    this.isEnriching = true;
    try {
      while (this.enrichmentQueue.length > 0) {
        const passageId = this.enrichmentQueue.shift()!;
        try {
          await this.enrichPassage(passageId);
        } catch {
          // Fouten in achtergrondverrijking mogen de 10s radar-loop nooit raken
        } finally {
          this.enrichmentInFlight.delete(passageId);
        }
      }
    } finally {
      this.isEnriching = false;
    }
  }

  private classifyTraffic(params: {
    callsign: string | null;
    registration: string | null;
    icaoTypeCode: string | null;
    operatorName: string | null;
    adsbCategory: string | null;
    isMilitary: boolean;
  }): TrafficCategory {
    const cs = (params.callsign || '').toUpperCase();
    const reg = (params.registration || '').toUpperCase();
    const type = (params.icaoTypeCode || '').toUpperCase();
    const op = (params.operatorName || '').toUpperCase();
    const adsb = (params.adsbCategory || '').toUpperCase();

    if (
      HELI_REG_OR_CALLSIGN.some(
        (p) => reg.startsWith(p) || cs.startsWith(p)
      ) ||
      op.includes('ANWB') ||
      op.includes('POLITIE') ||
      op.includes('TRAUMA') ||
      op.includes('COASTGUARD') ||
      op.includes('KUSTWACHT') ||
      op.includes('SAR')
    ) {
      return 'hems_police_sar';
    }

    if (
      params.isMilitary ||
      MIL_CALLSIGN_PREFIXES.some((p) => cs.startsWith(p)) ||
      op.includes('AIR FORCE') ||
      op.includes('LUCHTMACHT') ||
      op.includes('DEFENS') ||
      op.includes('MILIT') ||
      op.includes('NAVY') ||
      op.includes('ARMY') ||
      ['NH90', 'H64', 'AH64', 'CH47', 'H47', 'F16', 'F35', 'C130', 'K35R', 'KC30', 'A332'].includes(
        type
      )
    ) {
      return 'military';
    }

    if (AIRLINE_CALLSIGN_RE.test(cs)) {
      return 'commercial';
    }

    if (
      adsb === 'A1' ||
      adsb === 'A2' ||
      adsb === 'B1' ||
      adsb === 'B2' ||
      adsb === 'B6' ||
      reg.startsWith('PH-') ||
      cs.startsWith('PH') ||
      ['C150', 'C152', 'C172', 'C182', 'PA28', 'PA46', 'SR20', 'SR22', 'DR40', 'DA40', 'DA42', 'R44', 'R22', 'R66'].includes(
        type
      )
    ) {
      return 'general_aviation';
    }

    if (adsb === 'A3' || adsb === 'A4' || adsb === 'A5') {
      return 'commercial';
    }

    return 'unknown';
  }

  private async lookupAirport(code: string | null): Promise<{
    icao: string | null;
    iata: string | null;
    name: string | null;
  }> {
    if (!code) return { icao: null, iata: null, name: null };
    const clean = code.trim().toUpperCase();
    const cached = this.db.getAirportByCode(clean);
    if (cached) {
      return {
        icao: cached.icao_code,
        iata: cached.iata_code,
        name: cached.name,
      };
    }

    if (clean.length === 4) {
      try {
        const res = await fetch(`https://hexdb.io/api/v1/airport/icao/${clean}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const j: any = await res.json();
          if (j?.airport) {
            this.db.upsertAirport({
              icao_code: j.icao || clean,
              iata_code: j.iata || null,
              name: j.airport,
              city: j.region_name || null,
              country_code: j.country_code || null,
              timezone_iana: null,
              lat: j.latitude ? Number(j.latitude) : null,
              lon: j.longitude ? Number(j.longitude) : null,
            });
            return {
              icao: j.icao || clean,
              iata: j.iata || null,
              name: j.airport,
            };
          }
        }
      } catch {
        // Negeer netwerkfout
      }
    }
    return {
      icao: clean.length === 4 ? clean : null,
      iata: clean.length === 3 ? clean : null,
      name: null,
    };
  }

  private async enrichPassage(passageId: string) {
    const row = this.db.getPassageById(passageId);
    if (!row) return;

    const hex = String(row.icao24).toLowerCase();
    let reg = row.registration as string | null;
    let typeCode = row.icao_type_code as string | null;
    let modelName = row.model_name as string | null;
    let operatorName = row.operator_name as string | null;
    let isMilitary = Boolean(row.is_military);

    // STAP 1: Check lokale aircraft_registry, anders hexdb.io
    let registry = this.db.getAircraftRegistry(hex);
    if (!registry) {
      try {
        const res = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, {
          signal: AbortSignal.timeout(4500),
        });
        if (res.ok) {
          const j: any = await res.json();
          if (j && !j.status) {
            reg = reg || (j.Registration ? String(j.Registration).trim() : null);
            typeCode = typeCode || (j.ICAOTypeCode ? String(j.ICAOTypeCode).trim() : null);
            const mfg = j.Manufacturer ? String(j.Manufacturer).trim() : '';
            const mdl = j.Type ? String(j.Type).trim() : '';
            modelName = modelName || ([mfg, mdl].filter(Boolean).join(' ') || null);
            operatorName = operatorName || (j.RegisteredOwners ? String(j.RegisteredOwners).trim() : null);
            const opIcao = j.OperatorFlagCode ? String(j.OperatorFlagCode).trim() : null;

            const hint = this.classifyTraffic({
              callsign: row.callsign,
              registration: reg,
              icaoTypeCode: typeCode,
              operatorName,
              adsbCategory: row.adsb_category,
              isMilitary,
            });
            if (hint === 'military') isMilitary = true;

            this.db.upsertAircraftRegistry({
              icao24: hex,
              registration: reg,
              icao_type_code: typeCode,
              model_name: modelName,
              manufacturer: mfg || null,
              operator_name: operatorName,
              operator_icao: opIcao,
              adsb_category: row.adsb_category,
              is_military: isMilitary,
              traffic_hint: hint,
              source: 'hexdb',
            });
            registry = this.db.getAircraftRegistry(hex);
          }
        }
      } catch {
        // Fallback zonder hexdb
      }
    } else {
      reg = reg || registry.registration;
      typeCode = typeCode || registry.icao_type_code;
      modelName = modelName || registry.model_name;
      operatorName = operatorName || registry.operator_name;
      isMilitary = isMilitary || registry.is_military;
    }

    // STAP 2: Regelgebaseerde classificatie
    const category = this.classifyTraffic({
      callsign: row.callsign,
      registration: reg,
      icaoTypeCode: typeCode,
      operatorName,
      adsbCategory: row.adsb_category,
      isMilitary,
    });
    if (category === 'military') isMilitary = true;

    const callsign = row.callsign ? String(row.callsign).trim().toUpperCase() : null;

    if (category !== 'commercial' || !callsign || !AIRLINE_CALLSIGN_RE.test(callsign)) {
      this.db.updatePassageEnrichment(passageId, {
        registration: reg,
        icao_type_code: typeCode,
        model_name: modelName,
        operator_name: operatorName,
        traffic_category: category,
        is_military: isMilitary,
        route_status: 'not_applicable_vfr_mil',
        enrichment_source: registry ? 'hexdb+rule' : 'rule',
      });
      return;
    }

    // STAP 3: Callsign deduplicatie binnen 6 uur
    const sixHoursAgoIso = new Date(Date.now() - 6 * 3600_000).toISOString();
    const cachedRoute = this.db.findRecentEnrichedCallsign(callsign, sixHoursAgoIso);
    if (cachedRoute) {
      this.db.updatePassageEnrichment(passageId, {
        flight_number_iata: cachedRoute.flight_number_iata,
        registration: reg,
        icao_type_code: typeCode,
        model_name: modelName,
        operator_name: operatorName || cachedRoute.operator_name,
        traffic_category: category,
        is_military: isMilitary,
        dep_icao: cachedRoute.dep_icao,
        dep_iata: cachedRoute.dep_iata,
        dep_airport_name: cachedRoute.dep_airport_name,
        arr_icao: cachedRoute.arr_icao,
        arr_iata: cachedRoute.arr_iata,
        arr_airport_name: cachedRoute.arr_airport_name,
        scheduled_departure: cachedRoute.scheduled_departure,
        actual_departure: cachedRoute.actual_departure,
        scheduled_arrival: cachedRoute.scheduled_arrival,
        estimated_arrival: cachedRoute.estimated_arrival,
        route_status: cachedRoute.route_status as RouteStatus,
        enrichment_source: 'cache_6h',
      });
      return;
    }

    // STAP 4: Optionele commerciële vluchtdetails (AirLabs < 30/dag, AeroDataBox < 18/dag)
    const health = this.db.getHealth();
    const airlabsKey = process.env.AIRLABS_API_KEY;
    const aeroKey = process.env.AERODATABOX_API_KEY;
    let quotaHit = false;

    if (airlabsKey) {
      if ((health.airlabs_calls_today || 0) < 30) {
        try {
          this.db.incrementApiCalls('airlabs');
          const res = await fetch(
            `https://airlabs.co/api/v9/flight?flight_icao=${encodeURIComponent(callsign)}&api_key=${encodeURIComponent(airlabsKey)}`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (res.ok) {
            const j: any = await res.json();
            const f = j?.response;
            if (f && (f.dep_icao || f.dep_iata || f.arr_icao || f.arr_iata)) {
              const dep = await this.lookupAirport(f.dep_icao || f.dep_iata || null);
              const arr = await this.lookupAirport(f.arr_icao || f.arr_iata || null);
              const hasTimes = Boolean(f.dep_time_utc || f.arr_time_utc || f.dep_estimated_utc || f.arr_estimated_utc);
              this.db.updatePassageEnrichment(passageId, {
                flight_number_iata: f.flight_iata || null,
                registration: reg,
                icao_type_code: typeCode,
                model_name: modelName,
                operator_name: operatorName || f.airline_name || null,
                traffic_category: category,
                is_military: isMilitary,
                dep_icao: f.dep_icao || dep.icao,
                dep_iata: f.dep_iata || dep.iata,
                dep_airport_name: dep.name,
                arr_icao: f.arr_icao || arr.icao,
                arr_iata: f.arr_iata || arr.iata,
                arr_airport_name: arr.name,
                scheduled_departure: f.dep_time_utc || null,
                actual_departure: f.dep_actual_utc || f.dep_estimated_utc || null,
                scheduled_arrival: f.arr_time_utc || null,
                estimated_arrival: f.arr_estimated_utc || null,
                route_status: hasTimes ? 'enriched' : 'partial_route_only',
                enrichment_source: 'airlabs',
              });
              return;
            }
          }
        } catch {
          // Ga door naar gratis fallback
        }
      } else {
        quotaHit = true;
      }
    }

    if (aeroKey) {
      if ((health.aerodatabox_calls_today || 0) < 18) {
        try {
          this.db.incrementApiCalls('aerodatabox');
          const res = await fetch(
            `https://aerodatabox.p.rapidapi.com/flights/callsign/${encodeURIComponent(callsign)}`,
            {
              headers: {
                'X-RapidAPI-Key': aeroKey,
                'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
              },
              signal: AbortSignal.timeout(5000),
            }
          );
          if (res.ok) {
            const arrRes: any = await res.json();
            const f = Array.isArray(arrRes) ? arrRes[0] : arrRes;
            if (f?.departure?.airport || f?.arrival?.airport) {
              this.db.updatePassageEnrichment(passageId, {
                flight_number_iata: f.number || null,
                registration: reg,
                icao_type_code: typeCode,
                model_name: modelName,
                operator_name: operatorName || f.airline?.name || null,
                traffic_category: category,
                is_military: isMilitary,
                dep_icao: f.departure?.airport?.icao || null,
                dep_iata: f.departure?.airport?.iata || null,
                dep_airport_name: f.departure?.airport?.name || null,
                arr_icao: f.arrival?.airport?.icao || null,
                arr_iata: f.arrival?.airport?.iata || null,
                arr_airport_name: f.arrival?.airport?.name || null,
                scheduled_departure: f.departure?.scheduledTime?.utc || null,
                actual_departure: f.departure?.revisedTime?.utc || f.departure?.runwayTime?.utc || null,
                scheduled_arrival: f.arrival?.scheduledTime?.utc || null,
                estimated_arrival: f.arrival?.predictedTime?.utc || f.arrival?.revisedTime?.utc || null,
                route_status: 'enriched',
                enrichment_source: 'aerodatabox',
              });
              return;
            }
          }
        } catch {
          // Ga door naar gratis fallback
        }
      } else {
        quotaHit = true;
      }
    }

    // STAP 5: Gratis route-fallback via adsbdb.com & hexdb.io
    try {
      const res = await fetch(
        `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
        { signal: AbortSignal.timeout(4500) }
      );
      if (res.ok) {
        const j: any = await res.json();
        const fr = j?.response?.flightroute;
        if (fr?.origin || fr?.destination) {
          this.db.updatePassageEnrichment(passageId, {
            flight_number_iata: fr.callsign_iata || null,
            registration: reg,
            icao_type_code: typeCode,
            model_name: modelName,
            operator_name: operatorName || fr.airline?.name || null,
            traffic_category: category,
            is_military: isMilitary,
            dep_icao: fr.origin?.icao_code || null,
            dep_iata: fr.origin?.iata_code || null,
            dep_airport_name: fr.origin?.name || null,
            arr_icao: fr.destination?.icao_code || null,
            arr_iata: fr.destination?.iata_code || null,
            arr_airport_name: fr.destination?.name || null,
            route_status: 'partial_route_only',
            enrichment_source: 'adsbdb',
          });
          return;
        }
      }
    } catch {
      // Probeer hexdb route
    }

    try {
      const res = await fetch(
        `https://hexdb.io/api/v1/route/icao/${encodeURIComponent(callsign)}`,
        { signal: AbortSignal.timeout(4500) }
      );
      if (res.ok) {
        const j: any = await res.json();
        if (typeof j?.route === 'string' && j.route.includes('-')) {
          const parts = j.route.split('-');
          const dep = await this.lookupAirport(parts[0]);
          const arr = await this.lookupAirport(parts[1]);
          this.db.updatePassageEnrichment(passageId, {
            registration: reg,
            icao_type_code: typeCode,
            model_name: modelName,
            operator_name: operatorName,
            traffic_category: category,
            is_military: isMilitary,
            dep_icao: dep.icao,
            dep_iata: dep.iata,
            dep_airport_name: dep.name,
            arr_icao: arr.icao,
            arr_iata: arr.iata,
            arr_airport_name: arr.name,
            route_status: 'partial_route_only',
            enrichment_source: 'hexdb_route',
          });
          return;
        }
      }
    } catch {
      // Negeer netwerkfout
    }

    this.db.updatePassageEnrichment(passageId, {
      registration: reg,
      icao_type_code: typeCode,
      model_name: modelName,
      operator_name: operatorName,
      traffic_category: category,
      is_military: isMilitary,
      route_status: quotaHit ? 'quota_skipped' : 'not_found',
      enrichment_source: quotaHit ? 'quota' : 'none',
    });
  }
}
