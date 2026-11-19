-- ============================================================================
-- STEENWIJKERLAND AIRSPACE TRACKER - POSTGRESQL + POSTGIS SCHEMA (SUPABASE)
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. Classificatie-enums voor datakwaliteit en ontbrekende vluchtplannen
CREATE TYPE traffic_category_enum AS ENUM (
  'commercial',
  'general_aviation',
  'hems_police_sar',
  'military',
  'unknown'
);

CREATE TYPE route_status_enum AS ENUM (
  'enriched',               -- Route + geplande/geschatte tijden opgehaald
  'partial_route_only',     -- Alleen origin/dest (adsbdb/hexdb/Free-subset), geen live ETA
  'not_applicable_vfr_mil', -- Traumaheli, sportkist of defensie zonder commercieel plan
  'quota_skipped',          -- Verrijking overgeslagen door dagelijkse API-limiet
  'not_found',              -- Gezocht, niet gevonden bij verrijkings-API
  'pending'                 -- Wacht op asynchrone verrijking
);

-- 2. Gemeentegrens (officiële PDOK BRK Bestuurlijke Gebieden GM1708)
CREATE TABLE public.municipalities (
  code TEXT PRIMARY KEY, -- 'GM1708'
  cbs_code TEXT NOT NULL, -- '1708'
  name TEXT NOT NULL, -- 'Steenwijkerland'
  geom GEOMETRY(MultiPolygon, 4326) NOT NULL,
  centroid_lat DOUBLE PRECISION NOT NULL,
  centroid_lon DOUBLE PRECISION NOT NULL,
  poll_radius_nm INTEGER NOT NULL DEFAULT 25,
  source_url TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_municipalities_geom ON public.municipalities USING GIST (geom);

-- 3. Lokale cache van toestelmetadata (gevuld uit basic-ac-db.json.gz / hexdb.io)
CREATE TABLE public.aircraft_registry (
  icao24 TEXT PRIMARY KEY, -- 6-hex lowercase, bijv. '484163'
  registration TEXT,       -- bijv. 'PH-TTR'
  icao_type_code TEXT,     -- bijv. 'B738', 'EC35'
  model_name TEXT,         -- bijv. 'Boeing 737-800', 'Airbus H135'
  manufacturer TEXT,
  operator_name TEXT,      -- bijv. 'KLM', 'ANWB Medical Air Assistance'
  operator_icao TEXT,
  adsb_category TEXT,      -- bijv. 'A3', 'A7'
  is_military BOOLEAN NOT NULL DEFAULT FALSE,
  traffic_hint traffic_category_enum,
  source TEXT NOT NULL DEFAULT 'adsbx_db',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Referentietabel luchthavens (voorkomt herhaalde lookup-calls)
CREATE TABLE public.airports (
  icao_code TEXT PRIMARY KEY, -- bijv. 'EHAM'
  iata_code TEXT UNIQUE,      -- bijv. 'AMS'
  name TEXT NOT NULL,
  city TEXT,
  country_code TEXT,
  timezone_iana TEXT,         -- Voor UTC-conversie van lokale luchthaventijden
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Vluchtmetadata per unieke passage strikt binnen Steenwijkerland (GM1708)
CREATE TABLE public.flight_passages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  municipality_code TEXT NOT NULL REFERENCES public.municipalities(code) DEFAULT 'GM1708',
  icao24 TEXT NOT NULL,
  callsign TEXT,
  flight_number_iata TEXT,
  registration TEXT,
  icao_type_code TEXT,
  model_name TEXT,
  operator_name TEXT,
  traffic_category traffic_category_enum NOT NULL DEFAULT 'unknown',
  adsb_category TEXT,
  is_military BOOLEAN NOT NULL DEFAULT FALSE,
  has_mlat_positions BOOLEAN NOT NULL DEFAULT FALSE,

  -- Verplicht veld 1: Exacte tijdstippen en coördinaten van intrede, verloop en uittrede
  entry_time TIMESTAMPTZ NOT NULL,
  last_seen_time TIMESTAMPTZ NOT NULL,
  exit_time TIMESTAMPTZ, -- NULL zolang toestel actief boven GM1708 vliegt
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  entry_lat DOUBLE PRECISION NOT NULL,
  entry_lon DOUBLE PRECISION NOT NULL,
  exit_lat DOUBLE PRECISION,
  exit_lon DOUBLE PRECISION,
  track_geom GEOMETRY(LineString, 4326), -- Wordt opgebouwd vanaf 2e positiepunt

  -- Verplicht veld 2: Hoogtestatistieken van de passage (m en ft)
  min_alt_m INTEGER,
  max_alt_m INTEGER,
  min_alt_ft INTEGER,
  max_alt_ft INTEGER,
  point_count INTEGER NOT NULL DEFAULT 1,

  -- Verplichte velden 5 t/m 8: Herkomst, bestemming, vertrektijd en ETA
  dep_icao TEXT,
  dep_iata TEXT,
  dep_airport_name TEXT,
  arr_icao TEXT,
  arr_iata TEXT,
  arr_airport_name TEXT,
  scheduled_departure TIMESTAMPTZ,
  actual_departure TIMESTAMPTZ,
  scheduled_arrival TIMESTAMPTZ,
  estimated_arrival TIMESTAMPTZ, -- ETA

  route_status route_status_enum NOT NULL DEFAULT 'pending',
  enrichment_source TEXT, -- 'airlabs', 'aerodatabox', 'adsbdb', 'hexdb', 'rule'
  enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_passages_active
  ON public.flight_passages (is_active, last_seen_time DESC)
  WHERE is_active = TRUE;

CREATE INDEX idx_passages_timerange_gist
  ON public.flight_passages USING GIST (
    tstzrange(entry_time, COALESCE(exit_time, last_seen_time), '[]')
  );

CREATE INDEX idx_passages_entry_time
  ON public.flight_passages (entry_time DESC);

CREATE INDEX idx_passages_callsign_recent
  ON public.flight_passages (callsign, enriched_at DESC)
  WHERE callsign IS NOT NULL;

CREATE INDEX idx_passages_category_alt
  ON public.flight_passages (traffic_category, min_alt_m, max_alt_m);

-- 6. Hoogfrequente positiepunten (uitsluitend binnen GM1708-polygoon)
CREATE TABLE public.flight_positions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  passage_id UUID NOT NULL REFERENCES public.flight_passages(id) ON DELETE CASCADE,
  icao24 TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  geom GEOMETRY(Point, 4326) GENERATED ALWAYS AS
    (ST_SetSRID(ST_MakePoint(lon, lat), 4326)) STORED,

  -- Verplicht veld 2: Barometrische én geometrische hoogte in voet en meter
  alt_baro_ft INTEGER, -- NULL bij 'ground' of ontbrekend
  alt_baro_m INTEGER,
  alt_geom_ft INTEGER,
  alt_geom_m INTEGER,
  on_ground BOOLEAN NOT NULL DEFAULT FALSE,
  ground_speed_kts REAL,
  track_deg REAL, -- 0-360°; NULL indien niet uitgezonden
  vertical_rate_fpm INTEGER,
  position_source TEXT NOT NULL DEFAULT 'adsb_icao',
  is_mlat BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_positions_recorded_brin
  ON public.flight_positions USING BRIN (recorded_at) WITH (pages_per_range = 32);

CREATE INDEX idx_positions_passage_time
  ON public.flight_positions (passage_id, recorded_at ASC);

-- 7. Operationele feed-status & dagelijks API-quotumbeheer
CREATE TABLE public.ingestion_health (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_feed_source TEXT NOT NULL DEFAULT 'adsb.fi',
  last_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  aircraft_in_radius INTEGER NOT NULL DEFAULT 0,
  aircraft_in_gm1708 INTEGER NOT NULL DEFAULT 0,
  airlabs_calls_today INTEGER NOT NULL DEFAULT 0,
  aerodatabox_calls_today INTEGER NOT NULL DEFAULT 0,
  quota_reset_date DATE NOT NULL DEFAULT CURRENT_DATE
);

INSERT INTO public.ingestion_health (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) - STRIKTE READ-ONLY VOOR AI STUDIO FRONTEND
-- ============================================================================
ALTER TABLE public.municipalities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aircraft_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.airports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingestion_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read municipalities" ON public.municipalities FOR SELECT USING (true);
CREATE POLICY "Public read registry" ON public.aircraft_registry FOR SELECT USING (true);
CREATE POLICY "Public read airports" ON public.airports FOR SELECT USING (true);
CREATE POLICY "Public read passages" ON public.flight_passages FOR SELECT USING (true);
CREATE POLICY "Public read positions" ON public.flight_positions FOR SELECT USING (true);
CREATE POLICY "Public read health" ON public.ingestion_health FOR SELECT USING (true);

-- ============================================================================
-- POSTGRESQL RPC-FUNCTIES VOOR KAART, LIVE RADAR EN TIME-SCRUBBER
-- ============================================================================

-- A. Gemeentegrens als GeoJSON Feature uit database (elimineert CORS-risico)
CREATE OR REPLACE FUNCTION public.get_municipality_boundary(p_code TEXT DEFAULT 'GM1708')
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'type', 'Feature',
    'properties', jsonb_build_object(
      'code', m.code,
      'cbs_code', m.cbs_code,
      'name', m.name,
      'centroid_lat', m.centroid_lat,
      'centroid_lon', m.centroid_lon
    ),
    'geometry', ST_AsGeoJSON(m.geom, 6)::jsonb
  )
  FROM public.municipalities m
  WHERE m.code = p_code;
$$;

-- B. Live radarstatus + actuele sporen strikt binnen GM1708
CREATE OR REPLACE FUNCTION public.get_live_radar_state()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'health', (SELECT to_jsonb(h) FROM public.ingestion_health h WHERE id = 1),
    'passages', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'passage', to_jsonb(fp) - 'track_geom',
          'positions', (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                't', EXTRACT(EPOCH FROM p.recorded_at) * 1000,
                'lat', ROUND(p.lat::numeric, 6),
                'lon', ROUND(p.lon::numeric, 6),
                'alt_m', COALESCE(p.alt_baro_m, p.alt_geom_m),
                'alt_ft', COALESCE(p.alt_baro_ft, p.alt_geom_ft),
                'alt_baro_m', p.alt_baro_m,
                'alt_baro_ft', p.alt_baro_ft,
                'alt_geom_m', p.alt_geom_m,
                'alt_geom_ft', p.alt_geom_ft,
                'on_ground', p.on_ground,
                'gs', p.ground_speed_kts,
                'track', p.track_deg,
                'vrate', p.vertical_rate_fpm,
                'src', p.position_source
              ) ORDER BY p.recorded_at ASC
            ), '[]'::jsonb)
            FROM public.flight_positions p
            WHERE p.passage_id = fp.id
          )
        )
      )
      FROM public.flight_passages fp
      WHERE fp.is_active = TRUE
        AND fp.last_seen_time >= NOW() - INTERVAL '90 seconds'
    ), '[]'::jsonb)
  );
$$;

-- C. Historische Time-Scrubber slice (geïndexeerd via GiST + composiet B-tree)
CREATE OR REPLACE FUNCTION public.get_historical_replay_slice(
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ,
  p_min_alt_m INTEGER DEFAULT 0,
  p_max_alt_m INTEGER DEFAULT 20000,
  p_categories traffic_category_enum[] DEFAULT NULL,
  p_include_unknown_alt BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  WITH all_matches AS (
    SELECT fp.*
    FROM public.flight_passages fp
    WHERE tstzrange(fp.entry_time, COALESCE(fp.exit_time, fp.last_seen_time), '[]')
          && tstzrange(p_start, p_end, '[]')
      AND (p_categories IS NULL OR fp.traffic_category = ANY(p_categories))
      AND (
        (fp.max_alt_m >= p_min_alt_m AND fp.min_alt_m <= p_max_alt_m)
        OR (p_include_unknown_alt AND fp.min_alt_m IS NULL AND fp.max_alt_m IS NULL)
      )
    ORDER BY fp.entry_time ASC
  ),
  capped_matches AS (
    SELECT * FROM all_matches LIMIT 600
  )
  SELECT jsonb_build_object(
    'total_matched', (SELECT COUNT(*) FROM all_matches),
    'truncated', (SELECT COUNT(*) > 600 FROM all_matches),
    'passages', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'passage', to_jsonb(cm) - 'track_geom',
          'positions', (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                't', EXTRACT(EPOCH FROM p.recorded_at) * 1000,
                'lat', ROUND(p.lat::numeric, 6),
                'lon', ROUND(p.lon::numeric, 6),
                'alt_m', COALESCE(p.alt_baro_m, p.alt_geom_m),
                'alt_ft', COALESCE(p.alt_baro_ft, p.alt_geom_ft),
                'alt_baro_m', p.alt_baro_m,
                'alt_baro_ft', p.alt_baro_ft,
                'alt_geom_m', p.alt_geom_m,
                'alt_geom_ft', p.alt_geom_ft,
                'on_ground', p.on_ground,
                'gs', p.ground_speed_kts,
                'track', p.track_deg,
                'vrate', p.vertical_rate_fpm,
                'src', p.position_source
              ) ORDER BY p.recorded_at ASC
            ), '[]'::jsonb)
            FROM public.flight_positions p
            WHERE p.passage_id = cm.id
              AND p.recorded_at BETWEEN p_start AND p_end
          )
        )
      )
      FROM capped_matches cm
    ), '[]'::jsonb)
  );
$$;

-- ============================================================================
-- DATARETENTIE (pg_cron / worker cleanup) VOOR SUPABASE FREE 500 MB-LIMIET:
-- Verwijder dagelijks flight_positions ouder dan 90 dagen terwijl
-- flight_passages (met track_geom, intrede/uittrede, hoogtes & routes) behouden blijft:
--
-- SELECT cron.schedule('prune-old-flight-positions', '15 3 * * *', $$
--   DELETE FROM public.flight_positions
--   WHERE recorded_at < NOW() - INTERVAL '90 days';
-- $$);
-- ============================================================================
