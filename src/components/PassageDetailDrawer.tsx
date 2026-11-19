import React, { useMemo } from 'react';
import { PassageWithTrack, RadarMode } from '../types/radar';
import {
  formatAltitudeLabel,
  formatDateTimeNL,
  formatDurationSeconds,
  formatTimeNL,
  formatTimeUTC,
  getAltitudeColor,
  getCompassDirection,
  interpolatePassageAtTime,
  isHelicopterPassage,
  knotsToKmh,
  resolveTrackAtIndex,
  TRAFFIC_CATEGORY_LABELS,
} from '../lib/geoUtils';
import {
  X,
  Plane,
  Compass,
  Gauge,
  Clock,
  MapPin,
  ArrowRight,
  Radio,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';

interface PassageDetailDrawerProps {
  item: PassageWithTrack | null;
  mode: RadarMode;
  playheadMs: number;
  onClose: () => void;
}

export const PassageDetailDrawer: React.FC<PassageDetailDrawerProps> = ({
  item,
  mode,
  playheadMs,
  onClose,
}) => {
  if (!item) return null;
  const { passage, positions } = item;

  const activePointInfo = useMemo(() => {
    if (positions.length === 0) return null;
    if (mode === 'live') {
      const idx = positions.length - 1;
      const pt = positions[idx];
      const track = resolveTrackAtIndex(positions, idx);
      const trackIsComputed = pt.track === null;
      return { point: pt, track, trackIsComputed };
    }
    const interp = interpolatePassageAtTime(positions, playheadMs);
    if (interp) {
      return {
        point: interp.point,
        track: interp.resolvedTrack,
        trackIsComputed: false,
      };
    }
    const lastIdx = positions.length - 1;
    return {
      point: positions[lastIdx],
      track: resolveTrackAtIndex(positions, lastIdx),
      trackIsComputed: positions[lastIdx].track === null,
    };
  }, [positions, mode, playheadMs]);

  const currentPt = activePointInfo?.point || null;
  const isHeli = isHelicopterPassage(passage);

  // SVG Hoogteprofiel over de passage
  const chartSvg = useMemo(() => {
    const valid = positions.filter((p) => p.alt_m !== null);
    if (valid.length < 2) return null;
    const width = 340;
    const height = 88;
    const padX = 8;
    const padY = 10;

    const minT = positions[0].t;
    const maxT = Math.max(minT + 1000, positions[positions.length - 1].t);
    const alts = valid.map((p) => p.alt_m!);
    const minAlt = Math.min(...alts);
    const maxAlt = Math.max(minAlt + 50, Math.max(...alts));

    const pts = valid.map((p) => {
      const x = padX + ((p.t - minT) / (maxT - minT)) * (width - padX * 2);
      const y = height - padY - ((p.alt_m! - minAlt) / (maxAlt - minAlt)) * (height - padY * 2);
      return { x, y, alt: p.alt_m!, t: p.t };
    });

    const linePath = pts
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`)
      .join(' ');
    const areaPath = `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(
      height - padY
    ).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(height - padY).toFixed(1)} Z`;

    const playX =
      mode === 'history' && playheadMs >= minT && playheadMs <= maxT
        ? padX + ((playheadMs - minT) / (maxT - minT)) * (width - padX * 2)
        : null;

    return { width, height, linePath, areaPath, minAlt, maxAlt, playX };
  }, [positions, mode, playheadMs]);

  const renderMissingRouteReason = () => {
    switch (passage.route_status) {
      case 'not_applicable_vfr_mil':
        return 'Geen gepubliceerde lijnvluchtroute (VFR / helikopter / defensie-vlucht).';
      case 'quota_skipped':
        return 'Routedetails overgeslagen omdat het dagelijkse API-quotum is bereikt; gratis route-lookup leverde geen match.';
      case 'partial_route_only':
        return 'Alleen route-informatie (herkomst/bestemming) bekend; geplande en actuele tijden ontbreken.';
      case 'not_found':
        return 'Geen routegegevens gevonden voor dit callsign in de beschikbare databronnen.';
      case 'pending':
        return 'Achtergrondverrijking van vluchtroute en operator wordt uitgevoerd...';
      default:
        return null;
    }
  };

  return (
    <aside className="fixed inset-x-0 bottom-0 top-11 md:static md:w-[390px] lg:w-[420px] h-[calc(100vh-2.75rem)] md:h-full z-[600] bg-[var(--bg-card)] border-l border-[var(--border-subtle)] shadow-2xl flex flex-col justify-between text-[var(--text-main)] shrink-0 tabular-nums">
      {/* 1. KOP (Header) */}
      <div className="p-4 border-b border-[var(--border-subtle)] flex items-start justify-between gap-3 bg-[var(--bg-elevated)] shrink-0">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-[5px] border border-[var(--border-focus)] bg-[var(--bg-main)] flex items-center justify-center shrink-0">
            <Plane className="w-5 h-5 text-[var(--accent-gold)]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center flex-wrap gap-1.5 mb-1">
              <span className="px-2 py-0.5 rounded-[4px] text-xs font-bold font-mono bg-[var(--accent-gold)] text-[#060e0a]">
                {passage.callsign || passage.registration || passage.icao24.toUpperCase()}
              </span>
              {passage.flight_number_iata && (
                <span className="px-1.5 py-0.5 rounded-[4px] text-[11px] font-mono font-bold bg-[var(--bg-main)] border border-[var(--border-subtle)] text-[var(--status-blue)]">
                  {passage.flight_number_iata}
                </span>
              )}
              {isHeli && (
                <span className="px-1.5 py-0.5 rounded-[4px] text-[10px] font-bold bg-[var(--status-crimson)]/20 text-[var(--status-crimson)]">
                  HELIKOPTER
                </span>
              )}
              <span
                className={`px-1.5 py-0.5 rounded-[4px] text-[10px] font-bold ${
                  passage.visual_only
                    ? 'bg-[var(--status-blue)]/20 text-[var(--status-blue)]'
                    : passage.is_active
                    ? 'bg-[var(--status-emerald)]/20 text-[var(--status-emerald)]'
                    : 'bg-[var(--bg-main)] text-[var(--text-muted)] border border-[var(--border-subtle)]'
                }`}
              >
                {passage.visual_only
                  ? `NADERT (${passage.neighbor_municipality || 'BUURGEMEENTE'})`
                  : passage.is_active
                  ? 'ACTIEF IN GM1708'
                  : 'PASSAGE AFGEROND'}
              </span>
            </div>
            <h2 className="text-sm font-bold text-[var(--text-main)] tracking-tight leading-snug truncate">
              {passage.operator_name || TRAFFIC_CATEGORY_LABELS[passage.traffic_category]}
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">
              {TRAFFIC_CATEGORY_LABELS[passage.traffic_category]}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-card)] hover:bg-[var(--status-crimson)] text-[var(--text-main)] border border-[var(--border-subtle)] transition-colors cursor-pointer flex items-center gap-1 text-xs font-semibold shrink-0"
          title="Detailpaneel sluiten (Esc)"
        >
          <X className="w-4 h-4" />
          <span>Sluiten</span>
        </button>
      </div>

      {/* Scrollbare inhoud (Secties 2 t/m 8) */}
      <div className="p-4 overflow-y-auto space-y-4 flex-1 text-xs">
        {passage.visual_only && (
          <div className="p-3 rounded-[5px] bg-[var(--status-blue)]/10 border border-[var(--status-blue)]/40 text-[11px] text-[var(--text-main)] leading-relaxed">
            <strong className="text-[var(--status-blue)]">
              Visuele vooraankondiging vanuit {passage.neighbor_municipality || 'aangrenzende gemeente'}:
            </strong>{' '}
            Op basis van de huidige koers vliegt dit toestel{' '}
            {passage.eta_seconds ? `naar verwachting binnen ca. ${passage.eta_seconds} sec ` : ''}
            over Steenwijkerland.{' '}
            <span className="text-[var(--accent-gold-bright)] font-semibold">
              Deze waarneming telt nog NIET mee in de metingen en .CSV statistieken.
            </span>
          </div>
        )}
        {/* 2. TOESTEL & OPERATOR */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)]">
            2. Toestel &amp; Operator
          </div>
          <div className="grid grid-cols-2 gap-y-2 gap-x-3">
            <div>
              <div className="text-[10px] text-[var(--text-muted)]">ICAO24 (Hex)</div>
              <div className="font-mono font-bold text-[var(--accent-gold-bright)] uppercase">
                {passage.icao24}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)]">Registratie</div>
              <div className="font-mono font-bold text-[var(--text-main)]">
                {passage.registration || 'Onbekend'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)]">Typecode (ICAO)</div>
              <div className="font-mono font-semibold text-[var(--text-main)]">
                {passage.icao_type_code || 'Onbekend'}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-muted)]">Toestelmodel</div>
              <div className="font-medium text-[var(--text-main)] truncate">
                {passage.model_name || 'Onbekend model'}
              </div>
            </div>
          </div>
        </section>

        {/* 3. ROUTE (HERKOMST & BESTEMMING) */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)]">
            3. Route (Herkomst &amp; Bestemming)
          </div>
          {passage.dep_icao || passage.dep_iata || passage.arr_icao || passage.arr_iata ? (
            <div className="flex items-center justify-between gap-2 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[4px] p-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-mono font-bold text-sm text-[var(--status-blue)]">
                  {passage.dep_iata || passage.dep_icao || '—'}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] truncate">
                  {passage.dep_airport_name || passage.dep_icao || 'Onbekend vertrek'}
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-[var(--accent-gold)] shrink-0" />
              <div className="min-w-0 flex-1 text-right">
                <div className="font-mono font-bold text-sm text-[var(--status-emerald)]">
                  {passage.arr_iata || passage.arr_icao || '—'}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] truncate">
                  {passage.arr_airport_name || passage.arr_icao || 'Onbekende bestemming'}
                </div>
              </div>
            </div>
          ) : null}

          {renderMissingRouteReason() && (
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              {renderMissingRouteReason()}
            </p>
          )}
        </section>

        {/* 4. VLUCHTTIJDEN */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)]">
            4. Vluchttijden (STD / ATD / STA / ETA)
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <div className="text-[10px] text-[var(--text-dim)]">Gepland vertrek (STD)</div>
              <div className="font-semibold text-[var(--text-main)]">
                {passage.scheduled_departure ? formatTimeNL(passage.scheduled_departure, false) : '—'}
              </div>
              {passage.scheduled_departure && (
                <div className="text-[10px] text-[var(--text-dim)]">
                  {formatTimeUTC(passage.scheduled_departure)}
                </div>
              )}
            </div>
            <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <div className="text-[10px] text-[var(--text-dim)]">Werkelijk vertrek (ATD)</div>
              <div className="font-semibold text-[var(--status-emerald)]">
                {passage.actual_departure ? formatTimeNL(passage.actual_departure, false) : '—'}
              </div>
              {passage.actual_departure && (
                <div className="text-[10px] text-[var(--text-dim)]">
                  {formatTimeUTC(passage.actual_departure)}
                </div>
              )}
            </div>
            <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <div className="text-[10px] text-[var(--text-dim)]">Geplande aankomst (STA)</div>
              <div className="font-semibold text-[var(--text-main)]">
                {passage.scheduled_arrival ? formatTimeNL(passage.scheduled_arrival, false) : '—'}
              </div>
              {passage.scheduled_arrival && (
                <div className="text-[10px] text-[var(--text-dim)]">
                  {formatTimeUTC(passage.scheduled_arrival)}
                </div>
              )}
            </div>
            <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
              <div className="text-[10px] text-[var(--text-dim)]">Verwachte aankomst (ETA)</div>
              <div className="font-semibold text-[var(--status-blue)]">
                {passage.estimated_arrival ? formatTimeNL(passage.estimated_arrival, false) : '—'}
              </div>
              {passage.estimated_arrival && (
                <div className="text-[10px] text-[var(--text-dim)]">
                  {formatTimeUTC(passage.estimated_arrival)}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 5. ACTUELE / GESELECTEERDE POSITIE & TELEMETRIE */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)]">
            5. Positie &amp; Telemetrie
          </div>
          {currentPt ? (
            <>
              <div className="grid grid-cols-3 gap-2">
                <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
                  <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <Gauge className="w-3 h-3 text-[var(--status-blue)]" />
                    <span>Snelheid</span>
                  </div>
                  <div className="font-mono font-bold text-[var(--text-main)] mt-0.5">
                    {currentPt.gs !== null ? `${Math.round(currentPt.gs)} kts` : '—'}
                  </div>
                  <div className="font-mono text-[10px] text-[var(--text-dim)]">
                    {currentPt.gs !== null ? `${knotsToKmh(currentPt.gs)} km/u` : 'Onbekend'}
                  </div>
                </div>

                <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
                  <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <Compass className="w-3 h-3 text-[var(--status-purple)]" />
                    <span>Koers</span>
                  </div>
                  <div className="font-mono font-bold text-[var(--text-main)] mt-0.5">
                    {activePointInfo?.track ?? 0}° {getCompassDirection(activePointInfo?.track ?? 0)}
                  </div>
                  <div className="font-mono text-[10px] text-[var(--text-dim)]">
                    {activePointInfo?.trackIsComputed ? 'Berekend' : 'Transponder'}
                  </div>
                </div>

                <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
                  <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                    <TrendingUp className="w-3 h-3 text-[var(--accent-gold)]" />
                    <span>V-rate</span>
                  </div>
                  <div className="font-mono font-bold text-[var(--text-main)] mt-0.5">
                    {currentPt.vrate !== null
                      ? `${currentPt.vrate > 0 ? '+' : ''}${currentPt.vrate}`
                      : '—'}
                  </div>
                  <div className="font-mono text-[10px] text-[var(--text-dim)]">ft/min</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
                  <div className="text-[10px] text-[var(--text-dim)]">Barometrische hoogte</div>
                  <div
                    className="font-bold"
                    style={{
                      color: getAltitudeColor(currentPt.alt_baro_m, currentPt.on_ground),
                    }}
                  >
                    {formatAltitudeLabel(
                      currentPt.alt_baro_ft,
                      currentPt.alt_baro_m,
                      currentPt.on_ground
                    )}
                  </div>
                </div>
                <div className="p-2 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)]">
                  <div className="text-[10px] text-[var(--text-dim)]">Geometrische hoogte (GPS)</div>
                  <div className="font-bold text-[var(--text-main)]">
                    {formatAltitudeLabel(
                      currentPt.alt_geom_ft,
                      currentPt.alt_geom_m,
                      currentPt.on_ground
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <p className="text-[var(--text-dim)]">Geen telemetriepunten beschikbaar.</p>
          )}
        </section>

        {/* 6. PASSAGE DOOR GEMEENTE STEENWIJKERLAND */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)] flex items-center gap-1.5">
            <MapPin className="w-3 h-3 text-[var(--status-blue)]" />
            <span>6. Passage Gemeente Steenwijkerland (GM1708)</span>
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <div>
              <div className="text-[10px] text-[var(--text-dim)]">Intrede GM1708</div>
              <div className="text-[var(--text-main)] font-semibold">
                {formatDateTimeNL(passage.entry_time, true)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-dim)]">Uittrede / Laatst gezien</div>
              <div className="text-[var(--text-main)] font-semibold">
                {passage.exit_time
                  ? formatDateTimeNL(passage.exit_time, true)
                  : formatDateTimeNL(passage.last_seen_time, true)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-dim)]">Verblijfsduur</div>
              <div className="text-[var(--accent-gold-bright)] font-bold">
                {formatDurationSeconds(passage.entry_time, passage.exit_time)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-dim)]">Gelogde trackpunten</div>
              <div className="text-[var(--text-main)] font-bold">{passage.point_count} punten</div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-dim)]">Min hoogte in GM1708</div>
              <div className="text-[var(--text-main)]">
                {formatAltitudeLabel(passage.min_alt_ft, passage.min_alt_m)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-[var(--text-dim)]">Max hoogte in GM1708</div>
              <div className="text-[var(--text-main)]">
                {formatAltitudeLabel(passage.max_alt_ft, passage.max_alt_m)}
              </div>
            </div>
          </div>
        </section>

        {/* 7. HOOGTEPROFIEL GRAFIEK (SVG) */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)]">
              7. Hoogteprofiel over passage
            </span>
            {chartSvg && (
              <span className="font-mono text-[10px] text-[var(--text-muted)]">
                {chartSvg.minAlt.toLocaleString('nl-NL')}–{chartSvg.maxAlt.toLocaleString('nl-NL')}{' '}
                m
              </span>
            )}
          </div>
          {chartSvg ? (
            <svg
              viewBox={`0 0 ${chartSvg.width} ${chartSvg.height}`}
              className="w-full h-22 bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[4px]"
            >
              <defs>
                <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
                </linearGradient>
              </defs>
              <path d={chartSvg.areaPath} fill="url(#altGrad)" />
              <path
                d={chartSvg.linePath}
                fill="none"
                stroke="#38bdf8"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              {chartSvg.playX !== null && (
                <line
                  x1={chartSvg.playX}
                  y1={4}
                  x2={chartSvg.playX}
                  y2={chartSvg.height - 4}
                  stroke="#f59e0b"
                  strokeWidth="1.5"
                  strokeDasharray="3 2"
                />
              )}
            </svg>
          ) : (
            <div className="p-2 text-[11px] text-[var(--text-dim)] bg-[var(--bg-card)] border border-[var(--border-subtle)] rounded-[4px]">
              Minimaal 2 hoogtemetingen nodig voor het hoogteprofiel.
            </div>
          )}
        </section>

        {/* 8. BRON & KWALITEIT */}
        <section className="p-3 rounded-[5px] bg-[var(--bg-main)] border border-[var(--border-subtle)] space-y-1.5">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-dim)] flex items-center gap-1.5">
            <Radio className="w-3 h-3 text-[var(--status-emerald)]" />
            <span>8. Bron &amp; Datakwaliteit</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">
            <span className="px-2 py-0.5 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-main)]">
              Positiebron: {currentPt?.src || 'adsb_icao'}
            </span>
            <span className="px-2 py-0.5 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
              Verrijking: {passage.enrichment_source || 'geen'}
            </span>
          </div>
          {passage.has_mlat_positions && (
            <div className="mt-1 p-2 rounded-[4px] bg-[var(--status-purple)]/10 border border-[var(--status-purple)]/30 text-[11px] text-[var(--text-muted)] flex items-start gap-2">
              <ShieldAlert className="w-3.5 h-3.5 text-[var(--status-purple)] shrink-0 mt-0.5" />
              <span>
                Dit toestel bevat MLAT-posities (multilateratie, o.a. gebruikt bij defensie zonder
                ADS-B GPS-uitzending). Koers en exacte locatie kunnen licht schommelen.
              </span>
            </div>
          )}
        </section>
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 bg-[var(--bg-main)] border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-dim)] shrink-0">
        <span className="flex items-center gap-1 font-mono">
          <Clock className="w-3 h-3" />
          <span>Hex {passage.icao24.toUpperCase()}</span>
        </span>
        <span>Strikte GM1708 Geofence</span>
      </div>
    </aside>
  );
};
