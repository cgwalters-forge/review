// What the app does against GitHub: read the queue, read an item's
// context, and post an answer. The views call these; tests drive them
// with a scripted fetch.

import { type Answer, formatAnswer, parseQuestion } from "../answer.ts";
import type { GitHub } from "./api.ts";
import {
  answeredPending,
  assigneeLogins,
  fieldIds,
  type IssueRef,
  isQuestion,
  type Item,
  labelNames,
  parseIssueUrl,
  questionProblem,
  type QuestionScope,
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
        if (isQuestion(item)) ctx.answered = answeredPending(all);
      }),
      loadSubIssues(gh, item).then((subs) => {
        if (subs) ctx.subIssues = subs;
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
 * The open questions he has answered and the bot hasn't acted on yet, by
 * node id. Reads comments only of open questions that have any; the reads
 * are conditional, so an unchanged issue costs nothing, and at most
 * FETCH_CONCURRENCY run at once. A question whose comments can't be read
 * counts as unanswered.
 */
export async function loadAnswered(gh: GitHub, items: readonly Item[]): Promise<Set<string>> {
  const asked = items.filter((i) => isQuestion(i) && i.state === "open" && i.ref && (i.comments ?? 1) > 0);
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
 * Answer a question: one comment by you on its issue. The issue is read
 * fresh first and must be an open question in `scope` (the tracker,
 * assigned to him, unless overridden, e.g. by a test against a sandbox
 * repository), and a picked letter must be one of the options its body
 * offers now; anything else is refused before writing. A plain function
 * of a client and an issue, so a script can drive it with any token.
 */
export async function postAnswer(gh: GitHub, ref: IssueRef, answer: Answer, scope: QuestionScope = TRACKER_SCOPE): Promise<Posted> {
  const body = formatAnswer(answer);
  const path = `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  const issue = await gh.send<RawContent>("GET", path);
  const actual = parseIssueUrl(issue.html_url ?? "");
  // A transferred issue answers from its new home; don't follow it.
  if (!actual || refKey(actual).toLowerCase() !== refKey(ref).toLowerCase()) {
    throw new Error(`not answering: ${refKey(ref)} is now ${issue.html_url ?? "somewhere unknown"}`);
  }
  const facts = {
    kind: issue.pull_request ? "pr" : "issue",
    ref: actual,
    labels: labelNames(issue.labels),
    assignees: assigneeLogins(issue.assignees),
  } as const;
  const problem = questionProblem(issue.state ? { ...facts, state: issue.state } : facts, scope);
  if (problem !== undefined) throw new Error(`not answering: ${problem}`);
  // The options may have changed since the view was rendered.
  if (answer.choice !== undefined) {
    const letters = parseQuestion(issue.body ?? "").options.map((o) => o.letter);
    if (!letters.includes(answer.choice)) {
      const now = letters.length ? `it now offers ${letters.join(", ")}` : "it no longer offers options";
      throw new Error(`not answering: ${refKey(ref)} has no option ${answer.choice}; ${now}. Reload it.`);
    }
  }
  const c = await gh.send<{ html_url: string }>("POST", `${path}/comments`, { body });
  return { url: c.html_url };
}
