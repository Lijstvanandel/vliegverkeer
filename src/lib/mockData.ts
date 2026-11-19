import steenwijkerlandPolygonGeoJson from '../data/steenwijkerlandPolygon.json';
import {
  AvailableWeekOption,
  FlightPassage,
  HistoricalReplayResponse,
  LiveRadarResponse,
  MunicipalityBoundaryFeature,
  PassageWithTrack,
  PositionPoint,
  RadarFilters,
  StatsPeriod,
} from '../types/radar';
import {
  computeBearingDeg,
  feetToMeters,
  getAmsterdamIsoWeekInfo,
  getIsoWeekBoundsFromKey,
  haversineMeters,
  metersToFeet,
  roundCoord6,
} from './geoUtils';

export const FALLBACK_GM1708_BOUNDARY: MunicipalityBoundaryFeature = {
  type: 'Feature',
  properties: {
    code: 'GM1708',
    cbs_code: '1708',
    name: 'Steenwijkerland',
    centroid_lat: 52.766,
    centroid_lon: 6.062,
    poll_radius_nm: 25,
    source_url:
      'https://api.pdok.nl/kadaster/brk-bestuurlijke-gebieden/ogc/v1/collections/gemeentegebied/items?identificatie=GM1708',
  },
  geometry: {
    type: 'MultiPolygon',
    coordinates: steenwijkerlandPolygonGeoJson.coordinates as number[][][][],
  },
};

function interpolatePoints(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number,
  startTimeMs: number,
  durationMs: number,
  steps: number,
  altMStart: number,
  altMEnd: number,
  gsKts: number,
  src: string,
  nullTrackIndices: number[] = []
): PositionPoint[] {
  const pts: PositionPoint[] = [];
  const bearing = computeBearingDeg(startLat, startLon, endLat, endLon);
  const factualGs =
    durationMs > 0
      ? Math.max(
          15,
          Math.round(haversineMeters(startLat, startLon, endLat, endLon) / (durationMs / 1000) / 0.5144444)
        )
      : gsKts;
  const effectiveGs = gsKts > 0 ? factualGs : gsKts;
  for (let i = 0; i <= steps; i++) {
    const ratio = i / steps;
    const t = Math.round(startTimeMs + durationMs * ratio);
    const lat = roundCoord6(startLat + (endLat - startLat) * ratio);
    const lon = roundCoord6(startLon + (endLon - startLon) * ratio);
    const altM = Math.round(altMStart + (altMEnd - altMStart) * ratio);
    const altFt = metersToFeet(altM);
    const geomM = altM + 45;
    const geomFt = metersToFeet(geomM);
    const vrate =
      steps > 0
        ? Math.round(((metersToFeet(altMEnd) - metersToFeet(altMStart)) / (durationMs / 60000)))
        : 0;
    const isNullTrack = nullTrackIndices.includes(i);

    pts.push({
      t,
      lat,
      lon,
      alt_m: altM,
      alt_ft: altFt,
      alt_baro_m: altM,
      alt_baro_ft: altFt,
      alt_geom_m: geomM,
      alt_geom_ft: geomFt,
      on_ground: false,
      gs: isNullTrack ? null : effectiveGs,
      track: isNullTrack ? null : bearing,
      vrate,
      src,
    });
  }
  return pts;
}

function buildPassageFromTrack(
  partial: Omit<
    FlightPassage,
    | 'municipality_code'
    | 'entry_time'
    | 'last_seen_time'
    | 'entry_lat'
    | 'entry_lon'
    | 'min_alt_m'
    | 'max_alt_m'
    | 'min_alt_ft'
    | 'max_alt_ft'
    | 'point_count'
  >,
  positions: PositionPoint[]
): PassageWithTrack {
  const first = positions[0];
  const last = positions[positions.length - 1];
  const altsM = positions.map((p) => p.alt_m).filter((v): v is number => v !== null);
  const altsFt = positions.map((p) => p.alt_ft).filter((v): v is number => v !== null);

  return {
    passage: {
      ...partial,
      municipality_code: 'GM1708',
      entry_time: new Date(first.t).toISOString(),
      last_seen_time: new Date(last.t).toISOString(),
      entry_lat: first.lat,
      entry_lon: first.lon,
      min_alt_m: altsM.length ? Math.min(...altsM) : null,
      max_alt_m: altsM.length ? Math.max(...altsM) : null,
      min_alt_ft: altsFt.length ? Math.min(...altsFt) : null,
      max_alt_ft: altsFt.length ? Math.max(...altsFt) : null,
      point_count: positions.length,
    },
    positions,
  };
}

/**
 * Generates realistic live GM1708 passages anchored around the current timestamp
 * so Preview mode moves smoothly every 10 seconds / animation frame.
 */
export function getDemoLiveRadarState(nowMs: number = Date.now()): LiveRadarResponse {
  // Cycle every 4 minutes so live demo aircraft continuously cross GM1708
  const cycleMs = 240_000;
  const cycleStart = Math.floor(nowMs / cycleMs) * cycleMs;
  const elapsed = nowMs - cycleStart;

  // 1. Commercial airliner (KLM1234 EHAM -> ESSA at cruise altitude ~10,400 m)
  const klmDuration = 160_000;
  const klmPositions = interpolatePoints(
    52.668,
    5.892,
    52.888,
    6.262,
    cycleStart - 10_000,
    klmDuration,
    32,
    10363,
    10363,
    430,
    'adsb_icao'
  ).filter((p) => p.t <= nowMs);

  const klmScheduledDep = new Date(cycleStart - 16 * 60_000).toISOString();
  const klmActualDep = new Date(cycleStart - 14 * 60_000).toISOString();
  const klmScheduledArr = new Date(cycleStart + 98 * 60_000).toISOString();
  const klmEstimatedArr = new Date(cycleStart + 96 * 60_000).toISOString();

  // 2. ANWB Trauma Helicopter (PH-TTR / EC35 / LIFELNR4) low-altitude over Giethoorn -> Steenwijk
  const heliPositions = interpolatePoints(
    52.705,
    6.078,
    52.796,
    6.122,
    cycleStart - 30_000,
    240_000,
    24,
    310,
    365,
    122,
    'adsb_icao'
  ).filter((p) => p.t <= nowMs);

  // 3. Military MLAT helicopter around Havelte / Eesveen (with null track points to test fallback!)
  const milPositions = interpolatePoints(
    52.835,
    6.155,
    52.778,
    6.185,
    cycleStart - 10_000,
    210_000,
    21,
    185,
    240,
    105,
    'mlat',
    [3, 4, 7, 10, 11, 14, 17, 18]
  ).filter((p) => p.t <= nowMs);

  // 4. General Aviation VFR Cessna 172 (PH-ABC)
  const gaPositions = interpolatePoints(
    52.742,
    5.948,
    52.818,
    6.045,
    cycleStart + 10_000,
    220_000,
    22,
    670,
    720,
    98,
    'adsb_icao'
  ).filter((p) => p.t <= nowMs);

  const passages: PassageWithTrack[] = [];

  if (klmPositions.length > 0 && elapsed < klmDuration - 20_000) {
    passages.push(
      buildPassageFromTrack(
        {
          id: `demo-klm-${cycleStart}`,
          icao24: '484163',
          callsign: 'KLM1234',
          flight_number_iata: 'KL1234',
          registration: 'PH-BXO',
          icao_type_code: 'B738',
          model_name: 'Boeing 737-800',
          operator_name: 'KLM',
          traffic_category: 'commercial',
          adsb_category: 'A3',
          is_military: false,
          has_mlat_positions: false,
          exit_time: null,
          is_active: true,
          exit_lat: null,
          exit_lon: null,
          dep_icao: 'EHAM',
          dep_iata: 'AMS',
          dep_airport_name: 'Amsterdam Airport Schiphol',
          arr_icao: 'ESSA',
          arr_iata: 'ARN',
          arr_airport_name: 'Stockholm Arlanda Airport',
          scheduled_departure: klmScheduledDep,
          actual_departure: klmActualDep,
          scheduled_arrival: klmScheduledArr,
          estimated_arrival: klmEstimatedArr,
          route_status: 'enriched',
          enrichment_source: 'airlabs',
        },
        klmPositions
      )
    );
  }

  if (heliPositions.length > 0) {
    passages.push(
      buildPassageFromTrack(
        {
          id: `demo-hems-${cycleStart}`,
          icao24: '484901',
          callsign: 'LIFELNR4',
          flight_number_iata: null,
          registration: 'PH-TTR',
          icao_type_code: 'EC35',
          model_name: 'Airbus H135 (EC135 T3)',
          operator_name: 'ANWB Medical Air Assistance',
          traffic_category: 'hems_police_sar',
          adsb_category: 'A7',
          is_military: false,
          has_mlat_positions: false,
          exit_time: null,
          is_active: true,
          exit_lat: null,
          exit_lon: null,
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
          enrichment_source: 'rule',
        },
        heliPositions
      )
    );
  }

  if (milPositions.length > 0) {
    passages.push(
      buildPassageFromTrack(
        {
          id: `demo-mil-${cycleStart}`,
          icao24: '480c12',
          callsign: 'NAF42',
          flight_number_iata: null,
          registration: 'D-892',
          icao_type_code: 'NH90',
          model_name: 'NHIndustries NH90 NFH',
          operator_name: 'Koninklijke Luchtmacht (Defensie)',
          traffic_category: 'military',
          adsb_category: 'A7',
          is_military: true,
          has_mlat_positions: true,
          exit_time: null,
          is_active: true,
          exit_lat: null,
          exit_lon: null,
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
          enrichment_source: 'rule',
        },
        milPositions
      )
    );
  }

  if (gaPositions.length > 0) {
    passages.push(
      buildPassageFromTrack(
        {
          id: `demo-ga-${cycleStart}`,
          icao24: '485112',
          callsign: 'PH-ABC',
          flight_number_iata: null,
          registration: 'PH-ABC',
          icao_type_code: 'C172',
          model_name: 'Cessna 172S Skyhawk',
          operator_name: 'Vliegclub Hoogeveen (General Aviation)',
          traffic_category: 'general_aviation',
          adsb_category: 'A1',
          is_military: false,
          has_mlat_positions: false,
          exit_time: null,
          is_active: true,
          exit_lat: null,
          exit_lon: null,
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
          enrichment_source: 'rule',
        },
        gaPositions
      )
    );
  }

  // 5. Visuele vooraankondiging in Preview-modus: Weststellingwerf -> richting Steenwijk (nog niet in GM1708 meting)
  const approachPhaseStart = Math.floor(nowMs / 75_000) * 75_000;
  const approachWst = interpolatePoints(
    52.905,
    5.998,
    52.852,
    6.042,
    approachPhaseStart - 10_000,
    80_000,
    16,
    780,
    710,
    120,
    'adsb_icao'
  ).filter((p) => p.t <= nowMs);

  // 6. Visuele vooraankondiging in Preview-modus: Westerveld -> richting Steenwijkerland
  const approachWvd = interpolatePoints(
    52.805,
    6.325,
    52.775,
    6.215,
    approachPhaseStart - 10_000,
    80_000,
    16,
    4200,
    3650,
    290,
    'adsb_icao'
  ).filter((p) => p.t <= nowMs);

  const approaching_passages: PassageWithTrack[] = [
    buildPassageFromTrack(
      {
        id: `demo-approach-wst-${cycleStart}`,
        icao24: '485220',
        callsign: 'PH-WST',
        flight_number_iata: null,
        registration: 'PH-WST',
        icao_type_code: 'DA40',
        model_name: 'Diamond DA40 Diamond Star',
        operator_name: 'Vliegschool Noord-Nederland',
        traffic_category: 'general_aviation',
        adsb_category: 'A1',
        is_military: false,
        has_mlat_positions: false,
        exit_time: null,
        is_active: true,
        exit_lat: null,
        exit_lon: null,
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
        neighbor_municipality: 'Weststellingwerf',
        eta_seconds: 38,
      },
      approachWst
    ),
    buildPassageFromTrack(
      {
        id: `demo-approach-wvd-${cycleStart}`,
        icao24: '484551',
        callsign: 'TRA714',
        flight_number_iata: 'HV714',
        registration: 'PH-HXG',
        icao_type_code: 'B738',
        model_name: 'Boeing 737-800',
        operator_name: 'Transavia',
        traffic_category: 'commercial',
        adsb_category: 'A3',
        is_military: false,
        has_mlat_positions: false,
        exit_time: null,
        is_active: true,
        exit_lat: null,
        exit_lon: null,
        dep_icao: 'LEPA',
        dep_iata: 'PMI',
        dep_airport_name: 'Palma de Mallorca Airport',
        arr_icao: 'EHAM',
        arr_iata: 'AMS',
        arr_airport_name: 'Amsterdam Airport Schiphol',
        scheduled_departure: null,
        actual_departure: null,
        scheduled_arrival: null,
        estimated_arrival: null,
        route_status: 'partial_route_only',
        enrichment_source: 'visual_approach',
        visual_only: true,
        neighbor_municipality: 'Westerveld',
        eta_seconds: 26,
      },
      approachWvd
    ),
  ];

  return {
    health: {
      active_feed_source: 'Preview (GM1708 Demo)',
      last_poll_at: new Date(nowMs).toISOString(),
      last_success_at: new Date(nowMs).toISOString(),
      last_error: null,
      aircraft_in_radius: 28,
      aircraft_in_gm1708: passages.length,
      approaching_in_neighbors: approaching_passages.length,
    },
    passages,
    approaching_passages,
  };
}

/**
 * Generates deterministic historical passages across a 7-day window in Preview mode
 * so Time-Scrubber (uur / dag / week) and all filter controls can be explored immediately.
 */
export function getDemoHistoricalSlice(
  startIso: string,
  endIso: string,
  filters: RadarFilters
): HistoricalReplayResponse {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const allPassages: PassageWithTrack[] = [];

  // Anchor slots every 18 minutes across the requested window (bounded cleanly)
  const slotMs = 18 * 60_000;
  const firstSlot = Math.floor(startMs / slotMs) * slotMs;

  const templates = [
    {
      icao24: '484163',
      callsign: 'KLM1234',
      iata: 'KL1234',
      reg: 'PH-BXO',
      type: 'B738',
      model: 'Boeing 737-800',
      op: 'KLM',
      cat: 'commercial' as const,
      adsbCat: 'A3',
      mil: false,
      mlat: false,
      altStart: 10400,
      altEnd: 10450,
      gs: 455,
      lat0: 52.705,
      lon0: 5.955,
      lat1: 52.845,
      lon1: 6.175,
      durMs: 160_000,
      depIcao: 'EHAM',
      depIata: 'AMS',
      depName: 'Amsterdam Airport Schiphol',
      arrIcao: 'ESSA',
      arrIata: 'ARN',
      arrName: 'Stockholm Arlanda Airport',
      routeStatus: 'enriched' as const,
      source: 'airlabs',
    },
    {
      icao24: '484901',
      callsign: 'LIFELNR4',
      iata: null,
      reg: 'PH-TTR',
      type: 'EC35',
      model: 'Airbus H135 (EC135 T3)',
      op: 'ANWB Medical Air Assistance',
      cat: 'hems_police_sar' as const,
      adsbCat: 'A7',
      mil: false,
      mlat: false,
      altStart: 280,
      altEnd: 340,
      gs: 124,
      lat0: 52.695,
      lon0: 6.070,
      lat1: 52.805,
      lon1: 6.135,
      durMs: 240_000,
      depIcao: null,
      depIata: null,
      depName: null,
      arrIcao: null,
      arrIata: null,
      arrName: null,
      routeStatus: 'not_applicable_vfr_mil' as const,
      source: 'rule',
    },
    {
      icao24: '3c6671',
      callsign: 'DLH2471',
      iata: 'LH2471',
      reg: 'D-AINQ',
      type: 'A20N',
      model: 'Airbus A320neo',
      op: 'Lufthansa',
      cat: 'commercial' as const,
      adsbCat: 'A3',
      mil: false,
      mlat: false,
      altStart: 6200,
      altEnd: 4100,
      gs: 390,
      lat0: 52.835,
      lon0: 6.140,
      lat1: 52.710,
      lon1: 5.965,
      durMs: 170_000,
      depIcao: 'EDDF',
      depIata: 'FRA',
      depName: 'Frankfurt Airport',
      arrIcao: 'EHAM',
      arrIata: 'AMS',
      arrName: 'Amsterdam Airport Schiphol',
      routeStatus: 'partial_route_only' as const,
      source: 'adsbdb',
    },
    {
      icao24: '480c12',
      callsign: 'NAF42',
      iata: null,
      reg: 'D-892',
      type: 'NH90',
      model: 'NHIndustries NH90 NFH',
      op: 'Koninklijke Luchtmacht (Defensie)',
      cat: 'military' as const,
      adsbCat: 'A7',
      mil: true,
      mlat: true,
      altStart: 190,
      altEnd: 260,
      gs: 108,
      lat0: 52.838,
      lon0: 6.150,
      lat1: 52.775,
      lon1: 6.188,
      durMs: 220_000,
      depIcao: null,
      depIata: null,
      depName: null,
      arrIcao: null,
      arrIata: null,
      arrName: null,
      routeStatus: 'not_applicable_vfr_mil' as const,
      source: 'rule',
    },
    {
      icao24: '485112',
      callsign: 'PH-ABC',
      iata: null,
      reg: 'PH-ABC',
      type: 'C172',
      model: 'Cessna 172S Skyhawk',
      op: 'Vliegclub Hoogeveen',
      cat: 'general_aviation' as const,
      adsbCat: 'A1',
      mil: false,
      mlat: false,
      altStart: 620,
      altEnd: 740,
      gs: 96,
      lat0: 52.745,
      lon0: 5.940,
      lat1: 52.825,
      lon1: 6.060,
      durMs: 260_000,
      depIcao: null,
      depIata: null,
      depName: null,
      arrIcao: null,
      arrIata: null,
      arrName: null,
      routeStatus: 'not_applicable_vfr_mil' as const,
      source: 'rule',
    },
    {
      icao24: '4ca7b4',
      callsign: 'RYR8812',
      iata: 'FR8812',
      reg: 'EI-DWP',
      type: 'B738',
      model: 'Boeing 737-800',
      op: 'Ryanair',
      cat: 'commercial' as const,
      adsbCat: 'A3',
      mil: false,
      mlat: false,
      altStart: 11200,
      altEnd: 11280,
      gs: 468,
      lat0: 52.790,
      lon0: 5.875,
      lat1: 52.760,
      lon1: 6.192,
      durMs: 150_000,
      depIcao: null,
      depIata: null,
      depName: null,
      arrIcao: null,
      arrIata: null,
      arrName: null,
      routeStatus: 'quota_skipped' as const,
      source: 'rule',
    },
  ];

  let idx = 0;
  for (let slot = firstSlot; slot <= endMs; slot += slotMs) {
    const tpl = templates[idx % templates.length];
    idx++;
    const entryMs = slot + 120_000;
    if (entryMs + tpl.durMs < startMs || entryMs > endMs) continue;

    const pts = interpolatePoints(
      tpl.lat0,
      tpl.lon0,
      tpl.lat1,
      tpl.lon1,
      entryMs,
      tpl.durMs,
      Math.round(tpl.durMs / 10_000),
      tpl.altStart,
      tpl.altEnd,
      tpl.gs,
      tpl.mlat ? 'mlat' : 'adsb_icao',
      tpl.mlat ? [2, 5, 9, 13, 17] : []
    ).filter((p) => p.t >= startMs && p.t <= endMs);

    if (pts.length === 0) continue;
    const lastPt = pts[pts.length - 1];

    const item = buildPassageFromTrack(
      {
        id: `demo-hist-${tpl.icao24}-${slot}`,
        icao24: tpl.icao24,
        callsign: tpl.callsign,
        flight_number_iata: tpl.iata,
        registration: tpl.reg,
        icao_type_code: tpl.type,
        model_name: tpl.model,
        operator_name: tpl.op,
        traffic_category: tpl.cat,
        adsb_category: tpl.adsbCat,
        is_military: tpl.mil,
        has_mlat_positions: tpl.mlat,
        exit_time: new Date(lastPt.t).toISOString(),
        is_active: false,
        exit_lat: lastPt.lat,
        exit_lon: lastPt.lon,
        dep_icao: tpl.depIcao,
        dep_iata: tpl.depIata,
        dep_airport_name: tpl.depName,
        arr_icao: tpl.arrIcao,
        arr_iata: tpl.arrIata,
        arr_airport_name: tpl.arrName,
        scheduled_departure:
          tpl.routeStatus === 'enriched' ? new Date(entryMs - 18 * 60_000).toISOString() : null,
        actual_departure:
          tpl.routeStatus === 'enriched' ? new Date(entryMs - 16 * 60_000).toISOString() : null,
        scheduled_arrival:
          tpl.routeStatus === 'enriched' ? new Date(entryMs + 95 * 60_000).toISOString() : null,
        estimated_arrival:
          tpl.routeStatus === 'enriched' ? new Date(entryMs + 93 * 60_000).toISOString() : null,
        route_status: tpl.routeStatus,
        enrichment_source: tpl.source,
      },
      pts
    );

    allPassages.push(item);
  }

  // Apply exact client/server filter contract
  const q = filters.searchQuery.trim().toLowerCase();
  const filtered = allPassages.filter(({ passage }) => {
    if (filters.categories.length > 0 && !filters.categories.includes(passage.traffic_category)) {
      return false;
    }
    if (passage.min_alt_m === null && passage.max_alt_m === null) {
      if (!filters.includeUnknownAlt) return false;
    } else {
      const minA = passage.min_alt_m ?? 0;
      const maxA = passage.max_alt_m ?? 20000;
      if (maxA < filters.minAltM || minA > filters.maxAltM) return false;
    }
    if (q) {
      const hay = [
        passage.callsign,
        passage.registration,
        passage.icao24,
        passage.dep_iata,
        passage.dep_icao,
        passage.arr_iata,
        passage.arr_icao,
        passage.operator_name,
        passage.model_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const totalMatched = filtered.length;
  const truncated = totalMatched > 600;
  return {
    total_matched: totalMatched,
    truncated,
    passages: filtered.slice(0, 600),
  };
}

export function getDemoStats(
  period: StatsPeriod,
  weekKey?: string | null
): {
  rows: FlightPassage[];
  availableWeeks: AvailableWeekOption[];
  weekKey: string | null;
  weekLabel: string | null;
} {
  const now = Date.now();
  const allCatsFilter: RadarFilters = {
    minAltM: 0,
    maxAltM: 20000,
    includeUnknownAlt: true,
    categories: ['commercial', 'general_aviation', 'hems_police_sar', 'military', 'unknown'],
    searchQuery: '',
  };

  // Genereer laatste 6 ISO-weeknummers voor Preview-modus
  const availableWeeks: AvailableWeekOption[] = [];
  for (let w = 0; w < 6; w++) {
    const refInfo = getAmsterdamIsoWeekInfo(now - w * 7 * 86_400_000);
    if (!availableWeeks.some((aw) => aw.weekKey === refInfo.weekKey)) {
      const endClamp = Math.min(now, refInfo.endMs);
      const countEstimate =
        endClamp > refInfo.startMs
          ? Math.min(600, Math.max(1, Math.floor((endClamp - refInfo.startMs) / (18 * 60_000))))
          : 0;
      availableWeeks.push({
        weekKey: refInfo.weekKey,
        year: refInfo.year,
        weekNumber: refInfo.weekNumber,
        label: refInfo.label,
        count: countEstimate,
      });
    }
  }

  let startMs = now - 86_400_000;
  let endMs = now;
  let activeWeekKey: string | null = null;
  let activeWeekLabel: string | null = null;

  if (period === 'hour') {
    startMs = now - 3_600_000;
  } else if (period === 'day') {
    startMs = now - 86_400_000;
  } else if (period === 'week') {
    startMs = now - 7 * 86_400_000;
  } else if (period === 'weeknum') {
    const parsed = weekKey ? getIsoWeekBoundsFromKey(weekKey) : null;
    const resolved = parsed || getAmsterdamIsoWeekInfo(now);
    startMs = resolved.startMs;
    endMs = Math.min(now, resolved.endMs);
    activeWeekKey = resolved.weekKey;
    activeWeekLabel = resolved.label;
  } else {
    // 'all': toon ruim historisch venster (35 dagen, gesorteerd nieuwste eerst)
    startMs = now - 35 * 86_400_000;
  }

  const slice =
    endMs > startMs
      ? getDemoHistoricalSlice(
          new Date(startMs).toISOString(),
          new Date(endMs).toISOString(),
          allCatsFilter
        )
      : { passages: [] };

  const rows = slice.passages
    .map((p) => p.passage)
    .sort((a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime());

  return {
    rows,
    availableWeeks,
    weekKey: activeWeekKey,
    weekLabel: activeWeekLabel,
  };
}

export { feetToMeters };
