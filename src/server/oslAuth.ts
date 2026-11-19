import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export const OSL_ISSUER = (
  process.env.OSL_SSO_ISSUER || 'https://onafhankelijksteenwijkerland.nl'
).replace(/\/+$/, '');

export const OSL_DISCOVERY_URL = `${OSL_ISSUER}/.well-known/openid-configuration`;
export const OSL_JWKS_URL = `${OSL_ISSUER}/.well-known/jwks.json`;
export const OSL_TOKEN_URL = `${OSL_ISSUER}/api/auth/token`;
export const OSL_VERIFY_URL = `${OSL_ISSUER}/api/auth/verify`;
export const OSL_USERINFO_URL = `${OSL_ISSUER}/api/auth/userinfo`;
export const OSL_LOGOUT_API_URL = `${OSL_ISSUER}/api/auth/logout`;

interface RsaJwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [key: string]: unknown;
}

export interface OslTokenClaims {
  sub?: string;
  id?: string | number;
  username?: string;
  email?: string;
  name?: string;
  role?: string;
  is_member?: boolean;
  membership_state?: string;
  scope?: string;
  scopes?: string[];
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  [key: string]: unknown;
}

export interface OslVerifyResult {
  ok: boolean;
  status: number;
  error?: string;
  claims?: OslTokenClaims;
  scopes?: string[];
  method?: 'jwks' | 'verify_endpoint';
}

const JWKS_TTL_MS = 15 * 60 * 1000;
const JWKS_FORCE_COOLDOWN_MS = 15 * 1000;

let jwksCache: { keys: RsaJwk[]; fetchedAtMs: number } | null = null;
let inFlightJwksPromise: Promise<RsaJwk[]> | null = null;
let lastForcedFetchMs = 0;

async function fetchJwksKeys(forceRefresh = false): Promise<RsaJwk[]> {
  const now = Date.now();
  if (!forceRefresh && jwksCache && now - jwksCache.fetchedAtMs < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  if (forceRefresh && now - lastForcedFetchMs < JWKS_FORCE_COOLDOWN_MS && jwksCache) {
    return jwksCache.keys;
  }

  if (inFlightJwksPromise) {
    return inFlightJwksPromise;
  }

  if (forceRefresh) {
    lastForcedFetchMs = now;
  }

  inFlightJwksPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(OSL_JWKS_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!res.ok) {
        throw new Error(`JWKS HTTP ${res.status}`);
      }
      const data = (await res.json()) as { keys?: RsaJwk[] };
      const keys = Array.isArray(data?.keys)
        ? data.keys.filter((k) => k && k.kty === 'RSA' && k.n && k.e)
        : [];
      if (keys.length > 0) {
        jwksCache = { keys, fetchedAtMs: Date.now() };
      }
      return keys;
    } finally {
      inFlightJwksPromise = null;
    }
  })();

  return inFlightJwksPromise;
}

function decodeBase64UrlJson<T = Record<string, unknown>>(segment: string): T | null {
  try {
    const raw = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function extractScopesFromClaims(claims: OslTokenClaims | undefined | null): string[] {
  if (!claims) return [];
  const set = new Set<string>();
  if (Array.isArray(claims.scopes)) {
    for (const s of claims.scopes) {
      if (typeof s === 'string' && s.trim()) set.add(s.trim());
    }
  }
  if (typeof claims.scope === 'string') {
    for (const s of claims.scope.split(/\s+/)) {
      if (s.trim()) set.add(s.trim());
    }
  }
  return Array.from(set);
}

async function verifyJwtWithJwks(token: string): Promise<{
  outcome: 'valid' | 'invalid_definitive' | 'fallback_needed';
  claims?: OslTokenClaims;
  error?: string;
}> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { outcome: 'fallback_needed' };
  }

  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string; typ?: string }>(headerB64);
  const payload = decodeBase64UrlJson<OslTokenClaims>(payloadB64);

  if (!header || !payload) {
    return { outcome: 'invalid_definitive', error: 'Ongeldig JWT-formaat' };
  }

  if (header.alg !== 'RS256') {
    return { outcome: 'fallback_needed' };
  }

  const iss = typeof payload.iss === 'string' ? payload.iss.replace(/\/+$/, '') : '';
  if (iss && iss !== OSL_ISSUER) {
    return { outcome: 'invalid_definitive', error: 'Onjuiste token issuer' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && nowSec >= payload.exp + 30) {
    return { outcome: 'invalid_definitive', error: 'OSL sessie is verlopen' };
  }
  if (typeof payload.nbf === 'number' && nowSec + 30 < payload.nbf) {
    return { outcome: 'invalid_definitive', error: 'OSL token is nog niet geldig' };
  }

  let keys: RsaJwk[] = [];
  try {
    keys = await fetchJwksKeys(false);
  } catch {
    return { outcome: 'fallback_needed' };
  }

  let candidates = header.kid
    ? keys.filter((k) => k.kid === header.kid)
    : keys.filter((k) => !k.use || k.use === 'sig');

  if (header.kid && candidates.length === 0) {
    try {
      keys = await fetchJwksKeys(true);
      candidates = keys.filter((k) => k.kid === header.kid);
    } catch {
      return { outcome: 'fallback_needed' };
    }
  }

  if (candidates.length === 0) {
    return { outcome: 'fallback_needed' };
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = Buffer.from(sigB64, 'base64url');

  for (const jwk of candidates) {
    try {
      const publicKey = crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
      const verified = crypto.verify('RSA-SHA256', signingInput, publicKey, signature);
      if (verified) {
        return { outcome: 'valid', claims: payload };
      }
    } catch {
      // Probeer eventueel volgende sleutel
    }
  }

  // Als een specifieke kid aanwezig was en zelfs na refresh de handtekening faalt: ongeldig
  if (header.kid) {
    return { outcome: 'invalid_definitive', error: 'Ongeldige RS256 token-handtekening' };
  }
  return { outcome: 'fallback_needed' };
}

async function verifyViaRemoteEndpoint(token: string): Promise<OslVerifyResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(OSL_VERIFY_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!res.ok) {
      return {
        ok: false,
        status: 401,
        error: 'OSL sessie niet geldig of verlopen',
      };
    }

    const data = (await res.json()) as Record<string, any>;
    if (data?.valid === false || data?.active === false) {
      return {
        ok: false,
        status: 401,
        error: 'OSL token is ingetrokken of verlopen',
      };
    }

    const claims: OslTokenClaims = {
      ...(typeof data?.claims === 'object' && data.claims ? data.claims : {}),
      ...(typeof data?.user === 'object' && data.user ? data.user : {}),
      ...(data?.sub ? { sub: data.sub } : {}),
      ...(data?.email ? { email: data.email } : {}),
      ...(data?.name ? { name: data.name } : {}),
      ...(data?.username ? { username: data.username } : {}),
      ...(data?.role ? { role: data.role } : {}),
      ...(data?.scope ? { scope: data.scope } : {}),
      ...(Array.isArray(data?.scopes) ? { scopes: data.scopes } : {}),
    };

    return {
      ok: true,
      status: 200,
      claims,
      scopes: extractScopesFromClaims(claims),
      method: 'verify_endpoint',
    };
  } catch {
    return {
      ok: false,
      status: 401,
      error: 'Kan OSL sessie niet verifiëren',
    };
  }
}

export async function verifyOslAccessToken(
  token: string,
  requiredScope?: string
): Promise<OslVerifyResult> {
  if (!token || !token.trim()) {
    return { ok: false, status: 401, error: 'Geen Bearer token meegegeven' };
  }

  let verifiedResult: OslVerifyResult;
  const jwksAttempt = await verifyJwtWithJwks(token.trim());

  if (jwksAttempt.outcome === 'valid' && jwksAttempt.claims) {
    verifiedResult = {
      ok: true,
      status: 200,
      claims: jwksAttempt.claims,
      scopes: extractScopesFromClaims(jwksAttempt.claims),
      method: 'jwks',
    };
  } else if (jwksAttempt.outcome === 'invalid_definitive') {
    return {
      ok: false,
      status: 401,
      error: jwksAttempt.error || 'Ongeldig OSL token',
    };
  } else {
    verifiedResult = await verifyViaRemoteEndpoint(token.trim());
  }

  if (!verifiedResult.ok) {
    return verifiedResult;
  }

  const scopes = verifiedResult.scopes || [];
  if (requiredScope && scopes.length > 0 && !scopes.includes(requiredScope)) {
    return {
      ok: false,
      status: 403,
      error: `Benodigde export-scope '${requiredScope}' ontbreekt op dit OSL-account`,
    };
  }

  return verifiedResult;
}

export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1]?.trim() || null;
}

export interface AuthenticatedOslRequest extends Request {
  oslUser?: OslTokenClaims;
  oslScopes?: string[];
  oslAuthMethod?: 'jwks' | 'verify_endpoint';
}

export function requireOslExportAuth(requiredScope?: 'export:csv' | 'export:json') {
  return async (req: AuthenticatedOslRequest, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'OSL SSO-login vereist om de dataset te exporteren',
        code: 'auth_required',
        issuer: OSL_ISSUER,
      });
    }

    const result = await verifyOslAccessToken(token, requiredScope);
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error || 'OSL authenticatie vereist',
        code: result.status === 403 ? 'insufficient_scope' : 'invalid_token',
        issuer: OSL_ISSUER,
      });
    }

    req.oslUser = result.claims;
    req.oslScopes = result.scopes;
    req.oslAuthMethod = result.method;
    return next();
  };
}
