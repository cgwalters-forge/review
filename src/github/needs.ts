// What truly waits on him, as one list of single actions: the queue's
// entries that are his turn and the open decisions, each once. A PR is
// reviewed, a forge draft reviewed and promoted, a question answered
// (in place), a chore done or its text written. Pure, so tests can
// check the dedupe and the action each row asks for.

import { itemAction } from "./asks.ts";
import { isQuestion, type Item } from "./board.ts";
import { effectivePriority, type Entry, onBot, priorityRank } from "./queue.ts";
import type { Stop } from "./advance.ts";
import { type Decision, decisionLabel } from "./triage.ts";
import type { PrReason } from "./waiting.ts";
import { refKey } from "./forge.ts";

/** The one thing a row asks of him. */
export type NeedAction = "answer" | "review" | "promote" | "resign" | "rerun" | "write" | "read" | "fix";

export const ACTION_LABEL: Record<NeedAction, string> = {
  answer: "Answer",
  review: "Review",
  promote: "Review & promote",
  resign: "Approve to re-sign",
  rerun: "Rerun checks",
  write: "Write text",
  read: "Read",
  fix: "No ask (bot bug)",
};

export const ACTION_TITLE: Record<NeedAction, string> = {
  answer: "pick an option or write an answer; it is posted as a comment by you",
  review: "review the PR; approving, requesting changes or commenting tells the bot",
  promote: "the bot's draft PR: review it, and approve with /promote to send it upstream",
  resign: "DCO fails on commits lacking your sign-off: approving the head lets the bot add it",
  rerun: "a required check failed and only a maintainer can rerun it",
  write: "the bot asks for something it can't do itself: say what you did or decided",
  read: "a gist or note to read",
  fix: "Needs human, yet the bot named no ask: it should say what it wants",
};

export interface Need {
  /** The entry's key (`pr:…`, `item:…`), or `decision:<node id>` for a decision with no entry. */
  key: string;
  action: NeedAction;
  title: string;
  priority?: string;
  since?: string;
  /** Where it is, e.g. `owner/repo#12`. */
  where: string;
  /** The app route that opens it. */
  href: string;
  /** The entry, when the queue has one. */
  entry?: Entry;
  /** The entry it is nested under (a PR's or item's ask), for context. */
  parent?: Entry;
  /** The decision it is, when it is one (answering it works the same). */
  decision?: Decision;
  /** An open question he can answer on this page. */
  inPlace: boolean;
  /** Answered from this page: kept, dimmed, until the page reloads. */
  done?: boolean;
}

const REASON_ORDER: readonly PrReason[] = ["resign", "rerun", "review-requested", "updated"];
const REASON_ACTION: Record<PrReason, NeedAction> = { resign: "resign", rerun: "rerun", "review-requested": "review", updated: "review" };

/** What an entry that waits on him asks of him; "none" for one that does not wait on him at all. */
function actionOf(e: Entry, openAsks: number): NeedAction | "none" {
  if (e.kind === "pr") {
    const reason = REASON_ORDER.find((r) => e.wait?.reasons.includes(r));
    if (reason) return REASON_ACTION[reason];
    // A forge draft with no wait: his review and /promote is the point of it.
    if (e.pr && !e.wait) return e.verdict?.state === "promoted" ? "none" : "promote";
    return "none";
  }
  const item = e.item;
  if (!item) return "none";
  const action = itemAction(item, openAsks);
  switch (action.kind) {
    case "answer":
      return "answer";
    case "review":
      return "review";
    case "rerun":
      return "rerun";
    case "comment":
      return action.ask === "review" ? "review" : "write";
    case "read":
      return "read";
    case "bug":
      return "fix";
    case "blocked":
      return "read";
    case "asks":
    case "done":
      return "none";
  }
}

function needOf(e: Entry, parent: Entry | undefined, openAsks: number): Need | undefined {
  const action = actionOf(e, openAsks);
  if (action === "none") return undefined;
  const n: Need = { key: e.key, action, title: e.title, where: e.where, href: e.href, entry: e, inPlace: action === "answer" && e.item?.ref !== undefined };
  const priority = effectivePriority(e);
  if (priority) n.priority = priority;
  if (e.since) n.since = e.since;
  if (parent) n.parent = parent;
  return n;
}

/** The refKey of the issue an entry or decision is, lowercased, for matching the two. */
const issueKey = (item: Item | undefined): string | undefined => (item?.ref ? refKey(item.ref).toLowerCase() : undefined);

export interface NeedsInput {
  /** The queue, ranked (buildEntries). */
  entries: readonly Entry[];
  /** The open decisions, in order; undefined until read. */
  decisions?: readonly Decision[] | undefined;
  /** Node ids of decisions he answered and the bot has not acted on. */
  decisionsAnswered?: ReadonlySet<string>;
  /** Keys of rows answered from this page: kept (dimmed) after they stop waiting. */
  answeredHere?: ReadonlySet<string>;
}

/**
 * The rows that wait on him, most urgent first, then those he answered
 * from this page (marked `done`). An item with open asks is not a row:
 * its asks are. A decision that is also a question in the queue is that
 * row, labelled as the decision.
 */
export function buildNeeds(input: NeedsInput): Need[] {
  const out: Need[] = [];
  const done: Need[] = [];
  const keep = input.answeredHere ?? new Set<string>();
  const push = (e: Entry, parent: Entry | undefined, openAsks: number) => {
    // Waiting on the bot, or already answered: not his, unless he answered it from here.
    if (onBot(e)) return;
    if (e.settled) {
      const n = keep.has(e.key) ? needOf({ ...e, settled: false }, parent, openAsks) : undefined;
      if (n) done.push({ ...n, done: true });
      return;
    }
    const n = needOf(e, parent, openAsks);
    if (n) out.push(n);
  };
  for (const e of input.entries) {
    const open = (e.children ?? []).filter((c) => !c.settled && !onBot(c)).length;
    // An item with asks under it is only their context.
    if (e.kind !== "item" || open === 0) push(e, undefined, open);
    for (const c of e.children ?? []) push(c, e, 0);
  }
  const questions = new Map(out.concat(done).flatMap((n) => (n.action === "answer" && issueKey(n.entry?.item) ? [[issueKey(n.entry?.item) as string, n] as const] : [])));
  for (const d of input.decisions ?? []) {
    const hit = questions.get(issueKey(d.item) ?? "");
    if (hit) {
      hit.decision = d;
      continue;
    }
    const key = `decision:${d.item.nodeId}`;
    const answered = input.decisionsAnswered?.has(d.item.nodeId) === true;
    if (answered && !keep.has(key)) continue;
    const n: Need = { key, action: "answer", title: d.title, where: d.item.ref ? refKey(d.item.ref) : decisionLabel(d), href: d.item.ref ? `#item/${d.item.nodeId}` : "#", decision: d, inPlace: d.item.ref !== undefined && isQuestion(d.item) };
    if (d.item.createdAt) n.since = d.item.createdAt;
    (answered ? done : out).push(answered ? { ...n, done: true } : n);
  }
  const time = (n: Need) => {
    const t = n.since ? Date.parse(n.since) : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  out.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || time(a) - time(b) || a.key.localeCompare(b.key));
  return [...out, ...done];
}

/** How many of the rows still wait on him. */
export const waitingCount = (needs: readonly Need[]): number => needs.filter((n) => !n.done).length;

/** The rows as a list to step through: answerable questions are answered in place, the rest open. */
export function needStops(needs: readonly Need[]): Stop[] {
  return needs.map((n) => ({ key: n.key, href: n.inPlace ? "#" : n.href, title: n.decision ? `${decisionLabel(n.decision)}: ${n.title}` : n.title, waiting: !n.done, inPlace: n.inPlace }));
}
