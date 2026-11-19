import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FeedMode,
  FlightPassage,
  PassageWithTrack,
  RadarFilters,
  RadarMode,
  TimeGranularity,
} from './types/radar';
import { useMunicipalityBoundary } from './hooks/useMunicipalityBoundary';
import { useLiveRadar } from './hooks/useLiveRadar';
import { useHistoricalReplay } from './hooks/useHistoricalReplay';
import { useHistorySync } from './hooks/useHistorySync';
import { TopNavBar } from './components/TopNavBar';
import { RadarMap } from './components/RadarMap';
import {
  DEFAULT_RADAR_FILTERS,
  FilterSidebar,
} from './components/FilterSidebar';
import { TimeScrubberBar } from './components/TimeScrubberBar';
import { PassageDetailDrawer } from './components/PassageDetailDrawer';
import { AttributionFooter } from './components/AttributionFooter';
import { AirspaceStatsModal } from './components/AirspaceStatsModal';
import { EmbedDataproductModal } from './components/EmbedDataproductModal';

function applyPassageFilters(
  list: PassageWithTrack[],
  filters: RadarFilters
): PassageWithTrack[] {
  const q = filters.searchQuery.trim().toLowerCase();
  return list.filter(({ passage, positions }) => {
    if (
      filters.categories.length > 0 &&
      !filters.categories.includes(passage.traffic_category)
    ) {
      return false;
    }

    const latestAlt =
      positions.length > 0 ? positions[positions.length - 1].alt_m : passage.max_alt_m;
    const minA = passage.min_alt_m ?? latestAlt;
    const maxA = passage.max_alt_m ?? latestAlt;

    if (minA === null && maxA === null) {
      if (!filters.includeUnknownAlt) return false;
    } else {
      const lo = minA ?? maxA ?? 0;
      const hi = maxA ?? minA ?? 20000;
      if (hi < filters.minAltM || lo > filters.maxAltM) return false;
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
}

function getRangeForGranularity(g: TimeGranularity, nowMs: number): [number, number] {
  if (g === 'hour') return [nowMs - 3_600_000, nowMs];
  if (g === 'day') return [nowMs - 86_400_000, nowMs];
  if (g === 'week') return [nowMs - 7 * 86_400_000, nowMs];
  return [nowMs - 3_600_000, nowMs];
}

export default function App() {
  const isEmbed = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('embed') === 'true' ||
      params.get('widget') === 'true' ||
      window.self !== window.top
    );
  }, []);

  const [mode, setMode] = useState<RadarMode>('live');
  const [feedMode, setFeedMode] = useState<FeedMode>('live');
  const [filters, setFilters] = useState<RadarFilters>(DEFAULT_RADAR_FILTERS);
  const [isFilterOpen, setIsFilterOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth >= 1200 && window.self === window.top;
  });
  const [selectedPassageId, setSelectedPassageId] = useState<string | null>(null);
  const [isStatsModalOpen, setIsStatsModalOpen] = useState<boolean>(false);
  const [isEmbedModalOpen, setIsEmbedModalOpen] = useState<boolean>(false);

  // Historische Replay & 60 fps Time-Scrubber state
  const [granularity, setGranularity] = useState<TimeGranularity>('hour');
  const [historyRange, setHistoryRange] = useState<{ startMs: number; endMs: number }>(() => {
    const now = Date.now();
    return { startMs: now - 3_600_000, endMs: now };
  });
  const [playheadMs, setPlayheadMs] = useState<number>(() => Date.now() - 1_800_000);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [speed, setSpeed] = useState<number>(10);

  const { boundary, adjacentBoundaries } = useMunicipalityBoundary();
  const liveRadar = useLiveRadar(mode === 'live', feedMode);
  const historySync = useHistorySync(feedMode, liveRadar.passages);

  const startIso = useMemo(
    () => new Date(historyRange.startMs).toISOString(),
    [historyRange.startMs]
  );
  const endIso = useMemo(
    () => new Date(historyRange.endMs).toISOString(),
    [historyRange.endMs]
  );

  const historicalReplay = useHistoricalReplay({
    enabled: mode === 'history',
    feedMode,
    startIso,
    endIso,
    filters,
    refreshKey: historySync.historyVersion,
  });

  // Vloeiende ~30 fps requestAnimationFrame loop voor historische tijdlijn (voorkomt worker-stutter bij 60/120Hz)
  const lastRafRef = useRef<number | null>(null);
  useEffect(() => {
    if (mode !== 'history' || !isPlaying) {
      lastRafRef.current = null;
      return;
    }

    let rafId = 0;
    const step = (ts: number) => {
      if (lastRafRef.current === null) {
        lastRafRef.current = ts;
      } else {
        const elapsed = ts - lastRafRef.current;
        if (elapsed >= 32) {
          const dtMs = Math.min(200, elapsed);
          lastRafRef.current = ts;
          setPlayheadMs((prev) => {
            const next = prev + dtMs * speed;
            if (next >= historyRange.endMs) {
              setIsPlaying(false);
              return historyRange.endMs;
            }
            return next;
          });
        }
      }
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [mode, isPlaying, speed, historyRange.endMs]);

  const handleChangeMode = useCallback((nextMode: RadarMode) => {
    setMode(nextMode);
    setSelectedPassageId(null);
    if (nextMode === 'history') {
      const now = Date.now();
      const [s, e] = getRangeForGranularity(granularity, now);
      setHistoryRange({ startMs: s, endMs: e });
      setPlayheadMs(Math.round((s + e) / 2));
      setIsPlaying(false);
    } else {
      setIsPlaying(false);
    }
  }, [granularity]);

  const handleSelectGranularity = useCallback((g: TimeGranularity) => {
    setGranularity(g);
    setIsPlaying(false);
    if (g !== 'custom') {
      const now = Date.now();
      const [s, e] = getRangeForGranularity(g, now);
      setHistoryRange({ startMs: s, endMs: e });
      setPlayheadMs(Math.round(s + (e - s) * 0.75));
    }
  }, []);

  const handleChangeCustomRange = useCallback((startMs: number, endMs: number) => {
    setIsPlaying(false);
    setHistoryRange({ startMs, endMs });
    setPlayheadMs(startMs);
  }, []);

  // Gefilterde passages voor kaart + sidebar
  const visiblePassages = useMemo(() => {
    const raw = mode === 'live' ? liveRadar.passages : historicalReplay.passages;
    return applyPassageFilters(raw, filters);
  }, [mode, liveRadar.passages, historicalReplay.passages, filters]);

  const visibleApproachingPassages = useMemo(() => {
    if (mode !== 'live') return [];
    return applyPassageFilters(liveRadar.approachingPassages, filters);
  }, [mode, liveRadar.approachingPassages, filters]);

  // Geselecteerd toestel (blijft bewaard tot Esc of Sluiten)
  const selectedItem = useMemo<PassageWithTrack | null>(() => {
    if (!selectedPassageId) return null;
    const raw =
      mode === 'live'
        ? [...liveRadar.passages, ...liveRadar.approachingPassages]
        : historicalReplay.passages;
    return raw.find((p) => p.passage.id === selectedPassageId) || null;
  }, [
    selectedPassageId,
    mode,
    liveRadar.passages,
    liveRadar.approachingPassages,
    historicalReplay.passages,
  ]);

  // Escape sluit open modals/drawers
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isEmbedModalOpen) setIsEmbedModalOpen(false);
        else if (isStatsModalOpen) setIsStatsModalOpen(false);
        else if (selectedPassageId) setSelectedPassageId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isEmbedModalOpen, isStatsModalOpen, selectedPassageId]);

  const handleSelectPassageFromStats = useCallback(
    (passage: FlightPassage, followOnTimeline = true) => {
      setSelectedPassageId(passage.id);

      // Zorg dat actieve filters het gekozen toestel niet verbergen
      if (applyPassageFilters([{ passage, positions: [] }], filters).length === 0) {
        setFilters(DEFAULT_RADAR_FILTERS);
      }

      const inLive = liveRadar.passages.some((p) => p.passage.id === passage.id);
      if (inLive && !followOnTimeline && mode === 'live') {
        return;
      }

      const entryMs = new Date(passage.entry_time).getTime();
      const rawEndMs = new Date(
        passage.exit_time || passage.last_seen_time || passage.entry_time
      ).getTime();
      const flightEndMs = Number.isFinite(rawEndMs) && rawEndMs >= entryMs ? rawEndMs : entryMs;

      if (!Number.isFinite(entryMs)) return;

      // Focus een overzichtelijk tijdsvenster (~15 min) rond de gekozen vlucht
      const padBeforeMs = 3 * 60_000;
      const minWindowEnd = entryMs + 12 * 60_000;
      const padAfterMs = 3 * 60_000;
      const rangeStart = entryMs - padBeforeMs;
      const rangeEnd = Math.max(flightEndMs + padAfterMs, minWindowEnd);

      setMode('history');
      setGranularity('custom');
      setHistoryRange({ startMs: rangeStart, endMs: rangeEnd });
      setPlayheadMs(entryMs);
      setSpeed(5);
      setIsPlaying(flightEndMs > entryMs);
    },
    [filters, liveRadar.passages, mode]
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-main)] text-[var(--text-main)] overflow-hidden">
      <TopNavBar
        mode={mode}
        onChangeMode={handleChangeMode}
        feedMode={feedMode}
        onToggleFeedMode={setFeedMode}
        passages={visiblePassages}
        approachingPassages={visibleApproachingPassages}
        totalMatchedCount={
          mode === 'history' ? historicalReplay.totalMatched : visiblePassages.length
        }
        health={liveRadar.health}
        isSyncing={mode === 'live' ? liveRadar.isSyncing : historicalReplay.isLoading}
        onManualRefresh={liveRadar.refreshNow}
        isFilterOpen={isFilterOpen}
        onToggleFilterSidebar={() => setIsFilterOpen((v) => !v)}
        onSelectPassage={(id) => setSelectedPassageId(id)}
        onOpenStatsModal={() => setIsStatsModalOpen(true)}
        onOpenEmbedModal={() => setIsEmbedModalOpen(true)}
        searchQuery={filters.searchQuery}
        onSearchChange={(q) => setFilters((prev) => ({ ...prev, searchQuery: q }))}
        isEmbed={isEmbed}
      />

      <main className="flex-1 flex min-h-0 relative overflow-hidden">
        <FilterSidebar
          isOpen={isFilterOpen}
          onClose={() => setIsFilterOpen(false)}
          filters={filters}
          onChangeFilters={setFilters}
          passages={visiblePassages}
          approachingPassages={visibleApproachingPassages}
          selectedPassageId={selectedPassageId}
          onSelectPassage={(id) => setSelectedPassageId(id)}
        />

        <div className="flex-1 min-w-0 h-full relative">
          <RadarMap
            boundary={boundary}
            adjacentBoundaries={adjacentBoundaries}
            passages={visiblePassages}
            approachingPassages={visibleApproachingPassages}
            mode={mode}
            feedMode={feedMode}
            playheadMs={playheadMs}
            clockOffsetMs={liveRadar.clockOffsetMs}
            selectedPassageId={selectedPassageId}
            onSelectPassage={(id) => setSelectedPassageId(id)}
            health={liveRadar.health}
            historyVersion={historySync.historyVersion}
            onSwitchToLive={() => handleChangeMode('live')}
            onSwitchToPreview={() => setFeedMode('demo')}
            onSwitchToHistory={() => handleChangeMode('history')}
          />
        </div>

        <PassageDetailDrawer
          item={selectedItem}
          mode={mode}
          playheadMs={playheadMs}
          onClose={() => setSelectedPassageId(null)}
        />
      </main>

      {mode === 'history' && (
        <TimeScrubberBar
          granularity={granularity}
          onSelectGranularity={handleSelectGranularity}
          startMs={historyRange.startMs}
          endMs={historyRange.endMs}
          onChangeCustomRange={handleChangeCustomRange}
          playheadMs={playheadMs}
          onChangePlayhead={(ms) => {
            setIsPlaying(false);
            setPlayheadMs(ms);
          }}
          isPlaying={isPlaying}
          onTogglePlay={() => {
            if (playheadMs >= historyRange.endMs) {
              setPlayheadMs(historyRange.startMs);
            }
            setIsPlaying((v) => !v);
          }}
          speed={speed}
          onChangeSpeed={setSpeed}
          passages={visiblePassages}
          totalMatched={historicalReplay.totalMatched}
          truncated={historicalReplay.truncated}
          isLoading={historicalReplay.isLoading}
          onSwitchToLive={() => handleChangeMode('live')}
        />
      )}

      <AttributionFooter
        isEmbed={isEmbed}
        onOpenEmbedModal={() => setIsEmbedModalOpen(true)}
      />

      <AirspaceStatsModal
        isOpen={isStatsModalOpen}
        onClose={() => setIsStatsModalOpen(false)}
        feedMode={feedMode}
        onSelectPassageFromStats={handleSelectPassageFromStats}
        historyVersion={historySync.historyVersion}
        localArchiveCount={historySync.localArchiveCount}
        cloudUserEmail={historySync.cloudUser?.email ?? null}
        cloudSyncedCount={historySync.cloudSyncedCount}
        isCloudSyncing={historySync.isCloudSyncing}
        cloudError={historySync.cloudError}
        onCloudSignIn={historySync.signInAndSync}
        onCloudSignOut={historySync.signOutCloud}
        onCloudSyncNow={historySync.syncNow}
      />

      <EmbedDataproductModal
        isOpen={isEmbedModalOpen}
        onClose={() => setIsEmbedModalOpen(false)}
      />
    </div>
  );
}
