// Decision reads are serialized, including the first cache read. A forced
// refresh asked for meanwhile gets one forced follow-up, not a second reader.

export interface DecisionsRefreshHooks<T, C> {
  closed(): boolean;
  hasValue(): boolean;
  cached(): Promise<C | undefined>;
  read(): Promise<T>;
  applyCached(value: C): void;
  applyLive(value: T, force: boolean): void;
  error(e: unknown): void;
}

export class DecisionsRefresh<T, C> {
  readonly #hooks: DecisionsRefreshHooks<T, C>;
  #running = false;
  #queuedForce = false;

  constructor(hooks: DecisionsRefreshHooks<T, C>) {
    this.#hooks = hooks;
  }

  async refresh(force = false): Promise<void> {
    const h = this.#hooks;
    if (h.closed()) return;
    if (this.#running) {
      this.#queuedForce ||= force;
      return;
    }
    this.#running = true;
    try {
      do {
        this.#queuedForce = false;
        if (!h.hasValue()) {
          const cached = await h.cached().catch(() => undefined);
          // State may have landed elsewhere while the cache was being read,
          // including a live empty list: check again at completion time.
          if (cached !== undefined && !h.closed() && !h.hasValue()) h.applyCached(cached);
        }
        if (h.closed()) return;
        try {
          const value = await h.read();
          if (!h.closed()) h.applyLive(value, force);
        } catch (e) {
          if (!h.closed()) h.error(e);
        }
        force = true;
      } while (this.#queuedForce && !h.closed());
    } finally {
      this.#running = false;
      this.#queuedForce = false;
    }
  }
}
