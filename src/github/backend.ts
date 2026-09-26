// What the app does against GitHub: read the queue, read an item's
// context, and act on an ask: answer a question, comment on a review or
// chore, rerun a chore's failed runs. The views call these; tests drive
// them with a scripted fetch.

import { type Answer, formatAnswer, formatComment, parseQuestion } from "../answer.ts";
import type { GitHub } from "./api.ts";
import { failedJobs, parseAskBody, parseRunUrl, type RawJob, type RawRun, rerunComment, rerunProblem, type RunRef } from "./asks.ts";
import {
  answeredPending,
  askKind,
  askProblem,
  type AskKind,
  type AskScope,
  assigneeLogins,
  fieldIds,
  type IssueRef,
  isAsk,
  type Item,
  labelNames,
  parseIssueUrl,
  type RawContent,
  type RawField,
  type RawItem,
  queueItems,
  repoOf,
  type SubIssueSummary,
  TRACKER_SCOPE,
} from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER, FETCH_CONCURRENCY, PAGE_SIZE, QUEUE_STATUSES, RECENT_COMMENTS, TRACKER_REPO } from "./config.ts";
import { refKey } from "./forge.ts";
import { mapLimit } from "./prs.ts";

const PROJECT = `/users/${BOARD_OWNER}/projectsV2/${BOARD_NUMBER}`;

export interface Queue {
  items: Item[];
  changed: boolean;
}

/** Read the items needing a human or ready for review, conditionally: 304s cost nothing. */
export async function loadQueue(gh: GitHub): Promise<Queue> {
  const fields = await gh.getAll<RawField>(`${PROJECT}/fields?per_page=${PAGE_SIZE}`);
  const ids = fieldIds(fields.data).join(",");
  // The server-side filter keeps the poll to one page; queueItems filters
  // again, in case the filter syntax ever stops matching.
  const q = encodeURIComponent(`status:${QUEUE_STATUSES.map((s) => `"${s}"`).join(",")}`);
  const items = await gh.getAll<RawItem>(`${PROJECT}/items?per_page=${PAGE_SIZE}&fields=${ids}&q=${q}`);
  return {
    items: queueItems(items.data),
    changed: fields.changed || items.changed,
  };
}

export interface Comment {
  author: string;
  createdAt: string;
  url: string;
  body: string;
}

interface RawComment {
  user?: { login?: string } | null;
  created_at: string;
  html_url: string;
  body?: string | null;
}

export interface GistFile {
  name: string;
  language?: string;
  content: string;
  truncated: boolean;
}

export interface Gist {
  url: string;
  owner?: string;
  files: GistFile[];
}

interface RawGist {
  html_url: string;
  owner?: { login?: string } | null;
  files?: Record<string, { filename?: string; language?: string | null; content?: string; truncated?: boolean }>;
}

/** A sub-issue, as listed under its parent. */
export interface SubIssue {
  ref: IssueRef;
  url: string;
  title: string;
  state: string;
  labels: string[];
  /** Its own sub-issue progress, when it has sub-issues. */
  progress?: SubIssueSummary;
}

export interface Context {
  comments: Comment[];
  gists: Gist[];
  /** A tracker issue's sub-issues, when it has any. */
  subIssues?: SubIssue[];
  /** A rerun chore's runs, in the order its body names them. */
  runs?: RunStatus[];
  /** On a question: he commented after the bot last did. */
  answered?: boolean;
  /** Problems reading optional context, shown but not fatal. */
  warnings: string[];
}

/** The gist id in a gist URL, if it is one. */
export function gistId(url: string): string | undefined {
  return /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]+)(?:[#?].*)?$/.exec(url)?.[1];
}

function commentsPath(ref: IssueRef): string {
  return `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=${PAGE_SIZE}`;
}

/** Every comment on an issue or PR, oldest first, conditionally. */
async function loadComments(gh: GitHub, ref: IssueRef): Promise<Comment[]> {
  const r = await gh.getAll<RawComment>(commentsPath(ref));
  return r.data.map((c) => ({
    author: c.user?.login ?? "ghost",
    createdAt: c.created_at,
    url: c.html_url,
    body: c.body ?? "",
  }));
}

/**
 * A tracker issue's sub-issues, in GitHub's order, conditionally. Only
 * read for tracker issues whose summary says they have some; upstream
 * issues' trees aren't the bot's.
 */
export async function loadSubIssues(gh: GitHub, item: Item): Promise<SubIssue[] | undefined> {
  const ref = item.ref;
  if (!ref || item.kind !== "issue" || repoOf(ref) !== TRACKER_REPO.toLowerCase() || !item.subIssues) return undefined;
  const r = await gh.getAll<RawContent>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/sub_issues?per_page=${PAGE_SIZE}`);
  return r.data.flatMap((c) => {
    const subRef = parseIssueUrl(c.html_url ?? "");
    if (!subRef || !c.html_url) return [];
    const sub: SubIssue = { ref: subRef, url: c.html_url, title: c.title ?? "(no title)", state: c.state ?? "open", labels: labelNames(c.labels) };
    if (c.sub_issues_summary && c.sub_issues_summary.total > 0) sub.progress = c.sub_issues_summary;
    return [sub];
  });
}

/** Read an item's comments, gists and, on a tracker issue, sub-issues. */
export async function loadContext(gh: GitHub, item: Item): Promise<Context> {
  const ctx: Context = { comments: [], gists: [], warnings: [] };
  const tasks: Promise<void>[] = [];
  if (item.ref) {
    tasks.push(
      loadComments(gh, item.ref).then((all) => {
        ctx.comments = all.slice(-RECENT_COMMENTS);
        if (isAsk(item)) ctx.answered = answeredPending(all);
      }),
      loadSubIssues(gh, item).then((subs) => {
        if (subs) ctx.subIssues = subs;
      }),
    );
  }
  const reruns = askKind(item) === "chore" && item.state === "open" ? parseAskBody(item.body) : undefined;
  if (reruns && reruns.problems.length === 0 && reruns.reruns.length > 0) {
    tasks.push(
      loadRuns(gh, reruns.reruns).then((runs) => {
        ctx.runs = runs;
      }),
    );
  }
  for (const url of item.gist) {
    const id = gistId(url);
    if (!id) continue;
    tasks.push(
      gh.get<RawGist>(`/gists/${id}`).then((r) => {
        ctx.gists.push({
          url: r.data.html_url,
          ...(r.data.owner?.login ? { owner: r.data.owner.login } : {}),
          files: Object.values(r.data.files ?? {}).map((f) => ({
            name: f.filename ?? "(unnamed)",
            ...(f.language ? { language: f.language } : {}),
            content: f.content ?? "",
            truncated: f.truncated === true,
          })),
        });
      }),
    );
  }
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === "rejected") ctx.warnings.push(String(r.reason instanceof Error ? r.reason.message : r.reason));
  }
  return ctx;
}

/** The signed-in login. */
export async function viewer(gh: GitHub): Promise<string> {
  const r = await gh.get<{ login: string }>("/user");
  return r.data.login;
}

/**
 * The open asks he has answered (or commented on) and the bot hasn't acted
 * on yet, by node id. Reads comments only of open asks that have any; the reads
 * are conditional, so an unchanged issue costs nothing, and at most
 * FETCH_CONCURRENCY run at once. A question whose comments can't be read
 * counts as unanswered.
 */
export async function loadAnswered(gh: GitHub, items: readonly Item[]): Promise<Set<string>> {
  const asked = items.filter((i) => isAsk(i) && i.state === "open" && i.ref && (i.comments ?? 1) > 0);
  const answered = await mapLimit(asked, FETCH_CONCURRENCY, async (i) => {
    try {
      return answeredPending(await loadComments(gh, i.ref as IssueRef)) ? [i.nodeId] : [];
    } catch {
      return [];
    }
  });
  return new Set(answered.flat());
}

export interface Posted {
  /** The comment. */
  url: string;
}

/**
 * Read an ask's issue fresh and check it is still one of `want`'s kind
 * in `scope`; anything else throws, before anything is written. A
 * transferred issue doesn't count: it would answer from its new home.
 */
async function freshAsk(gh: GitHub, ref: IssueRef, want: AskKind, scope: AskScope): Promise<RawContent> {
  const issue = await gh.send<RawContent>("GET", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
  const actual = parseIssueUrl(issue.html_url ?? "");
  if (!actual || refKey(actual).toLowerCase() !== refKey(ref).toLowerCase()) {
    throw new Error(`not answering: ${refKey(ref)} is now ${issue.html_url ?? "somewhere unknown"}`);
  }
  const facts = {
    kind: issue.pull_request ? "pr" : "issue",
    ref: actual,
    labels: labelNames(issue.labels),
    assignees: assigneeLogins(issue.assignees),
    ...(issue.user?.login ? { author: issue.user.login } : {}),
    ...(issue.state ? { state: issue.state } : {}),
  } as const;
  const problem = askProblem(facts, want, scope);
  if (problem !== undefined) throw new Error(`not answering: ${problem}`);
  return issue;
}

async function comment(gh: GitHub, ref: IssueRef, body: string): Promise<Posted> {
  const c = await gh.send<{ html_url: string }>("POST", `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments`, { body });
  return { url: c.html_url };
}

/**
 * Answer a question: one comment by you on its issue. The issue is read
 * fresh first and must be an open question in `scope` (the tracker,
 * opened by the bot and assigned to him, unless overridden, e.g. by a
 * test against a sandbox repository), and a picked letter must be one of
 * the options its body offers now; anything else is refused before
 * writing. A plain function of a client and an issue, so a script can
 * drive it with any token.
 */
export async function postAnswer(gh: GitHub, ref: IssueRef, answer: Answer, scope: AskScope = TRACKER_SCOPE): Promise<Posted> {
  const body = formatAnswer(answer);
  const issue = await freshAsk(gh, ref, "question", scope);
  // The options may have changed since the view was rendered.
  if (answer.choice !== undefined) {
    const letters = parseQuestion(issue.body ?? "").options.map((o) => o.letter);
    if (!letters.includes(answer.choice)) {
      const now = letters.length ? `it now offers ${letters.join(", ")}` : "it no longer offers options";
      throw new Error(`not answering: ${refKey(ref)} has no option ${answer.choice}; ${now}. Reload it.`);
    }
  }
  return comment(gh, ref, body);
}

/**
 * Comment on a review or chore ask: his own words (bot command lines
 * refused, as in an answer), or what the app did for him. The issue is
 * read fresh and checked as postAnswer does.
 */
export async function postAskComment(gh: GitHub, ref: IssueRef, kind: "review" | "chore", text: string, scope: AskScope = TRACKER_SCOPE): Promise<Posted> {
  const body = formatComment(text);
  await freshAsk(gh, ref, kind, scope);
  return comment(gh, ref, body);
}

/** A run a chore asks to rerun, as last read. */
export interface RunStatus {
  run: RunRef;
  name?: string;
  status?: string;
  conclusion?: string;
  attempt?: number;
  /** The latest attempt's failed jobs. */
  failed: { name: string; url?: string }[];
  /** Why its failed jobs can't be rerun now, if they can't. */
  problem?: string;
}

async function readRun(gh: GitHub, run: RunRef): Promise<{ raw: RawRun; jobs: RawJob[] }> {
  const path = `/repos/${run.owner}/${run.repo}/actions/runs/${run.id}`;
  const raw = await gh.send<RawRun>("GET", path);
  const jobs = await gh.send<{ jobs?: RawJob[] }>("GET", `${path}/jobs?filter=latest&per_page=${PAGE_SIZE}`);
  return { raw, jobs: jobs.jobs ?? [] };
}

/** Read the runs a chore names, and whether each one's failed jobs can be rerun. */
export async function loadRuns(gh: GitHub, runs: readonly RunRef[]): Promise<RunStatus[]> {
  return mapLimit(runs, FETCH_CONCURRENCY, async (run) => {
    try {
      const { raw, jobs } = await readRun(gh, run);
      const out: RunStatus = {
        run,
        failed: failedJobs(jobs).map((j) => ({ name: j.name ?? "(unnamed job)", ...(j.html_url ? { url: j.html_url } : {}) })),
      };
      if (raw.name) out.name = raw.name;
      if (raw.status) out.status = raw.status;
      if (raw.conclusion) out.conclusion = raw.conclusion;
      if (typeof raw.run_attempt === "number") out.attempt = raw.run_attempt;
      const problem = rerunProblem(run, raw, jobs);
      if (problem) out.problem = problem;
      return out;
    } catch (e) {
      return { run, failed: [], problem: `couldn't read the run: ${e instanceof Error ? e.message : String(e)}` };
    }
  });
}

/**
 * Rerun the failed jobs of one run a chore names, with your token, then
 * say so on the chore. Strict, since it writes upstream: the chore is
 * read fresh and must be an open chore in `scope` whose body names this
 * exact run URL (and no line it can't read); the run is read fresh and
 * must be that run, in that repository, completed and failed, with
 * failed jobs. Only then the one endpoint that reruns failed jobs is
 * called, built from the parsed URL's parts.
 */
export async function rerunFailedJobs(gh: GitHub, ask: IssueRef, runUrl: string, scope: AskScope = TRACKER_SCOPE): Promise<Posted> {
  const run = parseRunUrl(runUrl);
  if (!run) throw new Error(`not rerunning: ${JSON.stringify(runUrl)} is not a workflow run URL`);
  const issue = await freshAsk(gh, ask, "chore", scope);
  const body = parseAskBody(issue.body ?? "");
  if (body.problems.length) throw new Error(`not rerunning: ${refKey(ask)} ${body.problems[0]}`);
  if (!body.reruns.some((r) => r.url === run.url)) throw new Error(`not rerunning: ${refKey(ask)} doesn't ask to rerun ${run.url}`);
  const { raw, jobs } = await readRun(gh, run);
  const problem = rerunProblem(run, raw, jobs);
  if (problem) throw new Error(`not rerunning ${run.url}: ${problem}`);
  await gh.send("POST", `/repos/${run.owner}/${run.repo}/actions/runs/${run.id}/rerun-failed-jobs`);
  try {
    return await comment(gh, ask, formatComment(rerunComment(run)));
  } catch (e) {
    throw new Error(`reran the failed jobs of ${run.url}, but couldn't say so on ${refKey(ask)}: ${e instanceof Error ? e.message : String(e)}. Comment there yourself.`);
  }
}
