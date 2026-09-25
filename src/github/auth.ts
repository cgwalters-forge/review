// Where the access token comes from.
//
// - Relay mode (deployed): the token-mediating relay of docs/design.md
//   holds the GitHub App refresh token in a sealed HttpOnly cookie and
//   hands out access tokens from POST auth/github/token.
// - Development mode, only on a loopback origin: no relay answers, so you
//   paste a token. It is kept in sessionStorage, which dies with the tab,
//   and never anywhere else. On any other origin a missing relay is an
//   error, so the deployed app never asks for a token.
//
// Access tokens themselves live only in memory.

import { DEV_TOKEN_KEY, RELAY_HEADER, RELAY_LOGOUT_PATH, RELAY_TOKEN_PATH } from "./config.ts";

/** Refresh from the relay this long before the token expires. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

/** Hosts where development mode is allowed. */
export const DEV_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

export function isDevHost(hostname: string): boolean {
  return DEV_HOSTS.includes(hostname);
}

export type AuthState =
  | { kind: "relay"; source: TokenSource }
  | { kind: "relay-signed-out" }
  | { kind: "relay-error"; message: string }
  | { kind: "dev"; source: TokenSource }
  | { kind: "dev-signed-out" };

export interface TokenSource {
  get(): Promise<string>;
  signOut(): Promise<void>;
}

interface RelayToken {
  access_token: string;
  /** ISO 8601. */
  expires_at: string;
}

function isRelayToken(v: unknown): v is RelayToken {
  const t = v as Partial<RelayToken> | null;
  return typeof t?.access_token === "string" && typeof t.expires_at === "string";
}

async function fetchRelayToken(): Promise<Response> {
  return fetch(RELAY_TOKEN_PATH, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { [RELAY_HEADER]: "1" },
  });
}

function relaySource(first: RelayToken): TokenSource {
  let current = first;
  let pending: Promise<RelayToken> | undefined;
  const refresh = async (): Promise<RelayToken> => {
    const res = await fetchRelayToken();
    const body: unknown = res.ok ? await res.json() : undefined;
    if (!isRelayToken(body)) throw new Error(`the sign-in relay answered HTTP ${res.status}; sign in again`);
    return body;
  };
  return {
    async get() {
      if (Date.parse(current.expires_at) - Date.now() > EXPIRY_MARGIN_MS) return current.access_token;
      // One refresh at a time; the relay single-flights across tabs too.
      pending ??= refresh().finally(() => (pending = undefined));
      current = await pending;
      return current.access_token;
    },
    async signOut() {
      await fetch(RELAY_LOGOUT_PATH, { method: "POST", credentials: "same-origin", headers: { [RELAY_HEADER]: "1" } });
    },
  };
}

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function devSource(token: string): TokenSource {
  return {
    get: async () => token,
    async signOut() {
      try {
        storage()?.removeItem(DEV_TOKEN_KEY);
      } catch {
        // Storage may be blocked; the token then lived in memory only.
      }
    },
  };
}

/** Find out which mode we're in, and whether we're signed in. */
export async function detectAuth(hostname: string = window.location.hostname): Promise<AuthState> {
  let res: Response | undefined;
  let failure = "no answer";
  try {
    res = await fetchRelayToken();
    failure = `HTTP ${res.status}`;
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (res?.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    if (isRelayToken(body)) return { kind: "relay", source: relaySource(body) };
    failure = "an unexpected response";
  } else if (res?.status === 401) {
    return { kind: "relay-signed-out" };
  }
  if (!isDevHost(hostname)) {
    return { kind: "relay-error", message: `The sign-in relay failed (${failure}). Try again later.` };
  }
  let saved: string | null = null;
  try {
    saved = storage()?.getItem(DEV_TOKEN_KEY) ?? null;
  } catch {
    // Blocked storage: ask for the token again.
  }
  return saved ? { kind: "dev", source: devSource(saved) } : { kind: "dev-signed-out" };
}

/** Use a pasted development token. */
export function useDevToken(token: string, hostname: string = window.location.hostname): TokenSource {
  if (!isDevHost(hostname)) throw new Error("tokens can only be pasted in development mode, on a loopback address");
  const t = token.trim();
  if (!/^[A-Za-z0-9_]+$/.test(t)) throw new Error("that doesn't look like a GitHub token");
  try {
    storage()?.setItem(DEV_TOKEN_KEY, t);
  } catch {
    // Keep it in memory only.
  }
  return devSource(t);
}
