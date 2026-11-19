import { useCallback, useEffect, useRef, useState } from 'react';
import { FeedMode, PassageWithTrack } from '../types/radar';
import {
  getAllLocalPassages,
  getLocalBackupCount,
  isRealHistoricalItem,
  upsertLocalPassages,
} from '../lib/localHistoryStore';
import {
  auth,
  fetchUserFlightPassagesFromFirestore,
  onAuthStateChanged,
  signInWithGoogle,
  signOutFirebase,
  syncFlightPassagesToFirestore,
  User,
} from '../firebase';

interface BackupIdsResponse {
  total: number;
  ids: string[];
}

interface BackupFullResponse {
  total: number;
  passages: PassageWithTrack[];
}

async function restorePassagesToServerInBatches(items: PassageWithTrack[]): Promise<number> {
  const valid = items.filter(isRealHistoricalItem);
  if (valid.length === 0) return 0;

  let totalRestored = 0;
  const BATCH_SIZE = 40;
  for (let i = 0; i < valid.length; i += BATCH_SIZE) {
    const chunk = valid.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch('/api/radar/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passages: chunk }),
      });
      if (res.ok) {
        const json = await res.json();
        totalRestored += Number(json?.restored || 0);
      }
    } catch {
      // Retry on next cycle if transient network glitch
    }
  }
  return totalRestored;
}

export function useHistorySync(
  feedMode: FeedMode,
  livePassages: PassageWithTrack[]
) {
  const [localArchiveCount, setLocalArchiveCount] = useState<number>(0);
  const [historyVersion, setHistoryVersion] = useState<number>(0);
  const [cloudUser, setCloudUser] = useState<User | null>(() => auth.currentUser);
  const [cloudSyncedCount, setCloudSyncedCount] = useState<number>(0);
  const [isCloudSyncing, setIsCloudSyncing] = useState<boolean>(false);
  const [cloudError, setCloudError] = useState<string | null>(null);

  const initialBootDoneRef = useRef(false);
  const cloudSyncedUidRef = useRef<string | null>(null);
  const lastLiveSaveSignatureRef = useRef<string>('');

  // Subscribe to Firebase auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCloudUser(user);
      if (!user) {
        cloudSyncedUidRef.current = null;
        setCloudSyncedCount(0);
      }
    });
    return () => unsub();
  }, []);

  // Bidirectional IndexedDB <-> Server SQLite reconcile on boot & periodic mirror
  const reconcileLocalAndServer = useCallback(async () => {
    if (feedMode !== 'live') return;

    try {
      const [localPassages, idsRes] = await Promise.all([
        getAllLocalPassages(),
        fetch('/api/radar/backup?idsOnly=1').then((r) =>
          r.ok ? (r.json() as Promise<BackupIdsResponse>) : null
        ),
      ]);

      setLocalArchiveCount(localPassages.length);

      if (!idsRes) return;
      const serverIds = new Set(idsRes.ids || []);
      const localIds = new Set(localPassages.map((p) => p.passage.id));

      // 1. Restore any local passages missing from server (e.g. after container rebuild / prompt sync)
      const missingOnServer = localPassages.filter((item) => !serverIds.has(item.passage.id));
      if (missingOnServer.length > 0) {
        const restored = await restorePassagesToServerInBatches(missingOnServer);
        if (restored > 0) {
          setHistoryVersion((v) => v + 1);
        }
      }

      // 2. Pull any server passages missing in IndexedDB (or update newly closed ones)
      const missingLocally = (idsRes.ids || []).some((id) => !localIds.has(id));
      if (missingLocally || (idsRes.total > localPassages.length && idsRes.total > 0)) {
        const fullRes = await fetch('/api/radar/backup');
        if (fullRes.ok) {
          const data = (await fullRes.json()) as BackupFullResponse;
          if (Array.isArray(data.passages) && data.passages.length > 0) {
            await upsertLocalPassages(data.passages);
            const updatedCount = await getLocalBackupCount();
            setLocalArchiveCount(updatedCount);
          }
        }
      }
    } catch {
      // Non-fatal: server might still be starting up
    }
  }, [feedMode]);

  useEffect(() => {
    if (feedMode !== 'live') return;
    if (!initialBootDoneRef.current) {
      initialBootDoneRef.current = true;
      reconcileLocalAndServer();
    }
    const timer = setInterval(() => {
      reconcileLocalAndServer();
    }, 30_000);
    return () => clearInterval(timer);
  }, [feedMode, reconcileLocalAndServer]);

  // Continuously mirror live GM1708 passages to browser IndexedDB
  useEffect(() => {
    if (feedMode !== 'live') return;
    const realLive = livePassages.filter(isRealHistoricalItem);
    if (realLive.length === 0) return;

    const sig = realLive
      .map((item) => `${item.passage.id}:${item.positions.length}:${item.passage.route_status}`)
      .join('|');
    if (sig === lastLiveSaveSignatureRef.current) return;
    lastLiveSaveSignatureRef.current = sig;

    upsertLocalPassages(realLive).then(async (written) => {
      if (written > 0) {
        const cnt = await getLocalBackupCount();
        setLocalArchiveCount(cnt);
      }
    });
  }, [feedMode, livePassages]);

  // Cloud Sync (Firestore <-> IndexedDB <-> Server SQLite)
  const syncWithCloud = useCallback(async (userOverride?: User | null) => {
    const activeUser = userOverride ?? auth.currentUser;
    if (!activeUser || !activeUser.emailVerified) return;

    setIsCloudSyncing(true);
    setCloudError(null);
    try {
      // Pull from Firestore
      const cloudPassages = await fetchUserFlightPassagesFromFirestore(activeUser.uid);
      if (cloudPassages.length > 0) {
        await upsertLocalPassages(cloudPassages);
        const restored = await restorePassagesToServerInBatches(cloudPassages);
        if (restored > 0) {
          setHistoryVersion((v) => v + 1);
        }
      }

      // Ensure we also pull latest server passages before pushing to Firestore
      try {
        const serverFull = await fetch('/api/radar/backup');
        if (serverFull.ok) {
          const data = (await serverFull.json()) as BackupFullResponse;
          if (Array.isArray(data.passages) && data.passages.length > 0) {
            await upsertLocalPassages(data.passages);
          }
        }
      } catch {}

      const allLocal = await getAllLocalPassages();
      setLocalArchiveCount(allLocal.length);

      if (allLocal.length > 0) {
        await syncFlightPassagesToFirestore(allLocal, 60);
      }
      setCloudSyncedCount(Math.max(cloudPassages.length, allLocal.length));
    } catch (err: any) {
      const msg = err?.message || 'Cloud synchronisatie mislukt';
      setCloudError(msg.length > 140 ? 'Cloud synchronisatie mislukt (controleer rechten).' : msg);
    } finally {
      setIsCloudSyncing(false);
    }
  }, []);

  useEffect(() => {
    if (
      feedMode === 'live' &&
      cloudUser &&
      cloudUser.emailVerified &&
      cloudSyncedUidRef.current !== cloudUser.uid
    ) {
      cloudSyncedUidRef.current = cloudUser.uid;
      syncWithCloud(cloudUser);
    }
  }, [feedMode, cloudUser, syncWithCloud]);

  const signInAndSync = useCallback(async () => {
    setCloudError(null);
    try {
      const u = await signInWithGoogle();
      if (u && u.emailVerified) {
        cloudSyncedUidRef.current = u.uid;
        await syncWithCloud(u);
      }
    } catch (err: any) {
      setCloudError(err?.message || 'Inloggen met Google geannuleerd of mislukt.');
    }
  }, [syncWithCloud]);

  const signOutCloud = useCallback(async () => {
    await signOutFirebase();
    cloudSyncedUidRef.current = null;
    setCloudSyncedCount(0);
    setCloudError(null);
  }, []);

  return {
    localArchiveCount,
    historyVersion,
    cloudUser,
    cloudSyncedCount,
    isCloudSyncing,
    cloudError,
    signInAndSync,
    signOutCloud,
    syncNow: () => syncWithCloud(cloudUser),
  };
}
