// The one ranked queue: forge PRs waiting for his review, board questions
// and chores, P0 first, then oldest first. Pure, so tests can check the
// ranking and what gets merged or dropped.

import { blockedBy, isQuestion, type Item, NO_PRIORITY, PRIORITY_ORDER } from "./board.ts";
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
  /** A question he answered, or the bot closed: waiting on the bot, not him. */
  settled?: boolean;
  /** The questions blocking this entry's item, nested under it. */
  children?: Entry[];
  /**
   * The priority it ranks and groups by, when an open nested question's
   * outranks its own; `priority` stays what the board says.
   */
  rankPriority?: string;
  /** The item a top-level question blocks, when that isn't in the queue. */
  blocks?: string;
}

/** Group heading for settled questions, listed after everything else. */
export const SETTLED_GROUP = "Answered, waiting on the bot";

/** Rank in PRIORITY_ORDER; anything else ranks after it, and none last. */
export function priorityRank(p: string | undefined): number {
  if (p === undefined) return PRIORITY_ORDER.length + 1;
  const i = PRIORITY_ORDER.indexOf(p);
  return i < 0 ? PRIORITY_ORDER.length : i;
}

/** The priority an entry ranks by: its own, or its most urgent open question's. */
export function effectivePriority(e: Entry): string | undefined {
  return e.rankPriority ?? e.priority;
}

/** Settled last, then priority, then oldest first (no date last), then by key for stability. */
export function rankEntries(entries: readonly Entry[]): Entry[] {
  const time = (e: Entry) => {
    const t = e.since ? Date.parse(e.since) : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...entries].sort(
    (a, b) =>
      Number(a.settled === true) - Number(b.settled === true) ||
      priorityRank(effectivePriority(a)) - priorityRank(effectivePriority(b)) ||
      time(a) - time(b) ||
      a.key.localeCompare(b.key),
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
 * - Question issues in the tracker are questions: settled (listed last)
 *   once he answered (`answered`, by node id) or the bot closed them.
 *   One whose blocked item (its parent issue, else its `Blocks:` URL) is
 *   also listed is nested under that entry rather than listed twice.
 * - Other Draft items (a gist to read) are chores, and so are Needs human
 *   items that aren't questions.
 *
 * Until the forge has been read once (`forgeKnown`), nothing is stale:
 * forge-only Draft items are listed as chores rather than dropped.
 */
export function buildEntries(
  items: readonly Item[],
  prs: readonly ForgePr[],
  verdicts: ReadonlyMap<string, Verdict>,
  forgeKnown = true,
  answered: ReadonlySet<string> = new Set(),
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
    if (isQuestion(item)) {
      kind = "question";
    } else if (item.status === DRAFT) {
      const forgeOnly = item.branch.length > 0 && item.branch.every((u) => FORGE_PR_RE.test(u));
      if (forgeOnly && forgeKnown) continue;
      kind = "chore";
    } else if (item.status === NEEDS_HUMAN) {
      kind = "chore";
    } else {
      continue;
    }
    const e: Entry = { key: `item:${item.nodeId}`, kind, title: item.title, where: itemWhere(item), href: itemHref(item), item };
    if (item.priority) e.priority = item.priority;
    const since = item.createdAt ?? item.updatedAt;
    if (since) e.since = since;
    if (kind === "question" && (item.state === "closed" || answered.has(item.nodeId))) e.settled = true;
    out.push(e);
  }
  return rankEntries(nestQuestions(out));
}

/**
 * The issues and PRs an entry is about, as refKeys: a forge PR entry
 * stands for its PR and for the Draft board item it folded in (often a
 * tracker issue, whose questions name that issue). A PR entry's item that
 * wasn't folded in (say, Needs human) has an entry of its own, which is
 * where its questions belong.
 */
function entryRefs(e: Entry): string[] {
  const item = e.kind !== "pr" || e.item?.status === DRAFT ? e.item : undefined;
  return [e.pr?.ref, item?.ref].flatMap((r) => (r ? [refKey(r).toLowerCase()] : []));
}

/**
 * Move each question under the entry for the item it blocks, when that
 * is listed and isn't a question itself; the rest stay top-level, noting
 * what they block. A parent ranks by its most urgent open question when
 * that outranks it, so nesting never buries a P0 question under a P2
 * item.
 */
function nestQuestions(entries: Entry[]): Entry[] {
  const parents = new Map<string, Entry>();
  for (const e of entries) {
    if (e.kind === "question") continue;
    for (const ref of entryRefs(e)) if (!parents.has(ref)) parents.set(ref, e);
  }
  const top: Entry[] = [];
  for (const e of entries) {
    const blocked = e.item ? blockedBy(e.item) : undefined;
    const parent = blocked ? parents.get(refKey(blocked).toLowerCase()) : undefined;
    if (parent) {
      (parent.children ??= []).push(e);
      continue;
    }
    if (blocked) e.blocks = refKey(blocked);
    top.push(e);
  }
  for (const e of top) {
    if (!e.children) continue;
    e.children = rankEntries(e.children);
    const urgent = e.children.find((c) => !c.settled);
    if (urgent && priorityRank(urgent.priority) < priorityRank(e.priority) && urgent.priority !== undefined) {
      e.rankPriority = urgent.priority;
    }
  }
  return top;
}

export interface EntryGroup {
  priority: string;
  entries: Entry[];
}

/** Consecutive runs of one priority (or settled) in a ranked list, for headings. */
export function groupRanked(entries: readonly Entry[]): EntryGroup[] {
  const out: EntryGroup[] = [];
  for (const e of entries) {
    const p = e.settled ? SETTLED_GROUP : (effectivePriority(e) ?? NO_PRIORITY);
    const last = out.at(-1);
    if (last?.priority === p) last.entries.push(e);
    else out.push({ priority: p, entries: [e] });
  }
  return out;
}
