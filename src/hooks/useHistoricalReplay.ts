import { useEffect, useState } from 'react';
import {
  FeedMode,
  HistoricalReplayResponse,
  PassageWithTrack,
  RadarFilters,
} from '../types/radar';
import { getDemoHistoricalSlice } from '../lib/mockData';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

interface UseHistoricalReplayArgs {
  enabled: boolean;
  feedMode: FeedMode;
  startIso: string;
  endIso: string;
  filters: RadarFilters;
  refreshKey?: number;
}

export function useHistoricalReplay({
  enabled,
  feedMode,
  startIso,
  endIso,
  filters,
  refreshKey = 0,
}: UseHistoricalReplayArgs) {
  const [passages, setPassages] = useState<PassageWithTrack[]>([]);
  const [totalMatched, setTotalMatched] = useState<number>(0);
  const [truncated, setTruncated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const catsKey = filters.categories.join(',');

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    const timer = setTimeout(async () => {
      setIsLoading(true);
      setError(null);

      try {
        if (feedMode === 'demo') {
          const demo = getDemoHistoricalSlice(startIso, endIso, filters);
          if (!cancelled) {
            setPassages(demo.passages);
            setTotalMatched(demo.total_matched);
            setTruncated(demo.truncated);
          }
          return;
        }

        if (isSupabaseConfigured && supabase) {
          const { data, error: rpcErr } = await supabase.rpc('get_historical_replay_slice', {
            p_start_time: startIso,
            p_end_time: endIso,
            p_min_alt_m: filters.minAltM,
            p_max_alt_m: filters.maxAltM,
            p_categories: filters.categories.length > 0 ? filters.categories : null,
            p_include_unknown_alt: filters.includeUnknownAlt,
          });
          if (!rpcErr && data && !cancelled) {
            const parsed = (
              typeof data === 'string' ? JSON.parse(data) : data
            ) as HistoricalReplayResponse;
            let list = Array.isArray(parsed.passages) ? parsed.passages : [];
            const q = filters.searchQuery.trim().toLowerCase();
            if (q) {
              list = list.filter(({ passage }) =>
                [
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
                  .toLowerCase()
                  .includes(q)
              );
            }
            setPassages(list);
            setTotalMatched(parsed.total_matched ?? list.length);
            setTruncated(Boolean(parsed.truncated));
            return;
          }
        }

        const qs = new URLSearchParams({
          start: startIso,
          end: endIso,
          minAlt: String(filters.minAltM),
          maxAlt: String(filters.maxAltM),
          includeUnknownAlt: String(filters.includeUnknownAlt),
        });
        if (catsKey) qs.set('categories', catsKey);
        if (filters.searchQuery.trim()) qs.set('q', filters.searchQuery.trim());

        const res = await fetch(`/api/radar/history?${qs.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: HistoricalReplayResponse = await res.json();
        if (!cancelled) {
          setPassages(Array.isArray(json.passages) ? json.passages : []);
          setTotalMatched(json.total_matched ?? 0);
          setTruncated(Boolean(json.truncated));
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Fout bij ophalen historie');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    enabled,
    feedMode,
    startIso,
    endIso,
    filters.minAltM,
    filters.maxAltM,
    filters.includeUnknownAlt,
    catsKey,
    filters.searchQuery,
    refreshKey,
  ]);

  return { passages, totalMatched, truncated, isLoading, error };
}
