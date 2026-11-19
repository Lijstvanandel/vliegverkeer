import React, { useState } from 'react';
import {
  FeedMode,
  IngestionHealth,
  PassageWithTrack,
  RadarMode,
} from '../types/radar';
import { formatTimeNL } from '../lib/geoUtils';
import {
  Search,
  RefreshCw,
  Radio,
  ToggleRight,
  BarChart3,
  Code2,
  ExternalLink,
  Plane,
  History,
  SlidersHorizontal,
  AlertTriangle,
} from 'lucide-react';

interface TopNavBarProps {
  mode: RadarMode;
  onChangeMode: (mode: RadarMode) => void;
  feedMode: FeedMode;
  onToggleFeedMode: (mode: FeedMode) => void;
  passages: PassageWithTrack[];
  approachingPassages?: PassageWithTrack[];
  totalMatchedCount: number;
  health: IngestionHealth;
  isSyncing: boolean;
  onManualRefresh: () => void;
  isFilterOpen: boolean;
  onToggleFilterSidebar: () => void;
  onSelectPassage: (passageId: string) => void;
  onOpenStatsModal: () => void;
  onOpenEmbedModal?: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  isEmbed?: boolean;
}

export const TopNavBar: React.FC<TopNavBarProps> = ({
  mode,
  onChangeMode,
  feedMode,
  onToggleFeedMode,
  passages,
  approachingPassages = [],
  totalMatchedCount,
  health,
  isSyncing,
  onManualRefresh,
  isFilterOpen,
  onToggleFilterSidebar,
  onSelectPassage,
  onOpenStatsModal,
  onOpenEmbedModal,
  searchQuery,
  onSearchChange,
  isEmbed = false,
}) => {
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const quickMatches = searchQuery.trim()
    ? passages
        .filter(({ passage }) => {
          const q = searchQuery.trim().toLowerCase();
          return [
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
            .includes(q);
        })
        .slice(0, 8)
    : [];

  return (
    <header className="bg-[var(--bg-card)] border-b border-[var(--border-subtle)] z-30 select-none shrink-0 flex flex-col">
      {/* Bovenste rij: Huisstijl merk, zoekbalk & globale radaracties */}
      <div className="h-11 px-2.5 md:px-4 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)]/70">
        {/* Merkblok (Onafhankelijk Steenwijkerland Dataproduct) */}
        <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          <a
            href="/"
            target={isEmbed ? '_blank' : undefined}
            rel={isEmbed ? 'noopener noreferrer' : undefined}
            className="flex items-center gap-2.5 text-[var(--text-main)] transition-opacity group min-w-0"
          >
            <img
              src="/logo-osl.webp"
              alt="Onafhankelijk Steenwijkerland"
              className="h-8 w-8 rounded-[4px] bg-[#f5f6f4] p-0.5 object-contain border border-[var(--border-subtle)] shrink-0"
            />
            <div className="flex flex-col leading-tight min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-xs sm:text-sm font-bold tracking-tight text-[var(--text-main)] whitespace-nowrap">
                  Onafhankelijk Steenwijkerland
                </span>
                <span className="text-[11px] text-[var(--accent-gold)] font-semibold hidden xs:inline whitespace-nowrap">
                  GM1708
                </span>
              </div>
              <span className="text-[10px] text-[var(--text-muted)] hidden md:inline truncate">
                Dataproduct van Onafhankelijk Steenwijkerland · Luchtverkeer Radar
              </span>
            </div>
          </a>
        </div>

        {/* Rechterzone: Zoeken, Live/Preview, Verversen, Insluiten */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Zoekbalk */}
          <div className="relative hidden sm:block">
            <div className="flex items-center bg-[var(--bg-main)] border border-[var(--border-subtle)] rounded-[4px] px-2 py-1 w-40 md:w-52 focus-within:border-[var(--border-focus)] transition-colors">
              <Search className="w-3.5 h-3.5 text-[var(--text-muted)] mr-1.5 shrink-0" />
              <input
                type="text"
                placeholder="Callsign, reg of IATA..."
                value={searchQuery}
                onChange={(e) => {
                  onSearchChange(e.target.value);
                  setIsSearchOpen(true);
                }}
                onFocus={() => setIsSearchOpen(true)}
                onBlur={() => setTimeout(() => setIsSearchOpen(false), 180)}
                className="bg-transparent text-xs text-[var(--text-main)] placeholder:text-[var(--text-dim)] focus:outline-none w-full"
              />
            </div>

            {isSearchOpen && quickMatches.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] rounded-[5px] shadow-2xl py-1 z-50 max-h-64 overflow-y-auto text-[var(--text-main)]">
                {quickMatches.map(({ passage }) => (
                  <button
                    key={passage.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onSelectPassage(passage.id);
                      setIsSearchOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-[var(--bg-card-hover)] transition-colors flex items-center justify-between text-xs border-b border-[var(--border-subtle)] last:border-b-0 tabular-nums cursor-pointer"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="font-bold text-[var(--accent-gold)] font-mono truncate">
                        {passage.callsign || passage.registration || passage.icao24.toUpperCase()}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] truncate">
                        {passage.operator_name || passage.model_name || 'Onbekend toestel'}
                      </div>
                    </div>
                    <span className="font-mono text-[var(--text-muted)] text-[11px] shrink-0">
                      {passage.dep_iata && passage.arr_iata
                        ? `${passage.dep_iata}→${passage.arr_iata}`
                        : passage.max_alt_m !== null
                        ? `${passage.max_alt_m} m`
                        : '—'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Echt Live vs Preview (Demo) */}
          <button
            type="button"
            onClick={() => onToggleFeedMode(feedMode === 'live' ? 'demo' : 'live')}
            className={`px-2.5 py-1 rounded-[4px] border transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer text-[11px] font-semibold ${
              feedMode === 'live'
                ? 'bg-[var(--bg-main)] text-[var(--status-emerald)] border-[var(--border-subtle)] hover:bg-[var(--bg-card-hover)]'
                : 'bg-[var(--accent-gold-glow)] text-[var(--accent-gold-bright)] border-[var(--accent-gold)]'
            }`}
            title="Wissel tussen echte 10s ADS-B feed boven GM1708 en Preview-simulatie"
          >
            {feedMode === 'live' ? (
              <Radio className="w-3 h-3 text-[var(--status-emerald)]" />
            ) : (
              <ToggleRight className="w-3 h-3 text-[var(--accent-gold)]" />
            )}
            <span>{feedMode === 'live' ? 'Echt Live' : 'Preview'}</span>
          </button>

          {/* Handmatig verversen */}
          <button
            type="button"
            onClick={onManualRefresh}
            disabled={isSyncing}
            className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-main)] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] border border-[var(--border-subtle)] rounded-[4px] transition-colors cursor-pointer"
            title="Ververs radargegevens nu"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-[var(--accent-gold)]' : ''}`}
            />
          </button>

          {/* Insluiten */}
          {onOpenEmbedModal && !isEmbed && (
            <button
              type="button"
              onClick={onOpenEmbedModal}
              className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] text-[var(--text-main)] border border-[var(--border-subtle)] hover:border-[var(--border-focus)] text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap"
              title="Insluiten als interactief dataproduct in nieuwsberichten (HTML/Iframe)"
            >
              <Code2 className="w-3.5 h-3.5 text-[var(--accent-gold)]" />
              <span>Insluiten (&lt;/&gt;)</span>
            </button>
          )}

          {isEmbed && (
            <a
              href="/"
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 rounded-[4px] bg-[var(--bg-main)] hover:bg-[var(--bg-card-hover)] text-[var(--accent-gold-bright)] border border-[var(--border-subtle)] hover:border-[var(--border-focus)] text-[11px] font-semibold transition-colors flex items-center gap-1 whitespace-nowrap"
              title="Open volledig scherm in nieuw tabblad"
            >
              <ExternalLink className="w-3 h-3" />
              <span className="hidden xs:inline">Volledig scherm</span>
            </a>
          )}
        </div>
      </div>

      {/* Onderste rij: Navigatiestrip & Feed-gezondheid */}
      <nav
        aria-label="Hoofdnavigatie luchtverkeer radar"
        className="px-2.5 md:px-4 py-1.5 bg-[var(--bg-main)] flex items-center justify-between gap-2 overflow-x-auto no-scrollbar text-xs font-medium text-[var(--text-main)]"
      >
        <div className="flex items-center gap-1.5 shrink-0">
          {/* 1. LIVE RADAR */}
          <button
            type="button"
            onClick={() => onChangeMode('live')}
            className={`px-2.5 py-1.5 rounded-[4px] border transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer font-semibold shrink-0 ${
              mode === 'live'
                ? 'bg-[var(--bg-elevated)] text-[var(--accent-gold-bright)] border-[var(--border-focus)]'
                : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-main)]'
            }`}
            title="Live 10-seconden radar boven Gemeente Steenwijkerland"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                mode === 'live' ? 'bg-[var(--status-emerald)] animate-pulse' : 'bg-[var(--text-dim)]'
              }`}
            />
            <Plane className="w-3.5 h-3.5 text-[var(--accent-gold)]" />
            <span>Live Radar</span>
          </button>

          {/* 2. HISTORIE TERUGKIJKEN */}
          <button
            type="button"
            onClick={() => onChangeMode('history')}
            className={`px-2.5 py-1.5 rounded-[4px] border transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer font-semibold shrink-0 ${
              mode === 'history'
                ? 'bg-[var(--bg-elevated)] text-[var(--accent-gold-bright)] border-[var(--border-focus)]'
                : 'bg-[var(--bg-card)] text-[var(--text-muted)] border-[var(--border-subtle)] hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-main)]'
            }`}
            title="Kijk historische vluchten en routes terug per uur, dag of week"
          >
            <History className="w-3.5 h-3.5 text-[var(--status-blue)]" />
            <span>Historie terugkijken</span>
          </button>

          {/* 3. Passages & Filters zijpaneel (gouden primaire actieknop in huisstijl) */}
          <button
            type="button"
            onClick={onToggleFilterSidebar}
            className={`px-2.5 py-1.5 rounded-[4px] border transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer font-bold tabular-nums shrink-0 ${
              isFilterOpen
                ? 'bg-[var(--accent-gold-bright)] text-[#060e0a] border-[var(--accent-gold-bright)]'
                : 'bg-[var(--accent-gold)] hover:bg-[var(--accent-gold-bright)] text-[#060e0a] border-[var(--accent-gold-bright)]'
            }`}
            title="Open of sluit filters (hoogte, verkeerstype) en passagelijst"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>
              Filters &amp; Passages ({mode === 'history' ? totalMatchedCount : passages.length})
            </span>
          </button>

          {/* 4. Luchtverkeer Statistieken (.CSV) */}
          <button
            type="button"
            onClick={onOpenStatsModal}
            className="px-2.5 py-1.5 rounded-[4px] bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] text-[var(--text-main)] border border-[var(--border-subtle)] hover:border-[var(--border-focus)] transition-colors whitespace-nowrap flex items-center gap-1.5 cursor-pointer font-semibold tabular-nums shrink-0"
            title="Bekijk statistieken per categorie, operator en tijdvak + CSV-export"
          >
            <BarChart3 className="w-3.5 h-3.5 text-[var(--status-emerald)]" />
            <span>Luchtverkeer Statistieken (.CSV)</span>
          </button>
        </div>

        {/* Rechter feed-status indicator */}
        <div className="hidden lg:flex items-center gap-2 text-[11px] font-mono tabular-nums shrink-0">
          {health.last_error && feedMode === 'live' && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 rounded-[4px] bg-[var(--status-crimson)]/15 border border-[var(--status-crimson)]/40 text-[var(--status-crimson)] max-w-[230px] truncate"
              title={health.last_error}
            >
              <AlertTriangle className="w-3 h-3 shrink-0" />
              <span className="truncate">{health.last_error}</span>
            </span>
          )}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-[4px] bg-[var(--bg-card)] border border-[var(--border-subtle)] text-[var(--text-muted)]">
            <span>
              Feed:{' '}
              <strong className="text-[var(--text-main)]">{health.active_feed_source}</strong>
            </span>
            <span className="text-[var(--border-focus)]">·</span>
            <span>
              In radius:{' '}
              <strong className="text-[var(--text-main)]">{health.aircraft_in_radius}</strong>
            </span>
            <span className="text-[var(--border-focus)]">·</span>
            <span>
              In GM1708:{' '}
              <strong className="text-[var(--accent-gold-bright)]">
                {health.aircraft_in_gm1708}
              </strong>
            </span>
            {mode === 'live' && (health.approaching_in_neighbors ?? approachingPassages.length) > 0 && (
              <>
                <span className="text-[var(--border-focus)]">·</span>
                <span title="Puur visueel vanuit directe buurgemeenten (nog niet in GM1708 meting/CSV)">
                  Nadert:{' '}
                  <strong className="text-[var(--status-blue)]">
                    {health.approaching_in_neighbors ?? approachingPassages.length}
                  </strong>
                </span>
              </>
            )}
            {health.last_success_at && (
              <>
                <span className="text-[var(--border-focus)]">·</span>
                <span>Poll: {formatTimeNL(health.last_success_at, true)}</span>
              </>
            )}
          </div>
        </div>
      </nav>
    </header>
  );
};
