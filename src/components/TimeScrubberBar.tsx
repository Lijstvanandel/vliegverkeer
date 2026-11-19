import React, { useMemo } from 'react';
import { PassageWithTrack, TimeGranularity } from '../types/radar';
import { formatDateTimeNL, formatTimeNL } from '../lib/geoUtils';
import {
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  Clock,
} from 'lucide-react';

interface TimeScrubberBarProps {
  granularity: TimeGranularity;
  onSelectGranularity: (g: TimeGranularity) => void;
  startMs: number;
  endMs: number;
  onChangeCustomRange: (startMs: number, endMs: number) => void;
  playheadMs: number;
  onChangePlayhead: (ms: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  speed: number;
  onChangeSpeed: (speed: number) => void;
  passages: PassageWithTrack[];
  totalMatched: number;
  truncated: boolean;
  isLoading: boolean;
}

const SPEEDS = [1, 5, 10, 30, 60];

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export const TimeScrubberBar: React.FC<TimeScrubberBarProps> = ({
  granularity,
  onSelectGranularity,
  startMs,
  endMs,
  onChangeCustomRange,
  playheadMs,
  onChangePlayhead,
  isPlaying,
  onTogglePlay,
  speed,
  onChangeSpeed,
  passages,
  totalMatched,
  truncated,
  isLoading,
}) => {
  // Activiteiten-histogram over 48 tijdbuckets
  const histogram = useMemo(() => {
    const buckets = new Array(48).fill(0);
    const span = Math.max(1, endMs - startMs);
    for (const { passage } of passages) {
      const entry = new Date(passage.entry_time).getTime();
      const exit = passage.exit_time ? new Date(passage.exit_time).getTime() : entry;
      const startBucket = Math.max(0, Math.min(47, Math.floor(((entry - startMs) / span) * 48)));
      const endBucket = Math.max(0, Math.min(47, Math.floor(((exit - startMs) / span) * 48)));
      for (let b = startBucket; b <= endBucket; b++) {
        buckets[b]++;
      }
    }
    const maxVal = Math.max(1, ...buckets);
    return { buckets, maxVal };
  }, [passages, startMs, endMs]);

  const progressPct = useMemo(() => {
    const span = Math.max(1, endMs - startMs);
    return Math.max(0, Math.min(100, ((playheadMs - startMs) / span) * 100));
  }, [playheadMs, startMs, endMs]);

  return (
    <section
      aria-label="Historische replay tijdbalk"
      className="bg-[var(--bg-card)] border-t border-[var(--border-subtle)] px-3 md:px-4 py-2.5 z-30 shrink-0 tabular-nums space-y-2"
    >
      {/* Waarschuwing bij > 600 passages */}
      {truncated && (
        <div className="px-3 py-1.5 rounded-[4px] bg-[var(--accent-gold-glow)] border border-[var(--accent-gold)] text-[11px] text-[var(--accent-gold-bright)] flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            Meer dan 600 passages gevonden (<strong>{totalMatched.toLocaleString('nl-NL')}</strong>{' '}
            totaal); de eerste 600 worden getoond. Kies een korter tijdvak of filter op hoogte/categorie.
          </span>
        </div>
      )}

      {/* Bovenste balk: Granulariteit & Huidige Playhead-tijd */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              { id: 'hour', label: 'Laatste uur' },
              { id: 'day', label: 'Afgelopen dag' },
              { id: 'week', label: 'Afgelopen week' },
              { id: 'custom', label: 'Aangepast' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectGranularity(tab.id)}
              className={`px-2.5 py-1 rounded-[4px] border text-[11px] font-semibold cursor-pointer transition-colors ${
                granularity === tab.id
                  ? 'bg-[var(--bg-elevated)] text-[var(--accent-gold-bright)] border-[var(--border-focus)]'
                  : 'bg-[var(--bg-main)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-main)]'
              }`}
            >
              {tab.label}
            </button>
          ))}

          {granularity === 'custom' && (
            <div className="flex flex-wrap items-center gap-1.5 ml-1 text-[11px]">
              <input
                type="datetime-local"
                value={toDatetimeLocalValue(startMs)}
                onChange={(e) => {
                  const val = new Date(e.target.value).getTime();
                  if (!isNaN(val) && val < endMs) {
                    onChangeCustomRange(val, endMs);
                  }
                }}
                className="px-2 py-0.5 rounded-[4px] bg-[var(--bg-main)] border border-[var(--border-subtle)] text-[var(--text-main)] font-mono text-[11px]"
              />
              <span className="text-[var(--text-dim)]">t/m</span>
              <input
                type="datetime-local"
                value={toDatetimeLocalValue(endMs)}
                onChange={(e) => {
                  const val = new Date(e.target.value).getTime();
                  if (!isNaN(val) && val > startMs) {
                    onChangeCustomRange(startMs, val);
                  }
                }}
                className="px-2 py-0.5 rounded-[4px] bg-[var(--bg-main)] border border-[var(--border-subtle)] text-[var(--text-main)] font-mono text-[11px]"
              />
            </div>
          )}
        </div>

        {/* Playhead timestamp */}
        <div className="flex items-center gap-2 text-xs font-mono">
          {isLoading && (
            <span className="text-[11px] text-[var(--accent-gold)] animate-pulse">
              Laden...
            </span>
          )}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] bg-[var(--bg-main)] border border-[var(--border-subtle)] text-[var(--text-main)]">
            <Clock className="w-3.5 h-3.5 text-[var(--status-blue)]" />
            <span className="font-bold text-[var(--accent-gold-bright)]">
              {formatDateTimeNL(new Date(playheadMs).toISOString(), true)}
            </span>
          </div>
        </div>
      </div>

      {/* Activiteiten-histogram + Tijdlijn Slider */}
      <div className="space-y-1">
        <div className="relative h-6 flex items-end gap-[2px] px-0.5 bg-[var(--bg-main)] border border-[var(--border-subtle)] rounded-[4px] pt-1">
          {histogram.buckets.map((count, i) => {
            const hPct = count === 0 ? 8 : Math.max(18, Math.round((count / histogram.maxVal) * 100));
            const bucketPct = ((i + 0.5) / histogram.buckets.length) * 100;
            const passed = bucketPct <= progressPct;
            return (
              <div
                key={i}
                className="flex-1 rounded-t-[1px] transition-colors"
                style={{
                  height: `${hPct}%`,
                  backgroundColor:
                    count === 0
                      ? 'rgba(96, 117, 106, 0.25)'
                      : passed
                      ? '#f59e0b'
                      : 'rgba(56, 189, 248, 0.55)',
                }}
                title={`${count} passage(s)`}
              />
            );
          })}
        </div>

        <input
          type="range"
          min={startMs}
          max={endMs}
          step={1000}
          value={playheadMs}
          onChange={(e) => onChangePlayhead(Number(e.target.value))}
          className="w-full accent-[#f59e0b] cursor-pointer h-1.5"
        />

        <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-[var(--text-dim)]">
          <span>{formatTimeNL(new Date(startMs).toISOString(), false)}</span>
          <div className="flex items-center gap-1.5">
            {/* -1 min */}
            <button
              type="button"
              onClick={() => onChangePlayhead(Math.max(startMs, playheadMs - 60_000))}
              className="px-2 py-1 rounded-[4px] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] text-[var(--text-main)] flex items-center gap-0.5 cursor-pointer"
              title="1 minuut terug"
            >
              <ChevronLeft className="w-3 h-3" />
              <span>-1m</span>
            </button>

            {/* Play / Pause */}
            <button
              type="button"
              onClick={onTogglePlay}
              className="px-3 py-1 rounded-[4px] bg-[var(--accent-gold)] hover:bg-[var(--accent-gold-bright)] text-[#060e0a] font-bold flex items-center gap-1 cursor-pointer"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isPlaying ? 'Pauze' : 'Afspelen'}</span>
            </button>

            {/* +1 min */}
            <button
              type="button"
              onClick={() => onChangePlayhead(Math.min(endMs, playheadMs + 60_000))}
              className="px-2 py-1 rounded-[4px] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] text-[var(--text-main)] flex items-center gap-0.5 cursor-pointer"
              title="1 minuut vooruit"
            >
              <span>+1m</span>
              <ChevronRight className="w-3 h-3" />
            </button>

            {/* Snelheden */}
            <div className="hidden sm:flex items-center gap-1 ml-1">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChangeSpeed(s)}
                  className={`px-1.5 py-1 rounded-[4px] border text-[10px] font-bold cursor-pointer transition-colors ${
                    speed === s
                      ? 'bg-[var(--bg-elevated)] text-[var(--accent-gold-bright)] border-[var(--border-focus)]'
                      : 'bg-[var(--bg-main)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-[var(--text-main)]'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          </div>
          <span>{formatTimeNL(new Date(endMs).toISOString(), false)}</span>
        </div>
      </div>
    </section>
  );
};
