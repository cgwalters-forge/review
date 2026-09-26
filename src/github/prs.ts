// What the app reads and writes for forge PRs: the list waiting on him,
// their verdicts, one PR's details for the review pane, and the review
// itself. Views call these; tests drive them with a scripted fetch.

import type { GitHub } from "./api.ts";
import type { IssueRef } from "./board.ts";
import { BOT_LOGIN, FETCH_CONCURRENCY, FORGE_ORG, OPERATOR, PAGE_SIZE } from "./config.ts";
import {
  type CiCheck,
  ciChecks,
  type ForgePr,
  parseSearchPr,
  type RawCheckRun,
  type RawIssueComment,
  type RawReview,
  type RawSearchIssue,
  type RawStatus,
  refKey,
  type ReviewRequest,
  reviewVerdict,
  type Verdict,
} from "./forge.ts";

/** The search for the bot's open draft PRs on the forge. */
export const FORGE_QUERY = `is:pr is:open draft:true org:${FORGE_ORG} author:${BOT_LOGIN}`;
/** Search pages to read at most (100 each). */
const MAX_SEARCH_PAGES = 5;

/** The bot's open draft PRs on the forge, oldest first. Search has no ETags, so poll it sparingly. */
export async function loadForgePrs(gh: GitHub): Promise<ForgePr[]> {
  const out: ForgePr[] = [];
  const q = encodeURIComponent(FORGE_QUERY);
  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const r = await gh.get<{ items?: RawSearchIssue[]; total_count?: number }>(
      `/search/issues?q=${q}&sort=created&order=asc&per_page=${PAGE_SIZE}&page=${page}`,
    );
    const items = r.data.items ?? [];
    for (const raw of items) {
      const pr = parseSearchPr(raw);
      if (pr) out.push(pr);
    }
    if (items.length < PAGE_SIZE || out.length >= (r.data.total_count ?? 0)) break;
  }
  return out;
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

interface RawPull {
  number: number;
  html_url: string;
  title?: string;
  body?: string | null;
  draft?: boolean;
  state?: string;
  merged_at?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  updated_at?: string;
  head: { sha: string; ref?: string; repo?: { full_name?: string } | null };
  base: { ref?: string; repo?: { full_name?: string; private?: boolean; parent?: { full_name?: string } } };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
}

export interface VerdictEntry {
  /** The PR's updated_at when this was read; a newer one means re-read. */
  updatedAt: string;
  head: string;
  verdict: Verdict;
}

/**
 * Read the verdicts of PRs whose updated_at moved since `known` (a push
 * or a review both move it). Heads come from one open-PR list per
 * repository, conditionally; reviews from each changed PR.
 */
export async function refreshVerdicts(
  gh: GitHub,
  prs: readonly ForgePr[],
  known: ReadonlyMap<string, VerdictEntry>,
): Promise<Map<string, VerdictEntry>> {
  const stale = prs.filter((p) => known.get(refKey(p.ref))?.updatedAt !== p.updatedAt);
  const out = new Map<string, VerdictEntry>();
  for (const p of prs) {
    const k = known.get(refKey(p.ref));
    if (k && k.updatedAt === p.updatedAt) out.set(refKey(p.ref), k);
  }
  if (stale.length === 0) return out;
  const repos = [...new Set(stale.map((p) => `${p.ref.owner}/${p.ref.repo}`))];
  const heads = new Map<string, string>();
  await mapLimit(repos, FETCH_CONCURRENCY, async (repo) => {
    const r = await gh.getAll<RawPull>(`/repos/${repo}/pulls?state=open&per_page=${PAGE_SIZE}`);
    for (const pull of r.data) heads.set(`${repo}#${pull.number}`, pull.head.sha);
  });
  await mapLimit(stale, FETCH_CONCURRENCY, async (p) => {
    const key = refKey(p.ref);
    const head = heads.get(key);
    // Not open any more (the search lags): nothing to decide.
    if (!head) {
      out.set(key, { updatedAt: p.updatedAt, head: "", verdict: { state: "none" } });
      return;
    }
    const { reviews, comments } = await readDecisions(gh, p.ref);
    out.set(key, { updatedAt: p.updatedAt, head, verdict: reviewVerdict(reviews, head, OPERATOR, comments) });
  });
  return out;
}

/** His reviews and conversation comments on a PR: what bot-pr decides by. */
async function readDecisions(gh: GitHub, ref: IssueRef): Promise<{ reviews: RawReview[]; comments: RawIssueComment[] }> {
  const repo = `/repos/${ref.owner}/${ref.repo}`;
  const [reviews, comments] = await Promise.all([
    gh.getAll<RawReview>(`${repo}/pulls/${ref.number}/reviews?per_page=${PAGE_SIZE}`),
    gh.getAll<RawIssueComment>(`${repo}/issues/${ref.number}/comments?per_page=${PAGE_SIZE}`),
  ]);
  return { reviews: reviews.data, comments: comments.data };
}

export interface Commit {
  sha: string;
  url: string;
  message: string;
  author: string;
  date?: string;
}

export interface FileDiff {
  filename: string;
  previous?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent when GitHub omits it (binary, or too large). */
  patch?: string;
  url?: string;
}

export interface PrDetail {
  ref: IssueRef;
  url: string;
  /** The PR's updated_at when read; the search's moving past it means stale. */
  updatedAt: string;
  title: string;
  body: string;
  author: string;
  state: string;
  draft: boolean;
  head: string;
  headRef?: string;
  baseRef?: string;
  /** The fork's parent repository, `owner/repo`. */
  parent?: string;
  isPrivate?: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** The PR's total; `commits` holds at most 250 (the API's limit). */
  commitCount: number;
  commits: Commit[];
  files: FileDiff[];
  checks: CiCheck[];
  verdict: Verdict;
  /**
   * False when the commit list doesn't end at the head: right after a
   * push GitHub can serve the old commits and diff with the new head, and
   * approving then would approve code he didn't see.
   */
  consistent: boolean;
  /** Problems reading optional parts, shown but not fatal. */
  warnings: string[];
}

interface RawCommit {
  sha: string;
  html_url: string;
  commit: { message?: string; author?: { name?: string; date?: string } | null };
  author?: { login?: string } | null;
}

interface RawFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  blob_url?: string;
}

/** Pages of files to read at most (the API stops at 3000 files). */
export const MAX_FILE_PAGES = 30;
/** Commits the API lists for a PR at most. */
const MAX_LISTED_COMMITS = 250;

function pullPath(ref: IssueRef): string {
  return `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

/** Everything the review pane shows about one PR. */
export async function loadPrDetail(gh: GitHub, ref: IssueRef): Promise<PrDetail> {
  const base = pullPath(ref);
  const pull = (await gh.get<RawPull>(base)).data;
  const head = pull.head.sha;
  const repo = `/repos/${ref.owner}/${ref.repo}`;
  const warnings: string[] = [];
  const optional = async <T>(what: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      warnings.push(`Couldn't read ${what}: ${e instanceof Error ? e.message : String(e)}`);
      return fallback;
    }
  };
  const [commits, files, runs, status, decisions, repoInfo] = await Promise.all([
    gh.getAll<RawCommit>(`${base}/commits?per_page=${PAGE_SIZE}`, 3).then((r) => r.data),
    gh.getAll<RawFile>(`${base}/files?per_page=${PAGE_SIZE}`, MAX_FILE_PAGES).then((r) => r.data),
    optional("check runs", gh.get<{ check_runs?: RawCheckRun[] }>(`${repo}/commits/${head}/check-runs?per_page=${PAGE_SIZE}`).then((r) => r.data.check_runs ?? []), []),
    optional("commit statuses", gh.get<{ statuses?: RawStatus[] }>(`${repo}/commits/${head}/status`).then((r) => r.data.statuses ?? []), []),
    readDecisions(gh, ref),
    optional("the repository", gh.get<{ private?: boolean; parent?: { full_name?: string } }>(repo).then((r) => r.data), {}),
  ]);
  const commitCount = pull.commits ?? commits.length;
  // Past the API's listing limit the last commit listed isn't the head,
  // so there is nothing to check; below it, a stale list (shorter or not)
  // ends elsewhere.
  const consistent = commitCount > MAX_LISTED_COMMITS || commits.at(-1)?.sha === head;
  if (!consistent) warnings.push("GitHub is still updating this PR after a push: the commits and diff may not be the head's yet. Reload (r) before approving.");
  const detail: PrDetail = {
    ref,
    url: pull.html_url,
    updatedAt: pull.updated_at ?? "",
    title: pull.title ?? "(no title)",
    body: pull.body ?? "",
    author: pull.user?.login ?? "ghost",
    state: pull.merged_at ? "merged" : (pull.state ?? "unknown"),
    draft: pull.draft === true,
    head,
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? files.length,
    commitCount,
    commits: commits.map((c) => {
      const out: Commit = { sha: c.sha, url: c.html_url, message: c.commit.message ?? "", author: c.author?.login ?? c.commit.author?.name ?? "unknown" };
      if (c.commit.author?.date) out.date = c.commit.author.date;
      return out;
    }),
    files: files.map((f) => {
      const out: FileDiff = { filename: f.filename, status: f.status ?? "modified", additions: f.additions ?? 0, deletions: f.deletions ?? 0 };
      if (f.previous_filename) out.previous = f.previous_filename;
      if (f.patch !== undefined) out.patch = f.patch;
      if (f.blob_url) out.url = f.blob_url;
      return out;
    }),
    checks: ciChecks(runs, status),
    verdict: reviewVerdict(decisions.reviews, head, OPERATOR, decisions.comments),
    consistent,
    warnings,
  };
  if (pull.head.ref) detail.headRef = pull.head.ref;
  if (pull.base.ref) detail.baseRef = pull.base.ref;
  if (repoInfo.parent?.full_name) detail.parent = repoInfo.parent.full_name;
  if (typeof repoInfo.private === "boolean") detail.isPrivate = repoInfo.private;
  return detail;
}

/**
 * Submit a review of the head he was shown. The PR is re-read first,
 * unconditionally, and a moved head refuses: an approval must name the
 * commit he read (bot-pr's promote only honours it for the head), and
 * a change request on stale code confuses the bot.
 */
export async function submitReview(gh: GitHub, ref: IssueRef, review: ReviewRequest): Promise<string> {
  const fresh = await gh.send<RawPull>("GET", pullPath(ref));
  if (fresh.state !== "open") throw new Error(`the PR is ${fresh.merged_at ? "merged" : (fresh.state ?? "not open")}; nothing was sent`);
  if (fresh.head.sha !== review.commit_id) {
    throw new Error(
      `the PR's head moved to ${fresh.head.sha.slice(0, 12)} since you opened it; nothing was sent. Reload (r) to review the new commits.`,
    );
  }
  const r = await gh.send<{ html_url?: string }>("POST", `${pullPath(ref)}/reviews`, review);
  return r.html_url ?? fresh.html_url;
}
