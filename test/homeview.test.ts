// The one page: its sections, their counts and defaults, and the few
// rows shown before "View all".

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Active } from "../src/github/agents.ts";
import type { Item } from "../src/github/board.ts";
import { applyLimit, COUNT_CLASS, DECISION_LIMIT, fillAgents, fillFocus, fillStatus, fillNeeds, fillPriority, fillUsage, type Home, type HomeHooks, homeSkeleton, resetExpanded, reveal, setSectionOpen, stepRow, VIEW_ALL_CLASS, walkRows } from "../src/github/homeview.ts";
import { buildNeeds } from "../src/github/needs.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { needsSignature } from "../src/github/needsview.ts";
import { PREVIEW_ROWS, SECTION_TITLE, SECTIONS, type SectionId } from "../src/github/sections.ts";
import type { UsageData } from "../src/github/usage.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const TRACKER = "https://github.com/cgwalters-forge/tracker/issues";
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function hooks(open: SectionId[] = [], log: string[] = []): HomeHooks {
  return {
    open: (id) => open.includes(id),
    toggled: (id, o) => log.push(`${id}:${o}`),
    opsToggled: (o) => log.push(`ops:${o}`),
    themesToggled: (o) => log.push(`themes:${o}`),
  };
}

function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return {
    id: 0, nodeId, kind: "issue", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], status: "Needs human",
    url: `${TRACKER}/${number}`, ref: { owner: "cgwalters-forge", repo: "tracker", number }, state: "open", author: "cgwalters-bot", assignees: ["cgwalters"], ...over,
  };
}

/** n open questions in the tracker. */
function questions(n: number): Item[] {
  return Array.from({ length: n }, (_, i) =>
    tracked(`PVTI_q${i}`, 100 + i, { labels: ["question"], body: `Blocks: ${TRACKER}/9\nQ: which ${i}?\nOptions:\nA) this\nB) that\n`, priority: "P1", createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
  );
}

const needsHooks = (sent: unknown[] = []) => ({
  login: "cgwalters",
  now: Date.parse("2026-02-01T00:00:00Z"),
  render,
  labelOf: () => undefined,
  send: async (n: { key: string }, a: unknown) => (sent.push([n.key, a]), "https://github.com/c/1"),
});

afterEach(() => resetExpanded());

describe("operator dashboard", () => {
  it("shows promotion actions once and keeps approved reruns, re-signs and context in Watching with states and reasons", () => {
    const home = homeSkeleton(hooks());
    const entries: Entry[] = ["rerun", "resign", "read", "promote", "write", "sent"].map((name, i) => {
      const pr = { ref: { owner: "cgwalters-forge", repo: "widget", number: i + 1 }, url: `https://github.com/cgwalters-forge/widget/pull/${i + 1}`, title: name, body: ["promote", "write", "sent"].includes(name) ? `<!-- bot-meta -->\n- Upstream: \`upstream/widget\`\n- Contribution policy: \`${name === "write" ? "human-text" : "ai-ok"}\`\n<!-- /bot-meta -->` : "", author: "cgwalters-bot", createdAt: "", updatedAt: "", draft: true };
      return { key: `pr:${i}`, kind: "pr", title: name, where: `widget#${i + 1}`, href: `#pr/cgwalters-forge/widget/${i + 1}`, pr, verdict: { state: name === "sent" ? "promoted" : "approved" }, wait: { reasons: name === "rerun" ? ["rerun"] : name === "resign" ? ["resign"] : [], onBot: false } };
    });
    const needs = buildNeeds({ entries });
    assert.equal(needs.find((n) => n.action === "promote")?.href, entries[3]?.pr?.url);
    assert.equal(needs.find((n) => n.action === "write")?.href, entries[4]?.href);
    fillNeeds(home, needs, needsHooks(), entries);
    assert.deepEqual([...home.slots.needs.querySelectorAll(".need .action")].map(text), ["Promote", "Write text"]);
    assert.equal(text(home.slots.needs.querySelector(".watching summary")), "Watching (4)");
    const watching = home.slots.needs.querySelectorAll(".watching-item");
    assert.deepEqual([...watching].map((r) => text(r.querySelector(".state"))), ["approved", "approved", "approved", "/promote sent; bot-pr decides"]);
    assert.match(text(watching[0]), /required checks failed: rerun/);
    assert.match(text(watching[1]), /approve to re-sign/);
    assert.match(text(watching[2]), /No concrete ask; read for context/);
    const sig = needsSignature(needs, needsHooks(), entries);
    for (const change of [{ verdict: { state: "approved-older" as const } }, { wait: { reasons: ["resign" as const], onBot: false } }, { item: tracked("why", 1, { why: "A new context reason" }) }]) {
      assert.notEqual(needsSignature(needs, needsHooks(), [{ ...entries[0]!, ...change }, ...entries.slice(1)]), sig);
    }
  });

  it("renders sanitized project markdown and expands without losing state on an unchanged update", () => {
    const home = homeSkeleton(hooks());
    const status = { body: "**Working**\n\n[x](javascript:alert(1))\n\n<script>alert(2)</script>\n\nMore", createdAt: "2026-10-01T00:00:00Z" };
    fillStatus(home, status, render);
    assert.equal(text(home.slots.status.querySelector("strong")), "Working");
    assert.equal(home.slots.status.querySelector("script, [href^='javascript:']"), null);
    assert.ok(home.slots.status.querySelector(".status-preview"));
    const button = home.slots.status.querySelector<HTMLButtonElement>("button")!;
    button.click();
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.equal(home.slots.status.querySelector(".status-preview"), null);
    fillStatus(home, status, render);
    assert.equal(home.slots.status.querySelector("button"), button);
  });

  it("shows active epics by priority with progress, running children and gray paused work", () => {
    const home = homeSkeleton(hooks());
    const epic = tracked("epic", 1, { labels: ["epic"], status: "In Progress", priority: "P0", subIssues: { total: 4, completed: 2, percent_completed: 50 } });
    const paused = tracked("paused", 2, { labels: ["epic"], status: "Paused", priority: "P1" });
    fillFocus(home, [paused, epic, tracked("child", 3, { parent: epic.ref!, status: "In Progress", lead: "worker" }), tracked("done", 4, { labels: ["epic"], state: "closed" })]);
    assert.deepEqual([...home.slots.focus.querySelectorAll("article h3")].map(text), ["P0 · epic", "P1 · paused"]);
    assert.equal(home.slots.focus.querySelector("progress")?.getAttribute("value"), "2");
    assert.match(text(home.slots.focus), /child · worker · running/);
    assert.ok(home.slots.focus.querySelector(".paused"));
  });

  it("keeps overflow in collapsed Watching and reveals it for action continuation", () => {
    const home = homeSkeleton(hooks(["needs"]));
    const entries = buildEntries(questions(DECISION_LIMIT + 3), [], new Map());
    fillNeeds(home, buildNeeds({ entries }), needsHooks(), entries);
    document.body.replaceChildren(home.el);
    assert.equal(walkRows(home.el).length, DECISION_LIMIT);
    const overflow = home.slots.needs.querySelector<HTMLElement>(".watching .need")!;
    reveal(overflow, home.slots.needs, "needs", ".need");
    assert.ok(walkRows(home.el).includes(overflow));
  });

  it("counts each Watching identity once and excludes decision context", () => {
    const home = homeSkeleton(hooks(["needs"]));
    const question = tracked("question", 100, { labels: ["question"] });
    const entries = buildEntries([question, tracked("watch", 101)], [], new Map());
    const needs = buildNeeds({ entries });
    const duplicate = { ...entries.find((e) => e.item?.nodeId === "watch")!, key: "another-watch" };
    fillNeeds(home, [{ ...needs[0]!, key: "decision:I_100" }], needsHooks(), [...entries, duplicate]);
    assert.equal(text(home.slots.needs.querySelector(".watching summary")), "Watching (1)");
  });
});

describe("homeSkeleton", () => {
  it("has the five sections in order, each with a count, closed unless its hook says otherwise", () => {
    const home = homeSkeleton(hooks(["needs"]));
    const sections = [...home.el.querySelectorAll<HTMLDetailsElement>("details.sec")];
    assert.deepEqual(sections.map((d) => text(d.querySelector(".sec-title"))), SECTIONS.map((id) => SECTION_TITLE[id]));
    assert.deepEqual(sections.map((d) => d.open), [true, false, false, false, false]);
    for (const d of sections) assert.ok(d.querySelector(`summary .${COUNT_CLASS}`), "a count in each header");
    assert.ok(home.slots.opsBox, "the ops detail folds under the agents");
    assert.ok(home.sections.priority.body.contains(home.slots.themesBox), "the themes fold under by-priority");
  });

  it("tells hooks about his toggles only, not the page's own", async () => {
    const log: string[] = [];
    const home = homeSkeleton(hooks([], log));
    document.body.replaceChildren(home.el);
    home.sections.changes.details.open = true;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log, ["changes:true"]);
    setSectionOpen(home, "usage", true, false, hooks([], log));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log, ["changes:true"], "opened by code, unremembered");
    setSectionOpen(home, "agents", true, true, hooks([], log));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log, ["changes:true", "agents:true"], "a jump is remembered once, as his");
    home.sections.changes.details.open = false;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log.at(-1), "changes:false");
  });

  it("tells hooks when the folds open", async () => {
    const log: string[] = [];
    const home = homeSkeleton(hooks([], log));
    document.body.replaceChildren(home.el);
    home.slots.opsBox.open = true;
    home.slots.themesBox.open = true;
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(log.sort(), ["ops:true", "themes:true"]);
  });
});

describe("applyLimit", () => {
  const list = (n: number) => {
    const slot = document.createElement("div");
    const ul = document.createElement("ul");
    ul.append(...Array.from({ length: n }, (_, i) => Object.assign(document.createElement("li"), { className: "r", textContent: String(i) })));
    slot.append(document.createElement("h3"), ul);
    return slot;
  };
  const shown = (slot: Element) => [...slot.querySelectorAll<HTMLElement>(".r")].filter((r) => !r.hidden).length;

  it("shows a few rows and a View all with the total, which shows the rest and folds back", () => {
    const slot = list(8);
    applyLimit(slot, "t", ".r");
    assert.equal(shown(slot), PREVIEW_ROWS);
    const button = slot.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`);
    assert.equal(button?.textContent, "View all 8");
    button?.click();
    assert.equal(shown(slot), 8);
    assert.equal(slot.querySelector(`.${VIEW_ALL_CLASS}`)?.textContent, "Show fewer");
    assert.equal(slot.querySelectorAll(`.${VIEW_ALL_CLASS}`).length, 1);
    slot.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`)?.click();
    assert.equal(shown(slot), PREVIEW_ROWS);
  });

  it("offers nothing when everything fits, and remembers View all across redraws", () => {
    const few = list(PREVIEW_ROWS);
    applyLimit(few, "few", ".r");
    assert.equal(few.querySelector(`.${VIEW_ALL_CLASS}`), null);
    const slot = list(9);
    applyLimit(slot, "again", ".r");
    slot.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`)?.click();
    const redrawn = list(9);
    applyLimit(redrawn, "again", ".r");
    assert.equal(shown(redrawn), 9);
  });

  it("hides the list and heading left with no row showing, and reveal opens it for a row in it", () => {
    const slot = document.createElement("div");
    const lists = [3, 4].map((n) => {
      const ul = document.createElement("ul");
      ul.append(...Array.from({ length: n }, () => Object.assign(document.createElement("li"), { className: "r" })));
      return ul;
    });
    slot.append(document.createElement("h3"), lists[0] as Node, document.createElement("h3"), lists[1] as Node);
    applyLimit(slot, "g", ".r");
    assert.equal(lists[0]?.hidden, false);
    assert.equal(lists[1]?.hidden, false);
    assert.equal((lists[1]?.previousElementSibling as HTMLElement).hidden, false);
    const last = lists[1]?.lastElementChild as HTMLElement;
    assert.ok(last.hidden);
    reveal(last, slot, "g", ".r");
    assert.ok(!last.hidden);
  });
});

describe("row walking", () => {
  function mounted(): Home {
    const home = homeSkeleton(hooks(["needs", "priority"]));
    for (const id of ["needs", "priority", "agents"] as const) {
      const slot = home.slots[id];
      slot.replaceChildren(...Array.from({ length: PREVIEW_ROWS + 2 }, (_, i) =>
        Object.assign(document.createElement("div"), { className: "row", textContent: `${id}:${i}` }),
      ));
      applyLimit(slot, id, ".row");
    }
    document.body.replaceChildren(home.el);
    return home;
  }

  it("j/k skip hidden rows and closed sections, and stop at the last visible row", () => {
    const home = mounted();
    const rows = walkRows(home.el);
    const needs = [...home.slots.needs.querySelectorAll<HTMLElement>(".row")];
    const priority = [...home.slots.priority.querySelectorAll<HTMLElement>(".row")];
    assert.deepEqual(rows, [...needs.slice(0, PREVIEW_ROWS), ...priority.slice(0, PREVIEW_ROWS)]);
    assert.equal(stepRow(rows, needs[PREVIEW_ROWS - 1], 1), priority[0]);
    assert.equal(stepRow(rows, priority[0], -1), needs[PREVIEW_ROWS - 1]);
    assert.equal(rows.at(-1), priority[PREVIEW_ROWS - 1]);
    assert.equal(stepRow(rows, rows.at(-1), 1), rows.at(-1));
    assert.equal(stepRow(rows, rows[0], -1), rows[0]);

    home.slots.needs.querySelector<HTMLButtonElement>(`.${VIEW_ALL_CLASS}`)?.click();
    const expanded = walkRows(home.el);
    assert.deepEqual(expanded, [...needs, ...priority.slice(0, PREVIEW_ROWS)]);
    assert.equal(stepRow(expanded, needs[PREVIEW_ROWS - 1], 1), needs[PREVIEW_ROWS]);
    assert.equal(stepRow(expanded, priority[0], -1), needs.at(-1));
  });

  it("reveal makes a hidden row walkable and keeps its list expanded after a redraw", () => {
    const home = mounted();
    const slot = home.slots.needs;
    const last = slot.querySelectorAll<HTMLElement>(".row")[PREVIEW_ROWS + 1]!;
    assert.ok(last.hidden);
    assert.ok(!walkRows(home.el).includes(last));
    reveal(last, slot, "needs", ".row");
    assert.ok(!last.hidden);
    assert.ok(walkRows(home.el).includes(last));
    assert.equal(slot.querySelector(`.${VIEW_ALL_CLASS}`)?.textContent, "Show fewer");

    const redrawn = mounted();
    const rows = [...redrawn.slots.needs.querySelectorAll<HTMLElement>(".row")];
    assert.ok(rows.every((r) => !r.hidden));
    assert.deepEqual(walkRows(redrawn.el).slice(0, rows.length), rows);
    assert.equal(redrawn.slots.needs.querySelector(`.${VIEW_ALL_CLASS}`)?.textContent, "Show fewer");
  });
});

describe("the sections' fills", () => {
  const mounted = (): Home => {
    const home = homeSkeleton(hooks());
    document.body.replaceChildren(home.el);
    return home;
  };
  const count = (home: Home, id: SectionId) => home.sections[id].count;

  it("lists what waits on him with a hot count, a few rows, and a form only on questions", () => {
    const home = mounted();
    const entries = buildEntries([...questions(7), tracked("PVTI_rev", 200, { labels: ["review"], body: `Blocks: ${TRACKER}/9\nAsk: look\n` })], [], new Map(), true);
    const waiting = fillNeeds(home, buildNeeds({ entries }), needsHooks(), entries);
    assert.equal(waiting, 7);
    assert.equal(text(count(home, "needs")), "7");
    assert.ok(count(home, "needs").classList.contains("hot"));
    const rows = [...home.slots.needs.querySelectorAll<HTMLElement>(".row")];
    assert.equal(rows.length, 7);
    assert.equal(rows.filter((r) => !r.hidden).length, 7);
    assert.equal(home.slots.needs.querySelector<HTMLDetailsElement>(".watching")?.open, false);
    assert.equal(rows.filter((r) => r.querySelector("form.answer")).length, 7, "the review row has no form");
  });

  it("says all caught up when nothing waits on him", () => {
    const home = mounted();
    assert.equal(fillNeeds(home, [], needsHooks()), 0);
    assert.match(text(home.slots.needs), /All caught up: nothing needs you right now/);
    assert.equal(text(count(home, "needs")), "0");
    assert.ok(!count(home, "needs").classList.contains("hot"));
  });

  it("counts every row by priority, filtered or not, in a section of its own", () => {
    const home = mounted();
    const entries = buildEntries(questions(3), [], new Map(), true);
    fillPriority(home, entries, () => undefined, Date.now(), { scope: "all" }, {});
    assert.equal(text(count(home, "priority")), "3");
    assert.equal(home.slots.priority.querySelectorAll('.row[data-section="priority"]').length, 3);
    assert.ok(home.slots.priority.querySelector(".filters"));
  });

  it("shows the agents' count against the target and the usage's busiest window", () => {
    const home = mounted();
    const active: Active = { board: [], local: null, warnings: [], at: Date.now() };
    fillAgents(home, active, Date.now());
    assert.equal(text(count(home, "agents")), "0/4");
    assert.ok(count(home, "agents").classList.contains("under"));
    fillAgents(home, undefined, Date.now());
    assert.equal(text(count(home, "agents")), "…");

    const usage: UsageData = {
      state: "ok",
      usage: {
        updatedAt: "2026-09-28T15:00:00Z",
        windows: [{ kind: "five_hour", since: "2026-09-28T10:00:00Z", requests: 1, usedPercent: 42, resetsAt: "2026-09-28T20:00:00Z", tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } }],
        workers: [],
      },
    };
    fillUsage(home, usage, null, Date.parse("2026-09-28T15:01:00Z"));
    assert.equal(text(count(home, "usage")), "5-hour 42%");
    assert.ok(home.slots.usage.querySelector(".uw"));
    fillUsage(home, { state: "unreadable" }, null, Date.now());
    assert.equal(text(count(home, "usage")), "private");
  });
});
