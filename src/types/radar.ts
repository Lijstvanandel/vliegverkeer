export type TrafficCategory =
  | 'commercial'
  | 'general_aviation'
  | 'hems_police_sar'
  | 'military'
  | 'unknown';

export type RouteStatus =
  | 'enriched'
  | 'partial_route_only'
  | 'not_applicable_vfr_mil'
  | 'quota_skipped'
  | 'not_found'
  | 'pending';

export interface PositionPoint {
  t: number; // Unix epoch in milliseconds
  lat: number;
  lon: number;
  alt_m: number | null; // Display-hoogte in meters (baro met geom fallback)
  alt_ft: number | null; // Display-hoogte in voet
  alt_baro_m: number | null;
  alt_baro_ft: number | null;
  alt_geom_m: number | null;
  alt_geom_ft: number | null;
  on_ground: boolean;
  gs: number | null; // Grondsnelheid in knopen
  track: number | null; // Koers in graden (0-360), null indien niet uitgezonden
  vrate: number | null; // Stijg-/daalsnelheid in ft/min
  src: string; // 'adsb_icao' | 'mlat' | etc.
}

export interface FlightPassage {
  id: string;
  municipality_code: string;
  icao24: string;
  callsign: string | null;
  flight_number_iata: string | null;
  registration: string | null;
  icao_type_code: string | null;
  model_name: string | null;
  operator_name: string | null;
  traffic_category: TrafficCategory;
  adsb_category: string | null;
  is_military: boolean;
  has_mlat_positions: boolean;
  entry_time: string;
  last_seen_time: string;
  exit_time: string | null;
  is_active: boolean;
  entry_lat: number;
  entry_lon: number;
  exit_lat: number | null;
  exit_lon: number | null;
  min_alt_m: number | null;
  max_alt_m: number | null;
  min_alt_ft: number | null;
  max_alt_ft: number | null;
  point_count: number;
  dep_icao: string | null;
  dep_iata: string | null;
  dep_airport_name: string | null;
  arr_icao: string | null;
  arr_iata: string | null;
  arr_airport_name: string | null;
  scheduled_departure: string | null;
  actual_departure: string | null;
  scheduled_arrival: string | null;
  estimated_arrival: string | null;
  route_status: RouteStatus;
  enrichment_source: string | null;
  visual_only?: boolean;
  neighbor_municipality?: string | null;
  eta_seconds?: number | null;
}

export interface PassageWithTrack {
  passage: FlightPassage;
  positions: PositionPoint[];
}

export interface IngestionHealth {
  active_feed_source: string;
  last_poll_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  aircraft_in_radius: number;
  aircraft_in_gm1708: number;
  approaching_in_neighbors?: number;
  airlabs_calls_today?: number;
  aerodatabox_calls_today?: number;
}

export interface LiveRadarResponse {
  server_time_ms?: number;
  health: IngestionHealth;
  passages: PassageWithTrack[];
  approaching_passages?: PassageWithTrack[];
}

export interface HistoricalReplayResponse {
  total_matched: number;
  truncated: boolean;
  passages: PassageWithTrack[];
}

export interface MunicipalityBoundaryFeature {
  type: 'Feature';
  properties: {
    code: string;
    cbs_code: string;
    name: string;
    centroid_lat: number;
    centroid_lon: number;
    poll_radius_nm?: number;
    source_url?: string;
  };
  geometry: {
    type: 'MultiPolygon';
    coordinates: number[][][][];
  };
}

export interface AdjacentMunicipalityFeature {
  type: 'Feature';
  properties: {
    code: string;
    name: string;
  };
  geometry: {
    type: 'MultiPolygon';
    coordinates: number[][][][];
  };
}

export interface AdjacentBoundariesCollection {
  type: 'FeatureCollection';
  features: AdjacentMunicipalityFeature[];
}

export type RadarMode = 'live' | 'history';
export type FeedMode = 'live' | 'demo';
export type TimeGranularity = 'hour' | 'day' | 'week' | 'custom';

export interface RadarFilters {
  minAltM: number;
  maxAltM: number;
  includeUnknownAlt: boolean;
  categories: TrafficCategory[];
  searchQuery: string;
}

export type StatsPeriod = 'hour' | 'day' | 'week' | 'weeknum' | 'all';

export interface AvailableWeekOption {
  weekKey: string; // e.g. '2026-W47'
  year: number;
  weekNumber: number;
  label: string;
  count: number;
}

export interface DailyCountSummary {
  dateKey: string; // YYYY-MM-DD in Europe/Amsterdam
  label: string;   // e.g. 'do 19 nov 2026'
  count: number;
}

export interface OperatorRankingEntry {
  operator: string;
  count: number;
  avgAltitudeM: number | null;
  category: TrafficCategory;
}

export interface AircraftTypeRankingEntry {
  typeKey: string;
  typeLabel: string;
  icaoTypeCode: string | null;
  count: number;
  avgAltitudeM: number | null;
}

export interface CompleteHistoryInsights {
  totalPassages: number;
  totalDays: number;
  quietestDay: DailyCountSummary | null;
  busiestDay: DailyCountSummary | null;
  topOperators: OperatorRankingEntry[];
  topAircraftTypes: AircraftTypeRankingEntry[];
}

export interface AirspaceStatsResponse {
  period: StatsPeriod;
  weekKey?: string | null;
  weekLabel?: string | null;
  availableWeeks?: AvailableWeekOption[];
  totalPassages: number;
  activePassages: number;
  totalPositions: number;
  avgAltitudeM: number | null;
  minAltitudeM: number | null;
  maxAltitudeM: number | null;
  lowAltitudeCount: number;
  lowestFlight: FlightPassage | null;
  highestFlight: FlightPassage | null;
  mlatPassages: number;
  byCategory: Array<{
    category: TrafficCategory;
    count: number;
    sharePct: number;
  }>;
  topOperators: Array<{
    operator: string;
    count: number;
    category: TrafficCategory;
  }>;
  hourlyDistribution: Array<{
    bucket: string;
    count: number;
  }>;
  recentPassages: FlightPassage[];
  allTimeInsights?: CompleteHistoryInsights;
}

export interface HeatmapCell {
  r: number;
  c: number;
  lat: number;
  lon: number;
  count: number;
}

export interface AllHistoryHeatmapResponse {
  totalPassages: number;
  totalPositions: number;
  maxCount: number;
  originLat: number;
  originLon: number;
  cellLatDeg: number;
  cellLonDeg: number;
  cellSizeM: number;
  cells: HeatmapCell[];
}

