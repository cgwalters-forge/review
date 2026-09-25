// Public names only: this file is part of the public app. Everything
// about the items themselves is fetched at runtime with your token.

export const API_ROOT = "https://api.github.com";

/** The Workstream board, a Projects v2 board owned by a user. */
export const BOARD_OWNER = "cgwalters-bot";
export const BOARD_NUMBER = 1;
export const BOARD_URL = `https://github.com/users/${BOARD_OWNER}/projects/${BOARD_NUMBER}`;

/** The only login whose answers the bot acts on. */
export const OPERATOR = "cgwalters";

/** The Status value that puts an item in the queue. */
export const NEEDS_HUMAN = "Needs human";

/** Board fields the app reads, by name; their ids are looked up at runtime. */
export const FIELD = {
  status: "Status",
  priority: "Priority",
  why: "Why",
  org: "Org",
  branch: "Branch",
  gist: "Gist",
} as const;

/**
 * Owners whose repositories are the bot's and his own working space: an
 * answer comment there is expected. On any other public repository it is
 * a public comment on someone's project, so the app asks first.
 */
export const HOME_OWNERS: readonly string[] = ["cgwalters-forge", "cgwalters-bot", OPERATOR];

/** Poll every this many ms while the tab is visible. */
export const POLL_INTERVAL_MS = 30_000;
/** Poll this many times slower when the rate budget runs low. */
export const POLL_BACKOFF_FACTOR = 4;
/** Below this fraction of the hourly budget, back off. */
export const RATE_LOW_FRACTION = 0.1;

/** Items per page when listing the board (the API maximum). */
export const PAGE_SIZE = 100;
/** Comments shown in the item view. */
export const RECENT_COMMENTS = 5;

/** Relay endpoints, relative to the app, per docs/design.md. */
export const RELAY_TOKEN_PATH = "auth/github/token";
export const RELAY_START_PATH = "auth/github/start";
export const RELAY_LOGOUT_PATH = "auth/logout";
/** The custom header the relay requires on token requests (CSRF defence). */
export const RELAY_HEADER = "X-Review-Relay";

/** sessionStorage key for the local-development token. */
export const DEV_TOKEN_KEY = "review.dev-token";
