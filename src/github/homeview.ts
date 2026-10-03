// The one page: collapsible sections (see sections.ts) that main.ts fills
// as their data arrives. The skeleton is built once and stays in place
// across data refreshes, so a section's open state, a half-typed answer
// and the scroll position are not lost when something behind them
// changes. Every section shows its count in its header and a few rows
// before "View all".

import { h } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { Active } from "./agents.ts";
import { agentsBody, agentsSummary } from "./agentsview.ts";
import type { Item } from "./board.ts";
import { diffBoard, type Snapshot } from "./boardfeed.ts";
import { type FeedOptions, feedSection } from "./boardfeedview.ts";
import type { QueueFilter } from "./filter.ts";
import type { Heartbeat } from "./heartbeat.ts";
import type { News } from "./news.ts";
import { newsList } from "./newsview.ts";
import { type Need, waitingCount } from "./needs.ts";
import { NEED_CLASS, needRow, type NeedsHooks } from "./needsview.ts";
import { type Ops } from "./ops.ts";
import { opsDetail, usageSection, usageSummary } from "./opsview.ts";
import type { Entry } from "./queue.ts";
import { PREVIEW_ROWS, SECTION_HINT, SECTION_TITLE, SECTIONS, type SectionId } from "./sections.ts";
import type { OpenBoard } from "./backend.ts";
import type { TriageFilter } from "./triage.ts";
import type { UsageData } from "./usage.ts";
import { triageView, type TriageHooks } from "./triageview.ts";
import { CAUGHT_UP_CLASS, type ListExtras, priorityList, ROW_CLASS, type RowLabel } from "./view.ts";

/** The class of the page, of a section, and of its count. */
export const HOME_CLASS = "home";
export const SECTION_CLASS = "sec";
export const COUNT_CLASS = "sec-count";
export const VIEW_ALL_CLASS = "view-all";

/** A section's parts. */
export interface SectionEls {
  details: HTMLDetailsElement;
  count: HTMLElement;
  body: HTMLElement;
}

/** The places the sections' data goes. */
export interface Slots {
  needs: HTMLElement;
  agents: HTMLElement;
  /** The ops detail under the agents, and its fold. */
  ops: HTMLElement;
  opsBox: HTMLDetailsElement;
  feed: HTMLElement;
  news: HTMLElement;
  priority: HTMLElement;
  /** The themes and verdicts under the priority list, and their fold. */
  themes: HTMLElement;
  themesBox: HTMLDetailsElement;
  usage: HTMLElement;
}

export interface Home {
  el: HTMLElement;
  sections: Record<SectionId, SectionEls>;
  slots: Slots;
  /** The open state each section is expected to have, so a toggle by code isn't taken for his. */
  expected: Map<SectionId, boolean>;
}

export interface HomeHooks {
  /** Whether each section starts open. */
  open(id: SectionId): boolean;
  /** He opened or closed a section. */
  toggled(id: SectionId, open: boolean): void;
  /** He opened or closed the ops detail, or the themes under the priority list. */
  opsToggled(open: boolean): void;
  themesToggled(open: boolean): void;
}

/** Sections whose "View all" is open: kept across re-renders, not across reloads. */
const expanded = new Set<string>();

/** Forget which "View all" were opened (tests). */
export function resetExpanded(): void {
  expanded.clear();
}

function section(id: SectionId, home: Pick<Home, "expected">, hooks: HomeHooks, ...body: HTMLElement[]): SectionEls {
  const count = h("span", { class: COUNT_CLASS }, "…");
  const bodyEl = h("div", { class: "sec-body" }, ...body);
  const details = h(
    "details",
    { class: `${SECTION_CLASS} sec-${id}`, id: `sec-${id}`, "data-section": id },
    h("summary", {}, h("span", { class: "sec-title" }, SECTION_TITLE[id]), count, h("span", { class: "sec-hint" }, SECTION_HINT[id])),
    bodyEl,
  );
  details.open = hooks.open(id);
  home.expected.set(id, details.open);
  details.addEventListener("toggle", () => {
    if (details.open === home.expected.get(id)) return;
    home.expected.set(id, details.open);
    hooks.toggled(id, details.open);
  });
  return { details, count, body: bodyEl };
}

function fold(cls: string, label: string, onToggle: (open: boolean) => void): { box: HTMLDetailsElement; slot: HTMLElement } {
  const slot = h("div", { class: `${cls}-slot` });
  const box = h("details", { class: `sub-fold ${cls}` }, h("summary", {}, label), slot);
  box.addEventListener("toggle", () => onToggle(box.open));
  return { box, slot };
}

export function homeSkeleton(hooks: HomeHooks): Home {
  const expected = new Map<SectionId, boolean>();
  const needs = h("div", { class: "needs-slot" });
  const agents = h("div", { class: "agents-slot" });
  const ops = fold("ops-fold", "Devspaces, agent runs and the bot's activity", hooks.opsToggled);
  const feed = h("div", { class: "feed-slot" });
  const news = h("div", { class: "news-slot" });
  const priority = h("div", { class: "priority-slot" });
  const themes = fold("themes-fold", "Themes and verdicts (every open board item)", hooks.themesToggled);
  const usage = h("div", { class: "usage-slot" });
  const ctx = { expected };
  const sections: Record<SectionId, SectionEls> = {
    needs: section("needs", ctx, hooks, needs),
    agents: section("agents", ctx, hooks, agents, ops.box),
    changes: section("changes", ctx, hooks, feed, news),
    priority: section("priority", ctx, hooks, priority, themes.box),
    usage: section("usage", ctx, hooks, usage),
  };
  const el = h("div", { class: HOME_CLASS }, ...SECTIONS.map((id) => sections[id].details));
  return { el, sections, slots: { needs, agents, ops: ops.slot, opsBox: ops.box, feed, news, priority, themes: themes.slot, themesBox: themes.box, usage }, expected };
}

/** Open or close a section from code (a jump, or its default changing). With `remember`, as if he did. */
export function setSectionOpen(home: Home, id: SectionId, open: boolean, remember: boolean, hooks: Pick<HomeHooks, "toggled">): void {
  const { details } = home.sections[id];
  if (details.open === open) return;
  if (remember) hooks.toggled(id, open);
  home.expected.set(id, open);
  details.open = open;
}

/** Set a section's count, with what it says to a screen reader. */
export function setCount(home: Home, id: SectionId, text: string, opts: { title?: string; hot?: boolean } = {}): void {
  const el = home.sections[id].count;
  el.textContent = text;
  el.title = opts.title ?? "";
  el.classList.toggle("hot", opts.hot === true);
}

/**
 * Show only the first `limit` rows of `slot` (those matching `rowSelector`)
 * until "View all" is pressed, and hide the lists and groups left with
 * no row showing. The button goes at the end of the slot.
 */
export function applyLimit(slot: HTMLElement, id: string, rowSelector: string, limit: number = PREVIEW_ROWS): void {
  slot.querySelector(`:scope > .${VIEW_ALL_CLASS}`)?.remove();
  const rows = [...slot.querySelectorAll<HTMLElement>(rowSelector)];
  const all = expanded.has(id);
  rows.forEach((r, i) => {
    r.hidden = !all && i >= limit;
  });
  for (const box of slot.querySelectorAll<HTMLElement>("section.group, ul")) {
    const inside = rows.filter((r) => box.contains(r));
    const empty = inside.length > 0 && inside.every((r) => r.hidden);
    box.hidden = empty;
    const before = box.previousElementSibling;
    if (before?.tagName === "H3") (before as HTMLElement).hidden = empty;
  }
  if (rows.length <= limit) return;
  const button = h("button", { type: "button", class: `small ${VIEW_ALL_CLASS}`, "aria-expanded": String(all) }, all ? "Show fewer" : `View all ${rows.length}`);
  button.addEventListener("click", () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    applyLimit(slot, id, rowSelector, limit);
  });
  slot.append(button);
}

/** Make sure a row can be seen: open "View all" for the list it is in, if it is hidden. */
export function reveal(row: HTMLElement, slot: HTMLElement, id: string, rowSelector: string): void {
  if (!row.hidden && !row.closest("[hidden]")) return;
  expanded.add(id);
  applyLimit(slot, id, rowSelector);
}

/** The rows the keyboard walks: those in an open section, not hidden by "View all". */
export function walkRows(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)].filter((r) => !r.closest("[hidden], details:not([open])"));
}

/** Move within the walkable rows, stopping at either end; without a selection, start at the first. */
export function stepRow(rows: readonly HTMLElement[], selected: HTMLElement | undefined, step: 1 | -1): HTMLElement | undefined {
  const i = selected ? rows.indexOf(selected) : -1;
  return rows[Math.max(0, Math.min(rows.length - 1, i + step))];
}

/** The ids the lists use for "View all". */
export const LIMIT_ID = { needs: "needs", agents: "agents", feed: "changes-feed", news: "changes-news", priority: "priority", usage: "usage" } as const;
export const NEED_ROW_SELECTOR = `.${NEED_CLASS}`;

// What each section is filled with.

export function fillNeeds(home: Home, needs: readonly Need[], hooks: NeedsHooks): number {
  const slot = home.slots.needs;
  const waiting = waitingCount(needs);
  if (needs.length === 0) slot.replaceChildren(h("p", { class: `empty ${CAUGHT_UP_CLASS}` }, "All caught up: nothing needs you right now."));
  else slot.replaceChildren(...needs.map((n) => needRow(n, hooks)));
  applyLimit(slot, LIMIT_ID.needs, NEED_ROW_SELECTOR);
  setCount(home, "needs", String(waiting), { title: `${waiting} waiting on you`, hot: waiting > 0 });
  return waiting;
}

export function fillAgents(home: Home, active: Active | undefined, now: number): void {
  const slot = home.slots.agents;
  slot.replaceChildren(agentsBody(active, now));
  applyLimit(slot, LIMIT_ID.agents, ".as-agent");
  const s = agentsSummary(active, now);
  setCount(home, "agents", s.count, { title: s.title });
  home.sections.agents.count.classList.toggle("under", s.under);
}

/** The ops detail; returns its element, whose live times main.ts keeps ticking. */
export function fillOps(home: Home, ops: Ops | undefined, now: number): HTMLElement {
  const el = opsDetail(ops, now);
  home.slots.ops.replaceChildren(el);
  return el;
}

export interface ChangesData {
  board?: readonly Item[] | undefined;
  seen: Snapshot | undefined;
  fromCache: boolean;
  news: News | undefined;
  feed: Pick<FeedOptions, "urgentOnly" | "onUrgentOnly" | "onSeen">;
}

export function fillChanges(home: Home, data: ChangesData, render: Renderer, now: number): void {
  home.slots.feed.replaceChildren(feedSection(data.board, data.seen, { ...data.feed, now, ...(data.fromCache ? { fromCache: true } : {}) }));
  applyLimit(home.slots.feed, LIMIT_ID.feed, ".feed-row");
  home.slots.news.replaceChildren(newsList(data.news, render, now));
  applyLimit(home.slots.news, LIMIT_ID.news, ".news-item");
  const changed = data.board && data.seen && !data.fromCache ? diffBoard(data.seen, data.board).length : undefined;
  setCount(home, "changes", changed === undefined ? "—" : String(changed), { title: changed === undefined ? "board changes since you last looked: not known yet" : `${changed} items changed on the board since you last looked`, hot: changed !== undefined && changed > 0 });
}

export function fillPriority(home: Home, entries: readonly Entry[], labelOf: (e: Entry) => RowLabel | undefined, now: number, filter: QueueFilter, extras: ListExtras): void {
  const slot = home.slots.priority;
  slot.replaceChildren(priorityList(entries, labelOf, now, filter, extras));
  applyLimit(slot, LIMIT_ID.priority, ".row");
  const rows = entries.reduce((n, e) => n + 1 + (e.children?.length ?? 0), 0);
  setCount(home, "priority", String(rows), { title: `${rows} rows in the queue, ranked by priority` });
}

export function fillThemes(home: Home, board: OpenBoard | undefined, filter: TriageFilter, hooks: TriageHooks): void {
  home.slots.themes.replaceChildren(triageView(board, filter, hooks));
}

export function fillUsage(home: Home, usage: UsageData | undefined, hb: Heartbeat | null | undefined, now: number): void {
  const slot = home.slots.usage;
  const body = usageSection(usage, hb, now);
  slot.replaceChildren(body ?? h("p", { class: "note" }, "Reading…"));
  applyLimit(slot, LIMIT_ID.usage, ".uc");
  setCount(home, "usage", usageSummary(usage));
}
