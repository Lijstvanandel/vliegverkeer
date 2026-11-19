import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import {
  AircraftTypeRankingEntry,
  AirspaceStatsResponse,
  AllHistoryHeatmapResponse,
  AvailableWeekOption,
  CompleteHistoryInsights,
  DailyCountSummary,
  FlightPassage,
  HistoricalReplayResponse,
  IngestionHealth,
  LiveRadarResponse,
  MunicipalityBoundaryFeature,
  OperatorRankingEntry,
  PassageWithTrack,
  PositionPoint,
  RouteStatus,
  StatsPeriod,
  TrafficCategory,
} from '../types/radar';
import { getAmsterdamIsoWeekInfo, getIsoWeekBoundsFromKey } from '../lib/geoUtils';
import { buildHeatmapFromTracks } from '../lib/heatmap';

const ICAO_TYPE_LABELS: Record<string, string> = {
  A20N: 'Airbus A320neo',
  A21N: 'Airbus A321neo',
  A319: 'Airbus A319',
  A320: 'Airbus A320',
  A321: 'Airbus A321',
  A332: 'Airbus A330-200',
  A333: 'Airbus A330-300',
  A359: 'Airbus A350-900',
  A388: 'Airbus A380-800',
  BCS1: 'Airbus A220-100',
  BCS3: 'Airbus A220-300',
  B737: 'Boeing 737-700',
  B738: 'Boeing 737-800',
  B739: 'Boeing 737-900',
  B38M: 'Boeing 737 MAX 8',
  B39M: 'Boeing 737 MAX 9',
  B744: 'Boeing 747-400',
  B748: 'Boeing 747-8',
  B763: 'Boeing 767-300',
  B772: 'Boeing 777-200',
  B77L: 'Boeing 777-200LR / Freighter',
  B77W: 'Boeing 777-300ER',
  B788: 'Boeing 787-8 Dreamliner',
  B789: 'Boeing 787-9 Dreamliner',
  B78X: 'Boeing 787-10 Dreamliner',
  E170: 'Embraer 170',
  E75L: 'Embraer 175 Long Wing',
  E75S: 'Embraer 175 Short Wing',
  E190: 'Embraer 190',
  E195: 'Embraer 195',
  E295: 'Embraer E195-E2',
  DH8D: 'De Havilland Dash 8-400',
  AT76: 'ATR 72-600',
  C172: 'Cessna 172 Skyhawk',
  C152: 'Cessna 152',
  C56X: 'Cessna Citation Excel',
  C650: 'Cessna Citation III',
  C68A: 'Cessna Citation Latitude',
  PC12: 'Pilatus PC-12',
  DA40: 'Diamond DA40',
  DA42: 'Diamond DA42',
  EC35: 'Airbus H135 (EC135)',
  EC45: 'Airbus H145 (EC145)',
  NH90: 'NHIndustries NH90',
  H47: 'Boeing CH-47 Chinook',
  CH47: 'Boeing CH-47 Chinook',
  H64: 'Boeing AH-64 Apache',
  AH64: 'Boeing AH-64 Apache',
  F35: 'Lockheed Martin F-35',
};

export interface AircraftRegistryRow {
  icao24: string;
  registration: string | null;
  icao_type_code: string | null;
  model_name: string | null;
  manufacturer: string | null;
  operator_name: string | null;
  operator_icao: string | null;
  adsb_category: string | null;
  is_military: boolean;
  traffic_hint: TrafficCategory | null;
  source: string;
}

export interface AirportRow {
  icao_code: string;
  iata_code: string | null;
  name: string;
  city: string | null;
  country_code: string | null;
  timezone_iana: string | null;
  lat: number | null;
  lon: number | null;
}

export class RadarDatabase {
  public db: DatabaseSync;
  private backupPath: string | null = null;
  private dirtyForBackup = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.backupPath = path.join(path.dirname(dbPath), 'flightHistoryBackup.json');
    }
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.initSchema();
    this.reconcileBackupOnBoot();
  }

  private initSchema() {
    // Flush eventuele ongesynchroniseerde WAL-frames van eerdere runs voordat we op DELETE overschakelen
    try {
      this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`);
    } catch {
      // Negeer als DB nog geen WAL had
    }

    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS municipalities (
        code TEXT PRIMARY KEY,
        cbs_code TEXT NOT NULL,
        name TEXT NOT NULL,
        geom_json TEXT NOT NULL,
        centroid_lat REAL NOT NULL,
        centroid_lon REAL NOT NULL,
        poll_radius_nm INTEGER NOT NULL DEFAULT 25,
        source_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aircraft_registry (
        icao24 TEXT PRIMARY KEY,
        registration TEXT,
        icao_type_code TEXT,
        model_name TEXT,
        manufacturer TEXT,
        operator_name TEXT,
        operator_icao TEXT,
        adsb_category TEXT,
        is_military INTEGER NOT NULL DEFAULT 0,
        traffic_hint TEXT,
        source TEXT NOT NULL DEFAULT 'hexdb',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS airports (
        icao_code TEXT PRIMARY KEY,
        iata_code TEXT,
        name TEXT NOT NULL,
        city TEXT,
        country_code TEXT,
        timezone_iana TEXT,
        lat REAL,
        lon REAL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_airports_iata ON airports (iata_code);

      CREATE TABLE IF NOT EXISTS flight_passages (
        id TEXT PRIMARY KEY,
        municipality_code TEXT NOT NULL DEFAULT 'GM1708',
        icao24 TEXT NOT NULL,
        callsign TEXT,
        flight_number_iata TEXT,
        registration TEXT,
        icao_type_code TEXT,
        model_name TEXT,
        operator_name TEXT,
        traffic_category TEXT NOT NULL DEFAULT 'unknown',
        adsb_category TEXT,
        is_military INTEGER NOT NULL DEFAULT 0,
        has_mlat_positions INTEGER NOT NULL DEFAULT 0,

        entry_time TEXT NOT NULL,
        entry_ms INTEGER NOT NULL,
        last_seen_time TEXT NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        exit_time TEXT,
        exit_ms INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        entry_lat REAL NOT NULL,
        entry_lon REAL NOT NULL,
        exit_lat REAL,
        exit_lon REAL,

        min_alt_m INTEGER,
        max_alt_m INTEGER,
        min_alt_ft INTEGER,
        max_alt_ft INTEGER,
        point_count INTEGER NOT NULL DEFAULT 1,

        dep_icao TEXT,
        dep_iata TEXT,
        dep_airport_name TEXT,
        arr_icao TEXT,
        arr_iata TEXT,
        arr_airport_name TEXT,
        scheduled_departure TEXT,
        actual_departure TEXT,
        scheduled_arrival TEXT,
        estimated_arrival TEXT,

        route_status TEXT NOT NULL DEFAULT 'pending',
        enrichment_source TEXT,
        enriched_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_passages_active
        ON flight_passages (is_active, last_seen_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_passages_icao_active
        ON flight_passages (icao24, is_active, last_seen_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_passages_entry_ms
        ON flight_passages (entry_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_passages_callsign_enriched
        ON flight_passages (callsign, enriched_at DESC);
      CREATE INDEX IF NOT EXISTS idx_passages_cat_alt
        ON flight_passages (traffic_category, min_alt_m, max_alt_m);

      CREATE TABLE IF NOT EXISTS flight_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        passage_id TEXT NOT NULL REFERENCES flight_passages(id) ON DELETE CASCADE,
        icao24 TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        recorded_ms INTEGER NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        alt_baro_ft INTEGER,
        alt_baro_m INTEGER,
        alt_geom_ft INTEGER,
        alt_geom_m INTEGER,
        on_ground INTEGER NOT NULL DEFAULT 0,
        ground_speed_kts REAL,
        track_deg REAL,
        vertical_rate_fpm INTEGER,
        position_source TEXT NOT NULL DEFAULT 'adsb_icao',
        is_mlat INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_positions_passage_ms
        ON flight_positions (passage_id, recorded_ms ASC);
      CREATE INDEX IF NOT EXISTS idx_positions_recorded_ms
        ON flight_positions (recorded_ms);

      CREATE TABLE IF NOT EXISTS ingestion_health (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_feed_source TEXT NOT NULL DEFAULT 'adsb.fi',
        last_poll_at TEXT,
        last_success_at TEXT,
        last_error TEXT,
        aircraft_in_radius INTEGER NOT NULL DEFAULT 0,
        aircraft_in_gm1708 INTEGER NOT NULL DEFAULT 0,
        airlabs_calls_today INTEGER NOT NULL DEFAULT 0,
        aerodatabox_calls_today INTEGER NOT NULL DEFAULT 0,
        quota_reset_date TEXT NOT NULL
      );
    `);

    const todayStr = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ingestion_health (id, active_feed_source, quota_reset_date) VALUES (1, 'adsb.fi', ?)`
      )
      .run(todayStr);

    // Close any lingering active passages from before server restart if older than 90s
    const cutoff = Date.now() - 90_000;
    this.db
      .prepare(
        `UPDATE flight_passages
         SET is_active = 0, exit_time = last_seen_time, exit_ms = last_seen_ms
         WHERE is_active = 1 AND last_seen_ms < ?`
      )
      .run(cutoff);
  }

  public upsertMunicipality(feature: MunicipalityBoundaryFeature, pollRadiusNm: number) {
    this.db
      .prepare(
        `INSERT INTO municipalities (code, cbs_code, name, geom_json, centroid_lat, centroid_lon, poll_radius_nm, source_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(code) DO UPDATE SET
           geom_json = excluded.geom_json,
           centroid_lat = excluded.centroid_lat,
           centroid_lon = excluded.centroid_lon,
           poll_radius_nm = excluded.poll_radius_nm,
           source_url = excluded.source_url,
           fetched_at = excluded.fetched_at`
      )
      .run(
        feature.properties.code,
        feature.properties.cbs_code,
        feature.properties.name,
        JSON.stringify(feature.geometry),
        feature.properties.centroid_lat,
        feature.properties.centroid_lon,
        pollRadiusNm,
        feature.properties.source_url || '',
        new Date().toISOString()
      );
  }

  public getMunicipalityBoundary(code = 'GM1708'): MunicipalityBoundaryFeature | null {
    const row = this.db
      .prepare(`SELECT * FROM municipalities WHERE code = ?`)
      .get(code) as any;
    if (!row) return null;
    try {
      const geometry = JSON.parse(row.geom_json);
      return {
        type: 'Feature',
        properties: {
          code: row.code,
          cbs_code: row.cbs_code,
          name: row.name,
          centroid_lat: Number(row.centroid_lat),
          centroid_lon: Number(row.centroid_lon),
          poll_radius_nm: Number(row.poll_radius_nm),
          source_url: row.source_url,
        },
        geometry,
      };
    } catch {
      return null;
    }
  }

  public getHealth(): IngestionHealth {
    const todayStr = new Date().toISOString().slice(0, 10);
    const row = this.db.prepare(`SELECT * FROM ingestion_health WHERE id = 1`).get() as any;
    if (!row) {
      return {
        active_feed_source: 'adsb.fi',
        last_poll_at: null,
        last_success_at: null,
        last_error: null,
        aircraft_in_radius: 0,
        aircraft_in_gm1708: 0,
        airlabs_calls_today: 0,
        aerodatabox_calls_today: 0,
      };
    }

    if (row.quota_reset_date !== todayStr) {
      this.db
        .prepare(
          `UPDATE ingestion_health SET airlabs_calls_today = 0, aerodatabox_calls_today = 0, quota_reset_date = ? WHERE id = 1`
        )
        .run(todayStr);
      row.airlabs_calls_today = 0;
      row.aerodatabox_calls_today = 0;
    }

    return {
      active_feed_source: row.active_feed_source,
      last_poll_at: row.last_poll_at,
      last_success_at: row.last_success_at,
      last_error: row.last_error,
      aircraft_in_radius: Number(row.aircraft_in_radius || 0),
      aircraft_in_gm1708: Number(row.aircraft_in_gm1708 || 0),
      airlabs_calls_today: Number(row.airlabs_calls_today || 0),
      aerodatabox_calls_today: Number(row.aerodatabox_calls_today || 0),
    };
  }

  public updateHealth(update: Partial<IngestionHealth>) {
    const current = this.getHealth();
    this.db
      .prepare(
        `UPDATE ingestion_health
         SET active_feed_source = ?,
             last_poll_at = ?,
             last_success_at = ?,
             last_error = ?,
             aircraft_in_radius = ?,
             aircraft_in_gm1708 = ?
         WHERE id = 1`
      )
      .run(
        update.active_feed_source ?? current.active_feed_source,
        update.last_poll_at !== undefined ? update.last_poll_at : current.last_poll_at,
        update.last_success_at !== undefined ? update.last_success_at : current.last_success_at,
        update.last_error !== undefined ? update.last_error : current.last_error,
        update.aircraft_in_radius ?? current.aircraft_in_radius,
        update.aircraft_in_gm1708 ?? current.aircraft_in_gm1708
      );
  }

  public incrementApiCalls(provider: 'airlabs' | 'aerodatabox') {
    this.getHealth(); // ensures daily reset
    const col = provider === 'airlabs' ? 'airlabs_calls_today' : 'aerodatabox_calls_today';
    this.db.prepare(`UPDATE ingestion_health SET ${col} = ${col} + 1 WHERE id = 1`).run();
  }

  public getAircraftRegistry(icao24: string): AircraftRegistryRow | null {
    const row = this.db
      .prepare(`SELECT * FROM aircraft_registry WHERE icao24 = ?`)
      .get(icao24.toLowerCase()) as any;
    if (!row) return null;
    return {
      icao24: row.icao24,
      registration: row.registration,
      icao_type_code: row.icao_type_code,
      model_name: row.model_name,
      manufacturer: row.manufacturer,
      operator_name: row.operator_name,
      operator_icao: row.operator_icao,
      adsb_category: row.adsb_category,
      is_military: Boolean(row.is_military),
      traffic_hint: row.traffic_hint as TrafficCategory | null,
      source: row.source,
    };
  }

  public upsertAircraftRegistry(row: AircraftRegistryRow) {
    this.db
      .prepare(
        `INSERT INTO aircraft_registry (
           icao24, registration, icao_type_code, model_name, manufacturer,
           operator_name, operator_icao, adsb_category, is_military, traffic_hint, source, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(icao24) DO UPDATE SET
           registration = COALESCE(excluded.registration, aircraft_registry.registration),
           icao_type_code = COALESCE(excluded.icao_type_code, aircraft_registry.icao_type_code),
           model_name = COALESCE(excluded.model_name, aircraft_registry.model_name),
           manufacturer = COALESCE(excluded.manufacturer, aircraft_registry.manufacturer),
           operator_name = COALESCE(excluded.operator_name, aircraft_registry.operator_name),
           operator_icao = COALESCE(excluded.operator_icao, aircraft_registry.operator_icao),
           adsb_category = COALESCE(excluded.adsb_category, aircraft_registry.adsb_category),
           is_military = MAX(aircraft_registry.is_military, excluded.is_military),
           traffic_hint = COALESCE(excluded.traffic_hint, aircraft_registry.traffic_hint),
           source = excluded.source,
           updated_at = excluded.updated_at`
      )
      .run(
        row.icao24.toLowerCase(),
        row.registration,
        row.icao_type_code,
        row.model_name,
        row.manufacturer,
        row.operator_name,
        row.operator_icao,
        row.adsb_category,
        row.is_military ? 1 : 0,
        row.traffic_hint,
        row.source,
        new Date().toISOString()
      );
  }

  public getAirportByCode(code: string): AirportRow | null {
    const clean = code.trim().toUpperCase();
    const row = this.db
      .prepare(`SELECT * FROM airports WHERE icao_code = ? OR iata_code = ?`)
      .get(clean, clean) as any;
    if (!row) return null;
    return {
      icao_code: row.icao_code,
      iata_code: row.iata_code,
      name: row.name,
      city: row.city,
      country_code: row.country_code,
      timezone_iana: row.timezone_iana,
      lat: row.lat !== null ? Number(row.lat) : null,
      lon: row.lon !== null ? Number(row.lon) : null,
    };
  }

  public upsertAirport(row: AirportRow) {
    this.db
      .prepare(
        `INSERT INTO airports (icao_code, iata_code, name, city, country_code, timezone_iana, lat, lon, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(icao_code) DO UPDATE SET
           iata_code = COALESCE(excluded.iata_code, airports.iata_code),
           name = excluded.name,
           city = COALESCE(excluded.city, airports.city),
           country_code = COALESCE(excluded.country_code, airports.country_code),
           timezone_iana = COALESCE(excluded.timezone_iana, airports.timezone_iana),
           lat = COALESCE(excluded.lat, airports.lat),
           lon = COALESCE(excluded.lon, airports.lon),
           updated_at = excluded.updated_at`
      )
      .run(
        row.icao_code.toUpperCase(),
        row.iata_code ? row.iata_code.toUpperCase() : null,
        row.name,
        row.city,
        row.country_code,
        row.timezone_iana,
        row.lat,
        row.lon,
        new Date().toISOString()
      );
  }

  public findOpenPassageForIcao(icao24: string, minLastSeenMs: number): any | null {
    return (
      this.db
        .prepare(
          `SELECT * FROM flight_passages
           WHERE icao24 = ? AND is_active = 1 AND last_seen_ms >= ?
           ORDER BY last_seen_ms DESC LIMIT 1`
        )
        .get(icao24.toLowerCase(), minLastSeenMs) || null
    );
  }

  public createPassageAndFirstPosition(
    passage: {
      id: string;
      icao24: string;
      callsign: string | null;
      registration: string | null;
      icao_type_code: string | null;
      adsb_category: string | null;
      is_military: boolean;
      has_mlat_positions: boolean;
      recordedAtIso: string;
      recordedMs: number;
      lat: number;
      lon: number;
    },
    pos: {
      alt_baro_ft: number | null;
      alt_baro_m: number | null;
      alt_geom_ft: number | null;
      alt_geom_m: number | null;
      on_ground: boolean;
      ground_speed_kts: number | null;
      track_deg: number | null;
      vertical_rate_fpm: number | null;
      position_source: string;
      is_mlat: boolean;
    }
  ) {
    const displayAltM = pos.alt_baro_m ?? pos.alt_geom_m;
    const displayAltFt = pos.alt_baro_ft ?? pos.alt_geom_ft;
    const nowIso = new Date().toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO flight_passages (
             id, municipality_code, icao24, callsign, registration, icao_type_code,
             traffic_category, adsb_category, is_military, has_mlat_positions,
             entry_time, entry_ms, last_seen_time, last_seen_ms, is_active,
             entry_lat, entry_lon, min_alt_m, max_alt_m, min_alt_ft, max_alt_ft,
             point_count, route_status, created_at
           ) VALUES (?, 'GM1708', ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 'pending', ?)`
        )
        .run(
          passage.id,
          passage.icao24.toLowerCase(),
          passage.callsign,
          passage.registration,
          passage.icao_type_code,
          passage.adsb_category,
          passage.is_military ? 1 : 0,
          passage.has_mlat_positions ? 1 : 0,
          passage.recordedAtIso,
          passage.recordedMs,
          passage.recordedAtIso,
          passage.recordedMs,
          passage.lat,
          passage.lon,
          displayAltM,
          displayAltM,
          displayAltFt,
          displayAltFt,
          nowIso
        );

      this.db
        .prepare(
          `INSERT INTO flight_positions (
             passage_id, icao24, recorded_at, recorded_ms, lat, lon,
             alt_baro_ft, alt_baro_m, alt_geom_ft, alt_geom_m, on_ground,
             ground_speed_kts, track_deg, vertical_rate_fpm, position_source, is_mlat
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          passage.id,
          passage.icao24.toLowerCase(),
          passage.recordedAtIso,
          passage.recordedMs,
          passage.lat,
          passage.lon,
          pos.alt_baro_ft,
          pos.alt_baro_m,
          pos.alt_geom_ft,
          pos.alt_geom_m,
          pos.on_ground ? 1 : 0,
          pos.ground_speed_kts,
          pos.track_deg,
          pos.vertical_rate_fpm,
          pos.position_source,
          pos.is_mlat ? 1 : 0
        );

      this.db.exec('COMMIT');
      this.dirtyForBackup = true;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public appendPositionToPassage(
    passageRow: any,
    update: {
      icao24: string;
      callsign: string | null;
      registration: string | null;
      icao_type_code: string | null;
      adsb_category: string | null;
      is_military: boolean;
      has_mlat_positions: boolean;
      recordedAtIso: string;
      recordedMs: number;
      lat: number;
      lon: number;
    },
    pos: {
      alt_baro_ft: number | null;
      alt_baro_m: number | null;
      alt_geom_ft: number | null;
      alt_geom_m: number | null;
      on_ground: boolean;
      ground_speed_kts: number | null;
      track_deg: number | null;
      vertical_rate_fpm: number | null;
      position_source: string;
      is_mlat: boolean;
    }
  ) {
    const displayAltM = pos.alt_baro_m ?? pos.alt_geom_m;
    const displayAltFt = pos.alt_baro_ft ?? pos.alt_geom_ft;

    const minAltM =
      displayAltM !== null
        ? passageRow.min_alt_m !== null
          ? Math.min(Number(passageRow.min_alt_m), displayAltM)
          : displayAltM
        : passageRow.min_alt_m;
    const maxAltM =
      displayAltM !== null
        ? passageRow.max_alt_m !== null
          ? Math.max(Number(passageRow.max_alt_m), displayAltM)
          : displayAltM
        : passageRow.max_alt_m;
    const minAltFt =
      displayAltFt !== null
        ? passageRow.min_alt_ft !== null
          ? Math.min(Number(passageRow.min_alt_ft), displayAltFt)
          : displayAltFt
        : passageRow.min_alt_ft;
    const maxAltFt =
      displayAltFt !== null
        ? passageRow.max_alt_ft !== null
          ? Math.max(Number(passageRow.max_alt_ft), displayAltFt)
          : displayAltFt
        : passageRow.max_alt_ft;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO flight_positions (
             passage_id, icao24, recorded_at, recorded_ms, lat, lon,
             alt_baro_ft, alt_baro_m, alt_geom_ft, alt_geom_m, on_ground,
             ground_speed_kts, track_deg, vertical_rate_fpm, position_source, is_mlat
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          passageRow.id,
          update.icao24.toLowerCase(),
          update.recordedAtIso,
          update.recordedMs,
          update.lat,
          update.lon,
          pos.alt_baro_ft,
          pos.alt_baro_m,
          pos.alt_geom_ft,
          pos.alt_geom_m,
          pos.on_ground ? 1 : 0,
          pos.ground_speed_kts,
          pos.track_deg,
          pos.vertical_rate_fpm,
          pos.position_source,
          pos.is_mlat ? 1 : 0
        );

      this.db
        .prepare(
          `UPDATE flight_passages
           SET callsign = COALESCE(?, callsign),
               registration = COALESCE(?, registration),
               icao_type_code = COALESCE(?, icao_type_code),
               adsb_category = COALESCE(?, adsb_category),
               is_military = MAX(is_military, ?),
               has_mlat_positions = MAX(has_mlat_positions, ?),
               last_seen_time = ?,
               last_seen_ms = ?,
               exit_lat = ?,
               exit_lon = ?,
               min_alt_m = ?,
               max_alt_m = ?,
               min_alt_ft = ?,
               max_alt_ft = ?,
               point_count = point_count + 1
           WHERE id = ?`
        )
        .run(
          update.callsign,
          update.registration,
          update.icao_type_code,
          update.adsb_category,
          update.is_military ? 1 : 0,
          update.has_mlat_positions ? 1 : 0,
          update.recordedAtIso,
          update.recordedMs,
          update.lat,
          update.lon,
          minAltM,
          maxAltM,
          minAltFt,
          maxAltFt,
          passageRow.id
        );

      this.db.exec('COMMIT');
      this.dirtyForBackup = true;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  public closeExitedPassages(activeIcaosInGm1708: Set<string>, staleCutoffMs: number) {
    const openRows = this.db
      .prepare(`SELECT id, icao24, last_seen_time, last_seen_ms, exit_lat, exit_lon, entry_lat, entry_lon FROM flight_passages WHERE is_active = 1`)
      .all() as any[];

    const stmtClose = this.db.prepare(
      `UPDATE flight_passages
       SET is_active = 0, exit_time = ?, exit_ms = ?, exit_lat = COALESCE(exit_lat, ?), exit_lon = COALESCE(exit_lon, ?)
       WHERE id = ?`
    );

    let closedAny = false;
    for (const r of openRows) {
      const stillInside = activeIcaosInGm1708.has(String(r.icao24).toLowerCase());
      const isStale = Number(r.last_seen_ms) < staleCutoffMs;
      if (!stillInside || isStale) {
        stmtClose.run(
          r.last_seen_time,
          r.last_seen_ms,
          r.exit_lat ?? r.entry_lat,
          r.exit_lon ?? r.entry_lon,
          r.id
        );
        closedAny = true;
      }
    }
    if (closedAny) {
      this.dirtyForBackup = true;
      this.saveBackupFile();
    }
  }

  public findRecentEnrichedCallsign(callsign: string, minEnrichedIso: string): any | null {
    return (
      this.db
        .prepare(
          `SELECT * FROM flight_passages
           WHERE callsign = ? AND route_status = 'enriched' AND enriched_at >= ?
           ORDER BY enriched_at DESC LIMIT 1`
        )
        .get(callsign, minEnrichedIso) || null
    );
  }

  public updatePassageEnrichment(
    passageId: string,
    fields: {
      flight_number_iata?: string | null;
      registration?: string | null;
      icao_type_code?: string | null;
      model_name?: string | null;
      operator_name?: string | null;
      traffic_category?: TrafficCategory;
      is_military?: boolean;
      dep_icao?: string | null;
      dep_iata?: string | null;
      dep_airport_name?: string | null;
      arr_icao?: string | null;
      arr_iata?: string | null;
      arr_airport_name?: string | null;
      scheduled_departure?: string | null;
      actual_departure?: string | null;
      scheduled_arrival?: string | null;
      estimated_arrival?: string | null;
      route_status: RouteStatus;
      enrichment_source: string;
    }
  ) {
    this.db
      .prepare(
        `UPDATE flight_passages
         SET flight_number_iata = COALESCE(?, flight_number_iata),
             registration = COALESCE(?, registration),
             icao_type_code = COALESCE(?, icao_type_code),
             model_name = COALESCE(?, model_name),
             operator_name = COALESCE(?, operator_name),
             traffic_category = COALESCE(?, traffic_category),
             is_military = MAX(is_military, ?),
             dep_icao = COALESCE(?, dep_icao),
             dep_iata = COALESCE(?, dep_iata),
             dep_airport_name = COALESCE(?, dep_airport_name),
             arr_icao = COALESCE(?, arr_icao),
             arr_iata = COALESCE(?, arr_iata),
             arr_airport_name = COALESCE(?, arr_airport_name),
             scheduled_departure = COALESCE(?, scheduled_departure),
             actual_departure = COALESCE(?, actual_departure),
             scheduled_arrival = COALESCE(?, scheduled_arrival),
             estimated_arrival = COALESCE(?, estimated_arrival),
             route_status = ?,
             enrichment_source = ?,
             enriched_at = ?
         WHERE id = ?`
      )
      .run(
        fields.flight_number_iata ?? null,
        fields.registration ?? null,
        fields.icao_type_code ?? null,
        fields.model_name ?? null,
        fields.operator_name ?? null,
        fields.traffic_category ?? null,
        fields.is_military ? 1 : 0,
        fields.dep_icao ?? null,
        fields.dep_iata ?? null,
        fields.dep_airport_name ?? null,
        fields.arr_icao ?? null,
        fields.arr_iata ?? null,
        fields.arr_airport_name ?? null,
        fields.scheduled_departure ?? null,
        fields.actual_departure ?? null,
        fields.scheduled_arrival ?? null,
        fields.estimated_arrival ?? null,
        fields.route_status,
        fields.enrichment_source,
        new Date().toISOString(),
        passageId
      );
    this.dirtyForBackup = true;
  }

  public getPassageById(id: string): any | null {
    return this.db.prepare(`SELECT * FROM flight_passages WHERE id = ?`).get(id) || null;
  }

  private mapPassageRow(r: any): FlightPassage {
    return {
      id: r.id,
      municipality_code: r.municipality_code,
      icao24: r.icao24,
      callsign: r.callsign,
      flight_number_iata: r.flight_number_iata,
      registration: r.registration,
      icao_type_code: r.icao_type_code,
      model_name: r.model_name,
      operator_name: r.operator_name,
      traffic_category: (r.traffic_category || 'unknown') as TrafficCategory,
      adsb_category: r.adsb_category,
      is_military: Boolean(r.is_military),
      has_mlat_positions: Boolean(r.has_mlat_positions),
      entry_time: r.entry_time,
      last_seen_time: r.last_seen_time,
      exit_time: r.exit_time,
      is_active: Boolean(r.is_active),
      entry_lat: Number(r.entry_lat),
      entry_lon: Number(r.entry_lon),
      exit_lat: r.exit_lat !== null ? Number(r.exit_lat) : null,
      exit_lon: r.exit_lon !== null ? Number(r.exit_lon) : null,
      min_alt_m: r.min_alt_m !== null ? Number(r.min_alt_m) : null,
      max_alt_m: r.max_alt_m !== null ? Number(r.max_alt_m) : null,
      min_alt_ft: r.min_alt_ft !== null ? Number(r.min_alt_ft) : null,
      max_alt_ft: r.max_alt_ft !== null ? Number(r.max_alt_ft) : null,
      point_count: Number(r.point_count || 1),
      dep_icao: r.dep_icao,
      dep_iata: r.dep_iata,
      dep_airport_name: r.dep_airport_name,
      arr_icao: r.arr_icao,
      arr_iata: r.arr_iata,
      arr_airport_name: r.arr_airport_name,
      scheduled_departure: r.scheduled_departure,
      actual_departure: r.actual_departure,
      scheduled_arrival: r.scheduled_arrival,
      estimated_arrival: r.estimated_arrival,
      route_status: (r.route_status || 'pending') as RouteStatus,
      enrichment_source: r.enrichment_source,
    };
  }

  private mapPositionRow(p: any): PositionPoint {
    const altBaroM = p.alt_baro_m !== null ? Number(p.alt_baro_m) : null;
    const altBaroFt = p.alt_baro_ft !== null ? Number(p.alt_baro_ft) : null;
    const altGeomM = p.alt_geom_m !== null ? Number(p.alt_geom_m) : null;
    const altGeomFt = p.alt_geom_ft !== null ? Number(p.alt_geom_ft) : null;
    return {
      t: Number(p.recorded_ms),
      lat: Math.round(Number(p.lat) * 1_000_000) / 1_000_000,
      lon: Math.round(Number(p.lon) * 1_000_000) / 1_000_000,
      alt_m: altBaroM ?? altGeomM,
      alt_ft: altBaroFt ?? altGeomFt,
      alt_baro_m: altBaroM,
      alt_baro_ft: altBaroFt,
      alt_geom_m: altGeomM,
      alt_geom_ft: altGeomFt,
      on_ground: Boolean(p.on_ground),
      gs: p.ground_speed_kts !== null ? Number(p.ground_speed_kts) : null,
      track: p.track_deg !== null ? Number(p.track_deg) : null,
      vrate: p.vertical_rate_fpm !== null ? Number(p.vertical_rate_fpm) : null,
      src: p.position_source || 'adsb_icao',
    };
  }

  public getLiveRadarState(): LiveRadarResponse {
    const health = this.getHealth();
    const cutoff = Date.now() - 90_000;
    const activePassages = this.db
      .prepare(
        `SELECT * FROM flight_passages
         WHERE is_active = 1 AND last_seen_ms >= ?
         ORDER BY last_seen_ms DESC`
      )
      .all(cutoff) as any[];

    const stmtPositions = this.db.prepare(
      `SELECT * FROM flight_positions WHERE passage_id = ? ORDER BY recorded_ms ASC`
    );

    const passages: PassageWithTrack[] = activePassages.map((r) => {
      const posRows = stmtPositions.all(r.id) as any[];
      return {
        passage: this.mapPassageRow(r),
        positions: posRows.map((p) => this.mapPositionRow(p)),
      };
    });

    return { health, passages };
  }

  public getHistoricalReplaySlice(params: {
    startMs: number;
    endMs: number;
    minAltM?: number;
    maxAltM?: number;
    categories?: TrafficCategory[] | null;
    includeUnknownAlt?: boolean;
  }): HistoricalReplayResponse {
    const minAltM = params.minAltM ?? 0;
    const maxAltM = params.maxAltM ?? 20000;
    const includeUnknown = params.includeUnknownAlt ?? true;

    const whereClauses: string[] = [
      `COALESCE(exit_ms, last_seen_ms) >= ?`,
      `entry_ms <= ?`,
    ];
    const args: any[] = [params.startMs, params.endMs];

    if (params.categories && params.categories.length > 0) {
      const placeholders = params.categories.map(() => '?').join(', ');
      whereClauses.push(`traffic_category IN (${placeholders})`);
      args.push(...params.categories);
    }

    if (includeUnknown) {
      whereClauses.push(
        `((max_alt_m >= ? AND min_alt_m <= ?) OR (min_alt_m IS NULL AND max_alt_m IS NULL))`
      );
      args.push(minAltM, maxAltM);
    } else {
      whereClauses.push(`(max_alt_m >= ? AND min_alt_m <= ?)`);
      args.push(minAltM, maxAltM);
    }

    const whereSql = whereClauses.join(' AND ');
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM flight_passages WHERE ${whereSql}`)
      .get(...args) as { cnt: number };
    const totalMatched = Number(countRow?.cnt || 0);
    const truncated = totalMatched > 600;

    const rows = this.db
      .prepare(
        `SELECT * FROM flight_passages WHERE ${whereSql} ORDER BY entry_ms ASC LIMIT 600`
      )
      .all(...args) as any[];

    const stmtPositions = this.db.prepare(
      `SELECT * FROM flight_positions
       WHERE passage_id = ? AND recorded_ms BETWEEN ? AND ?
       ORDER BY recorded_ms ASC`
    );

    const passages: PassageWithTrack[] = rows.map((r) => {
      const posRows = stmtPositions.all(r.id, params.startMs, params.endMs) as any[];
      return {
        passage: this.mapPassageRow(r),
        positions: posRows.map((p) => this.mapPositionRow(p)),
      };
    });

    return {
      total_matched: totalMatched,
      truncated,
      passages,
    };
  }

  public getAvailableWeeks(): AvailableWeekOption[] {
    const nowInfo = getAmsterdamIsoWeekInfo(Date.now());
    const weekMap = new Map<string, AvailableWeekOption>();
    weekMap.set(nowInfo.weekKey, {
      weekKey: nowInfo.weekKey,
      year: nowInfo.year,
      weekNumber: nowInfo.weekNumber,
      label: nowInfo.label,
      count: 0,
    });

    const tsRows = this.db
      .prepare(`SELECT entry_ms FROM flight_passages ORDER BY entry_ms DESC`)
      .all() as Array<{ entry_ms: number }>;

    for (const r of tsRows) {
      const info = getAmsterdamIsoWeekInfo(Number(r.entry_ms));
      const ex = weekMap.get(info.weekKey);
      if (ex) {
        ex.count++;
      } else {
        weekMap.set(info.weekKey, {
          weekKey: info.weekKey,
          year: info.year,
          weekNumber: info.weekNumber,
          label: info.label,
          count: 1,
        });
      }
    }

    return Array.from(weekMap.values()).sort((a, b) => b.weekKey.localeCompare(a.weekKey));
  }

  private resolvePeriodBounds(
    period: StatsPeriod,
    weekKey?: string | null
  ): { minMs: number; maxMs: number; weekKey: string | null; weekLabel: string | null } {
    const now = Date.now();
    if (period === 'hour') {
      return { minMs: now - 3_600_000, maxMs: now + 60_000, weekKey: null, weekLabel: null };
    }
    if (period === 'day') {
      return { minMs: now - 86_400_000, maxMs: now + 60_000, weekKey: null, weekLabel: null };
    }
    if (period === 'week') {
      return { minMs: now - 7 * 86_400_000, maxMs: now + 60_000, weekKey: null, weekLabel: null };
    }
    if (period === 'weeknum') {
      const parsed = weekKey ? getIsoWeekBoundsFromKey(weekKey) : null;
      const resolved = parsed || getAmsterdamIsoWeekInfo(now);
      return {
        minMs: resolved.startMs,
        maxMs: resolved.endMs,
        weekKey: resolved.weekKey,
        weekLabel: resolved.label,
      };
    }
    return { minMs: 0, maxMs: now + 60_000, weekKey: null, weekLabel: null };
  }

  public getAirspaceStats(period: StatsPeriod, weekKey?: string | null): AirspaceStatsResponse {
    const availableWeeks = this.getAvailableWeeks();
    const effectiveWeekKey =
      period === 'weeknum' ? weekKey || availableWeeks[0]?.weekKey || null : null;
    const bounds = this.resolvePeriodBounds(period, effectiveWeekKey);

    const rows = this.db
      .prepare(
        `SELECT * FROM flight_passages
         WHERE entry_ms >= ? AND entry_ms <= ?
         ORDER BY entry_ms DESC`
      )
      .all(bounds.minMs, bounds.maxMs) as any[];

    const totalPassages = rows.length;
    const activePassages = rows.filter((r) => Boolean(r.is_active)).length;
    const totalPositions = rows.reduce((acc, r) => acc + Number(r.point_count || 0), 0);
    const mlatPassages = rows.filter((r) => Boolean(r.has_mlat_positions)).length;

    const validMaxAlts = rows
      .map((r) => (r.max_alt_m !== null ? Number(r.max_alt_m) : null))
      .filter((v): v is number => v !== null);
    const avgAltitudeM = validMaxAlts.length
      ? Math.round(validMaxAlts.reduce((a, b) => a + b, 0) / validMaxAlts.length)
      : null;

    let lowestRow: any = null;
    let highestRow: any = null;
    let lowAltitudeCount = 0;

    for (const r of rows) {
      if (r.min_alt_m !== null && Number.isFinite(Number(r.min_alt_m))) {
        const minVal = Number(r.min_alt_m);
        if (minVal <= 1000) lowAltitudeCount++;
        if (!lowestRow || minVal < Number(lowestRow.min_alt_m)) {
          lowestRow = r;
        }
      }
      if (r.max_alt_m !== null && Number.isFinite(Number(r.max_alt_m))) {
        const maxVal = Number(r.max_alt_m);
        if (!highestRow || maxVal > Number(highestRow.max_alt_m)) {
          highestRow = r;
        }
      }
    }

    const minAltitudeM = lowestRow ? Number(lowestRow.min_alt_m) : null;
    const maxAltitudeM = highestRow ? Number(highestRow.max_alt_m) : null;
    const lowestFlight = lowestRow ? this.mapPassageRow(lowestRow) : null;
    const highestFlight = highestRow ? this.mapPassageRow(highestRow) : null;

    const catCounts = new Map<TrafficCategory, number>();
    const opMap = new Map<string, { count: number; category: TrafficCategory }>();
    const hourMap = new Map<string, number>();

    for (const r of rows) {
      const cat = (r.traffic_category || 'unknown') as TrafficCategory;
      catCounts.set(cat, (catCounts.get(cat) || 0) + 1);

      const op = r.operator_name || 'Onbekende operator';
      const existingOp = opMap.get(op);
      if (existingOp) {
        existingOp.count++;
      } else {
        opMap.set(op, { count: 1, category: cat });
      }

      const d = new Date(r.entry_time);
      const hourLabel =
        d.toLocaleTimeString('nl-NL', {
          timeZone: 'Europe/Amsterdam',
          hour: '2-digit',
        }) + ':00';
      hourMap.set(hourLabel, (hourMap.get(hourLabel) || 0) + 1);
    }

    const categories: TrafficCategory[] = [
      'commercial',
      'hems_police_sar',
      'general_aviation',
      'military',
      'unknown',
    ];
    const byCategory = categories.map((cat) => {
      const count = catCounts.get(cat) || 0;
      return {
        category: cat,
        count,
        sharePct: totalPassages > 0 ? Number(((count / totalPassages) * 100).toFixed(1)) : 0,
      };
    });

    const topOperators = Array.from(opMap.entries())
      .map(([operator, info]) => ({ operator, count: info.count, category: info.category }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);

    const hourlyDistribution = Array.from(hourMap.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));

    return {
      period,
      weekKey: bounds.weekKey,
      weekLabel: bounds.weekLabel,
      availableWeeks,
      totalPassages,
      activePassages,
      totalPositions,
      avgAltitudeM,
      minAltitudeM,
      maxAltitudeM,
      lowAltitudeCount,
      lowestFlight,
      highestFlight,
      mlatPassages,
      byCategory,
      topOperators,
      hourlyDistribution,
      recentPassages: rows.slice(0, 100).map((r) => this.mapPassageRow(r)),
      allTimeInsights: this.computeCompleteHistoryInsights(),
    };
  }

  public computeCompleteHistoryInsights(): CompleteHistoryInsights {
    const allRows = this.db
      .prepare(
        `SELECT operator_name, traffic_category, icao_type_code, model_name, entry_time, entry_ms, min_alt_m, max_alt_m
         FROM flight_passages
         ORDER BY entry_ms ASC`
      )
      .all() as Array<{
      operator_name: string | null;
      traffic_category: string | null;
      icao_type_code: string | null;
      model_name: string | null;
      entry_time: string;
      entry_ms: number;
      min_alt_m: number | null;
      max_alt_m: number | null;
    }>;

    const dayFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const labelFmt = new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    const dayCounts = new Map<string, { label: string; count: number }>();
    const opMap = new Map<
      string,
      { count: number; altSum: number; altCount: number; category: TrafficCategory }
    >();
    const typeMap = new Map<
      string,
      {
        icaoTypeCode: string | null;
        modelCounts: Map<string, number>;
        count: number;
        altSum: number;
        altCount: number;
      }
    >();

    for (const r of allRows) {
      const d = new Date(Number(r.entry_ms) || r.entry_time);
      if (!isNaN(d.getTime())) {
        const dateKey = dayFmt.format(d);
        const existingDay = dayCounts.get(dateKey);
        if (existingDay) {
          existingDay.count++;
        } else {
          dayCounts.set(dateKey, { label: labelFmt.format(d), count: 1 });
        }
      }

      const minA = r.min_alt_m !== null ? Number(r.min_alt_m) : null;
      const maxA = r.max_alt_m !== null ? Number(r.max_alt_m) : null;
      const midAltM =
        minA !== null && maxA !== null && Number.isFinite(minA) && Number.isFinite(maxA)
          ? (minA + maxA) / 2
          : maxA !== null && Number.isFinite(maxA)
          ? maxA
          : minA !== null && Number.isFinite(minA)
          ? minA
          : null;

      const cat = (r.traffic_category || 'unknown') as TrafficCategory;
      const rawOp = (r.operator_name || '').trim();
      if (rawOp && rawOp.toLowerCase() !== 'onbekende operator') {
        const exOp = opMap.get(rawOp);
        if (exOp) {
          exOp.count++;
          if (midAltM !== null) {
            exOp.altSum += midAltM;
            exOp.altCount++;
          }
        } else {
          opMap.set(rawOp, {
            count: 1,
            altSum: midAltM !== null ? midAltM : 0,
            altCount: midAltM !== null ? 1 : 0,
            category: cat,
          });
        }
      }

      const cleanIcaoType = (r.icao_type_code || '').trim().toUpperCase() || null;
      const cleanModel = (r.model_name || '').trim() || null;
      const typeKey = cleanIcaoType || (cleanModel ? cleanModel.toUpperCase() : null);
      if (typeKey) {
        let exType = typeMap.get(typeKey);
        if (!exType) {
          exType = {
            icaoTypeCode: cleanIcaoType,
            modelCounts: new Map<string, number>(),
            count: 0,
            altSum: 0,
            altCount: 0,
          };
          typeMap.set(typeKey, exType);
        }
        exType.count++;
        if (cleanModel) {
          exType.modelCounts.set(cleanModel, (exType.modelCounts.get(cleanModel) || 0) + 1);
        }
        if (midAltM !== null) {
          exType.altSum += midAltM;
          exType.altCount++;
        }
      }
    }

    const sortedDays: DailyCountSummary[] = Array.from(dayCounts.entries())
      .map(([dateKey, info]) => ({
        dateKey,
        label: info.label,
        count: info.count,
      }))
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

    let quietestDay: DailyCountSummary | null = null;
    let busiestDay: DailyCountSummary | null = null;
    for (const day of sortedDays) {
      if (!quietestDay || day.count < quietestDay.count) {
        quietestDay = day;
      }
      if (!busiestDay || day.count > busiestDay.count) {
        busiestDay = day;
      }
    }

    const topOperators: OperatorRankingEntry[] = Array.from(opMap.entries())
      .map(([operator, info]) => ({
        operator,
        count: info.count,
        avgAltitudeM: info.altCount > 0 ? Math.round(info.altSum / info.altCount) : null,
        category: info.category,
      }))
      .sort((a, b) => b.count - a.count || a.operator.localeCompare(b.operator))
      .slice(0, 10);

    const topAircraftTypes: AircraftTypeRankingEntry[] = Array.from(typeMap.entries())
      .map(([typeKey, info]) => {
        const mappedName = info.icaoTypeCode ? ICAO_TYPE_LABELS[info.icaoTypeCode] : undefined;
        let topModel: string | null = null;
        let topModelCount = -1;
        for (const [mName, cnt] of info.modelCounts.entries()) {
          if (cnt > topModelCount) {
            topModel = mName;
            topModelCount = cnt;
          }
        }
        return {
          typeKey,
          typeLabel: mappedName || topModel || info.icaoTypeCode || typeKey,
          icaoTypeCode: info.icaoTypeCode,
          count: info.count,
          avgAltitudeM: info.altCount > 0 ? Math.round(info.altSum / info.altCount) : null,
        };
      })
      .sort((a, b) => b.count - a.count || a.typeLabel.localeCompare(b.typeLabel))
      .slice(0, 10);

    return {
      totalPassages: allRows.length,
      totalDays: sortedDays.length,
      quietestDay,
      busiestDay,
      topOperators,
      topAircraftTypes,
    };
  }

  public getAllHistoryHeatmap(): AllHistoryHeatmapResponse {
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM flight_passages`)
      .get() as { cnt: number };
    const totalPassages = Number(countRow?.cnt || 0);

    const posRows = this.db
      .prepare(
        `SELECT passage_id, lat, lon
         FROM flight_positions
         ORDER BY passage_id ASC, recorded_ms ASC`
      )
      .all() as Array<{ passage_id: string; lat: number; lon: number }>;

    const trackMap = new Map<string, Array<{ lat: number; lon: number }>>();
    for (const row of posRows) {
      let arr = trackMap.get(row.passage_id);
      if (!arr) {
        arr = [];
        trackMap.set(row.passage_id, arr);
      }
      arr.push({ lat: Number(row.lat), lon: Number(row.lon) });
    }

    const tracks = Array.from(trackMap.entries()).map(([id, positions]) => ({
      id,
      positions,
    }));

    return buildHeatmapFromTracks(tracks, totalPassages);
  }

  public exportPassagesCSV(period: StatsPeriod, weekKey?: string | null): string {
    const bounds = this.resolvePeriodBounds(period, weekKey);

    const rows = this.db
      .prepare(
        `SELECT * FROM flight_passages
         WHERE entry_ms >= ? AND entry_ms <= ?
         ORDER BY entry_ms DESC LIMIT 5000`
      )
      .all(bounds.minMs, bounds.maxMs) as any[];

    const headers = [
      'Passage ID',
      'ICAO24',
      'Callsign',
      'Registratie',
      'Toesteltype',
      'Model',
      'Operator',
      'Verkeerscategorie',
      'Militair',
      'MLAT',
      'Intrede (ISO)',
      'Uittrede (ISO)',
      'Intrede Lat',
      'Intrede Lon',
      'Uittrede Lat',
      'Uittrede Lon',
      'Min Hoogte (m)',
      'Max Hoogte (m)',
      'Min Hoogte (ft)',
      'Max Hoogte (ft)',
      'Punten',
      'Vertrek ICAO',
      'Vertrek IATA',
      'Vertrek Luchthaven',
      'Aankomst ICAO',
      'Aankomst IATA',
      'Aankomst Luchthaven',
      'Geplande Vertrektijd',
      'Werkelijke Vertrektijd',
      'Geplande Aankomst',
      'Geschatte Aankomst (ETA)',
      'Routestatus',
      'Verrijkingsbron',
    ];

    const esc = (v: unknown) => {
      const s = String(v ?? '');
      if (s.includes(';') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [headers.map(esc).join(';')];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.icao24,
          r.callsign || '',
          r.registration || '',
          r.icao_type_code || '',
          r.model_name || '',
          r.operator_name || '',
          r.traffic_category,
          r.is_military ? 'Ja' : 'Nee',
          r.has_mlat_positions ? 'Ja' : 'Nee',
          r.entry_time,
          r.exit_time || 'Actief',
          r.entry_lat,
          r.entry_lon,
          r.exit_lat ?? '',
          r.exit_lon ?? '',
          r.min_alt_m ?? '',
          r.max_alt_m ?? '',
          r.min_alt_ft ?? '',
          r.max_alt_ft ?? '',
          r.point_count,
          r.dep_icao || '',
          r.dep_iata || '',
          r.dep_airport_name || '',
          r.arr_icao || '',
          r.arr_iata || '',
          r.arr_airport_name || '',
          r.scheduled_departure || '',
          r.actual_departure || '',
          r.scheduled_arrival || '',
          r.estimated_arrival || '',
          r.route_status,
          r.enrichment_source || '',
        ]
          .map(esc)
          .join(';')
      );
    }

    return '\uFEFF' + lines.join('\r\n');
  }

  public pruneOldPositions(retentionDays = 90) {
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    this.db.prepare(`DELETE FROM flight_positions WHERE recorded_ms < ?`).run(cutoffMs);
  }

  public getBackupPassageIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM flight_passages ORDER BY entry_ms DESC LIMIT 5000`)
      .all() as Array<{ id: string }>;
    return rows.map((r) => String(r.id));
  }

  public exportAllPassagesForBackup(limitCount = 5000): PassageWithTrack[] {
    const rows = this.db
      .prepare(`SELECT * FROM flight_passages ORDER BY entry_ms DESC LIMIT ?`)
      .all(limitCount) as any[];

    const stmtPositions = this.db.prepare(
      `SELECT * FROM flight_positions WHERE passage_id = ? ORDER BY recorded_ms ASC`
    );

    return rows.map((r) => {
      const posRows = stmtPositions.all(r.id) as any[];
      return {
        passage: this.mapPassageRow(r),
        positions: posRows.map((p) => this.mapPositionRow(p)),
      };
    });
  }

  public restorePassages(items: PassageWithTrack[]): number {
    if (!Array.isArray(items) || items.length === 0) return 0;

    const stmtCheckPassage = this.db.prepare(
      `SELECT id, point_count, is_active, last_seen_ms FROM flight_passages WHERE id = ?`
    );
    const stmtInsertPassage = this.db.prepare(
      `INSERT INTO flight_passages (
         id, municipality_code, icao24, callsign, flight_number_iata,
         registration, icao_type_code, model_name, operator_name,
         traffic_category, adsb_category, is_military, has_mlat_positions,
         entry_time, entry_ms, last_seen_time, last_seen_ms, exit_time, exit_ms, is_active,
         entry_lat, entry_lon, exit_lat, exit_lon,
         min_alt_m, max_alt_m, min_alt_ft, max_alt_ft, point_count,
         dep_icao, dep_iata, dep_airport_name, arr_icao, arr_iata, arr_airport_name,
         scheduled_departure, actual_departure, scheduled_arrival, estimated_arrival,
         route_status, enrichment_source, enriched_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const stmtExistingPosTimes = this.db.prepare(
      `SELECT recorded_ms FROM flight_positions WHERE passage_id = ?`
    );
    const stmtInsertPos = this.db.prepare(
      `INSERT INTO flight_positions (
         passage_id, icao24, recorded_at, recorded_ms, lat, lon,
         alt_baro_ft, alt_baro_m, alt_geom_ft, alt_geom_m, on_ground,
         ground_speed_kts, track_deg, vertical_rate_fpm, position_source, is_mlat
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const stmtUpdatePassageSummary = this.db.prepare(
      `UPDATE flight_passages
       SET callsign = COALESCE(?, callsign),
           flight_number_iata = COALESCE(?, flight_number_iata),
           registration = COALESCE(?, registration),
           icao_type_code = COALESCE(?, icao_type_code),
           model_name = COALESCE(?, model_name),
           operator_name = COALESCE(?, operator_name),
           traffic_category = CASE WHEN ? != 'unknown' THEN ? ELSE traffic_category END,
           last_seen_time = CASE WHEN ? > last_seen_ms THEN ? ELSE last_seen_time END,
           last_seen_ms = MAX(last_seen_ms, ?),
           exit_time = COALESCE(exit_time, ?),
           exit_ms = COALESCE(exit_ms, ?),
           is_active = CASE WHEN ? = 0 THEN 0 ELSE is_active END,
           exit_lat = COALESCE(exit_lat, ?),
           exit_lon = COALESCE(exit_lon, ?),
           min_alt_m = COALESCE(?, min_alt_m),
           max_alt_m = COALESCE(?, max_alt_m),
           min_alt_ft = COALESCE(?, min_alt_ft),
           max_alt_ft = COALESCE(?, max_alt_ft),
           point_count = MAX(point_count, ?),
           dep_icao = COALESCE(?, dep_icao),
           dep_iata = COALESCE(?, dep_iata),
           dep_airport_name = COALESCE(?, dep_airport_name),
           arr_icao = COALESCE(?, arr_icao),
           arr_iata = COALESCE(?, arr_iata),
           arr_airport_name = COALESCE(?, arr_airport_name),
           route_status = CASE WHEN route_status = 'pending' AND ? != 'pending' THEN ? ELSE route_status END,
           enrichment_source = COALESCE(enrichment_source, ?)
       WHERE id = ?`
    );

    let restoredCount = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        const p = item?.passage;
        const pts = Array.isArray(item?.positions) ? item.positions : [];
        if (
          !p ||
          !p.id ||
          !p.icao24 ||
          p.visual_only ||
          p.id.startsWith('demo-') ||
          p.id.startsWith('approach-')
        ) {
          continue;
        }

        const entryMs = new Date(p.entry_time).getTime();
        const lastSeenMs = new Date(p.last_seen_time || p.entry_time).getTime();
        const exitMs = p.exit_time ? new Date(p.exit_time).getTime() : null;
        if (!Number.isFinite(entryMs) || !Number.isFinite(lastSeenMs)) continue;

        const existing = stmtCheckPassage.get(p.id) as any;
        const cleanPts = pts.filter(
          (pt) => Number.isFinite(pt?.t) && Number.isFinite(pt?.lat) && Number.isFinite(pt?.lon)
        );

        if (!existing) {
          const safeLastMs = Math.max(entryMs, lastSeenMs);
          const safeExitMs =
            exitMs !== null && Number.isFinite(exitMs)
              ? exitMs
              : p.is_active
              ? null
              : safeLastMs;
          const safeExitTime = p.exit_time || (safeExitMs !== null ? new Date(safeExitMs).toISOString() : null);

          stmtInsertPassage.run(
            p.id,
            p.municipality_code || 'GM1708',
            p.icao24.toLowerCase(),
            p.callsign ?? null,
            p.flight_number_iata ?? null,
            p.registration ?? null,
            p.icao_type_code ?? null,
            p.model_name ?? null,
            p.operator_name ?? null,
            p.traffic_category || 'unknown',
            p.adsb_category ?? null,
            p.is_military ? 1 : 0,
            p.has_mlat_positions ? 1 : 0,
            p.entry_time,
            entryMs,
            p.last_seen_time || p.entry_time,
            safeLastMs,
            safeExitTime,
            safeExitMs,
            safeExitTime ? 0 : p.is_active ? 1 : 0,
            Number(p.entry_lat),
            Number(p.entry_lon),
            p.exit_lat !== null && p.exit_lat !== undefined ? Number(p.exit_lat) : null,
            p.exit_lon !== null && p.exit_lon !== undefined ? Number(p.exit_lon) : null,
            p.min_alt_m ?? null,
            p.max_alt_m ?? null,
            p.min_alt_ft ?? null,
            p.max_alt_ft ?? null,
            Math.max(1, cleanPts.length, Number(p.point_count || 1)),
            p.dep_icao ?? null,
            p.dep_iata ?? null,
            p.dep_airport_name ?? null,
            p.arr_icao ?? null,
            p.arr_iata ?? null,
            p.arr_airport_name ?? null,
            p.scheduled_departure ?? null,
            p.actual_departure ?? null,
            p.scheduled_arrival ?? null,
            p.estimated_arrival ?? null,
            p.route_status || 'pending',
            p.enrichment_source ?? null,
            p.route_status && p.route_status !== 'pending' ? p.entry_time : null,
            p.entry_time
          );

          for (const pt of cleanPts) {
            stmtInsertPos.run(
              p.id,
              p.icao24.toLowerCase(),
              new Date(pt.t).toISOString(),
              Math.round(pt.t),
              pt.lat,
              pt.lon,
              pt.alt_baro_ft ?? pt.alt_ft ?? null,
              pt.alt_baro_m ?? pt.alt_m ?? null,
              pt.alt_geom_ft ?? null,
              pt.alt_geom_m ?? null,
              pt.on_ground ? 1 : 0,
              pt.gs ?? null,
              pt.track ?? null,
              pt.vrate ?? null,
              pt.src || 'adsb_icao',
              pt.src === 'mlat' ? 1 : 0
            );
          }
          restoredCount++;
        } else if (cleanPts.length > Number(existing.point_count || 0)) {
          const knownTimes = new Set(
            (stmtExistingPosTimes.all(p.id) as Array<{ recorded_ms: number }>).map((r) =>
              Number(r.recorded_ms)
            )
          );
          let addedPos = false;
          for (const pt of cleanPts) {
            const ms = Math.round(pt.t);
            if (knownTimes.has(ms)) continue;
            knownTimes.add(ms);
            stmtInsertPos.run(
              p.id,
              p.icao24.toLowerCase(),
              new Date(ms).toISOString(),
              ms,
              pt.lat,
              pt.lon,
              pt.alt_baro_ft ?? pt.alt_ft ?? null,
              pt.alt_baro_m ?? pt.alt_m ?? null,
              pt.alt_geom_ft ?? null,
              pt.alt_geom_m ?? null,
              pt.on_ground ? 1 : 0,
              pt.gs ?? null,
              pt.track ?? null,
              pt.vrate ?? null,
              pt.src || 'adsb_icao',
              pt.src === 'mlat' ? 1 : 0
            );
            addedPos = true;
          }
          const safeExitMs =
            exitMs !== null && Number.isFinite(exitMs) ? exitMs : null;
          stmtUpdatePassageSummary.run(
            p.callsign ?? null,
            p.flight_number_iata ?? null,
            p.registration ?? null,
            p.icao_type_code ?? null,
            p.model_name ?? null,
            p.operator_name ?? null,
            p.traffic_category || 'unknown',
            p.traffic_category || 'unknown',
            lastSeenMs,
            p.last_seen_time || p.entry_time,
            lastSeenMs,
            p.exit_time ?? null,
            safeExitMs,
            p.is_active ? 1 : 0,
            p.exit_lat ?? null,
            p.exit_lon ?? null,
            p.min_alt_m ?? null,
            p.max_alt_m ?? null,
            p.min_alt_ft ?? null,
            p.max_alt_ft ?? null,
            knownTimes.size,
            p.dep_icao ?? null,
            p.dep_iata ?? null,
            p.dep_airport_name ?? null,
            p.arr_icao ?? null,
            p.arr_iata ?? null,
            p.arr_airport_name ?? null,
            p.route_status || 'pending',
            p.route_status || 'pending',
            p.enrichment_source ?? null,
            p.id
          );
          if (addedPos) restoredCount++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw err;
    }

    if (restoredCount > 0) {
      this.dirtyForBackup = true;
    }
    return restoredCount;
  }

  public saveBackupFile() {
    if (!this.backupPath) return;
    try {
      const passages = this.exportAllPassagesForBackup(5000);
      const payload = JSON.stringify({
        version: 1,
        municipality: 'GM1708',
        savedAt: new Date().toISOString(),
        passages,
      });
      const tmpPath = `${this.backupPath}.tmp`;
      fs.writeFileSync(tmpPath, payload, 'utf-8');
      fs.renameSync(tmpPath, this.backupPath);
      this.dirtyForBackup = false;
    } catch (err) {
      console.warn('[RadarDB] Kon JSON backup niet wegschrijven:', err);
    }
  }

  public flushBackupIfDirty() {
    if (this.dirtyForBackup) {
      this.saveBackupFile();
    }
  }

  private reconcileBackupOnBoot() {
    if (!this.backupPath) return;
    let backupPassages: PassageWithTrack[] = [];
    if (fs.existsSync(this.backupPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.backupPath, 'utf-8'));
        if (Array.isArray(raw?.passages)) {
          backupPassages = raw.passages;
        }
      } catch (err) {
        console.warn('[RadarDB] Kon JSON backup niet lezen bij opstarten:', err);
      }
    }

    if (backupPassages.length > 0) {
      const restored = this.restorePassages(backupPassages);
      if (restored > 0) {
        console.log(`[RadarDB] ${restored} historische vluchten hersteld vanuit flightHistoryBackup.json`);
      }
    }

    const dbCountRow = this.db.prepare(`SELECT COUNT(*) AS cnt FROM flight_passages`).get() as {
      cnt: number;
    };
    const dbCount = Number(dbCountRow?.cnt || 0);
    if (dbCount > backupPassages.length || (!fs.existsSync(this.backupPath) && dbCount > 0)) {
      this.saveBackupFile();
    }
  }
}
