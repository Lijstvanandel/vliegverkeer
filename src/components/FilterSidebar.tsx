import React from 'react';
import {
  PassageWithTrack,
  RadarFilters,
  TrafficCategory,
} from '../types/radar';
import {
  formatAltitudeLabel,
  formatTimeNL,
  getAltitudeColor,
  isHelicopterPassage,
  metersToFeet,
  TRAFFIC_CATEGORY_LABELS,
} from '../lib/geoUtils';
import {
  X,
  Search,
  SlidersHorizontal,
  Plane,
  RotateCcw,
} from 'lucide-react';

interface FilterSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  filters: RadarFilters;
  onChangeFilters: (next: RadarFilters) => void;
  passages: PassageWithTrack[];
  approachingPassages?: PassageWithTrack[];
  selectedPassageId: string | null;
  onSelectPassage: (id: string) => void;
}

const ALL_CATEGORIES: Array<{ id: TrafficCategory; dotClass: string }> = [
  { id: 'commercial', dotClass: 'bg-[#38bdf8]' },
  { id: 'hems_police_sar', dotClass: 'bg-[#ef4444]' },
  { id: 'general_aviation', dotClass: 'bg-[#f59e0b]' },
  { id: 'military', dotClass: 'bg-[#a855f7]' },
  { id: 'unknown', dotClass: 'bg-[#94a3b8]' },
];

export const DEFAULT_RADAR_FILTERS: RadarFilters = {
  minAltM: 0,
  maxAltM: 15000,
  includeUnknownAlt: true,
  categories: ['commercial', 'general_aviation', 'hems_police_sar', 'military', 'unknown'],
  searchQuery: '',
};

export const FilterSidebar: React.FC<FilterSidebarProps> = ({
  isOpen,
  onClose,
  filters,
  onChangeFilters,
  passages,
  approachingPassages = [],
  selectedPassageId,
  onSelectPassage,
}) => {
  if (!isOpen) return null;

  const toggleCategory = (cat: TrafficCategory) => {
    const exists = filters.categories.includes(cat);
    const nextCats = exists
      ? filters.categories.filter((c) => c !== cat)
      : [...filters.categories, cat];
    onChangeFilters({ ...filters, categories: nextCats });
  };

  return (
    <aside className="fixed inset-y-0 left-0 top-11 md:static w-[320px] sm:w-[350px] h-[calc(100vh-2.75rem)] md:h-full z-[500] bg-[var(--bg-card)] border-r border-[var(--border-subtle)] shadow-2xl flex flex-col text-[var(--text-main)] shrink-0 tabular-nums">
      {/* Header */}
      <div className="px-4 py-3 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-[var(--accent-gold)]" />
          <div>
            <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-main)]">
              Filters &amp; Passages
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              {passages.length} getoond binnen Steenwijkerland
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChangeFilters(DEFAULT_RADAR_FILTERS)}
            className="p-1.5 rounded-[4px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-card-hover)] border border-transparent hover:border-[var(--border-subtle)] transition-colors cursor-pointer"
            title="Herstel standaardfilters"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-[4px] text-[var(--text-muted)] hover:text-[var(--text-main)] hover:bg-[var(--bg-card-hover)] border border-transparent hover:border-[var(--border-subtle)] transition-colors cursor-pointer"
            title="Sluit filterpaneel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="p-3.5 space-y-4 border-b border-[var(--border-subtle)] bg-[var(--bg-main)]/60 shrink-0">
        {/* Zoekveld */}
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-[var(--text-dim)] absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={filters.searchQuery}
            onChange={(e) => onChangeFilters({ ...filters, searchQuery: e.target.value })}
            placeholder="Zoek callsign, registratie, ICAO24, luchthaven..."
            className="w-full pl-8 pr-3 py-1.5 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)] focus:border-[var(--border-focus)] text-xs text-[var(--text-main)] placeholder:text-[var(--text-dim)] focus:outline-none"
          />
        </div>

        {/* Hoogtefilter (m & ft) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-semibold text-[var(--text-muted)]">Hoogtebereik</span>
            <span className="font-mono text-[var(--accent-gold-bright)]">
              {filters.minAltM.toLocaleString('nl-NL')}–{filters.maxAltM.toLocaleString('nl-NL')} m
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <div className="flex justify-between text-[10px] text-[var(--text-dim)] font-mono mb-0.5">
                <span>Min: {filters.minAltM} m</span>
                <span>{metersToFeet(filters.minAltM).toLocaleString('nl-NL')} ft</span>
              </div>
              <input
                type="range"
                min={0}
                max={14000}
                step={250}
                value={filters.minAltM}
                onChange={(e) => {
                  const val = Math.min(Number(e.target.value), filters.maxAltM);
                  onChangeFilters({ ...filters, minAltM: val });
                }}
                className="w-full accent-[#f59e0b] cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-[10px] text-[var(--text-dim)] font-mono mb-0.5">
                <span>Max: {filters.maxAltM} m</span>
                <span>{metersToFeet(filters.maxAltM).toLocaleString('nl-NL')} ft</span>
              </div>
              <input
                type="range"
                min={500}
                max={15000}
                step={250}
                value={filters.maxAltM}
                onChange={(e) => {
                  const val = Math.max(Number(e.target.value), filters.minAltM);
                  onChangeFilters({ ...filters, maxAltM: val });
                }}
                className="w-full accent-[#38bdf8] cursor-pointer"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] cursor-pointer select-none pt-0.5">
            <input
              type="checkbox"
              checked={filters.includeUnknownAlt}
              onChange={(e) =>
                onChangeFilters({ ...filters, includeUnknownAlt: e.target.checked })
              }
              className="accent-[#f59e0b] rounded cursor-pointer"
            />
            <span>Inclusief toestellen met onbekende hoogte</span>
          </label>
        </div>

        {/* Categorie-filter */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-semibold text-[var(--text-muted)]">Verkeerstype</div>
          <div className="grid grid-cols-1 gap-1">
            {ALL_CATEGORIES.map((cat) => {
              const checked = filters.categories.includes(cat.id);
              const count = passages.filter((p) => p.passage.traffic_category === cat.id).length;
              return (
                <label
                  key={cat.id}
                  className={`flex items-center justify-between px-2 py-1 rounded-[4px] border text-[11px] cursor-pointer transition-colors ${
                    checked
                      ? 'bg-[var(--bg-card)] border-[var(--border-focus)] text-[var(--text-main)]'
                      : 'bg-transparent border-[var(--border-subtle)]/50 text-[var(--text-dim)]'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCategory(cat.id)}
                      className="accent-[#f59e0b] cursor-pointer"
                    />
                    <span className={`w-2 h-2 rounded-full shrink-0 ${cat.dotClass}`} />
                    <span className="truncate">{TRAFFIC_CATEGORY_LABELS[cat.id]}</span>
                  </span>
                  <span className="font-mono text-[10px] text-[var(--text-muted)] ml-2">
                    {count}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      {/* Passagelijst */}
      <div className="flex-1 overflow-y-auto divide-y divide-[var(--border-subtle)]/70">
        {passages.length === 0 && approachingPassages.length === 0 ? (
          <div className="p-6 text-center text-xs text-[var(--text-dim)] space-y-2">
            <Plane className="w-6 h-6 mx-auto text-[var(--text-dim)] opacity-60" />
            <p>Geen vluchtpassages komen overeen met de huidige filters.</p>
          </div>
        ) : (
          <>
            {passages.map(({ passage, positions }) => {
              const latest = positions[positions.length - 1];
              const isSelected = passage.id === selectedPassageId;
              const altColor = getAltitudeColor(
                latest?.alt_m ?? passage.max_alt_m,
                latest?.on_ground ?? false
              );
              const isHeli = isHelicopterPassage(passage);

              return (
                <button
                  key={passage.id}
                  type="button"
                  onClick={() => onSelectPassage(passage.id)}
                  className={`w-full text-left px-3.5 py-2.5 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--bg-elevated)] border-l-2 border-l-[var(--accent-gold)]'
                      : 'hover:bg-[var(--bg-card-hover)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: altColor }}
                      />
                      <span className="font-mono font-bold text-xs text-[var(--accent-gold-bright)] truncate">
                        {passage.callsign || passage.registration || passage.icao24.toUpperCase()}
                      </span>
                      {isHeli && (
                        <span className="px-1.5 py-0.2 rounded-[3px] bg-[var(--status-crimson)]/20 text-[var(--status-crimson)] text-[10px] font-bold">
                          HELI
                        </span>
                      )}
                      {passage.has_mlat_positions && (
                        <span className="px-1.5 py-0.2 rounded-[3px] bg-[var(--status-purple)]/20 text-[var(--status-purple)] text-[10px] font-bold">
                          MLAT
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10px] text-[var(--text-dim)] shrink-0">
                      {formatTimeNL(passage.last_seen_time, false)}
                    </span>
                  </div>

                  <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                    {passage.operator_name || passage.model_name || `Hex ${passage.icao24.toUpperCase()}`}
                  </div>

                  <div className="flex items-center justify-between gap-2 mt-1 text-[10px] font-mono">
                    <span className="text-[var(--text-main)]">
                      {formatAltitudeLabel(
                        latest?.alt_ft ?? passage.max_alt_ft,
                        latest?.alt_m ?? passage.max_alt_m,
                        latest?.on_ground ?? false
                      )}
                    </span>
                    {passage.dep_iata && passage.arr_iata ? (
                      <span className="text-[var(--status-blue)] font-bold">
                        {passage.dep_iata} → {passage.arr_iata}
                      </span>
                    ) : (
                      <span className="text-[var(--text-dim)]">
                        {passage.is_active ? 'Actief' : `${passage.point_count} ptn`}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}

            {approachingPassages.length > 0 && (
              <div className="bg-[var(--bg-main)]/70">
                <div className="px-3.5 py-1.5 bg-[var(--bg-elevated)]/80 border-y border-[var(--border-subtle)] text-[10px] font-bold uppercase tracking-wider text-[var(--status-blue)]">
                  Nadert vanuit buurgemeente ({approachingPassages.length} · puur visueel)
                </div>
                {approachingPassages.map(({ passage, positions }) => {
                  const latest = positions[positions.length - 1];
                  const isSelected = passage.id === selectedPassageId;
                  const altColor = getAltitudeColor(
                    latest?.alt_m ?? passage.max_alt_m,
                    latest?.on_ground ?? false
                  );

                  return (
                    <button
                      key={passage.id}
                      type="button"
                      onClick={() => onSelectPassage(passage.id)}
                      className={`w-full text-left px-3.5 py-2.5 transition-colors cursor-pointer border-b border-[var(--border-subtle)]/60 last:border-b-0 ${
                        isSelected
                          ? 'bg-[var(--bg-elevated)] border-l-2 border-l-[var(--status-blue)]'
                          : 'hover:bg-[var(--bg-card-hover)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0 opacity-80 ring-1 ring-[var(--status-blue)]"
                            style={{ backgroundColor: altColor }}
                          />
                          <span className="font-mono font-bold text-xs text-[var(--status-blue)] truncate">
                            {passage.callsign || passage.registration || passage.icao24.toUpperCase()}
                          </span>
                          <span className="px-1.5 py-0.2 rounded-[3px] bg-[var(--status-blue)]/15 text-[var(--status-blue)] text-[9px] font-bold">
                            NADERT
                          </span>
                        </div>
                        <span className="font-mono text-[10px] text-[var(--accent-gold-bright)] shrink-0">
                          {passage.eta_seconds ? `~${passage.eta_seconds}s` : '—'}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                        Boven {passage.neighbor_municipality || 'buurgemeente'} → GM1708
                      </div>
                      <div className="text-[10px] font-mono text-[var(--text-dim)] mt-0.5">
                        {formatAltitudeLabel(
                          latest?.alt_ft ?? passage.max_alt_ft,
                          latest?.alt_m ?? passage.max_alt_m,
                          latest?.on_ground ?? false
                        )}{' '}
                        · Nog niet in meting
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
};
