import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  GeoJSONSource,
  Map as MapLibreMap,
  MapLayerMouseEvent,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

setWorkerUrl(maplibreWorkerUrl);
import {
  AdjacentBoundariesCollection,
  AllHistoryHeatmapResponse,
  FeedMode,
  IngestionHealth,
  MunicipalityBoundaryFeature,
  PassageWithTrack,
  PositionPoint,
  RadarMode,
} from '../types/radar';
import {
  estimateSpeedKnotsFromTrack,
  formatAltitudeLabel,
  formatTimeNL,
  getAltitudeColor,
  haversineMeters,
  interpolatePassageAtTime,
  isHelicopterPassage,
  knotsToKmh,
  normalizeSignedAngleDeg,
  projectPositionBySpeed,
  resolveTrackAtIndex,
  roundCoord6,
} from '../lib/geoUtils';
import {
  buildHeatmapFromTracks,
  heatmapCellPolygonGeoJson,
  isPointInsideBoundary,
  latLonToHeatmapCell,
} from '../lib/heatmap';
import { getDemoHistoricalSlice } from '../lib/mockData';
import { Compass, Flame, Layers, Plane, Radio, History, ToggleRight, X } from 'lucide-react';

interface RadarMapProps {
  boundary: MunicipalityBoundaryFeature;
  adjacentBoundaries?: AdjacentBoundariesCollection;
  passages: PassageWithTrack[];
  approachingPassages?: PassageWithTrack[];
  mode: RadarMode;
  feedMode: FeedMode;
  playheadMs: number;
  clockOffsetMs?: number;
  selectedPassageId: string | null;
  onSelectPassage: (id: string | null) => void;
  health: IngestionHealth;
  historyVersion?: number;
  onSwitchToLive?: () => void;
  onSwitchToPreview?: () => void;
  onSwitchToHistory?: () => void;
}

interface LiveVisualTrackState {
  lastMeasuredT: number;
  offsetLat: number;
  offsetLon: number;
  offsetTrackDeg: number;
  prevRenderLat: number;
  prevRenderLon: number;
  prevRenderTrackDeg: number;
}

function createPlaneSdfCanvas(): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  // Crisp upward-pointing airliner silhouette (north = 0 deg)
  ctx.moveTo(32, 4);
  ctx.lineTo(36, 18);
  ctx.lineTo(58, 34);
  ctx.lineTo(58, 40);
  ctx.lineTo(36, 32);
  ctx.lineTo(36, 48);
  ctx.lineTo(46, 56);
  ctx.lineTo(46, 60);
  ctx.lineTo(32, 56);
  ctx.lineTo(18, 60);
  ctx.lineTo(18, 56);
  ctx.lineTo(28, 48);
  ctx.lineTo(28, 32);
  ctx.lineTo(6, 40);
  ctx.lineTo(6, 34);
  ctx.lineTo(28, 18);
  ctx.closePath();
  ctx.fill();
  return canvas;
}

function createHeliSdfCanvas(): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';

  // Fuselage + tail boom
  ctx.beginPath();
  ctx.ellipse(32, 28, 8, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillRect(29, 38, 6, 20);
  ctx.fillRect(23, 54, 18, 4);

  // Main rotor X-blades
  ctx.save();
  ctx.translate(32, 26);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-26, -2.5, 52, 5);
  ctx.fillRect(-2.5, -26, 5, 52);
  ctx.restore();

  return canvas;
}

function computeBoundaryBounds(feature: MunicipalityBoundaryFeature): [[number, number], [number, number]] {
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  for (const poly of feature.geometry.coordinates) {
    for (const ring of poly) {
      for (const pt of ring) {
        const lon = pt[0];
        const lat = pt[1];
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  if (minLon > maxLon) {
    return [
      [5.84, 52.66],
      [6.28, 52.86],
    ];
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

export const RadarMap: React.FC<RadarMapProps> = ({
  boundary,
  adjacentBoundaries,
  passages,
  approachingPassages = [],
  mode,
  feedMode,
  playheadMs,
  clockOffsetMs = 0,
  selectedPassageId,
  onSelectPassage,
  health,
  historyVersion = 0,
  onSwitchToLive,
  onSwitchToPreview,
  onSwitchToHistory,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const heatmapPopupRef = useRef<Popup | null>(null);
  const hoveredPassageIdRef = useRef<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [showTracks, setShowTracks] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [emptyCardDismissed, setEmptyCardDismissed] = useState(false);
  const [heatmapData, setHeatmapData] = useState<AllHistoryHeatmapResponse | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [hoveredHeatInfo, setHoveredHeatInfo] = useState<{
    key: string;
    count: number;
    nearbyMaxCount: number;
  } | null>(null);
  const [basemap, setBasemap] = useState<'dark' | 'pdok' | 'satellite'>('dark');
  const onSelectRef = useRef(onSelectPassage);
  onSelectRef.current = onSelectPassage;

  const heatmapCellLookup = useMemo(() => {
    const map = new Map<string, number>();
    if (!heatmapData) return map;
    for (const cell of heatmapData.cells) {
      map.set(`${cell.r}:${cell.c}`, cell.count);
    }
    return map;
  }, [heatmapData]);

  const heatmapStateRef = useRef<{
    showHeatmap: boolean;
    heatmapData: AllHistoryHeatmapResponse | null;
    cellLookup: Map<string, number>;
    boundary: MunicipalityBoundaryFeature;
    lastHoverKey: string | null;
  }>({
    showHeatmap,
    heatmapData,
    cellLookup: heatmapCellLookup,
    boundary,
    lastHoverKey: null,
  });
  heatmapStateRef.current.showHeatmap = showHeatmap;
  heatmapStateRef.current.heatmapData = heatmapData;
  heatmapStateRef.current.cellLookup = heatmapCellLookup;
  heatmapStateRef.current.boundary = boundary;

  // Factual speed-driven smooth state per ICAO24 (persists seamlessly across neighbor -> GM1708 boundary)
  const smoothStateRef = useRef<Map<string, LiveVisualTrackState>>(new Map());
  const liveInputsRef = useRef({
    passages,
    approachingPassages,
    selectedPassageId,
    showTracks,
    clockOffsetMs,
  });
  liveInputsRef.current = {
    passages,
    approachingPassages,
    selectedPassageId,
    showTracks,
    clockOffsetMs,
  };

  // Helper om GeoJSON collecties te bouwen (in live modus met feitelijke snelheidsprojectie + zachte blending)
  const buildGeoJsonSnapshot = useMemo(
    () =>
      (
        targetMode: RadarMode,
        nowSyncedMs: number,
        dtFrameSec: number,
        currentPassages: PassageWithTrack[],
        currentApproaching: PassageWithTrack[],
        currentSelectedId: string | null,
        tracksEnabled: boolean,
        currentPlayheadMs: number
      ) => {
        const trackFeatures: any[] = [];
        const approachTrackFeatures: any[] = [];
        const aircraftFeatures: any[] = [];
        const seenLiveKeys = new Set<string>();

        const combined =
          targetMode === 'live'
            ? [...currentPassages, ...currentApproaching]
            : currentPassages;

        for (const item of combined) {
          const { passage, positions } = item;
          if (!positions || positions.length === 0) continue;

          const isApproaching = Boolean(passage.visual_only);
          const isSelected = passage.id === currentSelectedId;
          let currentPt: PositionPoint | null = null;
          let resolvedTrack = 0;
          let trailToRender: PositionPoint[] = [];

          if (targetMode === 'live') {
            const lastIdx = positions.length - 1;
            const lastPt = positions[lastIdx];
            const factualTrack = resolveTrackAtIndex(positions, lastIdx);
            const effectiveGs = lastPt.gs ?? estimateSpeedKnotsFromTrack(positions);
            const elapsedSec = Math.max(0, Math.min(15, (nowSyncedMs - lastPt.t) / 1000));

            const projected = projectPositionBySpeed(
              lastPt.lat,
              lastPt.lon,
              factualTrack,
              effectiveGs,
              elapsedSec,
              lastPt.on_ground
            );

            const smoothKey = passage.icao24.toLowerCase();
            seenLiveKeys.add(smoothKey);
            let st = smoothStateRef.current.get(smoothKey);

            if (!st) {
              st = {
                lastMeasuredT: lastPt.t,
                offsetLat: 0,
                offsetLon: 0,
                offsetTrackDeg: 0,
                prevRenderLat: projected.lat,
                prevRenderLon: projected.lon,
                prevRenderTrackDeg: factualTrack,
              };
              smoothStateRef.current.set(smoothKey, st);
            } else {
              if (lastPt.t !== st.lastMeasuredT) {
                const gapMeters = haversineMeters(
                  st.prevRenderLat,
                  st.prevRenderLon,
                  projected.lat,
                  projected.lon
                );
                if (gapMeters <= 4500) {
                  st.offsetLat = st.prevRenderLat - projected.lat;
                  st.offsetLon = st.prevRenderLon - projected.lon;
                  st.offsetTrackDeg = normalizeSignedAngleDeg(
                    st.prevRenderTrackDeg - factualTrack
                  );
                } else {
                  st.offsetLat = 0;
                  st.offsetLon = 0;
                  st.offsetTrackDeg = 0;
                }
                st.lastMeasuredT = lastPt.t;
              }

              if (dtFrameSec > 0) {
                // Smooth ~1.2s ease-out correctie bij koers-/snelheidswijziging
                const decay = Math.exp(-dtFrameSec / 0.42);
                st.offsetLat *= decay;
                st.offsetLon *= decay;
                st.offsetTrackDeg *= decay;
              }
            }

            const renderLat = roundCoord6(projected.lat + st.offsetLat);
            const renderLon = roundCoord6(projected.lon + st.offsetLon);
            const renderTrack =
              ((factualTrack + st.offsetTrackDeg) % 360 + 360) % 360;

            st.prevRenderLat = renderLat;
            st.prevRenderLon = renderLon;
            st.prevRenderTrackDeg = renderTrack;

            currentPt = {
              ...lastPt,
              lat: renderLat,
              lon: renderLon,
            };
            resolvedTrack = renderTrack;

            const tipDist = haversineMeters(lastPt.lat, lastPt.lon, renderLat, renderLon);
            trailToRender =
              tipDist > 3
                ? [
                    ...positions,
                    {
                      ...lastPt,
                      t: nowSyncedMs,
                      lat: renderLat,
                      lon: renderLon,
                    },
                  ]
                : positions;
          } else {
            const interp = interpolatePassageAtTime(positions, currentPlayheadMs);
            if (!interp) continue;
            currentPt = interp.point;
            resolvedTrack = interp.resolvedTrack;
            trailToRender = interp.trailPositions;
          }

          if (tracksEnabled && trailToRender.length >= 2) {
            const targetArr = isApproaching ? approachTrackFeatures : trackFeatures;
            for (let i = 0; i < trailToRender.length - 1; i++) {
              const pA = trailToRender[i];
              const pB = trailToRender[i + 1];
              const avgAlt =
                pA.alt_m !== null && pB.alt_m !== null
                  ? Math.round((pA.alt_m + pB.alt_m) / 2)
                  : pA.alt_m ?? pB.alt_m ?? null;

              targetArr.push({
                type: 'Feature',
                properties: {
                  passage_id: passage.id,
                  alt_m: pB.on_ground ? -1 : avgAlt,
                  selected: isSelected ? 1 : 0,
                },
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [roundCoord6(pA.lon), roundCoord6(pA.lat)],
                    [roundCoord6(pB.lon), roundCoord6(pB.lat)],
                  ],
                },
              });
            }
          }

          const displayName =
            passage.callsign || passage.registration || passage.icao24.toUpperCase();
          const altText = currentPt.on_ground
            ? 'GROND'
            : currentPt.alt_m !== null
            ? `${currentPt.alt_m.toLocaleString('nl-NL')}m`
            : '—';
          const labelLine = isApproaching
            ? `${displayName}\nNADERT · ${altText}`
            : `${displayName}\n${altText}`;
          const color = getAltitudeColor(currentPt.alt_m, currentPt.on_ground);
          const isHeli = isHelicopterPassage(passage);

          aircraftFeatures.push({
            type: 'Feature',
            properties: {
              passage_id: passage.id,
              icao24: passage.icao24,
              callsign: displayName,
              label: labelLine,
              icon_name: isHeli ? 'icon-heli' : 'icon-plane',
              icon_color: isSelected ? '#fbbf24' : color,
              resolved_track: resolvedTrack,
              selected: isSelected ? 1 : 0,
              visual_only: isApproaching ? 1 : 0,
              neighbor_municipality: passage.neighbor_municipality || '',
              eta_seconds: passage.eta_seconds ?? null,
              alt_text: formatAltitudeLabel(currentPt.alt_ft, currentPt.alt_m, currentPt.on_ground),
              gs_text:
                currentPt.gs !== null
                  ? `${Math.round(currentPt.gs)} kts (${knotsToKmh(currentPt.gs)} km/u)`
                  : 'Onbekend',
              operator_text: passage.operator_name || passage.model_name || 'Onbekende operator',
              route_text:
                passage.dep_iata && passage.arr_iata
                  ? `${passage.dep_iata} → ${passage.arr_iata}`
                  : passage.dep_icao && passage.arr_icao
                  ? `${passage.dep_icao} → ${passage.arr_icao}`
                  : null,
              is_mlat: currentPt.src === 'mlat' || passage.has_mlat_positions ? 1 : 0,
            },
            geometry: {
              type: 'Point',
              coordinates: [roundCoord6(currentPt.lon), roundCoord6(currentPt.lat)],
            },
          });
        }

        if (targetMode === 'live') {
          for (const key of smoothStateRef.current.keys()) {
            if (!seenLiveKeys.has(key)) {
              smoothStateRef.current.delete(key);
            }
          }
        }

        return {
          tracksGeoJson: { type: 'FeatureCollection', features: trackFeatures },
          approachingTracksGeoJson: {
            type: 'FeatureCollection',
            features: approachTrackFeatures,
          },
          aircraftGeoJson: { type: 'FeatureCollection', features: aircraftFeatures },
        };
      },
    []
  );

  // In History-modus wordt de snapshot direct bepaald door playheadMs; in Live-modus telt het aantal actieve tracks
  const historySnapshot = useMemo(() => {
    if (mode === 'live') return null;
    return buildGeoJsonSnapshot(
      'history',
      playheadMs,
      0,
      passages,
      [],
      selectedPassageId,
      showTracks,
      playheadMs
    );
  }, [mode, passages, playheadMs, selectedPassageId, showTracks, buildGeoJsonSnapshot]);

  const visibleCount = useMemo(() => {
    if (mode === 'live') {
      return [...passages, ...approachingPassages].filter(
        (item) => item.positions && item.positions.length > 0
      ).length;
    }
    return historySnapshot?.aircraftGeoJson.features.length ?? 0;
  }, [mode, passages, approachingPassages, historySnapshot]);

  // Initialise MapLibre GL JS (zonder react-map-gl!)
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const bounds = computeBoundaryBounds(boundary);

    const map = new MapLibreMap({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [boundary.properties.centroid_lon, boundary.properties.centroid_lat],
      zoom: 10.6,
      attributionControl: false,
      fadeDuration: 0,
    });

    map.addControl(new NavigationControl({ showCompass: true }), 'bottom-right');

    const popup = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 16,
      maxWidth: '280px',
      className: 'pointer-events-none',
    });
    popupRef.current = popup;

    const heatmapPopup = new Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      maxWidth: '260px',
      className: 'pointer-events-none',
    });
    heatmapPopupRef.current = heatmapPopup;

    map.on('load', () => {
      // Extra API-key-vrije kaartlagen (PDOK Kadaster Grijs & Esri Satelliet)
      map.addSource('pdok-grijs', {
        type: 'raster',
        tiles: [
          'https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/grijs/EPSG:3857/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 19,
      });
      map.addLayer({
        id: 'pdok-grijs-layer',
        type: 'raster',
        source: 'pdok-grijs',
        layout: { visibility: 'none' },
        paint: {
          'raster-brightness-max': 0.52,
          'raster-contrast': 0.2,
          'raster-saturation': -0.5,
        },
      });

      map.addSource('esri-satelliet', {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        maxzoom: 18,
      });
      map.addLayer({
        id: 'esri-satelliet-layer',
        type: 'raster',
        source: 'esri-satelliet',
        layout: { visibility: 'none' },
      });
      // Registreer SDF iconen voor vliegtuig & helikopter
      const planeCanvas = createPlaneSdfCanvas();
      const heliCanvas = createHeliSdfCanvas();
      const planeCtx = planeCanvas.getContext('2d')!;
      const heliCtx = heliCanvas.getContext('2d')!;

      if (!map.hasImage('icon-plane')) {
        map.addImage(
          'icon-plane',
          planeCtx.getImageData(0, 0, planeCanvas.width, planeCanvas.height),
          { sdf: true }
        );
      }
      if (!map.hasImage('icon-heli')) {
        map.addImage(
          'icon-heli',
          heliCtx.getImageData(0, 0, heliCanvas.width, heliCanvas.height),
          { sdf: true }
        );
      }

      // 0. Direct aangrenzende gemeenten (7 buurgemeenten rond GM1708 voor visuele vooraankondiging)
      map.addSource('adjacent-boundaries', {
        type: 'geojson',
        data:
          adjacentBoundaries ||
          ({ type: 'FeatureCollection', features: [] } as any),
      });

      map.addLayer({
        id: 'adjacent-boundaries-fill',
        type: 'fill',
        source: 'adjacent-boundaries',
        paint: {
          'fill-color': '#38bdf8',
          'fill-opacity': 0.015,
        },
      });

      map.addLayer({
        id: 'adjacent-boundaries-outline',
        type: 'line',
        source: 'adjacent-boundaries',
        paint: {
          'line-color': '#38bdf8',
          'line-width': 1.2,
          'line-opacity': 0.28,
          'line-dasharray': [4, 4],
        },
      });

      // 1. Gemeentegrens GM1708
      map.addSource('steenwijkerland-boundary', {
        type: 'geojson',
        data: boundary as any,
      });

      map.addLayer({
        id: 'boundary-fill',
        type: 'fill',
        source: 'steenwijkerland-boundary',
        paint: {
          'fill-color': '#0ea5e9',
          'fill-opacity': 0.06,
        },
      });

      // 1b. Heatmap vliegsporen over volledige historie (standaard uitgeschakeld)
      map.addSource('history-heatmap-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'history-heatmap-layer',
        type: 'heatmap',
        source: 'history-heatmap-source',
        layout: {
          visibility: 'none',
        },
        paint: {
          'heatmap-weight': ['coalesce', ['get', 'weight'], 0.25],
          'heatmap-intensity': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            0.7,
            10.6,
            1.1,
            13,
            1.5,
          ],
          'heatmap-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8,
            8,
            10.6,
            19,
            12,
            28,
            14,
            52,
          ],
          'heatmap-opacity': 0.82,
          'heatmap-color': [
            'interpolate',
            ['linear'],
            ['heatmap-density'],
            0,
            'rgba(6, 14, 10, 0)',
            0.12,
            'rgba(56, 189, 248, 0.36)',
            0.34,
            'rgba(16, 185, 129, 0.65)',
            0.6,
            'rgba(245, 158, 11, 0.84)',
            0.84,
            'rgba(249, 115, 22, 0.94)',
            1,
            'rgba(239, 68, 68, 0.98)',
          ],
        },
      });

      map.addSource('heatmap-hover-cell-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      map.addLayer({
        id: 'heatmap-hover-cell-fill',
        type: 'fill',
        source: 'heatmap-hover-cell-source',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': '#fbbf24',
          'fill-opacity': 0.14,
        },
      });

      map.addLayer({
        id: 'heatmap-hover-cell-outline',
        type: 'line',
        source: 'heatmap-hover-cell-source',
        layout: { visibility: 'none' },
        paint: {
          'line-color': '#fbbf24',
          'line-width': 1.6,
          'line-opacity': 0.9,
        },
      });

      map.addLayer({
        id: 'boundary-outline',
        type: 'line',
        source: 'steenwijkerland-boundary',
        paint: {
          'line-color': '#38bdf8',
          'line-width': 2.5,
          'line-opacity': 0.9,
        },
      });

      // 2. Vliegsporen GM1708 (met maxzoom: 12 ter bescherming van MapLibre tiling performance)
      map.addSource('tracks-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        maxzoom: 12,
      });

      map.addLayer({
        id: 'tracks-layer',
        type: 'line',
        source: 'tracks-source',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': ['case', ['==', ['get', 'selected'], 1], 4.2, 2.4],
          'line-opacity': ['case', ['==', ['get', 'selected'], 1], 0.95, 0.72],
          'line-color': [
            'case',
            ['==', ['coalesce', ['get', 'alt_m'], -1], -1],
            '#94a3b8',
            [
              'interpolate',
              ['linear'],
              ['coalesce', ['get', 'alt_m'], 0],
              0,
              '#f59e0b',
              1000,
              '#10b981',
              5000,
              '#38bdf8',
              10500,
              '#818cf8',
            ],
          ],
        },
      });

      // 2b. Visuele aanvluchtsporen in aangrenzende gemeenten (gestippeld, puur visueel)
      map.addSource('approaching-tracks-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        maxzoom: 12,
      });

      map.addLayer({
        id: 'approaching-tracks-layer',
        type: 'line',
        source: 'approaching-tracks-source',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': ['case', ['==', ['get', 'selected'], 1], 3.2, 2.0],
          'line-opacity': 0.65,
          'line-dasharray': [2, 2],
          'line-color': [
            'case',
            ['==', ['coalesce', ['get', 'alt_m'], -1], -1],
            '#94a3b8',
            [
              'interpolate',
              ['linear'],
              ['coalesce', ['get', 'alt_m'], 0],
              0,
              '#f59e0b',
              1000,
              '#10b981',
              5000,
              '#38bdf8',
              10500,
              '#818cf8',
            ],
          ],
        },
      });

      // 3. Vliegtuigen & Helikopters: stabiele feature IDs + gescheiden hit-, icoon- en labellaag (geen collision-knipperen)
      map.addSource('aircraft-source', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'passage_id',
      });

      map.addLayer({
        id: 'aircraft-hit-layer',
        type: 'circle',
        source: 'aircraft-source',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'selected'], 1], 24, 20],
          'circle-color': '#000000',
          'circle-opacity': 0.001,
          'circle-stroke-width': 0,
        },
      });

      map.addLayer({
        id: 'aircraft-halo',
        type: 'circle',
        source: 'aircraft-source',
        filter: ['==', ['get', 'selected'], 1],
        paint: {
          'circle-radius': 20,
          'circle-color': 'rgba(245, 158, 11, 0.16)',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#fbbf24',
        },
      });

      map.addLayer({
        id: 'aircraft-label-layer',
        type: 'symbol',
        source: 'aircraft-source',
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-optional': true,
        },
        paint: {
          'text-color': '#f5f6f4',
          'text-halo-color': '#060e0a',
          'text-halo-width': 1.6,
        },
      });

      map.addLayer({
        id: 'aircraft-icon-layer',
        type: 'symbol',
        source: 'aircraft-source',
        layout: {
          'icon-image': ['get', 'icon_name'],
          'icon-size': ['case', ['==', ['get', 'selected'], 1], 0.56, 0.44],
          'icon-rotate': ['get', 'resolved_track'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['get', 'icon_color'],
          'icon-halo-color': '#060e0a',
          'icon-halo-width': 1.5,
        },
      });

      map.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 });

      const buildAircraftPopupHtml = (props: any) => {
        const routeBadge = props.route_text
          ? `<div style="margin-top:4px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#38bdf8;font-weight:700;">${props.route_text}</div>`
          : '';
        const mlatBadge =
          Number(props.is_mlat) === 1
            ? `<span style="margin-left:6px;padding:1px 4px;border-radius:3px;background:rgba(168,85,247,0.22);color:#d8b4fe;font-size:10px;font-weight:700;">MLAT</span>`
            : '';

        const approachBadge =
          Number(props.visual_only) === 1
            ? `<div style="margin-top:4px;padding:2px 6px;border-radius:3px;background:rgba(245,158,11,0.16);border:1px solid rgba(245,158,11,0.45);font-size:10px;color:#fbbf24;font-weight:700;">NADERT vanuit ${props.neighbor_municipality || 'buurgemeente'}${props.eta_seconds ? ` (~${props.eta_seconds}s)` : ''} · Nog niet in meting</div>`
            : '';

        return `<div style="padding:8px 10px;font-family:'Inter',sans-serif;font-variant-numeric:tabular-nums;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span style="font-family:'JetBrains Mono',monospace;font-weight:700;color:#fbbf24;font-size:12px;">${props.callsign}</span>
                ${mlatBadge}
              </div>
              <div style="font-size:11px;color:#9bb0a4;margin-top:2px;">${props.operator_text}</div>
              ${approachBadge}
              <div style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#f5f6f4;margin-top:5px;">
                ${props.alt_text}<br/>
                <span style="color:#9bb0a4;">Snelheid: ${props.gs_text}</span>
              </div>
              ${routeBadge}
            </div>`;
      };

      const handleAircraftHover = (e: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = 'pointer';
        heatmapPopup.remove();
        const hoverCellSrc = map.getSource('heatmap-hover-cell-source') as
          | GeoJSONSource
          | undefined;
        if (hoverCellSrc) {
          hoverCellSrc.setData({ type: 'FeatureCollection', features: [] } as any);
        }
        const feature = e.features?.[0];
        if (!feature) return;
        const props: any = feature.properties || {};
        const pid = props.passage_id ? String(props.passage_id) : null;
        hoveredPassageIdRef.current = pid;
        const coords = (feature.geometry as any).coordinates.slice();

        popup
          .setLngLat(coords)
          .setHTML(buildAircraftPopupHtml(props))
          .addTo(map);
      };

      map.on('mouseenter', 'aircraft-hit-layer', handleAircraftHover);
      map.on('mousemove', 'aircraft-hit-layer', (e: MapLayerMouseEvent) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const pid = feature.properties?.passage_id ? String(feature.properties.passage_id) : null;
        if (pid !== hoveredPassageIdRef.current || !popup.isOpen()) {
          handleAircraftHover(e);
        }
      });

      map.on('mouseleave', 'aircraft-hit-layer', () => {
        map.getCanvas().style.cursor = '';
        hoveredPassageIdRef.current = null;
        popup.remove();
      });

      map.on('mousemove', (e) => {
        const hs = heatmapStateRef.current;
        if (!hs.showHeatmap || !hs.heatmapData || hoveredPassageIdRef.current) {
          heatmapPopup.remove();
          if (hs.lastHoverKey !== null) {
            hs.lastHoverKey = null;
            setHoveredHeatInfo(null);
            const hoverCellSrc = map.getSource('heatmap-hover-cell-source') as
              | GeoJSONSource
              | undefined;
            if (hoverCellSrc) {
              hoverCellSrc.setData({ type: 'FeatureCollection', features: [] } as any);
            }
          }
          return;
        }

        const { r, c, key } = latLonToHeatmapCell(e.lngLat.lat, e.lngLat.lng);
        const count = hs.cellLookup.get(key) ?? 0;

        let nearbyMaxCount = 0;
        if (count === 0) {
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nCnt = hs.cellLookup.get(`${r + dr}:${c + dc}`) ?? 0;
              if (nCnt > nearbyMaxCount) nearbyMaxCount = nCnt;
            }
          }
        }

        const inGm1708 = isPointInsideBoundary(e.lngLat.lng, e.lngLat.lat, hs.boundary);
        if (count === 0 && nearbyMaxCount === 0 && !inGm1708) {
          heatmapPopup.remove();
          if (hs.lastHoverKey !== null) {
            hs.lastHoverKey = null;
            setHoveredHeatInfo(null);
            const hoverCellSrc = map.getSource('heatmap-hover-cell-source') as
              | GeoJSONSource
              | undefined;
            if (hoverCellSrc) {
              hoverCellSrc.setData({ type: 'FeatureCollection', features: [] } as any);
            }
          }
          return;
        }

        const total = hs.heatmapData.totalPassages;
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
        const movementLabel = count === 1 ? 'vliegbeweging' : 'vliegbewegingen';
        const countColor = count > 0 ? '#fbbf24' : '#9bb0a4';
        const nearbyNote =
          count === 0 && nearbyMaxCount > 0
            ? `<div style="font-size:10px;color:#38bdf8;margin-top:2px;">Direct naastgelegen vak: max ${nearbyMaxCount.toLocaleString('nl-NL')}×</div>`
            : '';

        heatmapPopup
          .setLngLat(e.lngLat)
          .setHTML(
            `<div style="padding:7px 10px;font-family:'Inter',sans-serif;font-variant-numeric:tabular-nums;">
              <div style="font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px;color:${countColor};">
                ${count.toLocaleString('nl-NL')} ${movementLabel}
              </div>
              <div style="font-size:11px;color:#f5f6f4;margin-top:2px;">
                ${pct}% van ${total.toLocaleString('nl-NL')} vluchten (volledige historie)
              </div>
              ${nearbyNote}
              <div style="font-family:'JetBrains Mono',monospace;font-size:10px;color:#9bb0a4;margin-top:3px;">
                Plek (~400 × 400 m) · GM1708
              </div>
            </div>`
          )
          .addTo(map);

        if (hs.lastHoverKey !== key) {
          hs.lastHoverKey = key;
          setHoveredHeatInfo({ key, count, nearbyMaxCount });
          const hoverCellSrc = map.getSource('heatmap-hover-cell-source') as
            | GeoJSONSource
            | undefined;
          if (hoverCellSrc) {
            hoverCellSrc.setData(heatmapCellPolygonGeoJson(r, c) as any);
          }
        }
      });

      map.on('mouseout', () => {
        heatmapPopup.remove();
        heatmapStateRef.current.lastHoverKey = null;
        setHoveredHeatInfo(null);
        const hoverCellSrc = map.getSource('heatmap-hover-cell-source') as
          | GeoJSONSource
          | undefined;
        if (hoverCellSrc) {
          hoverCellSrc.setData({ type: 'FeatureCollection', features: [] } as any);
        }
      });

      map.on('click', (e: MapLayerMouseEvent) => {
        const aircraftHits = map.queryRenderedFeatures(e.point, {
          layers: ['aircraft-hit-layer', 'aircraft-icon-layer', 'aircraft-label-layer'],
        });
        const acPid = aircraftHits[0]?.properties?.passage_id;
        if (acPid) {
          onSelectRef.current(String(acPid));
          return;
        }
        const trackHits = map.queryRenderedFeatures(e.point, {
          layers: ['tracks-layer'],
        });
        const trPid = trackHits[0]?.properties?.passage_id;
        if (trPid) {
          onSelectRef.current(String(trPid));
        }
      });

      setMapReady(true);
    });

    mapRef.current = map;

    return () => {
      popup.remove();
      heatmapPopup.remove();
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  // Update gemeentegrenzen (GM1708 + 7 buurgemeenten) zodra geladen
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const src = mapRef.current.getSource('steenwijkerland-boundary') as GeoJSONSource | undefined;
    if (src) {
      src.setData(boundary as any);
    }
    const adjSrc = mapRef.current.getSource('adjacent-boundaries') as GeoJSONSource | undefined;
    if (adjSrc && adjacentBoundaries) {
      adjSrc.setData(adjacentBoundaries as any);
    }
  }, [boundary, adjacentBoundaries, mapReady]);

  // Wis naderende buurgemeente-sporen eenmalig bij wisselen naar historie-modus
  useEffect(() => {
    if (!mapReady || !mapRef.current || mode !== 'history') return;
    smoothStateRef.current.clear();
    const appTrackSrc = mapRef.current.getSource('approaching-tracks-source') as
      | GeoJSONSource
      | undefined;
    if (appTrackSrc) {
      appTrackSrc.setData({ type: 'FeatureCollection', features: [] } as any);
    }
  }, [mode, mapReady]);

  // Direct muteren van MapLibre GeoJSON bronnen in History-modus (tijdbalk-gestuurd)
  useEffect(() => {
    if (!mapReady || !mapRef.current || mode !== 'history' || !historySnapshot) return;

    const trackSrc = mapRef.current.getSource('tracks-source') as GeoJSONSource | undefined;
    const acSrc = mapRef.current.getSource('aircraft-source') as GeoJSONSource | undefined;

    if (trackSrc) trackSrc.setData(historySnapshot.tracksGeoJson as any);
    if (acSrc) acSrc.setData(historySnapshot.aircraftGeoJson as any);

    const hoveredId = hoveredPassageIdRef.current;
    if (hoveredId && popupRef.current?.isOpen()) {
      const feat = historySnapshot.aircraftGeoJson.features.find(
        (f: any) => f.properties?.passage_id === hoveredId
      );
      if (feat) {
        popupRef.current.setLngLat((feat.geometry as any).coordinates);
      } else {
        hoveredPassageIdRef.current = null;
        popupRef.current.remove();
      }
    }
  }, [mode, historySnapshot, mapReady]);

  // Vloeiende ~30 fps Live snelheids-gebaseerde animatieloop (geen React re-renders per frame!)
  useEffect(() => {
    if (!mapReady || !mapRef.current || mode !== 'live') return;

    let rafId = 0;
    let prevRafTs = 0;
    let lastCommitTs = 0;

    const tick = (rafTs: number) => {
      const m = mapRef.current;
      if (!m) return;

      if (lastCommitTs !== 0 && rafTs - lastCommitTs < 32) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const dtFrameSec = prevRafTs > 0 ? Math.min(0.15, (rafTs - prevRafTs) / 1000) : 0;
      prevRafTs = rafTs;
      lastCommitTs = rafTs;

      const inputs = liveInputsRef.current;
      const nowSyncedMs = Date.now() + inputs.clockOffsetMs;
      const snapshot = buildGeoJsonSnapshot(
        'live',
        nowSyncedMs,
        dtFrameSec,
        inputs.passages,
        inputs.approachingPassages,
        inputs.selectedPassageId,
        inputs.showTracks,
        nowSyncedMs
      );

      const trackSrc = m.getSource('tracks-source') as GeoJSONSource | undefined;
      const appTrackSrc = m.getSource('approaching-tracks-source') as
        | GeoJSONSource
        | undefined;
      const acSrc = m.getSource('aircraft-source') as GeoJSONSource | undefined;

      if (trackSrc) trackSrc.setData(snapshot.tracksGeoJson as any);
      if (appTrackSrc) appTrackSrc.setData(snapshot.approachingTracksGeoJson as any);
      if (acSrc) acSrc.setData(snapshot.aircraftGeoJson as any);

      // Laat actieve hover-popup meeschuiven met het vliegtuig
      const hoveredId = hoveredPassageIdRef.current;
      if (hoveredId && popupRef.current?.isOpen()) {
        const feat = snapshot.aircraftGeoJson.features.find(
          (f: any) => f.properties?.passage_id === hoveredId
        );
        if (feat) {
          popupRef.current.setLngLat((feat.geometry as any).coordinates);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mapReady, mode, buildGeoJsonSnapshot]);

  // Laad volledige-historie heatmap data wanneer de kaartlaag geactiveerd wordt
  useEffect(() => {
    if (!showHeatmap) {
      heatmapPopupRef.current?.remove();
      setHoveredHeatInfo(null);
      heatmapStateRef.current.lastHoverKey = null;
      return;
    }

    let cancelled = false;
    const loadHeatmap = async () => {
      if (feedMode === 'demo') {
        const now = Date.now();
        const slice = getDemoHistoricalSlice(
          new Date(now - 35 * 86_400_000).toISOString(),
          new Date(now).toISOString(),
          {
            minAltM: 0,
            maxAltM: 20000,
            includeUnknownAlt: true,
            categories: ['commercial', 'general_aviation', 'hems_police_sar', 'military', 'unknown'],
            searchQuery: '',
          }
        );
        if (!cancelled) {
          setHeatmapData(
            buildHeatmapFromTracks(
              slice.passages.map((p) => ({
                id: p.passage.id,
                positions: p.positions,
              })),
              slice.passages.length
            )
          );
        }
        return;
      }

      setHeatmapLoading(true);
      try {
        const res = await fetch('/api/radar/heatmap');
        if (res.ok) {
          const data: AllHistoryHeatmapResponse = await res.json();
          if (!cancelled) setHeatmapData(data);
        }
      } catch {
        // Negeer tijdelijke netwerkfout
      } finally {
        if (!cancelled) setHeatmapLoading(false);
      }
    };

    loadHeatmap();
    const timer = feedMode === 'live' ? setInterval(loadHeatmap, 30_000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [showHeatmap, feedMode, historyVersion]);

  // Synchroniseer heatmap GeoJSON + laagzichtbaarheid in MapLibre
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const m = mapRef.current;

    const vis = showHeatmap ? 'visible' : 'none';
    for (const lid of [
      'history-heatmap-layer',
      'heatmap-hover-cell-fill',
      'heatmap-hover-cell-outline',
    ]) {
      if (m.getLayer(lid)) {
        m.setLayoutProperty(lid, 'visibility', vis);
      }
    }

    const src = m.getSource('history-heatmap-source') as GeoJSONSource | undefined;
    if (src) {
      if (showHeatmap && heatmapData) {
        const maxC = Math.max(1, heatmapData.maxCount);
        src.setData({
          type: 'FeatureCollection',
          features: heatmapData.cells.map((cell) => ({
            type: 'Feature',
            properties: {
              count: cell.count,
              weight: maxC === 1 ? 1 : 0.14 + 0.86 * (cell.count / maxC),
            },
            geometry: {
              type: 'Point',
              coordinates: [cell.lon, cell.lat],
            },
          })),
        } as any);
      } else if (!showHeatmap) {
        src.setData({ type: 'FeatureCollection', features: [] } as any);
        const hoverSrc = m.getSource('heatmap-hover-cell-source') as GeoJSONSource | undefined;
        if (hoverSrc) {
          hoverSrc.setData({ type: 'FeatureCollection', features: [] } as any);
        }
      }
    }
  }, [showHeatmap, heatmapData, mapReady]);

  // Schakel achtergrondkaart zonder API key (OpenFreeMap Donker / PDOK Kadaster / Esri Satelliet)
  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const m = mapRef.current;
    if (m.getLayer('pdok-grijs-layer')) {
      m.setLayoutProperty(
        'pdok-grijs-layer',
        'visibility',
        basemap === 'pdok' ? 'visible' : 'none'
      );
    }
    if (m.getLayer('esri-satelliet-layer')) {
      m.setLayoutProperty(
        'esri-satelliet-layer',
        'visibility',
        basemap === 'satellite' ? 'visible' : 'none'
      );
    }
  }, [basemap, mapReady]);

  useEffect(() => {
    setEmptyCardDismissed(false);
  }, [mode]);

  const handleRecenter = () => {
    if (!mapRef.current) return;
    const bounds = computeBoundaryBounds(boundary);
    mapRef.current.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 500 });
  };

  return (
    <div className="relative w-full h-full bg-[var(--bg-main)] overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {/* Kaartacties rechtsboven */}
      <div className="absolute top-3 right-3 z-20 flex flex-col items-end gap-1.5">
        <div className="flex items-center rounded-[4px] bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] p-0.5 shadow-lg text-[10px] font-semibold">
          {(
            [
              { id: 'dark', label: 'Donker' },
              { id: 'pdok', label: 'PDOK' },
              { id: 'satellite', label: 'Satelliet' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setBasemap(item.id)}
              className={`px-2 py-1 rounded-[3px] cursor-pointer transition-colors ${
                basemap === item.id
                  ? 'bg-[var(--accent-gold)] text-[#060e0a] font-bold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleRecenter}
          className="px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-card)]/95 hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] hover:border-[var(--border-focus)] text-[var(--text-main)] text-[11px] font-semibold shadow-lg flex items-center gap-1.5 cursor-pointer transition-colors"
          title="Centreer kaart op Gemeente Steenwijkerland (GM1708)"
        >
          <Compass className="w-3.5 h-3.5 text-[var(--status-blue)]" />
          <span>Centreer GM1708</span>
        </button>

        <button
          type="button"
          onClick={() => setShowTracks((v) => !v)}
          className={`px-2.5 py-1.5 rounded-[4px] border text-[11px] font-semibold shadow-lg flex items-center gap-1.5 cursor-pointer transition-colors ${
            showTracks
              ? 'bg-[var(--bg-elevated)]/95 text-[var(--accent-gold-bright)] border-[var(--border-focus)]'
              : 'bg-[var(--bg-card)]/95 text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-[var(--text-main)]'
          }`}
          title="Toon of verberg gevlogen hoogte-tracks"
        >
          <Layers className="w-3.5 h-3.5" />
          <span>Vliegsporen {showTracks ? 'Aan' : 'Uit'}</span>
        </button>

        <button
          type="button"
          onClick={() => setShowHeatmap((v) => !v)}
          className={`px-2.5 py-1.5 rounded-[4px] border text-[11px] font-semibold shadow-lg flex items-center gap-1.5 cursor-pointer transition-colors ${
            showHeatmap
              ? 'bg-[var(--bg-elevated)]/95 text-[var(--accent-gold-bright)] border-[var(--accent-gold)]'
              : 'bg-[var(--bg-card)]/95 text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-[var(--text-main)]'
          }`}
          title="Toon of verberg heatmap van alle historische vliegsporen (standaard uit)"
        >
          <Flame className={`w-3.5 h-3.5 ${showHeatmap ? 'text-[var(--accent-gold)]' : ''}`} />
          <span>Heatmap {showHeatmap ? 'Aan' : 'Uit'}</span>
        </button>
      </div>

      {/* Hoogte-kleurlegenda & Heatmap legenda linksonder */}
      <div className="hidden sm:flex flex-col gap-1.5 absolute bottom-3 left-3 z-20 p-2.5 rounded-[5px] bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] shadow-xl text-[11px] tabular-nums backdrop-blur-xs">
        <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center justify-between gap-4">
          <span>Vlieghoogte (baro/geom)</span>
          <span className="font-mono text-[var(--status-blue)]">GM1708</span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-[#f59e0b]" />
            <span className="text-[var(--text-main)]">0 – 1.000 m</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-[#10b981]" />
            <span className="text-[var(--text-main)]">1.000 – 5.000 m</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-[#38bdf8]" />
            <span className="text-[var(--text-main)]">&gt; 5.000 m (kruis)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-xs bg-[#94a3b8]" />
            <span className="text-[var(--text-muted)]">Grond / Onbekend</span>
          </div>
        </div>

        {showHeatmap && (
          <div className="mt-1 pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--accent-gold-bright)] flex items-center justify-between gap-3">
              <span className="flex items-center gap-1">
                <Flame className="w-3 h-3 text-[var(--accent-gold)]" />
                <span>Heatmap · Volledige historie</span>
              </span>
              {heatmapData && (
                <span className="font-mono text-[var(--text-dim)]">
                  {heatmapData.totalPassages.toLocaleString('nl-NL')} vluchten
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-[var(--text-dim)]">1×</span>
              <div
                className="h-2 flex-1 rounded-[2px] border border-[var(--border-subtle)]"
                style={{
                  background:
                    'linear-gradient(90deg, rgba(56,189,248,0.65) 0%, #10b981 35%, #f59e0b 65%, #ef4444 100%)',
                }}
              />
              <span className="text-[10px] font-mono text-[var(--accent-gold-bright)]">
                {heatmapData && heatmapData.maxCount > 0
                  ? `${heatmapData.maxCount.toLocaleString('nl-NL')}×`
                  : 'Max'}
              </span>
            </div>
            <div className="text-[10px] font-mono text-[var(--text-muted)] flex items-center justify-between gap-2">
              {heatmapLoading && !heatmapData ? (
                <span>Heatmap berekenen...</span>
              ) : hoveredHeatInfo ? (
                <>
                  <span>Hover (400×400 m):</span>
                  <strong className="text-[var(--accent-gold-bright)]">
                    {hoveredHeatInfo.count.toLocaleString('nl-NL')}{' '}
                    {hoveredHeatInfo.count === 1 ? 'vliegbeweging' : 'vliegbewegingen'}
                  </strong>
                </>
              ) : (
                <span>Hover over kaart voor exact aantal</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Linksboven op de kaart: snelle 'Terug naar Live' knop (alleen in historie-modus) + weggeklikte statuspil */}
      {( (mode === 'history' && onSwitchToLive) || (visibleCount === 0 && emptyCardDismissed) ) && (
        <div className="absolute top-3 left-3 z-20 flex flex-wrap items-center gap-2 max-w-[calc(100%-150px)]">
          {mode === 'history' && onSwitchToLive && (
            <button
              type="button"
              onClick={onSwitchToLive}
              className="px-3 py-1.5 rounded-[5px] bg-[var(--bg-card)]/95 hover:bg-[var(--bg-elevated)] border border-[var(--status-emerald)]/75 hover:border-[var(--status-emerald)] text-[var(--text-main)] text-xs font-bold shadow-xl backdrop-blur-xs flex items-center gap-2 cursor-pointer transition-colors"
              title="Keer direct terug naar de live situatie (alle gelogde historie blijft behouden)"
            >
              <span className="w-2 h-2 rounded-full bg-[var(--status-emerald)] animate-pulse shrink-0" />
              <Radio className="w-3.5 h-3.5 text-[var(--status-emerald)] shrink-0" />
              <span>Terug naar Live</span>
            </button>
          )}

          {visibleCount === 0 && emptyCardDismissed && (
            <button
              type="button"
              onClick={() => setEmptyCardDismissed(false)}
              className="px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-card)]/95 hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] hover:border-[var(--border-focus)] text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--text-main)] shadow-lg flex items-center gap-1.5 cursor-pointer transition-colors"
              title="Toon radarstatus-melding opnieuw"
            >
              <span className="w-2 h-2 rounded-full bg-[var(--status-emerald)] animate-pulse" />
              <span>
                {mode === 'live'
                  ? 'Op dit live moment geen vlucht in GM1708 · wacht op verkeer (10s)'
                  : 'Geen vlucht op dit tijdstip'}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Wegklikbare Lege Radar Statuskaart */}
      {visibleCount === 0 && !emptyCardDismissed && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-4">
          <div className="pointer-events-auto relative max-w-md w-full bg-[var(--bg-card)]/95 border border-[var(--border-subtle)] rounded-[6px] shadow-2xl p-5 backdrop-blur-sm tabular-nums">
            <button
              type="button"
              onClick={() => setEmptyCardDismissed(true)}
              aria-label="Melding sluiten"
              title="Melding wegklikken"
              className="absolute top-3 right-3 p-1 rounded-[4px] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] cursor-pointer transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>

            <div className="flex items-start gap-3 pr-6">
              <div className="w-9 h-9 rounded-[4px] bg-[var(--bg-elevated)] border border-[var(--border-focus)] flex items-center justify-center shrink-0">
                <Plane className="w-4.5 h-4.5 text-[var(--accent-gold)]" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-bold text-[var(--text-main)] tracking-tight">
                  {mode === 'live'
                    ? 'Op dit live moment geen vliegtuigen boven Steenwijkerland'
                    : 'Geen toestellen op dit exacte tijdstip in de selectie'}
                </h3>
                <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
                  {mode === 'live'
                    ? 'De live radar werkt gewoon door en ververst automatisch elke 10 seconden. Er vliegt alleen op dit precieze moment toevallig geen toestel binnen de gemeentegrens — wacht even af tot een vliegtuig nadert, of bekijk eerder gelogde vluchten in Historie terugkijken.'
                    : passages.length > 0
                    ? `Alleen op dit gekozen tijdstip is er niets te zien; in dit tijdvak zijn wél ${passages.length.toLocaleString('nl-NL')} gelogde vluchten aanwezig. Druk op Afspelen, verschuif de tijdbalk of schakel terug naar Live Radar.`
                    : 'Alleen voor dit tijdvak/filter zijn nu geen vluchten zichtbaar (alles wat eerder is gelogd blijft bewaard). Kies een breder tijdvak (Dag / Week), verruim de filters of schakel naar Live Radar en wacht tot er een toestel passeert.'}
                </p>

                <div className="mt-3 p-2.5 rounded-[4px] bg-[var(--bg-main)] border border-[var(--border-subtle)] grid grid-cols-2 gap-2 text-[11px] font-mono">
                  <div>
                    <div className="text-[var(--text-dim)]">Actieve feed</div>
                    <div className="text-[var(--text-main)] font-semibold flex items-center gap-1">
                      <Radio className="w-3 h-3 text-[var(--status-emerald)]" />
                      <span>{health.active_feed_source}</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-dim)]">Laatste succes-poll</div>
                    <div className="text-[var(--text-main)] font-semibold">
                      {formatTimeNL(health.last_success_at, true)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-dim)]">In 25 NM radius</div>
                    <div className="text-[var(--status-blue)] font-bold">
                      {health.aircraft_in_radius} toestellen
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--text-dim)]">Binnen GM1708</div>
                    <div className="text-[var(--accent-gold-bright)] font-bold">
                      {health.aircraft_in_gm1708} toestellen
                    </div>
                  </div>
                </div>

                {health.last_error && feedMode === 'live' && (
                  <p className="mt-2 text-[11px] text-[var(--status-crimson)] font-mono">
                    Melding: {health.last_error}
                  </p>
                )}

                <div className="mt-3.5 flex flex-wrap items-center gap-2">
                  {mode === 'live' && onSwitchToHistory && (
                    <button
                      type="button"
                      onClick={onSwitchToHistory}
                      className="px-3 py-1.5 rounded-[4px] bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-focus)] text-[var(--text-main)] text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <History className="w-3.5 h-3.5 text-[var(--status-blue)]" />
                      <span>Historie terugkijken</span>
                    </button>
                  )}
                  {mode === 'history' && onSwitchToLive && (
                    <button
                      type="button"
                      onClick={onSwitchToLive}
                      className="px-3 py-1.5 rounded-[4px] bg-[var(--bg-elevated)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-focus)] text-[var(--text-main)] text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Radio className="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                      <span>Terug naar Live Radar</span>
                    </button>
                  )}
                  {feedMode === 'live' && onSwitchToPreview && (
                    <button
                      type="button"
                      onClick={onSwitchToPreview}
                      className="px-3 py-1.5 rounded-[4px] bg-[var(--accent-gold)] hover:bg-[var(--accent-gold-bright)] text-[#060e0a] text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <ToggleRight className="w-3.5 h-3.5" />
                      <span>Open Preview-modus</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEmptyCardDismissed(true)}
                    className="px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] text-xs font-semibold cursor-pointer transition-colors"
                  >
                    Sluiten
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
