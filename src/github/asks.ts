// Review and chore asks: the tracker issues, besides questions, through
// which the bot asks cgwalters to do something. Pure functions over issue
// bodies and REST JSON, so tests feed them synthetic payloads.
//
// Every ask is an open issue in the tracker, assigned to him, with one
// of the labels `question`, `review` or `chore`, and a first line naming
// what it blocks (see answer.ts). After that, one ask per line:
//
//     Ask: Re-approve bootc#2500 at its new head
//     Review: `https://github.com/bootc-dev/bootc/pull/2500` at <40-hex sha>
//
//     Ask: Log in to the console and approve the new key
//
// A review names each PR to review and the head the bot expects. He
// finishes either with a comment on the issue, which the app posts for
// him after he reviews. A `Review:` line that doesn't parse exactly
// unlocks nothing: the issue then offers only a comment box.

import { parseBlocks, type Question, unfencedLines } from "../answer.ts";
import { askKind, askProblem, type IssueRef, type Item, questionOf } from "./board.ts";
import { DRAFT } from "./config.ts";
import type { ReviewAction } from "./forge.ts";

/** A PR the bot asks him to review, at the head it expects. */
export interface ReviewTarget {
  url: string;
  ref: IssueRef;
  /** The 40-hex head the bot asked about. */
  head: string;
}

/** A review or chore issue's body, as far as the app reads it. */
export interface AskBody {
  /** The URL on the `Blocks:` first line. */
  blocks?: string;
  /** The `Ask:` line, without its prefix. */
  ask?: string;
  reviews: ReviewTarget[];
  /** `Review:` lines that didn't parse; any makes the issue comment-only. */
  problems: string[];
}

// GitHub owner and repository names. "." and ".." are refused apart: in
// an API path they would climb out of /repos/{owner}/{repo}.
const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPO = "[A-Za-z0-9._-]{1,100}";
const PR_URL_RE = new RegExp(`^https://github\\.com/(${OWNER})/(${REPO})/pull/([1-9][0-9]{0,9})$`);
const SHA_RE = /^[0-9a-f]{40}$/;

const ASK_LINE_RE = /^Ask:[ \t]*(.+)$/;
// The URL bare or in a code span (the bot backticks upstream URLs, so
// the mention doesn't land on the upstream timeline).
const REVIEW_RE = /^Review:[ \t]+(`?)(\S+?)\1[ \t]+at[ \t]+(\S+)[ \t]*$/;

function dotName(name: string): boolean {
  return name === "." || name === "..";
}

/** A github.com PR URL, strictly: no trailing path, query or fragment. */
export function parsePrUrl(url: string): IssueRef | undefined {
  const m = PR_URL_RE.exec(url);
  if (!m || dotName(m[2] as string)) return undefined;
  return { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

/** Parse a review or chore issue's body (see the format at the top). */
export function parseAskBody(body: string): AskBody {
  const lines = unfencedLines(body);
  const out: AskBody = { reviews: [], problems: [] };
  const blocks = parseBlocks(lines);
  if (blocks) out.blocks = blocks;
  for (const line of lines) {
    const ask = ASK_LINE_RE.exec(line);
    if (ask) {
      out.ask ??= (ask[1] as string).trim();
      continue;
    }
    if (line.startsWith("Review:")) {
      const m = REVIEW_RE.exec(line);
      const ref = m ? parsePrUrl(m[2] as string) : undefined;
      const head = m?.[3] as string;
      if (!m || !ref || !SHA_RE.test(head)) out.problems.push(`can't read ${JSON.stringify(line)}: expected Review: \`https://github.com/OWNER/REPO/pull/N\` at <40-hex sha>`);
      else out.reviews.push({ url: m[2] as string, ref, head });
    }
  }
  return out;
}

/**
 * What the app comments on the review ask after he reviewed its PR, so
 * the bot sees it; undefined for a plain comment review, which settles
 * nothing. It names the head he reviewed, which may not be the one asked
 * about if the PR moved and he confirmed reviewing the new head.
 */
export function reviewComment(verb: ReviewAction, pr: IssueRef, head: string, reviewUrl: string): string | undefined {
  const what = `${pr.owner}/${pr.repo}#${pr.number} at ${head}`;
  switch (verb) {
    case "approve":
      return `Approved ${what}: ${reviewUrl}\n`;
    case "request-changes":
      return `Requested changes on ${what}: ${reviewUrl}\n`;
    case "comment":
      return undefined;
  }
}

/** What the item view offers for an item. */
export type ItemAction =
  /** An open question: the answer form. */
  | { kind: "answer"; ref: IssueRef; question: Question }
  /** A review ask naming PRs to review in the app's review pane. */
  | { kind: "review"; ref: IssueRef; body: AskBody }
  /** A chore, or a review the app can't read: a comment box. */
  | { kind: "comment"; ref: IssueRef; ask: "review" | "chore"; body: AskBody }
  /** An ask the bot closed. */
  | { kind: "done" }
  /** An ask the app can't act on (not assigned to him, say): why. */
  | { kind: "blocked"; reason: string }
  /** Not an ask, and it has open asks: those are the actions. */
  | { kind: "asks" }
  /** Needs human, but the bot left no open ask for it: a bot bug. */
  | { kind: "bug" }
  /** A Draft item: something to read (a gist), or a forge PR's tracking item. */
  | { kind: "read" };

/**
 * Decide what the item view offers. This is the one place that picks
 * it. `openAsks` is how many open asks are nested under the item in the
 * queue: a Needs human item that isn't an ask needs at least one, or the
 * bot left it without telling him what to do.
 */
export function itemAction(item: Item, openAsks: number): ItemAction {
  const kind = askKind(item);
  if (kind === undefined) {
    if (item.status === DRAFT) return { kind: "read" };
    return openAsks > 0 ? { kind: "asks" } : { kind: "bug" };
  }
  if (item.state === "closed") return { kind: "done" };
  const problem = askProblem(item, kind);
  if (problem !== undefined || !item.ref) return { kind: "blocked", reason: problem ?? "no issue" };
  const ref = item.ref;
  if (kind === "question") return { kind: "answer", ref, question: questionOf(item) };
  const body = parseAskBody(item.body);
  if (kind === "review" && body.problems.length === 0 && body.reviews.length > 0) return { kind: "review", ref, body };
  return { kind: "comment", ref, ask: kind, body };
}

/** Why a review ask fell back to a comment box, if it did. */
export function commentNote(action: ItemAction & { kind: "comment" }): string | undefined {
  const { body, ask } = action;
  if (body.problems.length) return body.problems.join("; ");
  if (ask === "review" && body.reviews.length === 0) return "it names no PR to review (no Review: line)";
  if (ask === "chore" && body.reviews.length) return "a chore can't ask for a review; that's a review ask";
  return undefined;
}

/**
 * The open review ask naming this PR, if one is in `items`: it lets the
 * review pane review a PR outside the bot's own space, and tells the bot
 * when he did. The first one wins.
 */
export function reviewAskFor(items: readonly Item[], pr: IssueRef): { item: Item; ref: IssueRef; body: AskBody; target: ReviewTarget } | undefined {
  const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
  for (const item of items) {
    const action = itemAction(item, 0);
    if (action.kind !== "review") continue;
    const target = action.body.reviews.find((r) => `${r.ref.owner}/${r.ref.repo}#${r.ref.number}`.toLowerCase() === key);
    if (target) return { item, ref: action.ref, body: action.body, target };
  }
  return undefined;
}
