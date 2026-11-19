# Security Specification (`security_spec.md`)

## 1. Data Invariants
1. **Global Default-Deny**: Every path not explicitly matched is denied (`allow read, write: if false;`).
2. **Verified Identity**: Only authenticated users with `request.auth != null && request.auth.token.email_verified == true` can read or write `/punctualityLogs/{logId}` and `/flightPassages/{docId}`.
3. **Ownership & Isolation**: Every document's `ownerId` must equal `request.auth.uid` on creation, cannot be mutated during updates (`incoming().ownerId == existing().ownerId`), and `get`/`list`/`delete` operations are restricted to documents where `resource.data.ownerId == request.auth.uid`.
4. **Path & Key Hardening**: Document ID (`{logId}` or `{docId}`) must match `^[a-zA-Z0-9_\-]+$` (1..128 chars) and equal `incoming().id`. No shadow fields are permitted (`hasAll` + `hasOnly`).
5. **Temporal Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update (`incoming().createdAt == existing().createdAt`). `updatedAt` must equal `request.time` on both creation and update.
6. **Bounded Values & Native Arrays**: `status`/`trafficCategory`/`routeStatus` are checked against strict enum allowlists; all numeric bounds (`delayMinutes`, altitudes, lat/lon, `pointCount`) are validated; all strings enforce `.size()`; and `FlightPassageArchive.positions` is strictly validated as a non-empty bounded list (`size() >= 1 && size() <= 350`) with `positions[0] is map` (no JSON string serialization).

## 2. The "Dirty Dozen" Payloads
1. **Unauthenticated Write**: Creating `/punctualityLogs/log_1` or `/flightPassages/fp_1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoof**: Creating `/punctualityLogs/log_1` or `/flightPassages/fp_1` with `email_verified: false` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: Setting `ownerId: "victim_uid"` while authenticated as `"attacker_uid"` -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on Create**: Including an extra ghost field `isAdmin: true` -> `PERMISSION_DENIED`.
5. **ID Poisoning**: Creating `/flightPassages/bad$id!` or mismatched `data.id != docId` -> `PERMISSION_DENIED`.
6. **Denial-of-Wallet String / Array Overflow**: Sending a 5,000-character `modelName` or 500 `positions` elements (exceeds max 350) -> `PERMISSION_DENIED`.
7. **Invalid Enum State**: Setting `trafficCategory: "ufo"` or `status: "hacked"` -> `PERMISSION_DENIED`.
8. **Client-Forged Timestamp on Create**: Setting `createdAt` to a past timestamp instead of `request.time` -> `PERMISSION_DENIED`.
9. **Ownership Hijack on Update**: Modifying `ownerId`, `passageId`, or `createdAt` during an update -> `PERMISSION_DENIED`.
10. **Unauthorized Field Mutation on Update**: Attempting to mutate immutable `icao24` or `entryTime` (or `stopId`/`line` in `punctualityLogs`) during an update -> `PERMISSION_DENIED`.
11. **Cross-Tenant Read (`get`)**: Authenticated user reading a document where `resource.data.ownerId != request.auth.uid` -> `PERMISSION_DENIED`.
12. **Unscoped List Scraping (`list`)**: Listing `/punctualityLogs` or `/flightPassages` without filtering `where('ownerId', '==', request.auth.uid)` -> `PERMISSION_DENIED`.
