// The poll loop: one poll at a time, the next one scheduled when it
// settles, paused while the tab is hidden, slowed or paused by the rate
// budget. A poll that never settles must not end the loop: after a
// stall timeout it is given up on and the loop goes on without it. And
// the loop says why the data on screen is getting old (pollNote), so a
// paused or stuck loop shows as such rather than as a quiet "cached".
//
// Kept apart from main.ts, with the poll and visibility injected, so
// tests can drive it with fake timers.

import type { RateLimit } from "./api.ts";

/** How long until the next poll, and, when it isn't the usual interval, why (shown as is). */
export interface Delay {
  ms: number;
  why?: string;
}

export interface PollerHooks {
  /**
   * One poll. It may reject; the loop goes on. `current()` turns false
   * once the loop gave up on it: it should then drop what it read, as a
   * newer poll may have shown something fresher.
   */
  run(current: () => boolean): Promise<void>;
  delay(): Delay;
  hidden(): boolean;
  /** Called whenever status() may have changed. */
  changed?(): void;
  /** Give up on a poll after this long (ms). */
  stallMs: number;
}

export interface PollStatus {
  closed: boolean;
  hidden: boolean;
  /** When the running poll started (epoch ms), if one is running. */
  running?: number;
  /** When the next poll is due, and why it is later than usual. */
  next?: { at: number; why?: string };
  /** Polls given up on in a row, reset by one that settles. */
  stalls: number;
}

export class Poller {
  readonly #hooks: PollerHooks;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Which poll is the running one; a poll given up on settles unheard. */
  #gen = 0;
  #running: { gen: number; since: number } | undefined;
  #next: { at: number; why?: string } | undefined;
  #again = false;
  #closed = false;
  #stalls = 0;

  constructor(hooks: PollerHooks) {
    this.#hooks = hooks;
  }

  /** Poll now, or right after the running poll if there is one. */
  now(): void {
    if (this.#closed) return;
    if (this.#running) this.#again = true;
    else this.#start();
  }

  /** The tab was hidden or shown: stop the timer, or poll at once. */
  visibilityChanged(): void {
    if (this.#closed) return;
    if (!this.#hooks.hidden()) {
      this.now();
      return;
    }
    clearTimeout(this.#timer);
    this.#next = undefined;
    this.#changed();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#stallTimer);
  }

  status(): PollStatus {
    const s: PollStatus = { closed: this.#closed, hidden: this.#hooks.hidden(), stalls: this.#stalls };
    if (this.#running) s.running = this.#running.since;
    if (this.#next) s.next = this.#next;
    return s;
  }

  /** A failing hook mustn't stop the loop. */
  #changed(): void {
    try {
      this.#hooks.changed?.();
    } catch (e) {
      console.error("review: updating the poll status failed:", e);
    }
  }

  #start(): void {
    clearTimeout(this.#timer);
    this.#next = undefined;
    const gen = ++this.#gen;
    this.#running = { gen, since: Date.now() };
    this.#stallTimer = setTimeout(() => this.#settled(gen, true), this.#hooks.stallMs);
    this.#changed();
    let p: Promise<void>;
    try {
      p = this.#hooks.run(() => this.#running?.gen === gen);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.catch((e: unknown) => console.error("review: poll failed:", e)).finally(() => this.#settled(gen, false));
  }

  #settled(gen: number, stalled: boolean): void {
    if (this.#running?.gen !== gen) return;
    clearTimeout(this.#stallTimer);
    this.#running = undefined;
    if (stalled) {
      this.#stalls++;
      console.warn(`review: a poll hasn't settled after ${this.#hooks.stallMs / 1000} s; going on without it`);
    } else {
      this.#stalls = 0;
    }
    if (this.#closed) return;
    if (this.#again) {
      this.#again = false;
      this.#start();
      return;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (!this.#hooks.hidden()) {
      let d: Delay;
      try {
        d = this.#hooks.delay();
      } catch (e) {
        console.error("review: computing the poll delay failed:", e);
        d = { ms: this.#hooks.stallMs };
      }
      this.#next = d.why === undefined ? { at: Date.now() + d.ms } : { at: Date.now() + d.ms, why: d.why };
      this.#timer = setTimeout(() => this.#start(), d.ms);
    }
    this.#changed();
  }
}

export interface DelayPolicy {
  interval: number;
  /** Poll this many times slower when the budget is low. */
  backoff: number;
  /** Below this fraction of the budget, it is low. */
  lowFraction: number;
  /** Formats a time of day for the label. */
  clock: (ms: number) => string;
}

/** Past the rate budget's reset, wait this much longer for GitHub's clock. */
const RESET_SLACK_MS = 5_000;

/** The next poll's delay under the rate budget: usual, slowed when low, or paused until it resets when spent. */
export function pollDelay(rate: RateLimit | undefined, now: number, p: DelayPolicy): Delay {
  if (!rate) return { ms: p.interval };
  const reset = rate.reset * 1000;
  if (rate.remaining <= 0 && reset > now) return { ms: Math.max(p.interval, reset - now + RESET_SLACK_MS), why: `paused: rate limit until ${p.clock(reset)}` };
  if (rate.remaining < rate.limit * p.lowFraction) return { ms: p.interval * p.backoff, why: "slowed: rate limit low" };
  return { ms: p.interval };
}

/** Minutes or seconds, for the waiting note. */
function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

/**
 * Why the data on screen may be getting old, for the header next to its
 * age; undefined while polling as usual.
 */
export function pollNote(s: PollStatus, now: number, slowMs: number): string | undefined {
  if (s.closed) return undefined;
  if (s.hidden) return "paused: tab hidden";
  if (s.running !== undefined) {
    const waited = now - s.running;
    if (s.stalls > 0) return `retrying: GitHub didn't answer the last ${s.stalls === 1 ? "poll" : `${s.stalls} polls`}`;
    return waited >= slowMs ? `waiting on GitHub for ${ago(waited)}` : undefined;
  }
  if (s.stalls > 0) return `stalled: GitHub didn't answer the last ${s.stalls === 1 ? "poll" : `${s.stalls} polls`}`;
  return s.next?.why;
}
