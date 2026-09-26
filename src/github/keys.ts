// Keyboard commands, as a pure mapping from a key press to a command so
// tests can check it; main.ts carries them out.

export type Route = "queue" | "item" | "pr" | "news";

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
  | "news";

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** The focused element's tag, lower case, and whether it is editable. */
  editing: boolean;
}

const COMMON: Record<string, Command> = { r: "refresh", "?": "help" };

const BY_ROUTE: Record<Route, Record<string, Command>> = {
  queue: { j: "next", k: "prev", ArrowDown: "next", ArrowUp: "prev", o: "open", Enter: "open", n: "news" },
  news: { u: "back", Escape: "back", n: "back" },
  item: { u: "back", Escape: "back", c: "compose" },
  pr: { j: "next", k: "prev", x: "fold", a: "approve", c: "compose", u: "back", Escape: "back" },
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
  queue: "j/k or ↓/↑ move · o or Enter open · n news · r refresh · ? keys",
  news: "u, Esc or n back to the queue · r refresh",
  item: "u or Esc back to the queue · c write an answer · r refresh",
  pr: "j/k next/previous file · x fold file · a approve · c write a review · u or Esc back · r reload",
};

export type RouteInfo =
  | { route: "queue" }
  | { route: "news" }
  | { route: "item"; id: string }
  | { route: "pr"; ref: { owner: string; repo: string; number: number } };

/** The view a location hash asks for; anything unknown is the queue. */
export function parseRoute(hash: string): RouteInfo {
  if (hash === "#news") return { route: "news" };
  const item = /^#item\/(PVTI_[A-Za-z0-9_-]+)$/.exec(hash);
  if (item?.[1]) return { route: "item", id: item[1] };
  const pr = /^#pr\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/([1-9][0-9]{0,9})$/.exec(hash);
  // "." and ".." are no repository's name, and would climb the API path.
  if (pr?.[1] && pr[2] && pr[3] && !/^\.+$/.test(pr[2])) return { route: "pr", ref: { owner: pr[1], repo: pr[2], number: Number(pr[3]) } };
  return { route: "queue" };
}
