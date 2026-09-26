// The one ranked queue: forge PRs waiting for his review, board questions
// and chores, P0 first, then oldest first. Pure, so tests can check the
// ranking and what gets merged or dropped.

import { type Item, NO_PRIORITY, PRIORITY_ORDER, questionOf } from "./board.ts";
import { DRAFT, FORGE_ORG, NEEDS_HUMAN } from "./config.ts";
import { type ForgePr, parseBotMeta, refKey, type Verdict, waitsOnReviewer } from "./forge.ts";

export type EntryKind = "pr" | "question" | "chore";

export interface Entry {
  /** `pr:owner/repo#n` or `item:PVTI_...`. */
  key: string;
  kind: EntryKind;
  priority?: string;
  /** When it started waiting, as far as the API says (ISO 8601). */
  since?: string;
  title: string;
  /** Where it is, e.g. `owner/repo#12`, or "draft item". */
  where: string;
  /** The app route that opens it. */
  href: string;
  /** The board item: the entry itself, or the one tracking a PR. */
  item?: Item;
  pr?: ForgePr;
  verdict?: Verdict;
}

/** Rank in PRIORITY_ORDER; anything else ranks after it, and none last. */
export function priorityRank(p: string | undefined): number {
  if (p === undefined) return PRIORITY_ORDER.length + 1;
  const i = PRIORITY_ORDER.indexOf(p);
  return i < 0 ? PRIORITY_ORDER.length : i;
}

/** Priority first, then oldest first (no date last), then by key for stability. */
export function rankEntries(entries: readonly Entry[]): Entry[] {
  const time = (e: Entry) => {
    const t = e.since ? Date.parse(e.since) : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...entries].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || time(a) - time(b) || a.key.localeCompare(b.key),
  );
}

const FORGE_PR_RE = new RegExp(`^https://github\\.com/${FORGE_ORG}/[A-Za-z0-9._-]+/pull/\\d+$`);

export function prHref(pr: ForgePr): string {
  return `#pr/${pr.ref.owner}/${pr.ref.repo}/${pr.ref.number}`;
}

export function itemHref(item: Item): string {
  return `#item/${item.nodeId}`;
}

function itemWhere(item: Item): string {
  if (item.ref) return refKey(item.ref);
  return item.kind === "draft" ? "draft item" : "item";
}

/**
 * Merge the board and the forge into one ranked list.
 *
 * - A forge PR is listed while it waits on him (see waitsOnReviewer; an
 *   unknown verdict counts as waiting). Its priority is its board item's,
 *   found by the item id in its bot-meta section, else by Branch.
 * - A Draft board item tracking a forge PR is that PR's entry, never a
 *   second one. One whose Branch holds only forge PRs, none of them open
 *   and waiting, is stale (promoted or closed) and dropped.
 * - Other Draft items (a gist to read) are chores, and so are Needs human
 *   items that ask no question with options.
 *
 * Until the forge has been read once (`forgeKnown`), nothing is stale:
 * forge-only Draft items are listed as chores rather than dropped.
 */
export function buildEntries(
  items: readonly Item[],
  prs: readonly ForgePr[],
  verdicts: ReadonlyMap<string, Verdict>,
  forgeKnown = true,
): Entry[] {
  const byNode = new Map(items.map((i) => [i.nodeId, i]));
  const byBranch = new Map<string, Item>();
  for (const i of items) for (const u of i.branch) if (!byBranch.has(u)) byBranch.set(u, i);
  const tracked = new Set<string>();
  const out: Entry[] = [];

  for (const pr of prs) {
    const metaItem = parseBotMeta(pr.body).item;
    const item = (metaItem ? byNode.get(metaItem) : undefined) ?? byBranch.get(pr.url);
    if (item?.status === DRAFT) tracked.add(item.nodeId);
    const key = refKey(pr.ref);
    const verdict = verdicts.get(key);
    if (verdict && !waitsOnReviewer(verdict)) continue;
    const e: Entry = { key: `pr:${key}`, kind: "pr", title: pr.title, where: key, href: prHref(pr), pr };
    if (item?.priority) e.priority = item.priority;
    if (item) e.item = item;
    if (pr.createdAt) e.since = pr.createdAt;
    if (verdict) e.verdict = verdict;
    out.push(e);
  }

  for (const item of items) {
    if (tracked.has(item.nodeId)) continue;
    let kind: EntryKind;
    if (item.status === DRAFT) {
      const forgeOnly = item.branch.length > 0 && item.branch.every((u) => FORGE_PR_RE.test(u));
      if (forgeOnly && forgeKnown) continue;
      kind = "chore";
    } else if (item.status === NEEDS_HUMAN) {
      kind = questionOf(item).options.length > 0 ? "question" : "chore";
    } else {
      continue;
    }
    const e: Entry = { key: `item:${item.nodeId}`, kind, title: item.title, where: itemWhere(item), href: itemHref(item), item };
    if (item.priority) e.priority = item.priority;
    const since = item.createdAt ?? item.updatedAt;
    if (since) e.since = since;
    out.push(e);
  }
  return rankEntries(out);
}

export interface EntryGroup {
  priority: string;
  entries: Entry[];
}

/** Consecutive runs of one priority in a ranked list, for headings. */
export function groupRanked(entries: readonly Entry[]): EntryGroup[] {
  const out: EntryGroup[] = [];
  for (const e of entries) {
    const p = e.priority ?? NO_PRIORITY;
    const last = out.at(-1);
    if (last?.priority === p) last.entries.push(e);
    else out.push({ priority: p, entries: [e] });
  }
  return out;
}
