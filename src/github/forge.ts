// Forge PRs: the bot's draft PRs in cgwalters-forge that wait for
// cgwalters' review. Pure functions over REST JSON (search results,
// reviews, patches, checks) and the review the app submits, so tests
// feed them synthetic payloads.
//
// The review is what `bot-pr promote` keys on: the latest APPROVED,
// CHANGES_REQUESTED or DISMISSED review by cgwalters, or conversation
// comment of his with a `/promote` line, decides, and an approval counts
// only for the commit it names (commit_id), which must be the PR's
// current head. So the app always submits with commit_id set to the head
// it showed, after checking the head didn't move. A `/promote` comment
// names no commit; bot-pr dates it against the push log, which the app
// can't read, so it shows such a PR as promoted but leaves the decision
// (and the PR, in the queue) to bot-pr.

import { AnswerError, isCommandLine } from "../answer.ts";
import { type IssueRef, parseIssueUrl } from "./board.ts";

/** A line in an approving review asking promote for a draft upstream PR. */
export const DRAFT_LINE = "/draft";
/** Lines in his conversation comments that approve, as bot-pr reads them. */
export const PROMOTE_LINES: readonly string[] = ["/promote", "/promote --human-text"];

/** `owner/repo#number`, the key the app uses for a PR everywhere. */
export function refKey(r: IssueRef): string {
  return `${r.owner}/${r.repo}#${r.number}`;
}

export interface ForgePr {
  ref: IssueRef;
  url: string;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

/** The subset of a search/issues result the app uses. */
export interface RawSearchIssue {
  html_url?: string;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
  draft?: boolean;
  pull_request?: unknown;
}

/** A PR from a search result, or undefined if it isn't one. */
export function parseSearchPr(raw: RawSearchIssue): ForgePr | undefined {
  if (!raw.pull_request || !raw.html_url || !/\/pull\/\d+$/.test(raw.html_url)) return undefined;
  const ref = parseIssueUrl(raw.html_url);
  if (!ref) return undefined;
  return {
    ref,
    url: raw.html_url,
    title: raw.title?.trim() || "(no title)",
    body: raw.body ?? "",
    author: raw.user?.login ?? "ghost",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
    draft: raw.draft === true,
  };
}

const META_START = "<!-- bot-meta -->";
const META_END = "<!-- /bot-meta -->";

/** What bot-pr records in a fork PR's bot-meta section. */
export interface BotMeta {
  /** The upstream repository, `owner/repo`. */
  upstream?: string;
  /** The upstream base branch. */
  base?: string;
  /** The Workstream board item, `PVTI_...`. */
  item?: string;
}

function metaSection(body: string): string | undefined {
  const start = body.indexOf(META_START);
  if (start < 0) return undefined;
  const end = body.indexOf(META_END, start);
  return body.slice(start + META_START.length, end < 0 ? undefined : end);
}

/** Parse the bot-meta section of a fork PR body; empty if there is none. */
export function parseBotMeta(body: string): BotMeta {
  const meta: BotMeta = {};
  const section = metaSection(body.replace(/\r\n?/g, "\n"));
  if (section === undefined) return meta;
  const up = /^- Upstream: `([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`(?:, base `([^`\s]+)`)?/m.exec(section);
  if (up?.[1]) meta.upstream = up[1];
  if (up?.[2]) meta.base = up[2];
  const item = /^- Board item: `(PVTI_[A-Za-z0-9_-]+)`/m.exec(section);
  if (item?.[1]) meta.item = item[1];
  return meta;
}

/** The body as it will read upstream: without the bot-meta section. */
export function withoutBotMeta(body: string): string {
  const start = body.indexOf(META_START);
  if (start < 0) return body;
  const end = body.indexOf(META_END, start);
  return (body.slice(0, start) + (end < 0 ? "" : body.slice(end + META_END.length))).trimEnd();
}

export interface RawReview {
  id?: number;
  user?: { login?: string } | null;
  state?: string;
  commit_id?: string | null;
  submitted_at?: string | null;
  html_url?: string;
  body?: string | null;
}

export interface RawIssueComment {
  user?: { login?: string } | null;
  body?: string | null;
  created_at?: string;
  html_url?: string;
}

/** Whether a comment has a line bot-pr reads as `/promote` (trimming spaces and tabs, as it does). */
export function hasPromoteLine(body: string): boolean {
  return body
    .replace(/\r/g, "")
    .split("\n")
    .some((l) => PROMOTE_LINES.includes(l.replace(/^[ \t]+|[ \t]+$/g, "")));
}

export type VerdictState =
  /** No approval or change request by him (or the last was dismissed). */
  | "none"
  /** He approved the current head: promote can go ahead. */
  | "approved"
  /** He approved an older head; the commits since are unreviewed. */
  | "approved-older"
  /** He asked for changes on the current head: the bot owes a push. */
  | "changes-requested"
  /** He asked for changes, and the bot pushed since. */
  | "changes-requested-older"
  /** His latest word is a `/promote` comment; bot-pr decides which head it approves. */
  | "promoted";

export interface Verdict {
  state: VerdictState;
  at?: string;
  url?: string;
}

const DECIDING = ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"];

interface Decision {
  kind: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PROMOTE";
  at: string;
  commit?: string | null | undefined;
  url?: string | undefined;
}

/**
 * His latest deciding review or `/promote` comment, read against the
 * current head, as bot-pr does. Ties keep the later entry in API order,
 * and entries without a date are ignored.
 */
export function reviewVerdict(
  reviews: readonly RawReview[],
  head: string,
  reviewer: string,
  comments: readonly RawIssueComment[] = [],
): Verdict {
  const decisions: Decision[] = [
    ...reviews
      .filter((r) => r.user?.login === reviewer && DECIDING.includes(r.state ?? "") && r.submitted_at)
      .map((r): Decision => ({ kind: r.state as Decision["kind"], at: r.submitted_at ?? "", commit: r.commit_id, url: r.html_url })),
    ...comments
      .filter((c) => c.user?.login === reviewer && c.created_at && hasPromoteLine(c.body ?? ""))
      .map((c): Decision => ({ kind: "PROMOTE", at: c.created_at ?? "", url: c.html_url })),
  ];
  // A stable sort, so equal times keep reviews' and then comments' order.
  // ISO 8601 times compare as strings, as bot-pr's sort_by does.
  const last = decisions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).at(-1);
  if (!last || last.kind === "DISMISSED") return { state: "none" };
  const current = last.commit === head;
  const state: VerdictState =
    last.kind === "PROMOTE"
      ? "promoted"
      : last.kind === "APPROVED"
        ? current
          ? "approved"
          : "approved-older"
        : current
          ? "changes-requested"
          : "changes-requested-older";
  const v: Verdict = { state, at: last.at };
  if (last.url) v.url = last.url;
  return v;
}

/** Whether the PR is still in his queue: not approved (nor sent back) at its head. */
export function waitsOnReviewer(v: Verdict): boolean {
  return v.state !== "approved" && v.state !== "changes-requested";
}

export const VERDICT_LABEL: Record<VerdictState, string> = {
  none: "not reviewed",
  approved: "approved",
  "approved-older": "approved an older head",
  "changes-requested": "changes requested",
  "changes-requested-older": "updated since your change request",
  promoted: "/promote sent; bot-pr decides",
};

export type DiffKind = "hunk" | "add" | "del" | "ctx" | "note";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** Line number in the old file (del, ctx). */
  old?: number;
  /** Line number in the new file (add, ctx). */
  new?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse the unified diff GitHub gives per file (the `patch` of a PR file:
 * hunks only, no file headers) into numbered lines.
 */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: "hunk", text: line });
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    if (mark === "+") out.push({ kind: "add", text, new: newNo++ });
    else if (mark === "-") out.push({ kind: "del", text, old: oldNo++ });
    else if (mark === "\\") out.push({ kind: "note", text: line });
    else out.push({ kind: "ctx", text, old: oldNo++, new: newNo++ });
  }
  return out;
}

export type CiState = "success" | "failure" | "pending" | "none";

export interface CiCheck {
  name: string;
  state: CiState;
  url?: string;
  /** The raw conclusion or state, e.g. "timed_out". */
  detail: string;
}

export interface RawCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string | null;
  details_url?: string | null;
}

export interface RawStatus {
  context?: string;
  state?: string;
  target_url?: string | null;
}

const PASSING = ["success", "neutral", "skipped"];

function withUrl(check: CiCheck, url: string | null | undefined): CiCheck {
  if (url) check.url = url;
  return check;
}

/** Check runs and commit statuses as one list, failures first. */
export function ciChecks(runs: readonly RawCheckRun[], statuses: readonly RawStatus[]): CiCheck[] {
  const out: CiCheck[] = [];
  for (const r of runs) {
    const done = r.status === "completed";
    const detail = done ? (r.conclusion ?? "unknown") : (r.status ?? "queued");
    const state: CiState = !done ? "pending" : PASSING.includes(detail) ? "success" : "failure";
    out.push(withUrl({ name: r.name ?? "(unnamed)", state, detail }, r.html_url ?? r.details_url));
  }
  for (const s of statuses) {
    const detail = s.state ?? "unknown";
    const state: CiState = detail === "success" ? "success" : detail === "pending" ? "pending" : "failure";
    out.push(withUrl({ name: s.context ?? "(unnamed)", state, detail }, s.target_url));
  }
  const order: CiState[] = ["failure", "pending", "success", "none"];
  return out.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || a.name.localeCompare(b.name));
}

/** One state for all checks: any failure, else any pending, else success. */
export function ciSummary(checks: readonly CiCheck[]): CiState {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.state === "failure")) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "success";
}

export type ReviewAction = "approve" | "request-changes" | "comment";

/** The body of POST /repos/{o}/{r}/pulls/{n}/reviews. */
export interface ReviewRequest {
  commit_id: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
}

const EVENT: Record<ReviewAction, ReviewRequest["event"]> = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
};

/**
 * Compose the review to submit. His text may not contain a line that
 * bot-pr would read as a command (a `/draft` in a change request would
 * still count), so the only command the app writes is the `/draft` line
 * of an approval he asked for with the checkbox.
 */
export function composeReview(action: ReviewAction, text: string, head: string, opts: { draft?: boolean } = {}): ReviewRequest {
  if (!/^[0-9a-f]{40}$/.test(head)) throw new AnswerError(`not a commit id: ${JSON.stringify(head)}`);
  const clean = text.replace(/\r\n?/g, "\n").trim();
  const bad = clean.split("\n").find(isCommandLine);
  if (bad !== undefined) {
    throw new AnswerError(`the line ${JSON.stringify(bad.trim())} would be read as a bot command; reword it (e.g. put it in backticks)`);
  }
  if (action !== "approve" && !clean) {
    throw new AnswerError(action === "comment" ? "write a comment first" : "say what to change");
  }
  if (opts.draft && action !== "approve") throw new AnswerError(`${DRAFT_LINE} goes only with an approval`);
  const body = [clean, opts.draft ? DRAFT_LINE : ""].filter(Boolean).join("\n\n");
  return { commit_id: head, event: EVENT[action], body };
}
