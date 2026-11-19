import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDocFromServer,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  limit,
  onSnapshot,
  serverTimestamp,
  Unsubscribe,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { PunctualityLogEntry, sanitizeLogId } from './utils/punctuality';
import { PassageWithTrack, PositionPoint, RouteStatus, TrafficCategory } from './types/radar';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Validate connection to Firestore on boot as required
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function signInWithGoogle(): Promise<User | null> {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export { onAuthStateChanged };
export type { User };

function clampStr(val: string | null | undefined, maxLen: number, fallback = '-'): string {
  const trimmed = (val || '').trim();
  if (!trimmed) return fallback.slice(0, maxLen);
  return trimmed.slice(0, maxLen);
}

function clampCoord(val: number | null | undefined, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampAltM(val: number | null | undefined): number {
  if (val === null || val === undefined) return -999;
  const n = Number(val);
  if (!Number.isFinite(n)) return -999;
  return Math.max(-500, Math.min(50000, Math.round(n)));
}

function samplePositionsForFirestore(
  passageLat: number,
  passageLon: number,
  entryTimeIso: string,
  positions: PositionPoint[]
): Array<Record<string, number | string | boolean>> {
  const valid = (positions || []).filter(
    (pt) => Number.isFinite(pt?.t) && Number.isFinite(pt?.lat) && Number.isFinite(pt?.lon)
  );
  let source = valid;
  if (source.length > 350) {
    const sampled: PositionPoint[] = [];
    const step = (source.length - 1) / 349;
    for (let i = 0; i < 350; i++) {
      sampled.push(source[Math.min(source.length - 1, Math.round(i * step))]);
    }
    source = sampled;
  }
  if (source.length === 0) {
    const tMs = new Date(entryTimeIso).getTime() || Date.now();
    source = [
      {
        t: tMs,
        lat: passageLat,
        lon: passageLon,
        alt_m: null,
        alt_ft: null,
        alt_baro_m: null,
        alt_baro_ft: null,
        alt_geom_m: null,
        alt_geom_ft: null,
        on_ground: false,
        gs: null,
        track: null,
        vrate: null,
        src: 'adsb_icao',
      },
    ];
  }
  return source.map((pt) => ({
    t: Math.round(pt.t),
    lat: Math.round(clampCoord(pt.lat, -90, 90, passageLat) * 1_000_000) / 1_000_000,
    lon: Math.round(clampCoord(pt.lon, -180, 180, passageLon) * 1_000_000) / 1_000_000,
    altM: clampAltM(pt.alt_m),
    gs: pt.gs !== null && Number.isFinite(pt.gs) ? Math.round(pt.gs) : -1,
    track: pt.track !== null && Number.isFinite(pt.track) ? Math.round(pt.track) : -1,
    src: clampStr(pt.src, 16, 'adsb_icao'),
  }));
}

/**
 * Sanitizes and syncs PunctualityLogEntry items to Firestore (`/punctualityLogs/{logId}`)
 * strictly adhering to the blueprint and security rules.
 */
export async function syncPunctualityLogsToFirestore(
  entries: PunctualityLogEntry[],
  maxBatchCount = 40
): Promise<number> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return 0;

  const ownerId = sanitizeLogId(user.uid);
  const slice = entries.slice(0, maxBatchCount);
  let synced = 0;

  for (const entry of slice) {
    const safeId = sanitizeLogId(`${ownerId}_${entry.id}`);
    const docPath = `punctualityLogs/${safeId}`;
    const docRef = doc(db, 'punctualityLogs', safeId);

    const status = ['ontime', 'delayed', 'early', 'cancelled'].includes(entry.status)
      ? entry.status
      : 'ontime';
    const delayMinutes = Math.max(-120, Math.min(600, Number(entry.delayMinutes) || 0));
    const isoYear = Math.max(2020, Math.min(2100, Number(entry.isoYear) || 2026));
    const isoWeek = Math.max(1, Math.min(53, Number(entry.isoWeek) || 1));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : '2026-10-18';
    const yearMonth = /^\d{4}-\d{2}$/.test(entry.yearMonth) ? entry.yearMonth : '2026-10';
    const yearWeek = /^\d{4}-W\d{2}$/.test(entry.yearWeek) ? entry.yearWeek : '2026-W42';

    try {
      const existingSnap = await getDoc(docRef);
      if (!existingSnap.exists()) {
        try {
          await setDoc(docRef, {
            id: safeId,
            ownerId,
            timestamp: clampStr(entry.timestamp, 64, new Date().toISOString()),
            date,
            yearMonth,
            isoYear,
            isoWeek,
            yearWeek,
            stopId: clampStr(entry.stopId, 64, 'swk-halte-1'),
            stopCode: clampStr(entry.stopCode, 64, 'NL:S:16301010'),
            stopName: clampStr(entry.stopName, 120, 'Halte'),
            town: clampStr(entry.town, 80, 'Steenwijk'),
            line: clampStr(entry.line, 16, '26'),
            operator: clampStr(entry.operator, 64, 'RRReis'),
            destination: clampStr(entry.destination, 120, 'Steenwijk'),
            journeyId: clampStr(entry.journeyId, 80, 'RIT-1'),
            plannedTime: clampStr(entry.plannedTime, 16, '08:00'),
            actualTime: clampStr(entry.actualTime, 32, '08:00'),
            delayMinutes,
            status,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          synced++;
        } catch (writeErr) {
          handleFirestoreError(writeErr, OperationType.CREATE, docPath);
        }
      } else {
        const existingData = existingSnap.data();
        if (
          existingData.status !== status ||
          existingData.delayMinutes !== delayMinutes ||
          existingData.actualTime !== entry.actualTime
        ) {
          try {
            await updateDoc(docRef, {
              timestamp: clampStr(entry.timestamp, 64, new Date().toISOString()),
              actualTime: clampStr(entry.actualTime, 32, '08:00'),
              delayMinutes,
              status,
              updatedAt: serverTimestamp(),
            });
            synced++;
          } catch (updErr) {
            handleFirestoreError(updErr, OperationType.UPDATE, docPath);
          }
        }
      }
    } catch (getErr) {
      handleFirestoreError(getErr, OperationType.GET, docPath);
    }
  }

  return synced;
}

/**
 * Subscribes to the current user's punctualityLogs in Firestore using a scoped `where('ownerId', '==', uid)` query.
 */
export function subscribeUserPunctualityLogs(
  uid: string,
  onLogs: (logs: PunctualityLogEntry[]) => void
): Unsubscribe {
  const safeOwnerId = sanitizeLogId(uid);
  const q = query(collection(db, 'punctualityLogs'), where('ownerId', '==', safeOwnerId), limit(100));

  return onSnapshot(
    q,
    (snapshot) => {
      const items: PunctualityLogEntry[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        items.push({
          id: String(d.id || docSnap.id),
          timestamp: String(d.timestamp || ''),
          date: String(d.date || ''),
          yearMonth: String(d.yearMonth || ''),
          isoYear: Number(d.isoYear || 2026),
          isoWeek: Number(d.isoWeek || 1),
          yearWeek: String(d.yearWeek || ''),
          stopId: String(d.stopId || ''),
          stopCode: String(d.stopCode || ''),
          stopName: String(d.stopName || ''),
          town: String(d.town || ''),
          line: String(d.line || ''),
          operator: String(d.operator || ''),
          destination: String(d.destination || ''),
          journeyId: String(d.journeyId || ''),
          plannedTime: String(d.plannedTime || ''),
          actualTime: String(d.actualTime || ''),
          delayMinutes: Number(d.delayMinutes || 0),
          status: (d.status as PunctualityLogEntry['status']) || 'ontime',
        });
      });
      onLogs(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, 'punctualityLogs');
    }
  );
}

/**
 * Syncs real GM1708 PassageWithTrack items to Firestore (`/flightPassages/{docId}`).
 */
export async function syncFlightPassagesToFirestore(
  items: PassageWithTrack[],
  maxBatchCount = 50
): Promise<number> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return 0;

  const ownerId = sanitizeLogId(user.uid);
  const validItems = items
    .filter(
      (it) =>
        it?.passage?.id &&
        it.passage.icao24 &&
        !it.passage.visual_only &&
        !it.passage.id.startsWith('demo-') &&
        !it.passage.id.startsWith('approach-')
    )
    .slice(0, maxBatchCount);

  let synced = 0;

  for (const item of validItems) {
    const p = item.passage;
    const safePassageId = sanitizeLogId(p.id).slice(0, 80);
    const safeId = sanitizeLogId(`${ownerId}_${safePassageId}`).slice(0, 128);
    const docPath = `flightPassages/${safeId}`;
    const docRef = doc(db, 'flightPassages', safeId);

    const entryLat = clampCoord(p.entry_lat, -90, 90, 52.787);
    const entryLon = clampCoord(p.entry_lon, -180, 180, 6.12);
    const exitLat = clampCoord(p.exit_lat, -90, 90, entryLat);
    const exitLon = clampCoord(p.exit_lon, -180, 180, entryLon);
    const minAltM = clampAltM(p.min_alt_m);
    const maxAltM = clampAltM(p.max_alt_m);
    const pointCount = Math.max(1, Math.min(50000, Math.round(p.point_count || item.positions.length || 1)));

    const trafficCategory: TrafficCategory = [
      'commercial',
      'general_aviation',
      'hems_police_sar',
      'military',
      'unknown',
    ].includes(p.traffic_category)
      ? p.traffic_category
      : 'unknown';

    const routeStatus: RouteStatus = [
      'enriched',
      'partial_route_only',
      'not_applicable_vfr_mil',
      'quota_skipped',
      'not_found',
      'pending',
    ].includes(p.route_status)
      ? p.route_status
      : 'pending';

    const compactPositions = samplePositionsForFirestore(
      entryLat,
      entryLon,
      p.entry_time,
      item.positions
    );

    const payload = {
      id: safeId,
      ownerId,
      passageId: safePassageId,
      municipalityCode: clampStr(p.municipality_code, 16, 'GM1708'),
      icao24: clampStr(p.icao24.toLowerCase(), 16, '000000').padEnd(4, '0'),
      callsign: clampStr(p.callsign, 24, '-'),
      registration: clampStr(p.registration, 24, '-'),
      icaoTypeCode: clampStr(p.icao_type_code, 16, '-'),
      modelName: clampStr(p.model_name, 120, '-'),
      operatorName: clampStr(p.operator_name, 120, '-'),
      trafficCategory,
      isMilitary: Boolean(p.is_military),
      hasMlat: Boolean(p.has_mlat_positions),
      entryTime: clampStr(p.entry_time, 64, new Date().toISOString()),
      lastSeenTime: clampStr(p.last_seen_time, 64, p.entry_time || new Date().toISOString()),
      exitTime: clampStr(p.exit_time, 64, '-'),
      isActive: Boolean(p.is_active),
      entryLat,
      entryLon,
      exitLat,
      exitLon,
      minAltM,
      maxAltM,
      pointCount,
      depIata: clampStr(p.dep_iata || p.dep_icao, 16, '-'),
      arrIata: clampStr(p.arr_iata || p.arr_icao, 16, '-'),
      routeStatus,
      positions: compactPositions,
    };

    try {
      const existingSnap = await getDoc(docRef);
      if (!existingSnap.exists()) {
        try {
          await setDoc(docRef, {
            ...payload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          synced++;
        } catch (writeErr) {
          handleFirestoreError(writeErr, OperationType.CREATE, docPath);
        }
      } else {
        const ex = existingSnap.data();
        const needsUpdate =
          Number(ex.pointCount || 0) < payload.pointCount ||
          (Boolean(ex.isActive) && !payload.isActive) ||
          (ex.routeStatus === 'pending' && payload.routeStatus !== 'pending');
        if (needsUpdate) {
          try {
            await updateDoc(docRef, {
              callsign: payload.callsign,
              registration: payload.registration,
              icaoTypeCode: payload.icaoTypeCode,
              modelName: payload.modelName,
              operatorName: payload.operatorName,
              trafficCategory: payload.trafficCategory,
              isMilitary: payload.isMilitary,
              hasMlat: payload.hasMlat,
              lastSeenTime: payload.lastSeenTime,
              exitTime: payload.exitTime,
              isActive: payload.isActive,
              exitLat: payload.exitLat,
              exitLon: payload.exitLon,
              minAltM: payload.minAltM,
              maxAltM: payload.maxAltM,
              pointCount: payload.pointCount,
              depIata: payload.depIata,
              arrIata: payload.arrIata,
              routeStatus: payload.routeStatus,
              positions: payload.positions,
              updatedAt: serverTimestamp(),
            });
            synced++;
          } catch (updErr) {
            handleFirestoreError(updErr, OperationType.UPDATE, docPath);
          }
        }
      }
    } catch (getErr) {
      handleFirestoreError(getErr, OperationType.GET, docPath);
    }
  }

  return synced;
}

/**
 * Fetches all FlightPassageArchive documents belonging to the authenticated user.
 */
export async function fetchUserFlightPassagesFromFirestore(uid: string): Promise<PassageWithTrack[]> {
  const safeOwnerId = sanitizeLogId(uid);
  const q = query(
    collection(db, 'flightPassages'),
    where('ownerId', '==', safeOwnerId),
    limit(500)
  );

  try {
    const snapshot = await getDocs(q);
    const restored: PassageWithTrack[] = [];
    snapshot.forEach((docSnap) => {
      const d = docSnap.data();
      const unDash = (val: unknown) => {
        const s = String(val ?? '').trim();
        return s && s !== '-' ? s : null;
      };
      const minAltM = Number(d.minAltM) === -999 ? null : Number(d.minAltM);
      const maxAltM = Number(d.maxAltM) === -999 ? null : Number(d.maxAltM);
      const rawPositions = Array.isArray(d.positions) ? d.positions : [];
      const positions: PositionPoint[] = rawPositions
        .filter((pt: any) => Number.isFinite(pt?.t) && Number.isFinite(pt?.lat) && Number.isFinite(pt?.lon))
        .map((pt: any) => {
          const altM = pt.altM !== undefined && Number(pt.altM) !== -999 ? Number(pt.altM) : null;
          const altFt = altM !== null ? Math.round(altM * 3.28084) : null;
          return {
            t: Number(pt.t),
            lat: Number(pt.lat),
            lon: Number(pt.lon),
            alt_m: altM,
            alt_ft: altFt,
            alt_baro_m: altM,
            alt_baro_ft: altFt,
            alt_geom_m: null,
            alt_geom_ft: null,
            on_ground: false,
            gs: pt.gs !== undefined && Number(pt.gs) >= 0 ? Number(pt.gs) : null,
            track: pt.track !== undefined && Number(pt.track) >= 0 ? Number(pt.track) : null,
            vrate: null,
            src: String(pt.src || 'adsb_icao'),
          };
        });

      restored.push({
        passage: {
          id: String(d.passageId || docSnap.id),
          municipality_code: String(d.municipalityCode || 'GM1708'),
          icao24: String(d.icao24 || ''),
          callsign: unDash(d.callsign),
          flight_number_iata: null,
          registration: unDash(d.registration),
          icao_type_code: unDash(d.icaoTypeCode),
          model_name: unDash(d.modelName),
          operator_name: unDash(d.operatorName),
          traffic_category: (d.trafficCategory as TrafficCategory) || 'unknown',
          adsb_category: null,
          is_military: Boolean(d.isMilitary),
          has_mlat_positions: Boolean(d.hasMlat),
          entry_time: String(d.entryTime || new Date().toISOString()),
          last_seen_time: String(d.lastSeenTime || d.entryTime || new Date().toISOString()),
          exit_time: unDash(d.exitTime),
          is_active: Boolean(d.isActive),
          entry_lat: Number(d.entryLat || 52.787),
          entry_lon: Number(d.entryLon || 6.12),
          exit_lat: Number.isFinite(Number(d.exitLat)) ? Number(d.exitLat) : null,
          exit_lon: Number.isFinite(Number(d.exitLon)) ? Number(d.exitLon) : null,
          min_alt_m: minAltM,
          max_alt_m: maxAltM,
          min_alt_ft: minAltM !== null ? Math.round(minAltM * 3.28084) : null,
          max_alt_ft: maxAltM !== null ? Math.round(maxAltM * 3.28084) : null,
          point_count: Number(d.pointCount || positions.length || 1),
          dep_icao: null,
          dep_iata: unDash(d.depIata),
          dep_airport_name: null,
          arr_icao: null,
          arr_iata: unDash(d.arrIata),
          arr_airport_name: null,
          scheduled_departure: null,
          actual_departure: null,
          scheduled_arrival: null,
          estimated_arrival: null,
          route_status: (d.routeStatus as RouteStatus) || 'pending',
          enrichment_source: 'firebase_cloud_backup',
        },
        positions,
      });
    });
    return restored;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'flightPassages');
  }
}

