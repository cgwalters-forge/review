// What the app does against GitHub: read the queue, read an item's
// context, and post an answer. The views call these; tests drive them
// with a scripted fetch.

import { type Answer, formatAnswer } from "../answer.ts";
import type { GitHub } from "./api.ts";
import { type AnswerTarget, fieldIds, type Item, type RawField, type RawItem, queueItems } from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER, PAGE_SIZE, QUEUE_STATUSES, RECENT_COMMENTS } from "./config.ts";

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

export interface Context {
  comments: Comment[];
  gists: Gist[];
  isPrivate?: boolean;
  /** Problems reading optional context, shown but not fatal. */
  warnings: string[];
}

/** The gist id in a gist URL, if it is one. */
export function gistId(url: string): string | undefined {
  return /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]+)(?:[#?].*)?$/.exec(url)?.[1];
}

/** Read an item's comments, gists and repository visibility. */
export async function loadContext(gh: GitHub, item: Item): Promise<Context> {
  const ctx: Context = { comments: [], gists: [], warnings: [] };
  const tasks: Promise<void>[] = [];
  if (item.ref) {
    const { owner, repo, number } = item.ref;
    tasks.push(
      gh.get<{ private?: boolean }>(`/repos/${owner}/${repo}`).then((r) => {
        if (typeof r.data.private === "boolean") ctx.isPrivate = r.data.private;
      }),
      gh.getAll<RawComment>(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=${PAGE_SIZE}`).then((r) => {
        ctx.comments = r.data.slice(-RECENT_COMMENTS).map((c) => ({
          author: c.user?.login ?? "ghost",
          createdAt: c.created_at,
          url: c.html_url,
          body: c.body ?? "",
        }));
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

export interface Posted {
  /** The comment. */
  url: string;
}

/** Post an answer: one comment by you on the item's issue or PR. */
export async function postAnswer(gh: GitHub, target: AnswerTarget, answer: Answer): Promise<Posted> {
  if (target.kind === "none") throw new Error(`can't answer here: ${target.reason}`);
  const body = formatAnswer(answer);
  const { owner, repo, number } = target.ref;
  const c = await gh.send<{ html_url: string }>("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body });
  return { url: c.html_url };
}
