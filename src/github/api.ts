// A small GitHub REST client: conditional GETs with ETags or
// Last-Modified (a 304 costs no rate budget when authorised) against one
// response cache (cache.ts), pagination by Link header, and rate-limit
// tracking. `fetch` is injected so tests can script responses.

import { type CachedResponse, ResponseCache, staleAfterWrite } from "./cache.ts";
import { API_ROOT } from "./config.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type TokenGetter = () => Promise<string>;

export class GitHubError extends Error {
  override name = "GitHubError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** Epoch seconds. */
  reset: number;
}

/** A cache-only read found nothing cached. */
export class CacheMiss extends Error {
  override name = "CacheMiss";
}

export interface Fetched<T> {
  data: T;
  /** False when the server answered 304 and the cached data was reused. */
  changed: boolean;
}

/** The URL of rel="next" in a Link header, if any. */
export function nextLink(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (m && m[2]?.split(/\s+/).includes("next")) return m[1];
  }
  return undefined;
}

/** A message, or an error entry's message (GitHub sends strings or objects). */
function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : "";
}

async function errorMessage(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown; errors?: unknown };
    const parts = [body.message, ...(Array.isArray(body.errors) ? body.errors : [])].map(errorText).filter(Boolean);
    if (parts.length) detail = `: ${parts.join("; ")}`;
  } catch {
    // Not JSON; the status is enough.
  }
  const hint =
    res.status === 401
      ? " (the token is invalid or expired; sign in again)"
      : res.status === 403 || res.status === 404
        ? " (no access with this token, or it lacks a permission)"
        : "";
  return `${what} failed with HTTP ${res.status}${detail}${hint}`;
}

export class GitHub {
  #fetch: Fetch;
  #token: TokenGetter;
  readonly cache: ResponseCache;
  /** Answer GETs from the cache only, never the network (see cacheOnly). */
  #cacheOnly = false;
  #oldest: number | undefined;
  rate: RateLimit | undefined;
  /** A classic token's scopes, from X-OAuth-Scopes; unset for other tokens. */
  scopes: string | undefined;

  constructor(token: TokenGetter, fetchImpl: Fetch = (i, init) => fetch(i, init), cache: ResponseCache = new ResponseCache()) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.cache = cache;
  }

  /**
   * A client over the same cache that never touches the network: GETs
   * answer from the cache or throw CacheMiss, and writes are refused. The
   * same loaders then render the last known state before revalidating.
   */
  cacheOnly(): GitHub {
    const gh = new GitHub(this.#token, () => Promise.reject(new Error("cache-only client")), this.cache);
    gh.#cacheOnly = true;
    return gh;
  }

  /** On a cache-only client: when the oldest response it served was fetched (epoch ms). */
  get oldest(): number | undefined {
    return this.#oldest;
  }

  /** The API URL for PATH; the token never goes anywhere else. */
  #url(path: string): string {
    if (path.startsWith(`${API_ROOT}/`)) return path;
    if (/^[a-z]+:/i.test(path)) throw new Error(`refusing to send the token outside ${API_ROOT}: ${path}`);
    if (!path.startsWith("/")) throw new Error(`API path must start with /: ${path}`);
    return `${API_ROOT}${path}`;
  }

  #noteRate(res: Response): void {
    // Search and GraphQL have budgets of their own; track the core one.
    const resource = res.headers.get("x-ratelimit-resource");
    if (resource !== null && resource !== "core") return;
    const limit = Number(res.headers.get("x-ratelimit-limit"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    if (limit > 0 && Number.isFinite(remaining)) this.rate = { limit, remaining, reset };
    const scopes = res.headers.get("x-oauth-scopes");
    if (scopes !== null) this.scopes = scopes;
  }

  async #send(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    const init: RequestInit = {
      method,
      // We do our own conditional requests; the browser cache would
      // otherwise answer from its copy for max-age=60 without asking.
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await this.#token()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...headers,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
    const res = await this.#fetch(url, init);
    this.#noteRate(res);
    return res;
  }

  /** GET one page, conditionally if we have it cached with a validator. */
  async #getPage(url: string): Promise<{ entry: CachedResponse; changed: boolean }> {
    const cached = await this.cache.get(url);
    if (this.#cacheOnly) {
      if (!cached) throw new CacheMiss(`not cached: GET ${url}`);
      this.#oldest = Math.min(this.#oldest ?? cached.fetchedAt, cached.fetchedAt);
      return { entry: cached, changed: true };
    }
    const validators: Record<string, string> = {};
    if (cached?.etag) validators["If-None-Match"] = cached.etag;
    else if (cached?.lastModified) validators["If-Modified-Since"] = cached.lastModified;
    const generation = this.cache.generation;
    const res = await this.#send("GET", url, validators);
    if (res.status === 304 && cached) {
      this.cache.refreshed(url);
      return { entry: cached, changed: false };
    }
    if (!res.ok) throw new GitHubError(res.status, await errorMessage(res, `GET ${url}`));
    const text = await res.text();
    const entry: CachedResponse = { data: JSON.parse(text) as unknown, fetchedAt: this.cache.now() };
    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    const next = nextLink(res.headers.get("link"));
    if (etag) entry.etag = etag;
    if (lastModified) entry.lastModified = lastModified;
    if (next) entry.next = next;
    this.cache.put(url, entry, text.length, generation);
    return { entry, changed: true };
  }

  /** GET a JSON resource, conditionally. */
  async get<T>(path: string): Promise<Fetched<T>> {
    const { entry, changed } = await this.#getPage(this.#url(path));
    return { data: entry.data as T, changed };
  }

  /**
   * GET every page of a list. Changed if any page changed, or the number
   * of pages did.
   */
  async getAll<T>(path: string, maxPages = 20): Promise<Fetched<T[]>> {
    const out: T[] = [];
    let changed = false;
    let url: string | undefined = this.#url(path);
    for (let page = 0; url; page++) {
      if (page >= maxPages) throw new Error(`GET ${path}: more than ${maxPages} pages; refusing to continue`);
      const { entry, changed: pageChanged } = await this.#getPage(this.#url(url));
      if (!Array.isArray(entry.data)) throw new Error(`GET ${url}: expected a JSON array`);
      out.push(...(entry.data as T[]));
      changed ||= pageChanged;
      url = entry.next;
    }
    return { data: out, changed };
  }

  /**
   * An unconditional request, with an optional JSON body. It never reads
   * or fills the cache, so a GET here is always the server's current
   * answer: guards before a write (the approve's head check) use it. A
   * successful write drops the cached responses it may have changed.
   */
  async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.#cacheOnly) throw new Error(`cache-only client: not sending ${method} ${path}`);
    const url = this.#url(path);
    // A write may land even if its response is lost, so invalidate first.
    if (method !== "GET") this.cache.invalidate(staleAfterWrite(url));
    const res = await this.#send(method, url, {}, body);
    if (!res.ok) throw new GitHubError(res.status, await errorMessage(res, `${method} ${path}`));
    // And again: a GET that raced the write may have cached the old state.
    if (method !== "GET") this.cache.invalidate(staleAfterWrite(url));
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  /** True when the rate budget is below `fraction` of its limit. */
  rateLow(fraction: number): boolean {
    return this.rate !== undefined && this.rate.remaining < this.rate.limit * fraction;
  }
}
