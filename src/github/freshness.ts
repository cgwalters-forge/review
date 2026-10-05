import type { GitHub } from "./api.ts";

export interface Freshness {
  state: "ok" | "cached" | "unavailable" | "pending";
  checkedAt?: number;
  /** Last successful read/validation (304 included), or the cache's age. */
  fetchedAt?: number;
  publishedAt?: string;
  error?: string;
}

export type Sources = Record<string, Freshness>;

/** Keep fetch failures separate from a successfully read empty source. */
export function readSource<T>(sources: Sources, name: string, read: () => Promise<T>): Promise<T | undefined>;
export function readSource<T>(sources: Sources, name: string, read: (gh: GitHub) => Promise<T>, gh: GitHub): Promise<T | undefined>;

export async function readSource<T>(sources: Sources, name: string, read: (gh: GitHub) => Promise<T>, gh?: GitHub): Promise<T | undefined> {
  const scope = gh?.readScope();
  try {
    const value = await (scope ? read(scope) : (read as () => Promise<T>)());
    const at = Date.now();
    sources[name] = { state: scope?.oldest === undefined ? "ok" : "cached", checkedAt: at, fetchedAt: scope?.oldest ?? at };
    return value;
  } catch (e) {
    sources[name] = { ...sources[name], state: "unavailable", checkedAt: Date.now(), error: e instanceof Error ? e.message : String(e) };
    return undefined;
  }
}
