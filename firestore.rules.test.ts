/**
 * Firestore Security Rules Test Suite for Dirty Dozen Payloads
 */
export interface DirtyDozenTestCase {
  name: string;
  operation: 'create' | 'update' | 'get' | 'list' | 'delete';
  path: string;
  auth: { uid: string; email_verified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_TESTS: DirtyDozenTestCase[] = [
  {
    name: '1. Unauthenticated Write (punctualityLogs)',
    operation: 'create',
    path: '/punctualityLogs/2026-10-18_QBUZZ_26_Steenwijk',
    auth: null,
    payload: { id: '2026-10-18_QBUZZ_26_Steenwijk' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '1b. Unauthenticated Write (flightPassages)',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: null,
    payload: { id: 'user_1_fp123' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '2. Unverified Email Spoof (flightPassages)',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: false },
    payload: { id: 'user_1_fp123', ownerId: 'user_1' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '3. Identity Spoofing on Create',
    operation: 'create',
    path: '/flightPassages/attacker_uid_fp123',
    auth: { uid: 'attacker_uid', email_verified: true },
    payload: { id: 'attacker_uid_fp123', ownerId: 'victim_uid' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '4. Shadow Field Injection on Create',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: { id: 'user_1_fp123', ownerId: 'user_1', ghostField: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '5. ID Poisoning',
    operation: 'create',
    path: '/flightPassages/invalid$id!',
    auth: { uid: 'user_1', email_verified: true },
    payload: { id: 'invalid$id!', ownerId: 'user_1' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '6a. Denial-of-Wallet String Overflow',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: {
      id: 'user_1_fp123',
      ownerId: 'user_1',
      modelName: 'A'.repeat(1000),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '6b. Denial-of-Wallet Positions Array Overflow',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: {
      id: 'user_1_fp123',
      ownerId: 'user_1',
      positions: new Array(400).fill({ t: 1, lat: 52.8, lon: 6.1 }),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '7. Invalid Enum State',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: {
      id: 'user_1_fp123',
      ownerId: 'user_1',
      trafficCategory: 'ufo_invalid',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '8. Client-Forged Timestamp on Create',
    operation: 'create',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: {
      id: 'user_1_fp123',
      ownerId: 'user_1',
      createdAt: '1999-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '9. Ownership Hijack on Update',
    operation: 'update',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: { ownerId: 'user_2' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '10. Unauthorized Field Mutation on Update',
    operation: 'update',
    path: '/flightPassages/user_1_fp123',
    auth: { uid: 'user_1', email_verified: true },
    payload: { icao24: 'deadbe' },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '11. Cross-Tenant Read (get)',
    operation: 'get',
    path: '/flightPassages/other_user_doc',
    auth: { uid: 'user_1', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    name: '12. Unscoped List Scraping (list)',
    operation: 'list',
    path: '/flightPassages',
    auth: { uid: 'user_1', email_verified: true },
    expected: 'PERMISSION_DENIED',
  },
];
