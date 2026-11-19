import React from 'react';
import { Code2, Maximize2, ExternalLink } from 'lucide-react';

interface AttributionFooterProps {
  isEmbed: boolean;
  onOpenEmbedModal: () => void;
}

export const AttributionFooter: React.FC<AttributionFooterProps> = ({
  isEmbed,
  onOpenEmbedModal,
}) => {
  return (
    <footer className="min-h-7 py-1 px-3 bg-[var(--bg-card)] border-t border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-muted)] shrink-0 z-30 tabular-nums">
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-[3px] bg-[var(--accent-gold)] text-[#060e0a] font-extrabold text-[9px] shrink-0">
          LA
        </span>
        <span className="font-bold text-[var(--text-main)] whitespace-nowrap">
          Dataproduct van Lijst van Andel
        </span>
        <span className="hidden lg:inline text-[var(--text-dim)]">·</span>
        <span className="hidden md:inline text-[10px] text-[var(--text-muted)] truncate">
          Luchtvaartdata via{' '}
          <a
            href="https://adsb.fi"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--status-blue)] hover:underline"
          >
            adsb.fi
          </a>{' '}
          / adsb.lol · Gemeentegrenzen via{' '}
          <a
            href="https://www.pdok.nl"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--status-blue)] hover:underline"
          >
            PDOK / CBS (GM1708)
          </a>{' '}
          · Kaart © OpenFreeMap &amp; OpenStreetMap-bijdragers
        </span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {!isEmbed && (
          <button
            type="button"
            onClick={onOpenEmbedModal}
            className="text-[var(--accent-gold)] hover:text-[var(--accent-gold-bright)] font-semibold flex items-center gap-1 cursor-pointer"
          >
            <Code2 className="w-3 h-3" />
            <span>Insluiten</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            if (!document.fullscreenElement) {
              document.documentElement.requestFullscreen?.().catch(() => {});
            } else {
              document.exitFullscreen?.().catch(() => {});
            }
          }}
          className="text-[var(--text-muted)] hover:text-[var(--text-main)] flex items-center gap-1 cursor-pointer"
          title="Schermvullend weergeven"
        >
          <Maximize2 className="w-3 h-3" />
          <span className="hidden sm:inline">Volledig scherm</span>
        </button>

        {isEmbed && (
          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--accent-gold-bright)] hover:underline font-semibold flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" />
            <span>Nieuw venster</span>
          </a>
        )}
      </div>
    </footer>
  );
};
