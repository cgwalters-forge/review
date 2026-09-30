// Keyboard commands, as a pure mapping from a key press to a command so
// tests can check it; main.ts carries them out.

import { parseFilterToken, type QueueFilter } from "./filter.ts";
import { TRIAGE_FILTERS, type TriageFilter } from "./triage.ts";

export type Route = "queue" | "item" | "pr" | "news" | "ops" | "triage" | "decisions";

export type Command =
  | "next"
  | "prev"
  | "open"
  | "back"
  | "refresh"
  | "approve"
  | "fold"
  | "compose"
  | "help"
  | "news"
  | "ops"
  | "triage"
  | "decisions"
  | "capture"
  // The PR pane's own, which it carries out itself.
  | "next-file"
  | "prev-file"
  | "next-hunk"
  | "prev-hunk"
  | "viewed"
  | "comment"
  | "guide"
  | "layout"
  | "prev-commit"
  | "next-commit";

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** The focused element's tag, lower case, and whether it is editable. */
  editing: boolean;
}

// b ("board") focuses the capture bar from anywhere; c is taken by the
// item and PR views.
const COMMON: Record<string, Command> = { r: "refresh", "?": "help", b: "capture" };

const BY_ROUTE: Record<Route, Record<string, Command>> = {
  queue: { j: "next", k: "prev", ArrowDown: "next", ArrowUp: "prev", o: "open", Enter: "open", n: "news", d: "ops", t: "triage", q: "decisions" },
  news: { u: "back", Escape: "back", n: "back", d: "ops", t: "triage", q: "decisions" },
  ops: { u: "back", Escape: "back", d: "back", n: "news", t: "triage", q: "decisions" },
  triage: { u: "back", Escape: "back", t: "back", n: "news", d: "ops", q: "decisions" },
  decisions: { u: "back", Escape: "back", q: "back", n: "news", d: "ops", t: "triage" },
  item: { u: "back", Escape: "back", c: "compose" },
  pr: {
    n: "next-file",
    p: "prev-file",
    j: "next-hunk",
    k: "prev-hunk",
    v: "viewed",
    x: "fold",
    a: "approve",
    c: "comment",
    g: "guide",
    s: "layout",
    "[": "prev-commit",
    "]": "next-commit",
    u: "back",
    Escape: "back",
  },
};

/**
 * The command for a key press, if any. Keys typed into a text field
 * belong to it, except Escape, which leaves the field; modified keys
 * belong to the browser.
 */
export function keyCommand(press: KeyPress, route: Route): Command | "blur" | undefined {
  if (press.ctrlKey || press.metaKey || press.altKey) return undefined;
  if (press.editing) return press.key === "Escape" ? "blur" : undefined;
  return BY_ROUTE[route][press.key] ?? COMMON[press.key];
}

export const HELP: Record<Route, string> = {
  queue: "j/k or ↓/↑ move · o or Enter open · t triage · q decisions · n news · d ops · b file to the board · r refresh · ? keys",
  news: "u, Esc or n back to the queue · t triage · q decisions · d ops · b file to the board · r refresh",
  ops: "u, Esc or d back to the queue · t triage · q decisions · n news · b file to the board · r refresh",
  triage: "u, Esc or t back to the queue · q decisions · n news · d ops · b file to the board · r refresh",
  decisions: "u, Esc or q back to the queue · t triage · n news · d ops · b file to the board · r refresh",
  item: "u or Esc back to the queue · c write an answer · b file to the board · r refresh",
  pr: "n/p next/previous file · j/k next/previous hunk · v mark viewed · x fold · c comment on the focused line (or write the review) · s unified/split · [/] previous/next commit · g guided review (then n/p between hotspots, Esc leaves) · a approve · b file to the board · u or Esc back · r reload",
};

export type RouteInfo =
  | { route: "queue"; filter?: QueueFilter }
  | { route: "news" }
  | { route: "ops" }
  | { route: "triage"; filter: TriageFilter }
  | { route: "decisions" }
  | { route: "item"; id: string }
  | { route: "pr"; ref: { owner: string; repo: string; number: number } };

/**
 * The view a location hash asks for; anything unknown is the queue. A
 * bare filter token (see filterToken), e.g. `#composefs`, is the queue
 * filtered so.
 */
export function parseRoute(hash: string): RouteInfo {
  if (hash === "#news") return { route: "news" };
  if (hash === "#ops") return { route: "ops" };
  if (hash === "#decisions") return { route: "decisions" };
  const triage = /^#triage(?:\/([a-z]+))?$/.exec(hash);
  if (triage) {
    const filter = TRIAGE_FILTERS.find((f) => f === (triage[1] ?? "all"));
    if (filter) return { route: "triage", filter };
  }
  const item = /^#item\/(PVTI_[A-Za-z0-9_-]+)$/.exec(hash);
  if (item?.[1]) return { route: "item", id: item[1] };
  const pr = /^#pr\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/([1-9][0-9]{0,9})$/.exec(hash);
  // "." and ".." are no repository's name, and would climb the API path.
  if (pr?.[1] && pr[2] && pr[3] && !/^\.+$/.test(pr[2])) return { route: "pr", ref: { owner: pr[1], repo: pr[2], number: Number(pr[3]) } };
  const filter = parseFilterToken(hash.slice(1));
  return filter ? { route: "queue", filter } : { route: "queue" };
}
