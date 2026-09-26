// Parse the Projects v2 REST API (`/users/{u}/projectsV2/{n}/...`) into
// the app's item model. Pure functions over JSON, so tests feed them
// synthetic payloads.

import { type Option, parseOptions } from "../answer.ts";
import { FIELD, QUEUE_STATUSES } from "./config.ts";

/** The subset of a project field the app uses. */
export interface RawField {
  id: number;
  name: string;
}

interface RawFieldValue {
  id?: number;
  name: string;
  data_type?: string;
  value: null | { raw?: string; name?: { raw?: string } } | string | number;
}

interface RawUser {
  login?: string;
}

interface RawContent {
  node_id?: string;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  user?: RawUser | null;
  base?: { repo?: { private?: boolean } };
}

/** The subset of a project item the app uses. */
export interface RawItem {
  id: number;
  node_id: string;
  content_type: string;
  content?: RawContent | null;
  fields?: RawFieldValue[];
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
}

export type ItemKind = "issue" | "pr" | "draft" | "unknown";

/** An issue or PR, as `owner/repo#number`. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface Item {
  /** Numeric project item id, for REST. */
  id: number;
  /** PVTI_... node id, as the bot and bot-board name items. */
  nodeId: string;
  kind: ItemKind;
  title: string;
  /** The issue or PR page; absent for drafts. */
  url?: string;
  ref?: IssueRef;
  /** True or false when the payload says; unknown for issues until fetched. */
  isPrivate?: boolean;
  /** Issue/PR state, e.g. "open", "closed", "merged". */
  state?: string;
  body: string;
  status?: string;
  priority?: string;
  why: string;
  org?: string;
  branch: string[];
  gist: string[];
  /** When the item was added to the board. */
  createdAt?: string;
  updatedAt?: string;
}

/** The priorities in queue order; anything else sorts after them. */
export const PRIORITY_ORDER: readonly string[] = ["P0", "P1", "P2", "P3"];
/** Group heading for items with no priority. */
export const NO_PRIORITY = "No priority";

const ISSUE_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)$/;

/** Parse a github.com issue or PR URL. */
export function parseIssueUrl(url: string): IssueRef | undefined {
  const m = ISSUE_URL_RE.exec(url);
  if (!m) return undefined;
  return { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}

/** Field ids for the fields the app reads, failing clearly if one is gone. */
export function fieldIds(fields: readonly RawField[]): number[] {
  const byName = new Map(fields.map((f) => [f.name, f.id]));
  return Object.values(FIELD).map((name) => {
    const id = byName.get(name);
    if (id === undefined) {
      throw new Error(`the board has no field named "${name}"; was it renamed?`);
    }
    return id;
  });
}

function fieldText(v: RawFieldValue["value"]): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v.raw === "string") return v.raw;
  if (typeof v.name?.raw === "string") return v.name.raw;
  return undefined;
}

/** Split a Branch or Gist field, which holds space-separated URLs. */
function urls(text: string | undefined): string[] {
  return (text ?? "").split(/\s+/).filter((u) => /^https:\/\/\S+$/.test(u));
}

function kindOf(contentType: string): ItemKind {
  switch (contentType) {
    case "Issue":
      return "issue";
    case "PullRequest":
      return "pr";
    case "DraftIssue":
      return "draft";
    default:
      return "unknown";
  }
}

/** Parse one project item. */
export function parseItem(raw: RawItem): Item {
  const fields = new Map<string, string>();
  for (const f of raw.fields ?? []) {
    const text = fieldText(f.value);
    if (text !== undefined) fields.set(f.name, text);
  }
  const c = raw.content ?? {};
  const kind = kindOf(raw.content_type);
  const item: Item = {
    id: raw.id,
    nodeId: raw.node_id,
    kind,
    title: c.title?.trim() || "(no title or no access)",
    body: c.body ?? "",
    why: fields.get(FIELD.why) ?? "",
    branch: urls(fields.get(FIELD.branch)),
    gist: urls(fields.get(FIELD.gist)),
  };
  const opt = <K extends keyof Item>(key: K, value: Item[K] | undefined) => {
    if (value !== undefined) item[key] = value;
  };
  opt("status", fields.get(FIELD.status));
  opt("priority", fields.get(FIELD.priority));
  opt("org", fields.get(FIELD.org));
  opt("createdAt", raw.created_at);
  opt("updatedAt", c.updated_at ?? raw.updated_at);
  if (kind !== "draft" && c.html_url) {
    item.url = c.html_url;
    opt("ref", parseIssueUrl(c.html_url));
    opt("isPrivate", c.base?.repo?.private);
    opt("state", c.merged_at ? "merged" : c.state);
  }
  return item;
}

/** The board's part of the queue: unarchived items needing a human, or Draft (ready for review). */
export function queueItems(raw: readonly RawItem[]): Item[] {
  return raw
    .filter((r) => !r.archived_at)
    .map(parseItem)
    .filter((i) => i.status !== undefined && QUEUE_STATUSES.includes(i.status));
}

/** The question an item asks, as the bot wrote it. */
export interface Question {
  options: Option[];
}

/**
 * The bot asks in Why, or in a draft's body; options come from the first
 * of those that has them. Issue and PR bodies are someone else's text, so
 * they never supply options.
 */
export function questionOf(item: Item): Question {
  const sources = [item.why];
  if (item.kind === "draft") sources.push(item.body);
  const optionSource = sources.find((t) => parseOptions(t).length > 0);
  return { options: optionSource ? parseOptions(optionSource) : [] };
}

/** Where an answer to this item goes, and whether to ask first. */
export type AnswerTarget = { kind: "comment"; ref: IssueRef; confirmPublic: boolean } | { kind: "none"; reason: string };

/**
 * Decide the answer channel. This is the one place that picks it.
 *
 * `isPrivate` is the repository's visibility when known; unknown is
 * treated as public, which only adds a question.
 */
export function answerTarget(item: Item, homeOwners: readonly string[], isPrivate?: boolean): AnswerTarget {
  if (!item.ref) return { kind: "none", reason: "this item has no issue or PR to comment on" };
  const home = homeOwners.includes(item.ref.owner);
  return { kind: "comment", ref: item.ref, confirmPublic: !home && isPrivate !== true };
}
