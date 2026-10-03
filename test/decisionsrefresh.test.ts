import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DecisionsRefresh } from "../src/github/decisionsrefresh.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function harness(initial?: string[]) {
  let value = initial;
  let closed = false;
  const cached: ReturnType<typeof deferred<string[]>>[] = [];
  const reads: ReturnType<typeof deferred<string[]>>[] = [];
  const applied: { value: string[]; cached: boolean; force: boolean }[] = [];
  const errors: unknown[] = [];
  const refresh = new DecisionsRefresh({
    closed: () => closed,
    hasValue: () => value !== undefined,
    cached: () => {
      const d = deferred<string[]>();
      cached.push(d);
      return d.promise;
    },
    read: () => {
      const d = deferred<string[]>();
      reads.push(d);
      return d.promise;
    },
    applyCached: (v) => {
      value = v;
      applied.push({ value: v, cached: true, force: false });
    },
    applyLive: (v, force) => {
      value = v;
      applied.push({ value: v, cached: false, force });
    },
    error: (e) => errors.push(e),
  });
  return { refresh, cached, reads, applied, errors, value: () => value, land: (v: string[]) => { value = v; }, close: () => { closed = true; } };
}

describe("DecisionsRefresh", () => {
  it("locks before the cache read and never starts overlapping live reads", async () => {
    const h = harness();
    const first = h.refresh.refresh();
    await h.refresh.refresh();
    assert.equal(h.cached.length, 1);
    assert.equal(h.reads.length, 0);
    h.cached[0]!.resolve(["cached"]);
    await flush();
    await h.refresh.refresh();
    assert.equal(h.reads.length, 1);
    h.reads[0]!.resolve(["first"]);
    await first;
    const second = h.refresh.refresh();
    assert.equal(h.reads.length, 2);
    assert.deepEqual(h.value(), ["first"], "the older read landed before the next one started");
    h.reads[1]!.resolve(["second"]);
    await second;
    assert.deepEqual(h.value(), ["second"]);
    assert.deepEqual(h.applied, [
      { value: ["cached"], cached: true, force: false },
      { value: ["first"], cached: false, force: false },
      { value: ["second"], cached: false, force: false },
    ]);
  });

  for (const during of ["cache", "live"]) {
    it(`coalesces multiple forced calls during the ${during} read into one forced rerun`, async () => {
      const h = harness(during === "live" ? [] : undefined);
      const first = h.refresh.refresh();
      await h.refresh.refresh(true);
      await h.refresh.refresh(true);
      await h.refresh.refresh();
      if (during === "cache") {
        h.cached[0]!.resolve(["cached"]);
        await flush();
      }
      assert.equal(h.reads.length, 1);
      h.reads[0]!.resolve(["first"]);
      await flush();
      assert.equal(h.reads.length, 2);
      h.reads[1]!.resolve(["second"]);
      await first;
      assert.equal(h.reads.length, 2);
      assert.deepEqual(h.applied.filter((a) => !a.cached), [
        { value: ["first"], cached: false, force: false },
        { value: ["second"], cached: false, force: true },
      ]);
    });
  }

  it("releases the lock after an error and consumes the queued force only once", async () => {
    const h = harness([]);
    const first = h.refresh.refresh();
    await h.refresh.refresh(true);
    const error = new Error("offline");
    h.reads[0]!.reject(error);
    await flush();
    assert.deepEqual(h.errors, [error]);
    assert.equal(h.reads.length, 2);
    h.reads[1]!.reject(error);
    await first;
    const retry = h.refresh.refresh();
    assert.equal(h.reads.length, 3);
    h.reads[2]!.resolve([]);
    await retry;
    assert.equal(h.reads.length, 3);
    assert.deepEqual(h.applied, [{ value: [], cached: false, force: false }]);
  });

  it("ignores a cache miss and still reads live", async () => {
    const h = harness();
    const first = h.refresh.refresh(true);
    h.cached[0]!.reject(new Error("cache miss"));
    await flush();
    h.reads[0]!.resolve([]);
    await first;
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.applied, [{ value: [], cached: false, force: true }]);
  });

  for (const live of [["live"], []]) {
    it(`doesn't apply a slow cache over a live ${live.length ? "nonempty" : "empty"} list`, async () => {
      const h = harness();
      const first = h.refresh.refresh();
      h.land(live);
      h.cached[0]!.resolve(["stale"]);
      await flush();
      assert.deepEqual(h.value(), live);
      assert.deepEqual(h.applied, []);
      h.reads[0]!.resolve(live);
      await first;
      assert.deepEqual(h.applied, [{ value: live, cached: false, force: false }]);
    });
  }

  for (const during of ["cache", "live"]) {
    it(`drops late results and queued refreshes when closed during the ${during} read`, async () => {
      const h = harness(during === "live" ? [] : undefined);
      const first = h.refresh.refresh();
      await h.refresh.refresh(true);
      h.close();
      if (during === "cache") h.cached[0]!.resolve(["stale"]);
      else h.reads[0]!.resolve(["stale"]);
      await first;
      await h.refresh.refresh(true);
      assert.deepEqual(h.applied, []);
      assert.equal(h.reads.length, during === "live" ? 1 : 0);
    });
  }
});
