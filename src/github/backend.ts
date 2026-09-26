// What the app does against GitHub: read the queue, read an item's
// context, and post an answer. The views call these; tests drive them
// with a scripted fetch.

import { type Answer, formatAnswer, formatReceipt, getDraftSection, setDraftSection } from "../answer.ts";
import type { GitHub } from "./api.ts";
import {
  type AnswerTarget,
  fieldIds,
  type Item,
  questionOf,
  type RawField,
  type RawItem,
  queueItems,
} from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER, OPERATOR, PAGE_SIZE, QUEUE_STATUSES, RECENT_COMMENTS } from "./config.ts";
import { checkReceipt, RECEIPT_FILE, type RawReceiptGist, type ReceiptCheck } from "./receipt.ts";

const PROJECT = `/users/${BOARD_OWNER}/projectsV2/${BOARD_NUMBER}`;

export interface Queue {
  items: Item[];
  /** Whether anyone can read the board, and so every draft body on it. */
  boardPublic: boolean;
  changed: boolean;
}

/** Read the items needing a human or ready for review, conditionally: 304s cost nothing. */
export async function loadQueue(gh: GitHub): Promise<Queue> {
  const project = await gh.get<{ public?: boolean }>(PROJECT);
  const fields = await gh.getAll<RawField>(`${PROJECT}/fields?per_page=${PAGE_SIZE}`);
  const ids = fieldIds(fields.data).join(",");
  // The server-side filter keeps the poll to one page; queueItems filters
  // again, in case the filter syntax ever stops matching.
  const q = encodeURIComponent(`status:${QUEUE_STATUSES.map((s) => `"${s}"`).join(",")}`);
  const items = await gh.getAll<RawItem>(`${PROJECT}/items?per_page=${PAGE_SIZE}&fields=${ids}&q=${q}`);
  return {
    items: queueItems(items.data),
    // Unknown counts as public: that only makes the warnings stricter.
    boardPublic: project.data.public !== false,
    changed: project.changed || fields.changed || items.changed,
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

/** A draft's answer receipt and whether it checks out. */
export interface ReceiptStatus {
  url: string;
  check: ReceiptCheck;
}

export interface Context {
  comments: Comment[];
  gists: Gist[];
  isPrivate?: boolean;
  receipt?: ReceiptStatus;
  /** Problems reading optional context, shown but not fatal. */
  warnings: string[];
}

/** The gist id in a gist URL, if it is one. */
export function gistId(url: string): string | undefined {
  return /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]+)(?:[#?].*)?$/.exec(url)?.[1];
}

/**
 * Fetch and check the receipt a draft's answer section points to, by
 * gist id. Undefined when the draft has no well-formed section.
 */
export async function verifyReceipt(gh: GitHub, item: Item): Promise<ReceiptStatus | undefined> {
  if (item.kind !== "draft") return undefined;
  const section = getDraftSection(item.body);
  const id = section ? gistId(section.receipt) : undefined;
  if (!section || !id) return undefined;
  const question = questionOf(item).id;
  try {
    const gist = await gh.get<RawReceiptGist>(`/gists/${id}`);
    return { url: section.receipt, check: checkReceipt(gist.data, item.nodeId, OPERATOR, question) };
  } catch (e) {
    return { url: section.receipt, check: { ok: false, reason: e instanceof Error ? e.message : String(e) } };
  }
}

/** Read an item's comments, gists, receipt and repository visibility. */
export async function loadContext(gh: GitHub, item: Item): Promise<Context> {
  const ctx: Context = { comments: [], gists: [], warnings: [] };
  const tasks: Promise<void>[] = [
    verifyReceipt(gh, item).then((r) => {
      if (r) ctx.receipt = r;
    }),
  ];
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
  /** The comment, or the receipt gist for a draft. */
  url: string;
}

/** A well-formed gist URL for dry-running setDraftSection. */
const PLACEHOLDER_GIST = "https://gist.github.com/0";

const UPDATE_DRAFT = `mutation($id: ID!, $body: String!) {
  updateProjectV2DraftIssue(input: {draftIssueId: $id, body: $body}) { draftIssue { id } }
}`;

/**
 * Post an answer. For an issue or PR, one comment by you. For a draft: a
 * gist receipt (the part the bot can verify came from you; unlisted, but
 * readable by anyone with the link, which a public board's draft body
 * shows), then the draft body's answer section pointing at it, written
 * over the freshest body we can read (draft bodies have no precondition).
 */
export async function postAnswer(gh: GitHub, item: Item, target: AnswerTarget, answer: Answer): Promise<Posted> {
  switch (target.kind) {
    case "comment": {
      const { owner, repo, number } = target.ref;
      const c = await gh.send<{ html_url: string }>("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, {
        body: formatAnswer(answer),
      });
      return { url: c.html_url };
    }
    case "draft": {
      const content = formatReceipt({ ...answer, item: item.nodeId });
      const fresh = await gh.send<RawItem>("GET", `${PROJECT}/items/${item.id}`);
      const body = fresh.content?.body ?? "";
      // Refuse a body we can't write (e.g. two answer sections) before
      // leaving a receipt behind.
      setDraftSection(body, answer, PLACEHOLDER_GIST);
      const receipt = await gh.send<{ html_url: string }>("POST", "/gists", {
        public: false,
        description: `review answer for ${item.nodeId}`,
        files: { [RECEIPT_FILE]: { content } },
      });
      try {
        await gh.graphql(UPDATE_DRAFT, { id: target.draftId, body: setDraftSection(body, answer, receipt.html_url) });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        throw new Error(`created the receipt ${receipt.html_url}, but could not write the draft body: ${why}`);
      }
      return { url: receipt.html_url };
    }
    case "none":
      throw new Error(`can't answer here: ${target.reason}`);
  }
}
