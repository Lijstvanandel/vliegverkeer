import { useEffect, useState } from 'react';
import {
  AdjacentBoundariesCollection,
  MunicipalityBoundaryFeature,
} from '../types/radar';
import { FALLBACK_GM1708_BOUNDARY } from '../lib/mockData';
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient';

const PDOK_DIRECT_URL =
  'https://api.pdok.nl/kadaster/brk-bestuurlijke-gebieden/ogc/v1/collections/gemeentegebied/items?identificatie=GM1708';

export function useMunicipalityBoundary() {
  const [boundary, setBoundary] = useState<MunicipalityBoundaryFeature>(FALLBACK_GM1708_BOUNDARY);
  const [adjacentBoundaries, setAdjacentBoundaries] = useState<AdjacentBoundariesCollection>({
    type: 'FeatureCollection',
    features: [],
  });
  const [source, setSource] = useState<'local' | 'api' | 'supabase' | 'pdok'>('local');
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    async function loadBoundary() {
      setIsLoading(true);
      try {
        // Laad direct aangrenzende buurgemeenten (7 stuks) voor visuele vooraankondiging
        fetch('/api/radar/adjacent-boundaries')
          .then((r) => (r.ok ? r.json() : null))
          .then((adj) => {
            if (!cancelled && adj?.type === 'FeatureCollection' && Array.isArray(adj.features)) {
              setAdjacentBoundaries(adj);
            }
          })
          .catch(() => {});

        // 1. Probeer Supabase RPC indien geconfigureerd
        if (isSupabaseConfigured && supabase) {
          const { data, error } = await supabase.rpc('get_municipality_boundary', {
            p_code: 'GM1708',
          });
          if (!error && data && !cancelled) {
            const parsed = typeof data === 'string' ? JSON.parse(data) : data;
            if (parsed?.geometry?.coordinates?.length) {
              setBoundary(parsed as MunicipalityBoundaryFeature);
              setSource('supabase');
              setIsLoading(false);
              return;
            }
          }
        }

        // 2. Probeer eigen backend /api/radar/boundary (PDOK gecached in SQLite)
        const apiRes = await fetch('/api/radar/boundary');
        if (apiRes.ok) {
          const apiData: MunicipalityBoundaryFeature = await apiRes.json();
          if (apiData?.geometry?.coordinates?.length && !cancelled) {
            setBoundary(apiData);
            setSource('api');
            setIsLoading(false);
            return;
          }
        }

        // 3. Rechtstreekse PDOK OGC fallback
        const pdokRes = await fetch(PDOK_DIRECT_URL, {
          headers: { Accept: 'application/geo+json, application/json' },
        });
        if (pdokRes.ok) {
          const json: any = await pdokRes.json();
          const f = Array.isArray(json?.features) ? json.features[0] : json;
          const geom = f?.geometry;
          if (geom?.coordinates?.length && !cancelled) {
            const coords =
              geom.type === 'MultiPolygon'
                ? geom.coordinates
                : geom.type === 'Polygon'
                ? [geom.coordinates]
                : null;
            if (coords) {
              setBoundary({
                ...FALLBACK_GM1708_BOUNDARY,
                geometry: { type: 'MultiPolygon', coordinates: coords },
              });
              setSource('pdok');
            }
          }
        }
      } catch {
        // Behoud FALLBACK_GM1708_BOUNDARY
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadBoundary();
    return () => {
      cancelled = true;
    };
  }, []);

  return { boundary, adjacentBoundaries, source, isLoading };
}
