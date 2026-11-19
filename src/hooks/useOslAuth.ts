import { useCallback, useEffect, useRef, useState } from 'react';
import {
  OSL_ISSUER,
  OslAuthSession,
  PendingDatasetExport,
  buildOslAuthorizeUrl,
  clearOslSession,
  clearPkceTransaction,
  exchangeOslAuthorizationCode,
  generateOAuthState,
  generatePkceChallengeS256,
  generatePkceCodeVerifier,
  getOslRedirectUri,
  isSessionExpired,
  loadOslSession,
  loadPkceTransaction,
  refreshOslAccessToken,
  savePkceTransaction,
} from '../lib/oslAuth';

export function useOslAuth(isEmbed: boolean) {
  const [session, setSession] = useState<OslAuthSession | null>(() => {
    const existing = loadOslSession();
    if (!existing) return null;
    if (isSessionExpired(existing) && !existing.refresh_token) {
      clearOslSession();
      return null;
    }
    return existing;
  });
  const [isAuthenticating, setIsAuthenticating] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingExport, setPendingExport] = useState<PendingDatasetExport | null>(null);

  const popupRef = useRef<Window | null>(null);
  const popupTimerRef = useRef<number | null>(null);
  const callbackProcessedRef = useRef<boolean>(false);

  const cleanupPopupWatcher = useCallback(() => {
    if (popupTimerRef.current !== null) {
      window.clearInterval(popupTimerRef.current);
      popupTimerRef.current = null;
    }
    popupRef.current = null;
  }, []);

  // Verwerk standalone redirect callback (/sso/callback?code=...&state=...)
  useEffect(() => {
    if (typeof window === 'undefined' || callbackProcessedRef.current) return;
    const pathname = window.location.pathname.replace(/\/+$/, '');
    if (pathname !== '/sso/callback') return;

    callbackProcessedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const err = params.get('error');
    const errDesc = params.get('error_description');

    // Fallback als de callback toch binnen een popup belandt i.p.v. web_message
    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage(
          {
            type: 'osl-sso-callback',
            code,
            state,
            iss: OSL_ISSUER,
            error: err || undefined,
            error_description: errDesc || undefined,
          },
          '*'
        );
      } catch {}
      window.close();
      return;
    }

    if (err) {
      setAuthError(errDesc || `OSL inloggen geannuleerd (${err})`);
      clearPkceTransaction();
      window.history.replaceState({}, '', '/');
      return;
    }

    if (!code || !state) {
      setAuthError('Ongeldige OSL SSO-callback: code of state ontbreekt');
      clearPkceTransaction();
      window.history.replaceState({}, '', '/');
      return;
    }

    const tx = loadPkceTransaction();
    if (!tx || tx.state !== state) {
      setAuthError('OSL login-sessie verlopen of ongeldige state. Probeer opnieuw.');
      clearPkceTransaction();
      window.history.replaceState({}, '', '/');
      return;
    }

    setIsAuthenticating(true);
    setAuthError(null);

    exchangeOslAuthorizationCode({
      code,
      codeVerifier: tx.codeVerifier,
      redirectUri: tx.redirectUri,
    })
      .then((newSession) => {
        setSession(newSession);
        if (tx.pendingExport) {
          setPendingExport(tx.pendingExport);
        }
      })
      .catch((e: any) => {
        setAuthError(e?.message || 'OSL token-omwisseling mislukt');
      })
      .finally(() => {
        clearPkceTransaction();
        setIsAuthenticating(false);
        window.history.replaceState({}, '', '/');
      });
  }, []);

  // Luister naar web_message popup callbacks vanuit https://onafhankelijksteenwijkerland.nl
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onMessage = async (event: MessageEvent) => {
      const allowedOrigins = new Set([OSL_ISSUER, window.location.origin]);
      if (!allowedOrigins.has(event.origin)) return;

      const data = event.data;
      if (!data || data.type !== 'osl-sso-callback') return;

      if (data.iss && String(data.iss).replace(/\/+$/, '') !== OSL_ISSUER) {
        return;
      }

      const tx = loadPkceTransaction();
      if (!tx) return;

      if (data.error) {
        cleanupPopupWatcher();
        clearPkceTransaction();
        setIsAuthenticating(false);
        setAuthError(data.error_description || `OSL login geannuleerd (${data.error})`);
        try {
          popupRef.current?.close();
        } catch {}
        return;
      }

      if (typeof data.code !== 'string' || typeof data.state !== 'string' || data.state !== tx.state) {
        cleanupPopupWatcher();
        clearPkceTransaction();
        setIsAuthenticating(false);
        setAuthError('Beveiligingscontrole (state) van OSL SSO mislukt. Probeer opnieuw.');
        try {
          popupRef.current?.close();
        } catch {}
        return;
      }

      cleanupPopupWatcher();
      try {
        popupRef.current?.close();
      } catch {}

      setIsAuthenticating(true);
      setAuthError(null);

      try {
        const newSession = await exchangeOslAuthorizationCode({
          code: data.code,
          codeVerifier: tx.codeVerifier,
          redirectUri: tx.redirectUri,
        });
        setSession(newSession);
        if (tx.pendingExport) {
          setPendingExport(tx.pendingExport);
        }
      } catch (e: any) {
        setAuthError(e?.message || 'OSL token-omwisseling mislukt');
      } finally {
        clearPkceTransaction();
        setIsAuthenticating(false);
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      cleanupPopupWatcher();
    };
  }, [cleanupPopupWatcher]);

  // Verifieer of ververs access_token zo nodig
  const getValidAccessToken = useCallback(async (): Promise<string | null> => {
    const current = session || loadOslSession();
    if (!current) return null;

    if (!isSessionExpired(current)) {
      return current.access_token;
    }

    if (current.refresh_token) {
      try {
        const refreshed = await refreshOslAccessToken(current.refresh_token);
        setSession(refreshed);
        return refreshed.access_token;
      } catch {
        clearOslSession();
        setSession(null);
        return null;
      }
    }

    clearOslSession();
    setSession(null);
    return null;
  }, [session]);

  const startLogin = useCallback(
    async (exportAfterLogin: PendingDatasetExport | null = null) => {
      setAuthError(null);
      setIsAuthenticating(true);

      try {
        const codeVerifier = generatePkceCodeVerifier();
        const codeChallenge = await generatePkceChallengeS256(codeVerifier);
        const state = generateOAuthState();
        const redirectUri = getOslRedirectUri();

        savePkceTransaction({
          codeVerifier,
          state,
          redirectUri,
          createdAtMs: Date.now(),
          pendingExport: exportAfterLogin,
        });

        const usePopup = isEmbed;
        const authorizeUrl = await buildOslAuthorizeUrl({
          redirectUri,
          state,
          codeChallenge,
          webMessageMode: usePopup,
        });

        if (usePopup) {
          const popup = window.open(
            authorizeUrl,
            'osl_sso_login',
            'width=540,height=700,resizable=yes,scrollbars=yes'
          );
          if (!popup) {
            clearPkceTransaction();
            setIsAuthenticating(false);
            setAuthError('Popup geblokkeerd door browser. Sta popups toe en probeer opnieuw.');
            return;
          }
          popupRef.current = popup;
          cleanupPopupWatcher();
          popupTimerRef.current = window.setInterval(() => {
            if (!popupRef.current || popupRef.current.closed) {
              cleanupPopupWatcher();
              // Wacht heel even zodat een eventueel net ontvangen postMessage eerst kan landen
              window.setTimeout(() => {
                if (loadPkceTransaction()?.state === state) {
                  clearPkceTransaction();
                  setIsAuthenticating(false);
                }
              }, 350);
            }
          }, 400);
          return;
        }

        // Standalone bezoek: redirect naar centrale OSL authorize UI
        window.location.assign(authorizeUrl);
      } catch (e: any) {
        clearPkceTransaction();
        setIsAuthenticating(false);
        setAuthError(e?.message || 'Kan OSL SSO-login niet starten');
      }
    },
    [isEmbed, cleanupPopupWatcher]
  );

  const invalidateSession = useCallback(() => {
    clearOslSession();
    setSession(null);
  }, []);

  const logout = useCallback(async () => {
    const current = session || loadOslSession();
    clearOslSession();
    clearPkceTransaction();
    setSession(null);
    setPendingExport(null);
    setAuthError(null);

    if (current) {
      fetch('/api/auth/osl/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(current.access_token ? { Authorization: `Bearer ${current.access_token}` } : {}),
        },
        body: JSON.stringify({ refresh_token: current.refresh_token || undefined }),
      }).catch(() => {});
    }
  }, [session]);

  const clearPendingExport = useCallback(() => {
    setPendingExport(null);
  }, []);

  return {
    session,
    user: session?.user || null,
    isAuthenticated: Boolean(session?.access_token && !isSessionExpired(session)),
    isAuthenticating,
    authError,
    pendingExport,
    clearPendingExport,
    startLogin,
    getValidAccessToken,
    invalidateSession,
    logout,
  };
}
