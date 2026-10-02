// Filtering the queue by target organization and priority. The point is
// to tell upstream work (composefs and the projects around it) from work
// on the bot's own harness at a glance. Pure: entries in, entries and
// chip counts out, and the hash token that names a filter.

import { type Item, NO_PRIORITY, PRIORITY_ORDER, repoOf } from "./board.ts";
import { BOT_LOGIN, FORGE_ORG, TRACKER_REPO } from "./config.ts";
import { parseBotMeta } from "./forge.ts";
import { effectivePriority, type Entry } from "./queue.ts";

/** The organizations that are the bot itself: its harness, forks and tracker. */
export const OWN_ORGS: readonly string[] = [BOT_LOGIN, FORGE_ORG];

/** The label prefix naming a tracker issue's target organization. */
export const TARGET_LABEL_PREFIX = "target:";

/** Presets over organizations: everything, upstream work, or the bot's own. */
export type Preset = "all" | "composefs" | "infra";
export const PRESETS: readonly Preset[] = ["all", "composefs", "infra"];
export const PRESET_LABEL: Record<Preset, string> = { all: "All", composefs: "Composefs", infra: "Our infra" };
export const PRESET_TITLE: Record<Preset, string> = {
  all: "everything waiting on you",
  composefs: `upstream work: every target organization but ${OWN_ORGS.join(" and ")}`,
  infra: `the bot's own harness: ${OWN_ORGS.join(" and ")}`,
};

/** The chip for entries whose target organization isn't known. */
export const NO_ORG = "no org";

/** The prefix of a single organization in a filter token (an org may be named like a preset). */
const ORG_TOKEN = "org:";
/** Joins a filter token's scope and priority. */
const TOKEN_SEP = "+";
/** A priority in a token, as the board names them (NONE_TOKEN for none). */
const PRIORITY_TOKEN = /^P[0-9]$/;
/** Stands for "no org" or "no priority" in a token (so an org named "none" can't be picked alone). */
const NONE_TOKEN = "none";
const ORG_NAME = /^[A-Za-z0-9-]+$/;

export interface QueueFilter {
  /** A preset, or one organization (lowercased; NO_ORG for unknown). */
  scope: Preset | { org: string };
  /** One priority (a board name, or NO_PRIORITY), or any. */
  priority?: string;
}

export const ALL: QueueFilter = { scope: "all" };

/** An organization name as a filter holds it: lowercased, and undefined unless it is a valid name. */
function orgName(name: string | undefined): string | undefined {
  const n = name?.trim();
  return n && ORG_NAME.test(n) ? n.toLowerCase() : undefined;
}

/** The organization the board's Org field or a tracker `target:<org>` label names. */
function statedOrg(item: Item): string | undefined {
  const label = item.labels.find((x) => x.toLowerCase().startsWith(TARGET_LABEL_PREFIX));
  return orgName(item.org) ?? orgName(label?.slice(TARGET_LABEL_PREFIX.length));
}

/**
 * The organization an item targets: the board's Org field, else the
 * tracker's `target:<org>` label, else the owner of the issue or PR it
 * is. The tracker's owner says nothing about the target, so a tracker
 * issue with neither has no known org.
 */
export function itemOrg(item: Item): string | undefined {
  const stated = statedOrg(item);
  if (stated || !item.ref || repoOf(item.ref) === TRACKER_REPO.toLowerCase()) return stated;
  return orgName(item.ref.owner);
}

/**
 * The organization an entry targets. A forge PR counts as its upstream
 * (from bot-meta), else what its board item states, else the fork's
 * owner; other entries are their item's.
 */
export function entryOrg(e: Entry): string | undefined {
  if (e.pr) {
    const up = parseBotMeta(e.pr.body).upstream?.split("/")[0];
    return orgName(up) ?? (e.item ? statedOrg(e.item) : undefined) ?? orgName(e.pr.ref.owner);
  }
  return e.item ? itemOrg(e.item) : undefined;
}

export function isOwnOrg(org: string): boolean {
  return OWN_ORGS.some((o) => o.toLowerCase() === org);
}

function inScope(org: string | undefined, scope: QueueFilter["scope"]): boolean {
  if (scope === "all") return true;
  if (scope === "composefs") return org !== undefined && !isOwnOrg(org);
  if (scope === "infra") return org !== undefined && isOwnOrg(org);
  return (org ?? NO_ORG) === scope.org;
}

function priorityOf(e: Entry): string {
  return effectivePriority(e) ?? NO_PRIORITY;
}

function matches(e: Entry, f: QueueFilter): boolean {
  return inScope(entryOrg(e), f.scope) && (f.priority === undefined || priorityOf(e) === f.priority);
}

/** Rows an entry shows: itself and its nested asks. */
const rowsOf = (e: Entry) => 1 + (e.children?.length ?? 0);

/** The top-level entries a filter keeps, in order; nested asks go with their entry. */
export function applyFilter(entries: readonly Entry[], f: QueueFilter): Entry[] {
  return entries.filter((e) => matches(e, f));
}

export interface Chip {
  /** The filter clicking it selects. */
  filter: QueueFilter;
  label: string;
  title?: string;
  /** Rows it would show. */
  count: number;
  on: boolean;
}

export interface Chips {
  presets: Chip[];
  orgs: Chip[];
  priorities: Chip[];
}

function sameScope(a: QueueFilter["scope"], b: QueueFilter["scope"]): boolean {
  return typeof a === "string" || typeof b === "string" ? a === b : a.org === b.org;
}

function withPriority(scope: QueueFilter["scope"], priority: string | undefined): QueueFilter {
  return priority === undefined ? { scope } : { scope, priority };
}

/**
 * The chips to show, from the entries themselves: every organization and
 * priority that occurs, plus the chosen ones even when nothing has them
 * any more (a remembered filter must stay visible to be cleared).
 * Priorities that no token can name get no chip. Counts are faceted: a scope chip counts under
 * the chosen priority, a priority chip under the chosen scope. Clicking
 * the chosen org or priority again clears it.
 */
export function chips(entries: readonly Entry[], f: QueueFilter): Chips {
  const count = (g: QueueFilter) => applyFilter(entries, g).reduce((n, e) => n + rowsOf(e), 0);
  const presets = PRESETS.map((p) => {
    const filter = withPriority(p, f.priority);
    return { filter, label: PRESET_LABEL[p], title: PRESET_TITLE[p], count: count(filter), on: f.scope === p };
  });
  // Upstream first, then the bot's own, then unknown; within each, by
  // total rows, so the order stays put as the priority changes.
  const group = (org: string) => (org === NO_ORG ? 2 : isOwnOrg(org) ? 1 : 0);
  const totals = new Map<string, number>();
  for (const e of entries) {
    const org = entryOrg(e) ?? NO_ORG;
    totals.set(org, (totals.get(org) ?? 0) + rowsOf(e));
  }
  if (typeof f.scope !== "string" && !totals.has(f.scope.org)) totals.set(f.scope.org, 0);
  const orgs = [...totals.keys()]
    .sort((a, b) => group(a) - group(b) || (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b))
    .map((org) => {
      const on = sameScope(f.scope, { org });
      const filter = withPriority(on ? "all" : { org }, f.priority);
      const title = org === NO_ORG ? "entries with no target organization" : isOwnOrg(org) ? "the bot's own" : "upstream";
      return { filter, label: org, title, count: count(withPriority({ org }, f.priority)), on };
    });
  const present = new Set(entries.map(priorityOf).filter((p) => p === NO_PRIORITY || PRIORITY_TOKEN.test(p)));
  if (f.priority !== undefined) present.add(f.priority);
  const order = [...PRIORITY_ORDER, ...[...present].filter((p) => !PRIORITY_ORDER.includes(p) && p !== NO_PRIORITY).sort(), NO_PRIORITY];
  const priorities = order
    .filter((p) => present.has(p))
    .map((p) => {
      const on = f.priority === p;
      return { filter: withPriority(f.scope, on ? undefined : p), label: p, count: count({ scope: f.scope, priority: p }), on };
    });
  return { presets, orgs, priorities };
}

/** The filter in words, for the folded filter bar: "All", "Composefs · P0", "bootc-dev". */
export function filterText(f: QueueFilter): string {
  const scope = typeof f.scope === "string" ? PRESET_LABEL[f.scope] : f.scope.org;
  return f.priority === undefined ? scope : `${scope} · ${f.priority}`;
}

/** The hash token naming a filter, e.g. `composefs`, `org:bootc-dev+P0`, `all`. */
export function filterToken(f: QueueFilter): string {
  const scope = typeof f.scope === "string" ? f.scope : `${ORG_TOKEN}${f.scope.org === NO_ORG ? NONE_TOKEN : f.scope.org}`;
  if (f.priority === undefined) return scope;
  return `${scope}${TOKEN_SEP}${f.priority === NO_PRIORITY ? NONE_TOKEN : f.priority}`;
}

/** The filter a token names (see filterToken), or undefined if it names none. */
export function parseFilterToken(token: string): QueueFilter | undefined {
  const parts = token.split(TOKEN_SEP);
  if (parts.length > 2) return undefined;
  const [s = "", p] = parts;
  let scope: QueueFilter["scope"];
  const preset = PRESETS.find((x) => x === s);
  if (preset) {
    scope = preset;
  } else if (s.startsWith(ORG_TOKEN)) {
    const org = s.slice(ORG_TOKEN.length);
    const name = org === NONE_TOKEN ? NO_ORG : orgName(org);
    if (!name) return undefined;
    scope = { org: name };
  } else {
    return undefined;
  }
  if (p === undefined) return { scope };
  if (p === NONE_TOKEN) return { scope, priority: NO_PRIORITY };
  return PRIORITY_TOKEN.test(p) ? { scope, priority: p } : undefined;
}

/** A remembered filter, as stored: its token. */
export function isFilterToken(v: unknown): v is string {
  return typeof v === "string" && parseFilterToken(v) !== undefined;
}
