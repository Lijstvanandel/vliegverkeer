import { useCallback, useEffect, useRef, useState } from 'react';
import { FeedMode, IngestionHealth, LiveRadarResponse, PassageWithTrack } from '../types/radar';
import { getDemoLiveRadarState } from '../lib/mockData';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

const DEFAULT_HEALTH: IngestionHealth = {
  active_feed_source: 'adsb.fi',
  last_poll_at: null,
  last_success_at: null,
  last_error: null,
  aircraft_in_radius: 0,
  aircraft_in_gm1708: 0,
  approaching_in_neighbors: 0,
};

export function useLiveRadar(enabled: boolean, feedMode: FeedMode) {
  const [passages, setPassages] = useState<PassageWithTrack[]>([]);
  const [approachingPassages, setApproachingPassages] = useState<PassageWithTrack[]>([]);
  const [health, setHealth] = useState<IngestionHealth>(DEFAULT_HEALTH);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAtMs, setLastFetchedAtMs] = useState<number>(Date.now());
  const [clockOffsetMs, setClockOffsetMs] = useState<number>(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchLive = useCallback(
    async (triggerPoll = false) => {
      if (!enabled) return;

      if (feedMode === 'demo') {
        const now = Date.now();
        const demo = getDemoLiveRadarState(now);
        if (!mountedRef.current) return;
        setPassages(demo.passages);
        setApproachingPassages(demo.approaching_passages || []);
        setHealth(demo.health);
        setError(null);
        setClockOffsetMs(0);
        setLastFetchedAtMs(now);
        return;
      }

      setIsSyncing(true);
      try {
        if (isSupabaseConfigured && supabase && !triggerPoll) {
          const { data, error: rpcErr } = await supabase.rpc('get_live_radar_state');
          if (!rpcErr && data) {
            const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as LiveRadarResponse;
            if (!mountedRef.current) return;
            setPassages(Array.isArray(parsed.passages) ? parsed.passages : []);
            setApproachingPassages(
              Array.isArray(parsed.approaching_passages) ? parsed.approaching_passages : []
            );
            setHealth(parsed.health || DEFAULT_HEALTH);
            setError(parsed.health?.last_error || null);
            if (typeof parsed.server_time_ms === 'number') {
              setClockOffsetMs(parsed.server_time_ms - Date.now());
            }
            setLastFetchedAtMs(Date.now());
            return;
          }
        }

        if (triggerPoll) {
          const res = await fetch('/api/radar/poll-now', { method: 'POST' });
          if (res.ok) {
            const json = await res.json();
            const state = json.state as LiveRadarResponse;
            if (!mountedRef.current) return;
            setPassages(Array.isArray(state?.passages) ? state.passages : []);
            setApproachingPassages(
              Array.isArray(state?.approaching_passages) ? state.approaching_passages : []
            );
            setHealth(state?.health || DEFAULT_HEALTH);
            setError(json.error || state?.health?.last_error || null);
            if (typeof state?.server_time_ms === 'number') {
              setClockOffsetMs(state.server_time_ms - Date.now());
            }
            setLastFetchedAtMs(Date.now());
            return;
          }
        }

        const res = await fetch('/api/radar/live');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: LiveRadarResponse = await res.json();
        if (!mountedRef.current) return;
        setPassages(Array.isArray(data.passages) ? data.passages : []);
        setApproachingPassages(
          Array.isArray(data.approaching_passages) ? data.approaching_passages : []
        );
        setHealth(data.health || DEFAULT_HEALTH);
        setError(data.health?.last_error || null);
        if (typeof data.server_time_ms === 'number') {
          setClockOffsetMs(data.server_time_ms - Date.now());
        }
        setLastFetchedAtMs(Date.now());
      } catch (err: any) {
        if (!mountedRef.current) return;
        setError(err?.message || 'Kan live radar-feed niet laden');
      } finally {
        if (mountedRef.current) setIsSyncing(false);
      }
    },
    [enabled, feedMode]
  );

  useEffect(() => {
    if (!enabled) return;
    fetchLive(false);
    // Lokale SQLite/RAM poll elke 2.5s (geen extra externe API-calls) voor minimale vertraging bij bochten
    const intervalMs = 2_500;
    const id = setInterval(() => {
      fetchLive(false);
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, feedMode, fetchLive]);

  return {
    passages,
    approachingPassages,
    health,
    isSyncing,
    error,
    lastFetchedAtMs,
    clockOffsetMs,
    refreshNow: () => fetchLive(feedMode === 'live'),
  };
}
