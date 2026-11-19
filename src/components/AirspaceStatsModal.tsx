import React, { useEffect, useState } from 'react';
import {
  AircraftTypeRankingEntry,
  AirspaceStatsResponse,
  AvailableWeekOption,
  CompleteHistoryInsights,
  DailyCountSummary,
  FeedMode,
  FlightPassage,
  OperatorRankingEntry,
  StatsPeriod,
  TrafficCategory,
} from '../types/radar';
import { getDemoStats } from '../lib/mockData';
import {
  formatAltitudeLabel,
  formatDateTimeNL,
  formatTimeNL,
  metersToFeet,
  TRAFFIC_CATEGORY_LABELS,
} from '../lib/geoUtils';
import {
  X,
  BarChart3,
  Download,
  Plane,
  Radio,
  ArrowUpDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  Play,
  Calendar,
  Cloud,
  DatabaseBackup,
  RefreshCw,
  LogOut,
  TrendingDown,
  TrendingUp,
  Building2,
  History,
} from 'lucide-react';

interface AirspaceStatsModalProps {
  isOpen: boolean;
  onClose: () => void;
  feedMode: FeedMode;
  onSelectPassageFromStats: (passage: FlightPassage, followOnTimeline?: boolean) => void;
  historyVersion?: number;
  localArchiveCount?: number;
  cloudUserEmail?: string | null;
  cloudSyncedCount?: number;
  isCloudSyncing?: boolean;
  cloudError?: string | null;
  onCloudSignIn?: () => void;
  onCloudSignOut?: () => void;
  onCloudSyncNow?: () => void;
}

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

function computeCompleteHistoryInsightsClient(rows: FlightPassage[]): CompleteHistoryInsights {
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

  for (const r of rows) {
    const d = new Date(r.entry_time);
    if (!isNaN(d.getTime())) {
      const dateKey = dayFmt.format(d);
      const exDay = dayCounts.get(dateKey);
      if (exDay) exDay.count++;
      else dayCounts.set(dateKey, { label: labelFmt.format(d), count: 1 });
    }

    const minA = r.min_alt_m !== null && Number.isFinite(r.min_alt_m) ? r.min_alt_m : null;
    const maxA = r.max_alt_m !== null && Number.isFinite(r.max_alt_m) ? r.max_alt_m : null;
    const midAltM =
      minA !== null && maxA !== null
        ? (minA + maxA) / 2
        : maxA !== null
        ? maxA
        : minA !== null
        ? minA
        : null;

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
          category: r.traffic_category,
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
    .map(([dateKey, info]) => ({ dateKey, label: info.label, count: info.count }))
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  let quietestDay: DailyCountSummary | null = null;
  let busiestDay: DailyCountSummary | null = null;
  for (const day of sortedDays) {
    if (!quietestDay || day.count < quietestDay.count) quietestDay = day;
    if (!busiestDay || day.count > busiestDay.count) busiestDay = day;
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
    totalPassages: rows.length,
    totalDays: sortedDays.length,
    quietestDay,
    busiestDay,
    topOperators,
    topAircraftTypes,
  };
}

function computeClientStats(
  period: StatsPeriod,
  rows: FlightPassage[],
  availableWeeks: AvailableWeekOption[],
  weekKey: string | null,
  weekLabel: string | null,
  allTimeInsights?: CompleteHistoryInsights
): AirspaceStatsResponse {
  const totalPassages = rows.length;
  const activePassages = rows.filter((r) => r.is_active).length;
  const totalPositions = rows.reduce((acc, r) => acc + r.point_count, 0);
  const mlatPassages = rows.filter((r) => r.has_mlat_positions).length;

  const validMaxAlts = rows
    .map((r) => r.max_alt_m)
    .filter((v): v is number => v !== null);
  const avgAltitudeM = validMaxAlts.length
    ? Math.round(validMaxAlts.reduce((a, b) => a + b, 0) / validMaxAlts.length)
    : null;

  let lowestFlight: FlightPassage | null = null;
  let highestFlight: FlightPassage | null = null;
  let lowAltitudeCount = 0;

  for (const r of rows) {
    if (r.min_alt_m !== null && Number.isFinite(r.min_alt_m)) {
      if (r.min_alt_m <= 1000) lowAltitudeCount++;
      if (!lowestFlight || r.min_alt_m < (lowestFlight.min_alt_m ?? Infinity)) {
        lowestFlight = r;
      }
    }
    if (r.max_alt_m !== null && Number.isFinite(r.max_alt_m)) {
      if (!highestFlight || r.max_alt_m > (highestFlight.max_alt_m ?? -Infinity)) {
        highestFlight = r;
      }
    }
  }

  const minAltitudeM = lowestFlight ? lowestFlight.min_alt_m : null;
  const maxAltitudeM = highestFlight ? highestFlight.max_alt_m : null;

  const cats: TrafficCategory[] = [
    'commercial',
    'hems_police_sar',
    'general_aviation',
    'military',
    'unknown',
  ];
  const byCategory = cats.map((cat) => {
    const count = rows.filter((r) => r.traffic_category === cat).length;
    return {
      category: cat,
      count,
      sharePct: totalPassages > 0 ? Number(((count / totalPassages) * 100).toFixed(1)) : 0,
    };
  });

  const opMap = new Map<string, { count: number; category: TrafficCategory }>();
  for (const r of rows) {
    const op = r.operator_name || 'Onbekende operator';
    const ex = opMap.get(op);
    if (ex) ex.count++;
    else opMap.set(op, { count: 1, category: r.traffic_category });
  }
  const topOperators = Array.from(opMap.entries())
    .map(([operator, info]) => ({ operator, count: info.count, category: info.category }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    period,
    weekKey,
    weekLabel,
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
    hourlyDistribution: [],
    recentPassages: rows.slice(0, 100),
    allTimeInsights,
  };
}

function getFlightTitle(p: FlightPassage): string {
  return p.callsign || p.registration || p.icao24.toUpperCase();
}

export const AirspaceStatsModal: React.FC<AirspaceStatsModalProps> = ({
  isOpen,
  onClose,
  feedMode,
  onSelectPassageFromStats,
  historyVersion = 0,
  localArchiveCount = 0,
  cloudUserEmail = null,
  cloudSyncedCount = 0,
  isCloudSyncing = false,
  cloudError = null,
  onCloudSignIn,
  onCloudSignOut,
  onCloudSyncNow,
}) => {
  const [period, setPeriod] = useState<StatsPeriod>('day');
  const [selectedWeekKey, setSelectedWeekKey] = useState<string>('');
  const [stats, setStats] = useState<AirspaceStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);

    if (feedMode === 'demo') {
      const demo = getDemoStats(period, selectedWeekKey || null);
      const demoAll = period === 'all' ? demo : getDemoStats('all');
      if (!selectedWeekKey && demo.availableWeeks.length > 0) {
        setSelectedWeekKey(demo.availableWeeks[0].weekKey);
      }
      setStats(
        computeClientStats(
          period,
          demo.rows,
          demo.availableWeeks,
          demo.weekKey,
          demo.weekLabel,
          computeCompleteHistoryInsightsClient(demoAll.rows)
        )
      );
      setLoading(false);
      return;
    }

    const params = new URLSearchParams({ period });
    if (period === 'weeknum' && selectedWeekKey) {
      params.set('week', selectedWeekKey);
    }

    fetch(`/api/radar/stats?${params.toString()}`)
      .then((r) => r.json())
      .then((data: AirspaceStatsResponse) => {
        if (cancelled) return;
        setStats(data);
        if (!selectedWeekKey && data.availableWeeks && data.availableWeeks.length > 0) {
          setSelectedWeekKey(data.weekKey || data.availableWeeks[0].weekKey);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, period, selectedWeekKey, feedMode, historyVersion]);

  if (!isOpen) return null;

  const handleFollowFlight = (passage: FlightPassage) => {
    onSelectPassageFromStats(passage, true);
    onClose();
  };

  const handleDownloadCsv = () => {
    if (feedMode === 'live') {
      const params = new URLSearchParams({ period });
      if (period === 'weeknum' && (selectedWeekKey || stats?.weekKey)) {
        params.set('week', selectedWeekKey || stats?.weekKey || '');
      }
      window.location.href = `/api/radar/export.csv?${params.toString()}`;
      return;
    }
    if (!stats) return;
    const header =
      'Passage ID;ICAO24;Callsign;Registratie;Model;Operator;Categorie;Intrede;Uittrede;Min Hoogte m;Max Hoogte m;Herkomst;Bestemming\r\n';
    const lines = stats.recentPassages.map((p) =>
      [
        p.id,
        p.icao24,
        p.callsign || '',
        p.registration || '',
        p.model_name || '',
        p.operator_name || '',
        p.traffic_category,
        p.entry_time,
        p.exit_time || 'Actief',
        p.min_alt_m ?? '',
        p.max_alt_m ?? '',
        p.dep_iata || p.dep_icao || '',
        p.arr_iata || p.arr_icao || '',
      ].join(';')
    );
    const blob = new Blob(['\uFEFF' + header + lines.join('\r\n')], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const suffix = period === 'weeknum' && stats.weekKey ? `week-${stats.weekKey}` : period;
    a.download = `steenwijkerland-luchtverkeer-preview-${suffix}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const availableWeeks = stats?.availableWeeks || [];

  return (
    <div
      className="fixed inset-0 z-[700] flex items-center justify-center bg-[#060e0a]/85 backdrop-blur-xs p-3 md:p-6 tabular-nums"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl max-h-[90vh] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[6px] shadow-2xl flex flex-col overflow-hidden text-[var(--text-main)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[4px] bg-[var(--accent-gold)] text-[#060e0a] flex items-center justify-center">
              <BarChart3 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-bold tracking-tight">
                Luchtverkeer Statistieken — Gemeente Steenwijkerland (GM1708)
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                Passages, laagst/hoogst gevlogen hoogtes en vluchtroutes · Dataproduct van Lijst van
                Andel
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleDownloadCsv}
              className="px-3 py-1.5 rounded-[4px] bg-[var(--accent-gold)] hover:bg-[var(--accent-gold-bright)] text-[#060e0a] text-xs font-bold flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download .CSV</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-[4px] bg-[var(--bg-card)] hover:bg-[var(--status-crimson)] border border-[var(--border-subtle)] text-[var(--text-main)] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Periode Tabs + Weeknummer selectie */}
        <div className="px-5 py-2.5 bg-[var(--bg-main)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'hour', label: 'Per uur' },
                { id: 'day', label: 'Afgelopen 24 uur' },
                { id: 'week', label: 'Afgelopen 7 dagen' },
                { id: 'weeknum', label: 'Per weeknummer' },
                { id: 'all', label: 'Alle historie' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setPeriod(t.id)}
                className={`px-3 py-1 rounded-[4px] border text-xs font-semibold cursor-pointer transition-colors ${
                  period === t.id
                    ? 'bg-[var(--bg-elevated)] text-[var(--accent-gold-bright)] border-[var(--border-focus)]'
                    : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:text-[var(--text-main)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {period === 'weeknum' && availableWeeks.length > 0 && (
            <div className="flex items-center gap-2">
              <Calendar className="w-3.5 h-3.5 text-[var(--accent-gold)] shrink-0" />
              <select
                value={selectedWeekKey || stats?.weekKey || availableWeeks[0].weekKey}
                onChange={(e) => setSelectedWeekKey(e.target.value)}
                aria-label="Kies weeknummer"
                className="px-2.5 py-1 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-focus)] text-xs font-mono text-[var(--text-main)] focus:outline-none cursor-pointer"
              >
                {availableWeeks.map((w) => (
                  <option key={w.weekKey} value={w.weekKey}>
                    {w.label} ({w.count}x)
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Persistente Historie-opslag & Optionele Cloud Backup */}
        {feedMode === 'live' && (
          <div className="px-5 py-2 bg-[var(--bg-elevated)]/40 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0">
            <div className="flex items-center gap-2 text-[var(--text-muted)]">
              <DatabaseBackup className="w-3.5 h-3.5 text-[var(--status-emerald)] shrink-0" />
              <span>
                Persistente historie-opslag actief:{' '}
                <strong className="font-mono text-[var(--text-main)]">
                  {localArchiveCount.toLocaleString('nl-NL')}
                </strong>{' '}
                vluchten bewaard in browser- &amp; JSON-archief
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {cloudError && (
                <span className="text-[10px] text-[var(--status-crimson)] font-mono">
                  {cloudError}
                </span>
              )}
              {cloudUserEmail ? (
                <>
                  <span className="text-[11px] font-mono text-[var(--status-blue)] flex items-center gap-1">
                    <Cloud className="w-3.5 h-3.5 shrink-0" />
                    <span>
                      Cloud: {cloudUserEmail} ({cloudSyncedCount}x)
                    </span>
                  </span>
                  {onCloudSyncNow && (
                    <button
                      type="button"
                      onClick={onCloudSyncNow}
                      disabled={isCloudSyncing}
                      className="px-2 py-1 rounded-[4px] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] text-[var(--text-main)] font-semibold flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${isCloudSyncing ? 'animate-spin' : ''}`} />
                      <span>{isCloudSyncing ? 'Syncen...' : 'Nu syncen'}</span>
                    </button>
                  )}
                  {onCloudSignOut && (
                    <button
                      type="button"
                      onClick={onCloudSignOut}
                      className="px-2 py-1 rounded-[4px] bg-[var(--bg-card)] hover:bg-[var(--status-crimson)]/20 border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center gap-1 cursor-pointer"
                    >
                      <LogOut className="w-3 h-3" />
                      <span>Uitloggen</span>
                    </button>
                  )}
                </>
              ) : (
                onCloudSignIn && (
                  <button
                    type="button"
                    onClick={onCloudSignIn}
                    disabled={isCloudSyncing}
                    className="px-2.5 py-1 rounded-[4px] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] border border-[var(--border-focus)] text-[var(--accent-gold-bright)] font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Cloud className="w-3.5 h-3.5" />
                    <span>Cloud-backup koppelen (Google)</span>
                  </button>
                )
              )}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1">
          {loading || !stats ? (
            <div className="py-12 text-center text-xs text-[var(--text-muted)] font-mono">
              Statistieken laden...
            </div>
          ) : (
            <>
              {period === 'weeknum' && stats.weekLabel && (
                <div className="px-3.5 py-2 rounded-[4px] bg-[var(--bg-elevated)]/70 border border-[var(--border-subtle)] text-xs flex items-center justify-between gap-2">
                  <span className="text-[var(--text-muted)]">
                    Geselecteerde periode:{' '}
                    <strong className="text-[var(--accent-gold-bright)] font-mono">
                      {stats.weekLabel}
                    </strong>
                  </span>
                  <span className="font-mono text-[11px] text-[var(--text-dim)]">
                    Tijdzone Europe/Amsterdam (ISO-8601)
                  </span>
                </div>
              )}

              {/* Rij 1: Overzicht KPIs */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)]">
                  <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
                    <Plane className="w-3.5 h-3.5 text-[var(--accent-gold)]" />
                    <span>Totaal Passages</span>
                  </div>
                  <div className="text-2xl font-bold font-mono text-[var(--text-main)] mt-1">
                    {stats.totalPassages.toLocaleString('nl-NL')}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--status-emerald)] mt-0.5">
                    {stats.activePassages} nu actief in GM1708
                  </div>
                </div>

                <div className="p-3.5 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)]">
                  <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
                    <Radio className="w-3.5 h-3.5 text-[var(--status-emerald)]" />
                    <span>ADS-B / MLAT Punten</span>
                  </div>
                  <div className="text-2xl font-bold font-mono text-[var(--text-main)] mt-1">
                    {stats.totalPositions.toLocaleString('nl-NL')}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--status-purple)] mt-0.5">
                    {stats.mlatPassages} passages met MLAT
                  </div>
                </div>

                <div className="p-3.5 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)]">
                  <div className="text-[11px] text-[var(--text-muted)]">
                    Laagvliegers (&le;1.000 m)
                  </div>
                  <div className="text-2xl font-bold font-mono text-[var(--accent-gold-bright)] mt-1">
                    {stats.lowAltitudeCount.toLocaleString('nl-NL')}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--text-dim)] mt-0.5">
                    Traumaheli / VFR / Defensie
                  </div>
                </div>
              </div>

              {/* Rij 2: Hoogte-analyse (Gemiddeld / Laagstgevlogen / Hoogstgevlogen + Volg op tijdlijn) */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Gemiddelde Max Hoogte */}
                <div className="p-3.5 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] flex flex-col justify-between">
                  <div>
                    <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
                      <ArrowUpDown className="w-3.5 h-3.5 text-[var(--status-blue)]" />
                      <span>Gemiddelde Max Hoogte</span>
                    </div>
                    <div className="text-2xl font-bold font-mono text-[var(--status-blue)] mt-1">
                      {stats.avgAltitudeM !== null
                        ? `${stats.avgAltitudeM.toLocaleString('nl-NL')} m`
                        : '—'}
                    </div>
                  </div>
                  <div className="text-[11px] font-mono text-[var(--text-dim)] mt-2">
                    {stats.avgAltitudeM !== null
                      ? `${metersToFeet(stats.avgAltitudeM).toLocaleString('nl-NL')} ft gemiddeld`
                      : 'Geen hoogtedata in periode'}
                  </div>
                </div>

                {/* Laagstgevlogen Hoogte + vluchtkoppeling */}
                <div className="p-3.5 rounded-[5px] bg-[var(--bg-main)] border border-[var(--accent-gold)]/45 flex flex-col justify-between gap-2">
                  <div>
                    <div className="text-[11px] text-[var(--text-muted)] flex items-center justify-between gap-1.5">
                      <span className="flex items-center gap-1.5">
                        <ArrowDownToLine className="w-3.5 h-3.5 text-[var(--accent-gold)]" />
                        <span>Laagstgevlogen Hoogte</span>
                      </span>
                      {stats.minAltitudeM !== null && (
                        <span className="text-[10px] font-mono text-[var(--text-dim)]">
                          {metersToFeet(stats.minAltitudeM).toLocaleString('nl-NL')} ft
                        </span>
                      )}
                    </div>
                    <div className="text-2xl font-bold font-mono text-[var(--accent-gold-bright)] mt-1">
                      {stats.minAltitudeM !== null
                        ? `${stats.minAltitudeM.toLocaleString('nl-NL')} m`
                        : '—'}
                    </div>
                    {stats.lowestFlight ? (
                      <div className="mt-1.5 text-[11px] space-y-0.5">
                        <div className="font-mono font-bold text-[var(--text-main)] truncate">
                          {getFlightTitle(stats.lowestFlight)}
                          {stats.lowestFlight.icao_type_code
                            ? ` · ${stats.lowestFlight.icao_type_code}`
                            : ''}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] truncate">
                          {stats.lowestFlight.operator_name ||
                            stats.lowestFlight.model_name ||
                            TRAFFIC_CATEGORY_LABELS[stats.lowestFlight.traffic_category]}{' '}
                          · {formatDateTimeNL(stats.lowestFlight.entry_time, false)}
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] font-mono text-[var(--text-dim)] mt-1.5">
                        Geen vlucht in deze periode
                      </div>
                    )}
                  </div>

                  {stats.lowestFlight && (
                    <button
                      type="button"
                      onClick={() => handleFollowFlight(stats.lowestFlight!)}
                      className="w-full px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-elevated)] hover:bg-[var(--accent-gold)] hover:text-[#060e0a] border border-[var(--border-focus)] text-[var(--accent-gold-bright)] text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Volg laagste vlucht op tijdlijn</span>
                    </button>
                  )}
                </div>

                {/* Hoogstgevlogen Hoogte + vluchtkoppeling */}
                <div className="p-3.5 rounded-[5px] bg-[var(--bg-main)] border border-[var(--status-blue)]/45 flex flex-col justify-between gap-2">
                  <div>
                    <div className="text-[11px] text-[var(--text-muted)] flex items-center justify-between gap-1.5">
                      <span className="flex items-center gap-1.5">
                        <ArrowUpFromLine className="w-3.5 h-3.5 text-[var(--status-blue)]" />
                        <span>Hoogstgevlogen Hoogte</span>
                      </span>
                      {stats.maxAltitudeM !== null && (
                        <span className="text-[10px] font-mono text-[var(--text-dim)]">
                          {metersToFeet(stats.maxAltitudeM).toLocaleString('nl-NL')} ft
                        </span>
                      )}
                    </div>
                    <div className="text-2xl font-bold font-mono text-[var(--status-blue)] mt-1">
                      {stats.maxAltitudeM !== null
                        ? `${stats.maxAltitudeM.toLocaleString('nl-NL')} m`
                        : '—'}
                    </div>
                    {stats.highestFlight ? (
                      <div className="mt-1.5 text-[11px] space-y-0.5">
                        <div className="font-mono font-bold text-[var(--text-main)] truncate">
                          {getFlightTitle(stats.highestFlight)}
                          {stats.highestFlight.icao_type_code
                            ? ` · ${stats.highestFlight.icao_type_code}`
                            : ''}
                        </div>
                        <div className="text-[10px] text-[var(--text-muted)] truncate">
                          {stats.highestFlight.operator_name ||
                            stats.highestFlight.model_name ||
                            TRAFFIC_CATEGORY_LABELS[stats.highestFlight.traffic_category]}{' '}
                          · {formatDateTimeNL(stats.highestFlight.entry_time, false)}
                        </div>
                      </div>
                    ) : (
                      <div className="text-[11px] font-mono text-[var(--text-dim)] mt-1.5">
                        Geen vlucht in deze periode
                      </div>
                    )}
                  </div>

                  {stats.highestFlight && (
                    <button
                      type="button"
                      onClick={() => handleFollowFlight(stats.highestFlight!)}
                      className="w-full px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-elevated)] hover:bg-[var(--status-blue)] hover:text-[#060e0a] border border-[var(--status-blue)]/50 text-[var(--status-blue)] text-[11px] font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
                    >
                      <Play className="w-3 h-3 fill-current" />
                      <span>Volg hoogste vlucht op tijdlijn</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Verdeling per categorie & top operators */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                    Verkeerscategorieën
                  </h3>
                  <div className="space-y-2">
                    {stats.byCategory.map((c) => (
                      <div key={c.category} className="space-y-1 text-xs">
                        <div className="flex justify-between">
                          <span className="text-[var(--text-main)]">
                            {TRAFFIC_CATEGORY_LABELS[c.category]}
                          </span>
                          <span className="font-mono text-[var(--text-muted)]">
                            {c.count} ({c.sharePct}%)
                          </span>
                        </div>
                        <div className="h-2 rounded-xs bg-[var(--bg-card)] overflow-hidden">
                          <div
                            className="h-full bg-[var(--accent-gold)]"
                            style={{ width: `${c.sharePct}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="p-4 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                    Meest actieve operators (periode)
                  </h3>
                  <div className="divide-y divide-[var(--border-subtle)]/60 text-xs">
                    {stats.topOperators.length === 0 ? (
                      <div className="py-4 text-[var(--text-dim)]">Nog geen data.</div>
                    ) : (
                      stats.topOperators.map((op) => (
                        <div
                          key={op.operator}
                          className="py-1.5 flex items-center justify-between gap-2"
                        >
                          <span className="text-[var(--text-main)] truncate">{op.operator}</span>
                          <span className="font-mono font-bold text-[var(--status-blue)] shrink-0">
                            {op.count}x
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Complete Historie: Stilste/Drukste dag & Top 10 Vliegmaatschappijen / Toesteltypes */}
              {stats.allTimeInsights && (
                <div className="rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] overflow-hidden">
                  <div className="px-4 py-2.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <History className="w-3.5 h-3.5 text-[var(--accent-gold)] shrink-0" />
                      <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-main)]">
                        Complete Historie — Dagrecords &amp; Top 10
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-[var(--text-dim)]">
                      {stats.allTimeInsights.totalPassages.toLocaleString('nl-NL')} passages over{' '}
                      {stats.allTimeInsights.totalDays.toLocaleString('nl-NL')}{' '}
                      {stats.allTimeInsights.totalDays === 1 ? 'dag' : 'dagen'}
                    </span>
                  </div>

                  <div className="p-4 space-y-4">
                    {/* Minste vs Meeste toestellen op een dag */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="p-3.5 rounded-[5px] bg-[var(--bg-card)] border border-[var(--border-subtle)] flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
                            <TrendingDown className="w-3.5 h-3.5 text-[var(--accent-gold)] shrink-0" />
                            <span>Dag met minste toestellen</span>
                          </div>
                          {stats.allTimeInsights.quietestDay ? (
                            <>
                              <div className="text-sm font-bold text-[var(--text-main)] mt-1 capitalize">
                                {stats.allTimeInsights.quietestDay.label}
                              </div>
                              <div className="text-[11px] font-mono text-[var(--text-dim)] mt-0.5">
                                {stats.allTimeInsights.quietestDay.dateKey}
                                {stats.allTimeInsights.totalDays === 1
                                  ? ' · voorlopig 1 dag geregistreerd'
                                  : ''}
                              </div>
                            </>
                          ) : (
                            <div className="text-xs font-mono text-[var(--text-dim)] mt-1.5">
                              Nog geen dagdata beschikbaar
                            </div>
                          )}
                        </div>
                        {stats.allTimeInsights.quietestDay && (
                          <div className="text-right shrink-0">
                            <div className="text-2xl font-bold font-mono text-[var(--accent-gold-bright)]">
                              {stats.allTimeInsights.quietestDay.count.toLocaleString('nl-NL')}
                            </div>
                            <div className="text-[10px] font-mono text-[var(--text-dim)]">
                              {stats.allTimeInsights.quietestDay.count === 1
                                ? 'toestel'
                                : 'toestellen'}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="p-3.5 rounded-[5px] bg-[var(--bg-card)] border border-[var(--border-subtle)] flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-[11px] text-[var(--text-muted)] flex items-center gap-1.5">
                            <TrendingUp className="w-3.5 h-3.5 text-[var(--status-emerald)] shrink-0" />
                            <span>Dag met meeste toestellen</span>
                          </div>
                          {stats.allTimeInsights.busiestDay ? (
                            <>
                              <div className="text-sm font-bold text-[var(--text-main)] mt-1 capitalize">
                                {stats.allTimeInsights.busiestDay.label}
                              </div>
                              <div className="text-[11px] font-mono text-[var(--text-dim)] mt-0.5">
                                {stats.allTimeInsights.busiestDay.dateKey}
                              </div>
                            </>
                          ) : (
                            <div className="text-xs font-mono text-[var(--text-dim)] mt-1.5">
                              Nog geen dagdata beschikbaar
                            </div>
                          )}
                        </div>
                        {stats.allTimeInsights.busiestDay && (
                          <div className="text-right shrink-0">
                            <div className="text-2xl font-bold font-mono text-[var(--status-emerald)]">
                              {stats.allTimeInsights.busiestDay.count.toLocaleString('nl-NL')}
                            </div>
                            <div className="text-[10px] font-mono text-[var(--text-dim)]">
                              {stats.allTimeInsights.busiestDay.count === 1
                                ? 'toestel'
                                : 'toestellen'}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Top 10 Vliegmaatschappijen & Top 10 Soorten Toestellen */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Top 10 Vliegmaatschappijen + gem. vlieghoogte */}
                      <div className="rounded-[5px] bg-[var(--bg-card)] border border-[var(--border-subtle)] overflow-hidden">
                        <div className="px-3.5 py-2 bg-[var(--bg-elevated)]/60 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
                            <Building2 className="w-3.5 h-3.5 text-[var(--status-blue)]" />
                            <span>Top 10 Vliegmaatschappijen</span>
                          </span>
                          <span className="text-[10px] font-mono text-[var(--text-dim)]">
                            Aantal &amp; gem. hoogte
                          </span>
                        </div>
                        <table className="w-full text-left border-collapse text-xs">
                          <thead className="bg-[var(--bg-main)]/60 text-[10px] text-[var(--text-dim)] uppercase font-mono">
                            <tr>
                              <th className="py-1.5 px-3 w-8">#</th>
                              <th className="py-1.5 px-2">Maatschappij</th>
                              <th className="py-1.5 px-2 text-right">Gem. hoogte</th>
                              <th className="py-1.5 px-3 text-right">Aantal</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border-subtle)]/60">
                            {stats.allTimeInsights.topOperators.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={4}
                                  className="py-5 px-3 text-center text-[var(--text-dim)]"
                                >
                                  Nog geen vliegmaatschappijen geregistreerd.
                                </td>
                              </tr>
                            ) : (
                              stats.allTimeInsights.topOperators.map((op, idx) => (
                                <tr key={op.operator} className="hover:bg-[var(--bg-card-hover)]">
                                  <td className="py-1.5 px-3 font-mono text-[var(--text-dim)]">
                                    {idx + 1}.
                                  </td>
                                  <td
                                    className="py-1.5 px-2 text-[var(--text-main)] font-medium truncate max-w-[180px]"
                                    title={op.operator}
                                  >
                                    {op.operator}
                                  </td>
                                  <td className="py-1.5 px-2 text-right font-mono text-[var(--text-muted)] whitespace-nowrap">
                                    {op.avgAltitudeM !== null ? (
                                      <>
                                        <span>
                                          {op.avgAltitudeM.toLocaleString('nl-NL')} m
                                        </span>
                                        <span className="text-[10px] text-[var(--text-dim)] ml-1">
                                          ({metersToFeet(op.avgAltitudeM).toLocaleString('nl-NL')} ft)
                                        </span>
                                      </>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="py-1.5 px-3 text-right font-mono font-bold text-[var(--status-blue)] whitespace-nowrap">
                                    {op.count.toLocaleString('nl-NL')}x
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      {/* Top 10 Soorten Toestellen */}
                      <div className="rounded-[5px] bg-[var(--bg-card)] border border-[var(--border-subtle)] overflow-hidden">
                        <div className="px-3.5 py-2 bg-[var(--bg-elevated)]/60 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
                            <Plane className="w-3.5 h-3.5 text-[var(--accent-gold)]" />
                            <span>Top 10 Soorten Toestellen</span>
                          </span>
                          <span className="text-[10px] font-mono text-[var(--text-dim)]">
                            Aantal passages
                          </span>
                        </div>
                        <table className="w-full text-left border-collapse text-xs">
                          <thead className="bg-[var(--bg-main)]/60 text-[10px] text-[var(--text-dim)] uppercase font-mono">
                            <tr>
                              <th className="py-1.5 px-3 w-8">#</th>
                              <th className="py-1.5 px-2">Toesteltype</th>
                              <th className="py-1.5 px-2 text-right">ICAO</th>
                              <th className="py-1.5 px-3 text-right">Aantal</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[var(--border-subtle)]/60">
                            {stats.allTimeInsights.topAircraftTypes.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={4}
                                  className="py-5 px-3 text-center text-[var(--text-dim)]"
                                >
                                  Nog geen toesteltypes geregistreerd.
                                </td>
                              </tr>
                            ) : (
                              stats.allTimeInsights.topAircraftTypes.map((t, idx) => (
                                <tr key={t.typeKey} className="hover:bg-[var(--bg-card-hover)]">
                                  <td className="py-1.5 px-3 font-mono text-[var(--text-dim)]">
                                    {idx + 1}.
                                  </td>
                                  <td
                                    className="py-1.5 px-2 text-[var(--text-main)] font-medium truncate max-w-[200px]"
                                    title={t.typeLabel}
                                  >
                                    {t.typeLabel}
                                  </td>
                                  <td className="py-1.5 px-2 text-right font-mono">
                                    {t.icaoTypeCode ? (
                                      <span className="px-1.5 py-0.5 rounded-[3px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
                                        {t.icaoTypeCode}
                                      </span>
                                    ) : (
                                      <span className="text-[var(--text-dim)]">—</span>
                                    )}
                                  </td>
                                  <td className="py-1.5 px-3 text-right font-mono font-bold text-[var(--accent-gold-bright)] whitespace-nowrap">
                                    {t.count.toLocaleString('nl-NL')}x
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Recente Passages Tabel */}
              <div className="rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] overflow-hidden">
                <div className="px-4 py-2.5 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                    Vluchtpassages binnen GM1708
                  </span>
                  <span className="text-[11px] font-mono text-[var(--text-dim)]">
                    Klik op een vlucht om direct op de tijdlijn te volgen
                  </span>
                </div>
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full text-left border-collapse text-xs font-mono">
                    <thead className="bg-[var(--bg-card)] text-[10px] text-[var(--text-dim)] uppercase sticky top-0">
                      <tr>
                        <th className="py-2 px-3">Callsign / Reg</th>
                        <th className="py-2 px-3">Operator / Type</th>
                        <th className="py-2 px-3">Intrede</th>
                        <th className="py-2 px-3">Laagst</th>
                        <th className="py-2 px-3">Hoogst</th>
                        <th className="py-2 px-3">Route</th>
                        <th className="py-2 px-3 text-right">Tijdlijn</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]/60">
                      {stats.recentPassages.length === 0 ? (
                        <tr>
                          <td
                            colSpan={7}
                            className="py-6 px-3 text-center text-[var(--text-dim)] font-sans"
                          >
                            Geen passages geregistreerd in deze periode.
                          </td>
                        </tr>
                      ) : (
                        stats.recentPassages.map((p) => {
                          const isLowest = stats.lowestFlight?.id === p.id;
                          const isHighest = stats.highestFlight?.id === p.id;
                          return (
                            <tr
                              key={p.id}
                              onClick={() => handleFollowFlight(p)}
                              className="hover:bg-[var(--bg-card-hover)] cursor-pointer transition-colors"
                            >
                              <td className="py-2 px-3 font-bold text-[var(--accent-gold-bright)]">
                                <div className="flex items-center gap-1.5">
                                  <span>{getFlightTitle(p)}</span>
                                  {isLowest && (
                                    <span className="px-1 py-0.5 rounded-[3px] bg-[var(--accent-gold)]/20 text-[var(--accent-gold-bright)] text-[9px] font-bold">
                                      LAAGST
                                    </span>
                                  )}
                                  {isHighest && (
                                    <span className="px-1 py-0.5 rounded-[3px] bg-[var(--status-blue)]/20 text-[var(--status-blue)] text-[9px] font-bold">
                                      HOOGST
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 px-3 font-sans text-[var(--text-main)]">
                                {p.operator_name || p.model_name || '—'}
                              </td>
                              <td className="py-2 px-3 text-[var(--text-muted)]">
                                {formatDateTimeNL(p.entry_time, false)} (
                                {formatTimeNL(p.entry_time, true)})
                              </td>
                              <td className="py-2 px-3 text-[var(--accent-gold-bright)]">
                                {p.min_alt_m !== null
                                  ? `${p.min_alt_m.toLocaleString('nl-NL')} m`
                                  : '—'}
                              </td>
                              <td className="py-2 px-3 text-[var(--status-blue)]">
                                {formatAltitudeLabel(p.max_alt_ft, p.max_alt_m)}
                              </td>
                              <td className="py-2 px-3 text-[var(--status-blue)]">
                                {p.dep_iata && p.arr_iata
                                  ? `${p.dep_iata} → ${p.arr_iata}`
                                  : TRAFFIC_CATEGORY_LABELS[p.traffic_category]}
                              </td>
                              <td className="py-2 px-3 text-right">
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[3px] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[10px] font-sans font-semibold text-[var(--text-main)]">
                                  <Play className="w-2.5 h-2.5 fill-current text-[var(--accent-gold)]" />
                                  Volg
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
