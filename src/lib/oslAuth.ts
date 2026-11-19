import { FeedMode, StatsPeriod } from '../types/radar';

export const OSL_ISSUER = 'https://onafhankelijksteenwijkerland.nl';
export const OSL_AUTHORIZE_URL = `${OSL_ISSUER}/authorize`;
export const OSL_TOKEN_ENDPOINT = `${OSL_ISSUER}/api/auth/token`;
export const OSL_LOGOUT_UI_URL = `${OSL_ISSUER}/sso/logout`;
export const OSL_CLIENT_ID = 'vliegverkeer-radar';
export const OSL_SCOPES = 'openid profile email export:csv export:json';

export type ExportFormat = 'csv' | 'json';

export interface PendingDatasetExport {
  format: ExportFormat;
  period: StatsPeriod;
  weekKey: string | null;
  feedMode: FeedMode;
}

export interface OslUserProfile {
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
}

export interface OslAuthSession {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at_ms: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  user?: OslUserProfile | null;
}

export interface OslPkceTransaction {
  codeVerifier: string;
  state: string;
  redirectUri: string;
  createdAtMs: number;
  pendingExport: PendingDatasetExport | null;
}

const SESSION_STORAGE_KEY = 'osl_auth_session_v1';
const PKCE_STORAGE_KEY = 'osl_pkce_tx_v1';

let memorySession: OslAuthSession | null = null;
let memoryPkceTx: OslPkceTransaction | null = null;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkceCodeVerifier(): string {
  const bytes = new Uint8Array(48);
  window.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function generateOAuthState(): string {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function generatePkceChallengeS256(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', encoded);
  return toBase64Url(new Uint8Array(digest));
}

export function getOslRedirectUri(): string {
  if (typeof window !== 'undefined') {
    const { protocol, hostname, origin } = window.location;
    if (
      protocol === 'https:' &&
      (hostname === 'onafhankelijksteenwijkerland.nl' ||
        hostname.endsWith('.onafhankelijksteenwijkerland.nl') ||
        hostname === 'scientiarum.nl' ||
        hostname.endsWith('.scientiarum.nl'))
    ) {
      return `${origin}/sso/callback`;
    }
  }
  return 'https://vliegverkeer.onafhankelijksteenwijkerland.nl/sso/callback';
}

export function decodeJwtPayload<T = Record<string, any>>(token?: string | null): T | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = decodeURIComponent(
      atob(b64 + pad)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')
    );
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function savePkceTransaction(tx: OslPkceTransaction) {
  memoryPkceTx = tx;
  try {
    window.sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(tx));
  } catch {
    // In sommige sandboxed iframes kan sessionStorage geblokkeerd zijn; memory fallback blijft werken
  }
}

export function loadPkceTransaction(): OslPkceTransaction | null {
  if (memoryPkceTx) return memoryPkceTx;
  try {
    const raw = window.sessionStorage.getItem(PKCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OslPkceTransaction;
    if (!parsed?.codeVerifier || !parsed?.state) return null;
    if (Date.now() - Number(parsed.createdAtMs || 0) > 15 * 60_000) {
      clearPkceTransaction();
      return null;
    }
    memoryPkceTx = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPkceTransaction() {
  memoryPkceTx = null;
  try {
    window.sessionStorage.removeItem(PKCE_STORAGE_KEY);
  } catch {}
}

export function saveOslSession(session: OslAuthSession) {
  memorySession = session;
  try {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {}
}

export function loadOslSession(): OslAuthSession | null {
  if (memorySession) return memorySession;
  try {
    const raw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OslAuthSession;
    if (!parsed?.access_token) return null;
    memorySession = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function clearOslSession() {
  memorySession = null;
  try {
    window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {}
}

export function isSessionExpired(session: OslAuthSession | null, skewMs = 30_000): boolean {
  if (!session || !session.access_token) return true;
  if (!session.expires_at_ms) return false;
  return Date.now() >= session.expires_at_ms - skewMs;
}

export function normalizeTokenResponse(raw: any): OslAuthSession {
  if (!raw || typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new Error(raw?.error_description || raw?.error || 'Geen access_token ontvangen van OSL SSO');
  }
  const expiresInSec = Number(raw.expires_in) > 0 ? Number(raw.expires_in) : 3600;
  const jwtClaims =
    decodeJwtPayload<OslUserProfile>(raw.access_token) ||
    decodeJwtPayload<OslUserProfile>(raw.id_token);

  const user: OslUserProfile | null = raw.user
    ? { ...(jwtClaims || {}), ...raw.user }
    : jwtClaims;

  return {
    access_token: raw.access_token,
    token_type: raw.token_type || 'Bearer',
    expires_in: expiresInSec,
    expires_at_ms: Date.now() + expiresInSec * 1000,
    id_token: typeof raw.id_token === 'string' ? raw.id_token : undefined,
    refresh_token: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : OSL_SCOPES,
    user,
  };
}

export async function buildOslAuthorizeUrl(options: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  webMessageMode: boolean;
}): Promise<string> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OSL_CLIENT_ID,
    redirect_uri: options.redirectUri,
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    scope: OSL_SCOPES,
  });
  if (options.webMessageMode) {
    params.set('response_mode', 'web_message');
  }
  return `${OSL_AUTHORIZE_URL}?${params.toString()}`;
}

async function postOslTokenRequest(payload: Record<string, string>): Promise<any> {
  const endpoints = ['/api/auth/osl/token', OSL_TOKEN_ENDPOINT];
  let lastError = 'OSL token-omwisseling mislukt';

  for (let i = 0; i < endpoints.length; i++) {
    const url = endpoints[i];
    const hasFallback = i < endpoints.length - 1;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (netErr: any) {
      if (hasFallback) continue;
      throw new Error(netErr?.message || lastError);
    }

    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      return json;
    }

    // Als de lokale proxy-route niet aanwezig/bereikbaar is (404/405/502/503/504),
    // val direct terug op het CORS-ondersteunde OSL token endpoint.
    if (hasFallback && (res.status === 404 || res.status === 405 || res.status >= 500)) {
      continue;
    }

    lastError =
      json?.error_description ||
      json?.error ||
      `OSL token-omwisseling mislukt (HTTP ${res.status})`;
    throw new Error(lastError);
  }

  throw new Error(lastError);
}

export async function exchangeOslAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OslAuthSession> {
  const json = await postOslTokenRequest({
    grant_type: 'authorization_code',
    client_id: OSL_CLIENT_ID,
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });
  const session = normalizeTokenResponse(json);
  saveOslSession(session);
  return session;
}

export async function refreshOslAccessToken(refreshToken: string): Promise<OslAuthSession> {
  const json = await postOslTokenRequest({
    grant_type: 'refresh_token',
    client_id: OSL_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const session = normalizeTokenResponse(json);
  saveOslSession(session);
  return session;
}

export function buildOslLogoutUiUrl(returnUrl?: string): string {
  const target =
    returnUrl ||
    (typeof window !== 'undefined'
      ? `${window.location.origin}/`
      : 'https://vliegverkeer.onafhankelijksteenwijkerland.nl/');
  return `${OSL_LOGOUT_UI_URL}?redirect_uri=${encodeURIComponent(target)}`;
}
