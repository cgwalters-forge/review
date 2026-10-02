import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Item, parseItem, type RawItem } from "../src/github/board.ts";
import {
  type ChangeKind,
  changesOf,
  diffBoard,
  groupByTime,
  isUrgent,
  type ItemState,
  loadSeen,
  saveSeen,
  snapshotOf,
  stateOf,
} from "../src/github/boardfeed.ts";
import { feedSection, type FeedOptions } from "../src/github/boardfeedview.ts";
import { installDom } from "./helpers.ts";

installDom();
// groupByTime works in local days.
process.env.TZ = "UTC";

const NOW = Date.parse("2026-10-01T15:00:00Z");

function item(n: number, over: Partial<Item> = {}): Item {
  return {
    id: n,
    nodeId: `PVTI_${n}`,
    kind: "issue",
    title: `item ${n}`,
    url: `https://github.com/cgwalters-forge/tracker/issues/${n}`,
    body: "",
    why: "",
    labels: [],
    assignees: [],
    branch: [],
    gist: [],
    status: "Todo",
    priority: "P2",
    ...over,
  };
}

function freshStorage(): Map<string, string> {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return mem;
}

describe("parseItem", () => {
  it("reads Lead and News, and when the board item last moved", () => {
    const raw: RawItem = {
      id: 1,
      node_id: "PVTI_1",
      content_type: "Issue",
      content: { title: "t", html_url: "https://github.com/o/r/issues/1", updated_at: "2026-09-01T00:00:00Z" },
      updated_at: "2026-10-01T12:00:00Z",
      fields: [
        { name: "Lead", value: { raw: " wfc " } },
        { name: "News", value: { raw: "2026-10-01: rebased onto main" } },
      ],
    };
    const i = parseItem(raw);
    assert.equal(i.lead, "wfc");
    assert.equal(i.news, "2026-10-01: rebased onto main");
    assert.equal(i.movedAt, "2026-10-01T12:00:00Z");
    assert.equal(parseItem({ ...raw, fields: [{ name: "News", value: { raw: "  " } }] }).news, undefined);
  });
});

describe("changesOf", () => {
  const base: ItemState = { title: "x", status: "Todo", priority: "P2" };
  // name, the new state's differences, the expected [kind, dir?, from, to] list
  const cases: [string, Partial<ItemState>, [ChangeKind, string | undefined, string | undefined, string | undefined][]][] = [
    ["nothing", {}, []],
    ["title only", { title: "renamed" }, []],
    ["status", { status: "In Progress" }, [["status", undefined, "Todo", "In Progress"]]],
    ["done", { status: "Done" }, [["done", undefined, "Todo", "Done"]]],
    ["raised", { priority: "P0" }, [["priority", "up", "P2", "P0"]]],
    ["lowered", { priority: "P3" }, [["priority", "down", "P2", "P3"]]],
    ["lead claimed", { lead: "wfc" }, [["lead", undefined, undefined, "wfc"]]],
    ["news", { news: "2026-10-01: merged" }, [["news", undefined, undefined, "2026-10-01: merged"]]],
    [
      "several, in a fixed order",
      { news: "n", lead: "wfc", priority: "P1", status: "Done" },
      [
        ["done", undefined, "Todo", "Done"],
        ["priority", "up", "P2", "P1"],
        ["lead", undefined, undefined, "wfc"],
        ["news", undefined, undefined, "n"],
      ],
    ],
  ];
  for (const [name, diff, want] of cases) {
    it(name, () => {
      const got = changesOf(base, { ...base, ...diff }).map((c) => [c.kind, c.dir, c.from, c.to]);
      assert.deepEqual(got, want);
    });
  }
  it("an unset priority ranks lowest", () => {
    assert.deepEqual(changesOf(base, { title: "x", status: "Todo" }), [{ kind: "priority", dir: "down", from: "P2" }]);
    assert.deepEqual(changesOf({ title: "x", status: "Todo" }, { ...base, priority: "P3" }), [{ kind: "priority", dir: "up", to: "P3" }]);
  });
  it("a cleared News or released Lead", () => {
    assert.deepEqual(changesOf({ ...base, news: "old" }, base), []);
    assert.deepEqual(changesOf({ ...base, lead: "wfc" }, base), [{ kind: "lead", from: "wfc" }]);
  });
});

describe("diffBoard", () => {
  const seen = snapshotOf([item(1), item(2), item(3, { priority: "P0" }), item(4), item(6, { status: "Done" })], NOW - 3 * 86_400_000);
  const now = [
    item(1),
    item(2, { status: "Done", movedAt: "2026-10-01T10:00:00Z" }),
    item(4, { priority: "P1", movedAt: "2026-10-01T14:00:00Z" }),
    item(5, { movedAt: "2026-09-30T09:00:00Z" }),
  ];
  const diff = diffBoard(seen, now);

  it("shows a new item's News", () => {
    const got = diffBoard(snapshotOf([], NOW), [item(7, { news: "2026-10-01: opened" })]);
    assert.deepEqual(got[0]?.changes, [{ kind: "added", to: "Todo" }, { kind: "news", to: "2026-10-01: opened" }]);
  });

  it("lists added, changed and gone items, newest first, gone last, not Done ones archived", () => {
    assert.deepEqual(
      diff.map((c) => [c.nodeId, c.changes.map((x) => x.kind).join(",")]),
      [
        ["PVTI_4", "priority"],
        ["PVTI_2", "done"],
        ["PVTI_5", "added"],
        ["PVTI_3", "gone"],
      ],
    );
    assert.equal(diff.find((c) => c.nodeId === "PVTI_3")?.priority, "P0");
  });

  it("filters to P0/P1, including what was lowered from them", () => {
    assert.deepEqual(diff.filter(isUrgent).map((c) => c.nodeId), ["PVTI_4", "PVTI_3"]);
    assert.ok(isUrgent({ nodeId: "x", title: "x", priority: "P3", changes: [{ kind: "priority", dir: "down", from: "P1", to: "P3" }] }));
  });

  it("groups by day", () => {
    const groups = groupByTime(diff, Date.parse("2026-10-01T15:00:00"));
    assert.deepEqual(
      groups.map((g) => [g.group, g.items.map((c) => c.nodeId)]),
      [
        ["Today", ["PVTI_4", "PVTI_2"]],
        ["Yesterday", ["PVTI_5"]],
        ["Gone from the board", ["PVTI_3"]],
      ],
    );
  });
});

describe("the seen snapshot", () => {
  it("keeps only the public fields the feed compares", () => {
    const s = stateOf(item(1, { why: "private-ish rationale", body: "body", news: "n", lead: "l" }));
    assert.deepEqual(Object.keys(s).sort(), ["lead", "news", "priority", "status", "title", "url"]);
  });

  it("round-trips through localStorage, and a malformed one is ignored", () => {
    const mem = freshStorage();
    assert.equal(loadSeen(), undefined);
    const s = snapshotOf([item(1)], NOW);
    saveSeen(s);
    assert.deepEqual(loadSeen(), s);
    mem.set("review.board.seen", JSON.stringify({ v: 1, at: NOW, items: { x: { title: 3 } } }));
    assert.equal(loadSeen(), undefined);
  });
});

describe("feedSection", () => {
  const opts = (over: Partial<FeedOptions> = {}): FeedOptions => ({ now: NOW, urgentOnly: false, onUrgentOnly: () => {}, onSeen: () => {}, ...over });
  const seen = snapshotOf([item(1), item(2, { priority: "P3" })], NOW - 86_400_000);
  const board = [
    item(1, { priority: "P0", news: "2026-10-01: needs your approval of 075b2a2c", movedAt: "2026-10-01T14:00:00Z" }),
    item(2, { priority: "P3", status: "Done", movedAt: "2026-10-01T13:00:00Z" }),
    item(3, { title: "<img src=x onerror=alert(1)>", movedAt: "2026-10-01T12:00:00Z" }),
  ];

  it("shows chips and the News line, as text", () => {
    const el = feedSection(board, seen, opts());
    const rows = [...el.querySelectorAll(".feed-row")];
    assert.deepEqual(
      rows.map((r) => [...r.querySelectorAll(".chip")].map((c) => c.textContent)),
      [["↑ P0", "news"], ["Done"], ["new"]],
    );
    assert.equal(rows[0]?.querySelector(".feed-news")?.textContent, "2026-10-01: needs your approval of 075b2a2c");
    assert.equal(el.querySelector("img"), null);
    assert.match(el.textContent ?? "", /3 items changed/);
  });

  it("filters to P0/P1 and marks seen through its callbacks", () => {
    let urgent: boolean | undefined;
    let seenClicked = false;
    const el = feedSection(board, seen, opts({ urgentOnly: true, onUrgentOnly: (on) => (urgent = on), onSeen: () => (seenClicked = true) }));
    assert.equal(el.querySelectorAll(".feed-row").length, 1);
    const box = el.querySelector<HTMLInputElement>("input.feed-urgent");
    assert.ok(box?.checked);
    box.checked = false;
    box.dispatchEvent(new window.Event("change"));
    assert.equal(urgent, false);
    el.querySelector<HTMLButtonElement>("button.feed-seen")?.click();
    assert.ok(seenClicked);
  });

  it("says when there's nothing yet, nothing new, or no board", () => {
    assert.match(feedSection(board, undefined, opts()).textContent ?? "", /Tracking starts now/);
    const same = feedSection(board, snapshotOf(board, NOW), opts());
    assert.match(same.textContent ?? "", /Nothing changed since then/);
    assert.ok(same.querySelector<HTMLButtonElement>("button.feed-seen")?.disabled);
    assert.match(feedSection(undefined, seen, opts()).textContent ?? "", /couldn't be read/);
  });
});
