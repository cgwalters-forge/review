// Public names only: this file is part of the public app. Everything
// about the items themselves is fetched at runtime with your token.

export const API_ROOT = "https://api.github.com";

/** The Workstream board, a Projects v2 board owned by a user. */
export const BOARD_OWNER = "cgwalters-bot";
export const BOARD_NUMBER = 1;
export const BOARD_URL = `https://github.com/users/${BOARD_OWNER}/projects/${BOARD_NUMBER}`;

/** The only login whose answers the bot acts on. */
export const OPERATOR = "cgwalters";

/** The Status of an item blocked on his decision or action. */
export const NEEDS_HUMAN = "Needs human";
/** The Status of an item ready for his review (a forge PR or a gist). */
export const DRAFT = "Draft";
/** The Statuses that put an item in the queue (the board's "Needs cgwalters" view). */
export const QUEUE_STATUSES: readonly string[] = [NEEDS_HUMAN, DRAFT];

/** The organization holding the forks where the bot proposes draft PRs. */
export const FORGE_ORG = "cgwalters-forge";
/** The bot's login: the forge PRs listed are the ones it opened. */
export const BOT_LOGIN = "cgwalters-bot";

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
/** Poll the forge's PR search this often: search has its own, smaller budget. */
export const FORGE_POLL_INTERVAL_MS = 60_000;
/** ... and at most this often when asked to refresh (r, or after a review). */
export const FORGE_MIN_INTERVAL_MS = 10_000;
/** Parallel requests when refreshing PR verdicts. */
export const FETCH_CONCURRENCY = 6;
/** A file's diff starts collapsed above this many lines. */
export const DIFF_COLLAPSE_LINES = 300;
/** Poll this many times slower when the rate budget runs low. */
export const POLL_BACKOFF_FACTOR = 4;
/** Below this fraction of the hourly budget, back off. */
export const RATE_LOW_FRACTION = 0.1;

/** Items per page when listing the board (the API maximum). */
export const PAGE_SIZE = 100;
/** Comments shown in the item view. */
export const RECENT_COMMENTS = 5;

/** The repositories whose merged PRs the news pane shows: the bot, its runner and this app. */
export const NEWS_REPOS: readonly string[] = [
  "cgwalters-bot/homegit",
  "cgwalters-forge/cgwalters-devspace-sandbox",
  "bootc-dev/cgwalters-devspace-sandbox",
  "cgwalters-forge/review",
];
/** Closed PRs read per repository (one page). */
export const NEWS_PER_REPO = 30;
/** News items shown. */
export const NEWS_LIMIT = 40;

/** localStorage key for the chosen theme (auto, light, dark). */
export const THEME_KEY = "review.theme";

/** Storage key for the pasted token (sessionStorage, or localStorage if remembered). */
export const TOKEN_KEY = "review.token";

/**
 * What a classic token needs, by scope; each entry is met by any one of
 * its scopes. Shown on the sign-in page, and checked against the
 * X-OAuth-Scopes header once signed in.
 */
export const CLASSIC_SCOPES = [
  { any: ["public_repo", "repo"], why: "read PRs and post comments and reviews as you (repo only if you want private repositories too)" },
  { any: ["read:project", "project"], why: "read the Workstream board (project only to answer draft items)" },
  { any: ["gist"], why: "save answer receipts for draft items" },
] as const satisfies readonly { any: readonly string[]; why: string }[];
