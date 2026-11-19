import { PassageWithTrack } from '../types/radar';

const DB_NAME = 'swk_radar_history_v1';
const DB_VERSION = 1;
const STORE_NAME = 'passages';

export function isRealHistoricalItem(item: PassageWithTrack | null | undefined): boolean {
  const p = item?.passage;
  if (!p || !p.id || !p.icao24) return false;
  if (p.visual_only) return false;
  if (p.id.startsWith('demo-') || p.id.startsWith('approach-')) return false;
  return true;
}

function openHistoryDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'passage.id' });
          store.createIndex('entry_time', 'passage.entry_time', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function shouldReplaceStored(
  existing: PassageWithTrack | undefined,
  incoming: PassageWithTrack
): boolean {
  if (!existing) return true;
  if (incoming.positions.length > existing.positions.length) return true;
  if (existing.passage.is_active && !incoming.passage.is_active) return true;
  if (
    existing.passage.route_status === 'pending' &&
    incoming.passage.route_status !== 'pending'
  ) {
    return true;
  }
  if ((incoming.passage.point_count || 0) > (existing.passage.point_count || 0)) {
    return true;
  }
  if (!existing.passage.dep_iata && incoming.passage.dep_iata) return true;
  if (!existing.passage.model_name && incoming.passage.model_name) return true;
  return false;
}

export async function upsertLocalPassages(items: PassageWithTrack[]): Promise<number> {
  const valid = items.filter(isRealHistoricalItem);
  if (valid.length === 0) return 0;

  const db = await openHistoryDb();
  if (!db) return 0;

  return new Promise((resolve) => {
    let written = 0;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const item of valid) {
        const getReq = store.get(item.passage.id);
        getReq.onsuccess = () => {
          const existing = getReq.result as PassageWithTrack | undefined;
          if (shouldReplaceStored(existing, item)) {
            try {
              store.put(item);
              written++;
            } catch {
              // Ignore single put error
            }
          }
        };
      }

      tx.oncomplete = () => {
        db.close();
        resolve(written);
      };
      tx.onerror = () => {
        db.close();
        resolve(written);
      };
    } catch {
      db.close();
      resolve(0);
    }
  });
}

export async function getAllLocalPassages(): Promise<PassageWithTrack[]> {
  const db = await openHistoryDb();
  if (!db) return [];

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? (req.result as PassageWithTrack[]) : [];
        const clean = rows.filter(isRealHistoricalItem);
        clean.sort(
          (a, b) =>
            new Date(b.passage.entry_time).getTime() - new Date(a.passage.entry_time).getTime()
        );
        db.close();
        resolve(clean);
      };
      req.onerror = () => {
        db.close();
        resolve([]);
      };
    } catch {
      db.close();
      resolve([]);
    }
  });
}

export async function getLocalBackupCount(): Promise<number> {
  const db = await openHistoryDb();
  if (!db) return 0;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.count();
      req.onsuccess = () => {
        const count = Number(req.result || 0);
        db.close();
        resolve(count);
      };
      req.onerror = () => {
        db.close();
        resolve(0);
      };
    } catch {
      db.close();
      resolve(0);
    }
  });
}
