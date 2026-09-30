// Quick capture: his notes for the bot, filed as issues in the tracker
// with CAPTURE_LABEL and added to the board. The label is what the bot
// routes on (bot-notify in homegit): an open tracker issue of his that
// carries it is a request to triage, and the bot removes the label once
// it has. The board add is a convenience on top, so a failed one leaves
// the issue filed and says why.

import { type GitHub } from "./api.ts";
import { type IssueRef, parseIssueUrl } from "./board.ts";
import { BOARD_NUMBER, BOARD_OWNER, BOARD_URL, CAPTURE_LABEL, TRACKER_REPO } from "./config.ts";
import { refKey } from "./forge.ts";

/** What he typed into the capture bar. */
export interface CaptureDraft {
  title: string;
  body: string;
  url: string;
}

export const EMPTY_DRAFT: CaptureDraft = { title: "", body: "", url: "" };

/** The issue to create, as POST /repos/{TRACKER_REPO}/issues takes it. */
export interface IssueRequest {
  title: string;
  body: string;
  labels: string[];
}

// Pages under an issue or PR (/files, /commits/SHA...) link to it too.
const GITHUB_LINK_RE = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/;

/**
 * The issue or PR a pasted github.com link points at, ignoring its
 * fragment, query and sub-pages; undefined for anything else.
 */
export function linkedRef(url: string): IssueRef | undefined {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.hostname !== "github.com") return undefined;
  const m = GITHUB_LINK_RE.exec(u.pathname);
  return m ? parseIssueUrl(`https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`) : undefined;
}

/** The link field, checked: empty, or an https URL. */
function checkedLink(url: string): string {
  const t = url.trim();
  if (!t) return "";
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error(`"${t}" isn't a URL.`);
  }
  if (u.protocol !== "https:") throw new Error("The link must be an https URL.");
  return u.href;
}

/** The title a link suggests: `owner/repo#N: its title`, or just the reference. */
export function linkTitle(ref: IssueRef, title?: string): string {
  const t = title?.trim();
  return t ? `${refKey(ref)}: ${t}` : refKey(ref);
}

/**
 * The issue a draft files: his title (else the linked issue's
 * reference), his text, and the link on a line of its own, where GitHub
 * renders it as a link (a reference card, for an issue or PR).
 */
export function captureRequest(draft: CaptureDraft): IssueRequest {
  const link = checkedLink(draft.url);
  const ref = link ? linkedRef(link) : undefined;
  const title = draft.title.trim() || (ref ? linkTitle(ref) : "");
  if (!title) throw new Error("Type a title first (or paste a GitHub link).");
  const body = [draft.body.trim(), link].filter(Boolean).join("\n\n");
  return { title, body, labels: [CAPTURE_LABEL] };
}

/** The filed issue, and why it isn't on the board, if it isn't. */
export interface Filed {
  number: number;
  url: string;
  /** Set when the board add failed: the issue is filed regardless. */
  boardError?: string;
}

interface CreatedIssue {
  id: number;
  number: number;
  html_url: string;
}

/** What a failed board add means, and what the token lacks. */
export const BOARD_ADD_HELP =
  `The bot adds it when it triages the issue. For this app to add it (to ${BOARD_URL}), the token needs the project scope, or on a fine-grained token the organization's Projects: read and write.`;

/**
 * File a draft: create the issue, then add it to the board over REST
 * (an organization's project takes items there; no GraphQL needed). A
 * failed add doesn't undo the issue: the label alone gets it triaged.
 */
export async function fileCapture(gh: GitHub, draft: CaptureDraft): Promise<Filed> {
  const req = captureRequest(draft);
  const issue = await gh.send<CreatedIssue>("POST", `/repos/${TRACKER_REPO}/issues`, req);
  const filed: Filed = { number: issue.number, url: issue.html_url };
  try {
    await gh.send("POST", `/orgs/${BOARD_OWNER}/projectsV2/${BOARD_NUMBER}/items`, { type: "Issue", id: issue.id });
  } catch (e) {
    filed.boardError = `${e instanceof Error ? e.message : String(e)}. ${BOARD_ADD_HELP}`;
  }
  return filed;
}

/** The title of a linked issue or PR, to suggest one; undefined if it can't be read. */
export async function loadLinkTitle(gh: GitHub, ref: IssueRef): Promise<string | undefined> {
  try {
    const r = await gh.get<{ title?: string }>(`/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`);
    return r.data.title;
  } catch {
    return undefined;
  }
}
