// Entry point: sign-in, routing between the queue, board items and forge
// PRs, keyboard commands, and polling while the tab is visible.

import { h } from "../dom.ts";
import { createRenderer } from "../markdown.ts";
import { GitHub, GitHubError } from "./api.ts";
import { missingScopes, type Persistence, savedToken, type TokenSource, useToken } from "./auth.ts";
import { answerTarget, type Item, questionOf } from "./board.ts";
import { type Context, loadContext, loadQueue, postAnswer, type ReceiptStatus, verifyReceipt, viewer } from "./backend.ts";
import {
  CLASSIC_SCOPES,
  FORGE_MIN_INTERVAL_MS,
  FORGE_POLL_INTERVAL_MS,
  HOME_OWNERS,
  OPERATOR,
  POLL_BACKOFF_FACTOR,
  POLL_INTERVAL_MS,
  RATE_LOW_FRACTION,
  THEME_KEY,
} from "./config.ts";
import { composeReview, type ForgePr, refKey, VERDICT_LABEL } from "./forge.ts";
import { type Command, HELP, keyCommand, parseRoute, type Route, type RouteInfo } from "./keys.ts";
import { loadForgePrs, loadPrDetail, type PrDetail, refreshVerdicts, submitReview, type VerdictEntry } from "./prs.ts";
import { APPROVE_ACTION, FILE_CLASS, prView, REVIEW_FORM_CLASS } from "./prview.ts";
import { buildEntries, type Entry } from "./queue.ts";
import { answerState, CONTEXT_CLASS, contextView, itemView, queueView, ROW_CLASS, ROW_KEY_ATTR, type RowLabel, STATE_LABEL } from "./view.ts";

const render = createRenderer(window);

interface State {
  gh: GitHub;
  source: TokenSource;
  login?: string;
  items: Item[];
  boardPublic: boolean;
  loaded: boolean;
  /** The bot's open draft PRs on the forge, from the last search. */
  prs: ForgePr[];
  /** Their verdicts and heads, by refKey. */
  verdicts: Map<string, VerdictEntry>;
  lastForgePoll: number;
  /** Search the forge on the next poll if the minimum interval allows. */
  forceForge: boolean;
  /** Whether a forge search has succeeded, so missing forge PRs mean gone. */
  forgeKnown: boolean;
  verdictsRunning: boolean;
  polling: boolean;
  /** The ranked queue. */
  entries: Entry[];
  /** The queue row the keyboard is on. */
  selected: string | undefined;
  /** Items answered from this tab, until the bot moves them on. */
  sent: Set<string>;
  /** PRs reviewed from this tab, by refKey. */
  reviewed: Set<string>;
  /** Context of opened items, by node id. */
  context: Map<string, Context>;
  /** Loaded PR details, by refKey. */
  details: Map<string, PrDetail>;
  /** The search's updated_at a PR was last reloaded for, by refKey. */
  reloadedFor: Map<string, string>;
  /** Checked receipts of drafts that claim an answer, by node id. */
  receipts: Map<string, ReceiptStatus>;
  /** The open item as it was rendered, to notice changes under it. */
  shown?: { nodeId: string; key: string };
  /** The open PR as it was rendered: its key and updated_at. */
  shownPr?: { key: string; updatedAt: string };
  /** A note about the open item or PR, e.g. that it changed. */
  itemNote?: string;
  /** The file the keyboard is on in a PR. */
  fileIndex: number;
  help: boolean;
  lastPoll?: Date;
  error?: string;
  forgeError?: string;
  /** What the token lacks, e.g. classic scopes. */
  tokenWarning?: string;
  timer?: ReturnType<typeof setTimeout>;
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html lacks #${id}`);
  return el as T;
}

function showMain(node: Node): void {
  byId("view").replaceChildren(node);
}

function setNotice(text: string | undefined): void {
  const n = byId("notice");
  n.textContent = text ?? "";
  n.hidden = !text;
}

const route = (): RouteInfo => parseRoute(window.location.hash);

function routeItemId(): string | undefined {
  const r = route();
  return r.route === "item" ? r.id : undefined;
}

/** What the open item view shows; a change means the view is stale. */
function itemKey(item: Item): string {
  return JSON.stringify([item.title, item.why, item.body, item.priority, item.status]);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function renderMeta(state: State): void {
  const parts = [state.login ? `signed in as ${state.login}` : ""];
  if (state.lastPoll) parts.push(`checked ${state.lastPoll.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  if (state.gh.rate) parts.push(`API ${state.gh.rate.remaining}/${state.gh.rate.limit}`);
  byId("meta").textContent = parts.filter(Boolean).join(" · ");
}

/** Meta line and notices only: never touches the view, or a half-typed answer. */
function renderChrome(state: State): void {
  renderMeta(state);
  const r = route().route;
  const warnings = [state.error, state.forgeError, state.tokenWarning, r !== "queue" ? state.itemNote : undefined];
  if (state.login && state.login !== OPERATOR) {
    warnings.push(`You are signed in as ${state.login}; the bot acts only on answers and reviews from ${OPERATOR}.`);
  }
  if (state.gh.rateLow(RATE_LOW_FRACTION)) warnings.push("The API rate budget is low; polling less often.");
  if (state.help) warnings.push(`Keys: ${HELP[r]}`);
  setNotice(warnings.filter(Boolean).join(" ") || undefined);
}

function labelOf(state: State): (e: Entry) => RowLabel | undefined {
  return (e) => {
    if (e.kind === "pr") {
      if (e.pr && state.reviewed.has(refKey(e.pr.ref))) return { text: "reviewed from here", cls: "answered" };
      const v = e.verdict;
      if (!v) return { text: "checking reviews…", cls: "pending" };
      return v.state === "none" ? undefined : { text: VERDICT_LABEL[v.state], cls: `v-${v.state}` };
    }
    const st = e.item ? answerState(e.item, state.sent, state.receipts) : undefined;
    return st ? { text: STATE_LABEL[st], cls: st } : undefined;
  };
}

function rows(): HTMLElement[] {
  return [...byId("view").querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)];
}

/** Mark the selected queue row, defaulting to the first. */
function markSelected(state: State, scroll: boolean): void {
  const all = rows();
  const sel = all.find((r) => r.getAttribute(ROW_KEY_ATTR) === state.selected) ?? all[0];
  for (const r of all) {
    r.classList.toggle("sel", r === sel);
    if (r === sel) r.setAttribute("aria-current", "true");
    else r.removeAttribute("aria-current");
  }
  state.selected = sel?.getAttribute(ROW_KEY_ATTR) ?? undefined;
  if (scroll && sel) {
    sel.scrollIntoView({ block: "nearest" });
    sel.focus({ preventScroll: true });
  }
}

function renderQueue(state: State): void {
  showMain(queueView(state.entries, labelOf(state)));
  markSelected(state, false);
}

/** Rebuild the whole view for the current route. */
function renderRoute(state: State): void {
  delete state.shown;
  delete state.shownPr;
  delete state.itemNote;
  state.fileIndex = -1;
  renderChrome(state);
  if (!state.loaded) {
    showMain(h("p", { class: "empty" }, "Loading…"));
    return;
  }
  const r = route();
  if (r.route === "pr") {
    renderPr(state, r.ref);
    return;
  }
  const item = r.route === "item" ? state.items.find((i) => i.nodeId === r.id) : undefined;
  if (!item) {
    if (r.route === "item") setNotice("That item no longer needs you (or isn't on the board).");
    renderQueue(state);
    return;
  }
  const ctx = state.context.get(item.nodeId);
  const target = answerTarget(item, HOME_OWNERS, ctx?.isPrivate ?? item.isPrivate, state.boardPublic);
  state.shown = { nodeId: item.nodeId, key: itemKey(item) };
  showMain(
    itemView(item, target, questionOf(item), ctx, render, state.sent.has(item.nodeId), {
      send: async (answer) => {
        const posted = await postAnswer(state.gh, item, target, answer);
        state.sent.add(item.nodeId);
        void refreshContext(state, item);
        return posted.url;
      },
    }),
  );
  if (!ctx) void refreshContext(state, item);
}

function prEntry(state: State, key: string): Entry | undefined {
  return state.entries.find((e) => e.key === `pr:${key}`);
}

function renderPr(state: State, ref: { owner: string; repo: string; number: number }): void {
  const key = refKey(ref);
  const detail = state.details.get(key);
  if (!detail) {
    showMain(h("main", { class: "item" }, h("a", { href: "#", class: "back" }, "← Queue (u)"), h("p", { class: "empty" }, `Loading ${key}…`)));
    void loadPr(state, ref);
    return;
  }
  // Opening a PR the forge says changed since we read it reads it again,
  // once per search result, in case the two timestamps never agree.
  const searched = state.prs.find((p) => refKey(p.ref) === key)?.updatedAt;
  if (searched && detail.updatedAt && searched > detail.updatedAt && state.reloadedFor.get(key) !== searched) {
    state.reloadedFor.set(key, searched);
    state.details.delete(key);
    renderPr(state, ref);
    return;
  }
  state.shownPr = { key, updatedAt: detail.updatedAt };
  showMain(
    prView(detail, prEntry(state, key), render, {
      review: async (action, text, draft) => {
        const url = await submitReview(state.gh, ref, composeReview(action, text, detail.head, { draft }));
        state.reviewed.add(key);
        state.forceForge = true;
        // Our own review moved updated_at: note the new one so it isn't
        // reported as a change, without re-rendering the form.
        void loadPrDetail(state.gh, ref)
          .then((d) => {
            state.details.set(key, d);
            if (state.shownPr?.key === key) state.shownPr.updatedAt = d.updatedAt;
          })
          .catch(() => {
            // The next open reloads it.
          });
        return url;
      },
    }, { reviewedHere: state.reviewed.has(key) }),
  );
}

/** Load (or reload) a PR's details, then show them if it is still open. */
async function loadPr(state: State, ref: { owner: string; repo: string; number: number }): Promise<void> {
  const key = refKey(ref);
  try {
    state.details.set(key, await loadPrDetail(state.gh, ref));
  } catch (e) {
    const r = route();
    if (r.route === "pr" && refKey(r.ref) === key) {
      showMain(
        h(
          "main",
          { class: "item" },
          h("a", { href: "#", class: "back" }, "← Queue (u)"),
          h("p", { class: "warn" }, `Couldn't load ${key}: ${message(e)}. Press r to retry.`),
        ),
      );
    }
    return;
  }
  const r = route();
  if (r.route === "pr" && refKey(r.ref) === key) renderRoute(state);
}

/** (Re)load an item's context and update only that part of its view. */
async function refreshContext(state: State, item: Item): Promise<void> {
  const ctx = await loadContext(state.gh, item);
  state.context.set(item.nodeId, ctx);
  if (ctx.receipt) state.receipts.set(item.nodeId, ctx.receipt);
  if (routeItemId() !== item.nodeId) return;
  const container = byId("view").querySelector(`.${CONTEXT_CLASS}`);
  container?.replaceChildren(contextView(item, ctx, render));
}

/** Check the receipts of drafts that claim an answer, for the queue's labels. */
async function refreshReceipts(state: State): Promise<void> {
  const checks = await Promise.all(state.items.map(async (i) => [i.nodeId, await verifyReceipt(state.gh, i)] as const));
  state.receipts = new Map(checks.flatMap(([id, r]) => (r ? [[id, r] as const] : [])));
}

/** Re-search the forge when due; true if its list of PRs changed. Verdicts follow in the background. */
async function pollForge(state: State): Promise<boolean> {
  const wait = state.forceForge ? FORGE_MIN_INTERVAL_MS : FORGE_POLL_INTERVAL_MS;
  if (Date.now() - state.lastForgePoll < wait) return false;
  state.forceForge = false;
  try {
    const prs = await loadForgePrs(state.gh);
    state.lastForgePoll = Date.now();
    state.forgeKnown = true;
    delete state.forgeError;
    const sig = (p: readonly ForgePr[]) => JSON.stringify(p.map((x) => [refKey(x.ref), x.updatedAt]));
    const changed = sig(prs) !== sig(state.prs);
    state.prs = prs;
    void pollVerdicts(state);
    return changed;
  } catch (e) {
    state.forgeError = `Couldn't read the forge's PRs: ${message(e)}`;
    return false;
  }
}

/** Re-read the verdicts of PRs that changed, and update the view if any moved. */
async function pollVerdicts(state: State): Promise<void> {
  // One at a time; the next forge poll catches up on what this one missed.
  if (state.verdictsRunning) return;
  state.verdictsRunning = true;
  try {
    const verdicts = await refreshVerdicts(state.gh, state.prs, state.verdicts);
    const sig = (v: ReadonlyMap<string, VerdictEntry>) => JSON.stringify([...v].map(([k, e]) => [k, e.head, e.verdict.state]).sort());
    const changed = sig(verdicts) !== sig(state.verdicts);
    state.verdicts = verdicts;
    if (changed && state.loaded) update(state, false, false);
  } catch (e) {
    state.forgeError = `Couldn't read the forge PRs' reviews: ${message(e)}`;
    renderChrome(state);
  } finally {
    state.verdictsRunning = false;
  }
}

function rebuildEntries(state: State): void {
  const verdicts = new Map([...state.verdicts].map(([k, v]) => [k, v.verdict]));
  state.entries = buildEntries(state.items, state.prs, verdicts, state.forgeKnown);
}

/**
 * Rebuild the queue after new data, and refresh the view without losing
 * a half-typed answer or review: only the queue is re-rendered; an open
 * item or PR just gets a note if it changed underneath.
 */
function update(state: State, boardChanged: boolean, first: boolean): void {
  rebuildEntries(state);
  const r = route();
  if (first || r.route === "queue") {
    renderRoute(state);
  } else if (r.route === "item") {
    const item = state.items.find((i) => i.nodeId === r.id);
    if (!item) state.itemNote = "This item no longer needs you; the bot may have acted on it.";
    else if (state.shown && itemKey(item) !== state.shown.key) {
      state.itemNote = "This item changed on the board since you opened it; go back and reopen it to see the new version.";
    }
    if (item && boardChanged) void refreshContext(state, item);
    renderChrome(state);
  } else {
    const key = refKey(r.ref);
    const now = state.prs.find((p) => refKey(p.ref) === key)?.updatedAt;
    if (state.shownPr?.key === key && now && state.shownPr.updatedAt && now > state.shownPr.updatedAt) {
      state.itemNote = "This PR changed since you opened it (new commits or reviews); press r to reload.";
    }
    renderChrome(state);
  }
}

async function poll(state: State): Promise<void> {
  // One poll at a time; the running one schedules the next.
  if (state.polling) return;
  state.polling = true;
  clearTimeout(state.timer);
  // The board and the forge load side by side; whichever answers first shows first.
  const forge = pollForge(state);
  try {
    const q = await loadQueue(state.gh);
    state.lastPoll = new Date();
    delete state.error;
    const first = !state.loaded;
    if (q.changed || first) {
      state.items = q.items;
      state.boardPublic = q.boardPublic;
      // Keep "sent" only for items still waiting on the bot.
      const ids = new Set(q.items.map((i) => i.nodeId));
      for (const s of state.sent) if (!ids.has(s)) state.sent.delete(s);
      state.context.clear();
      await refreshReceipts(state);
      state.loaded = true;
      update(state, true, first);
    } else {
      renderChrome(state);
    }
  } catch (e) {
    state.error = `Couldn't read the board: ${message(e)}`;
    if (state.loaded) renderChrome(state);
    else renderRoute(state);
  }
  try {
    if ((await forge) && state.loaded) update(state, false, false);
  } finally {
    // Whatever went wrong above, keep polling.
    state.polling = false;
    schedule(state);
  }
}

function schedule(state: State): void {
  if (document.hidden) return;
  const slow = state.gh.rateLow(RATE_LOW_FRACTION) ? POLL_BACKOFF_FACTOR : 1;
  state.timer = setTimeout(() => void poll(state), POLL_INTERVAL_MS * slow);
}

function isEditing(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

function moveFile(state: State, step: number): void {
  const files = [...byId("view").querySelectorAll<HTMLDetailsElement>(`details.${FILE_CLASS}`)];
  if (files.length === 0) return;
  state.fileIndex = Math.max(0, Math.min(files.length - 1, state.fileIndex + step));
  const f = files[state.fileIndex];
  for (const x of files) x.classList.toggle("sel", x === f);
  f?.scrollIntoView({ block: "start" });
  f?.querySelector("summary")?.focus({ preventScroll: true });
}

function run(state: State, cmd: Command, where: Route): void {
  const view = byId("view");
  switch (cmd) {
    case "next":
    case "prev": {
      const step = cmd === "next" ? 1 : -1;
      if (where === "pr") {
        moveFile(state, step);
        return;
      }
      const all = rows();
      const i = all.findIndex((r) => r.getAttribute(ROW_KEY_ATTR) === state.selected);
      const next = all[Math.max(0, Math.min(all.length - 1, i + step))];
      state.selected = next?.getAttribute(ROW_KEY_ATTR) ?? undefined;
      markSelected(state, true);
      return;
    }
    case "open": {
      const sel = rows().find((r) => r.classList.contains("sel"));
      if (sel) window.location.hash = sel.getAttribute("href") ?? "#";
      return;
    }
    case "back":
      window.location.hash = "#";
      return;
    case "refresh": {
      const r = route();
      if (r.route === "pr") {
        void loadPr(state, r.ref);
        return;
      }
      state.forceForge = true;
      void poll(state);
      return;
    }
    case "approve":
      view.querySelector<HTMLButtonElement>(`.${REVIEW_FORM_CLASS} button[data-action="${APPROVE_ACTION}"]`)?.click();
      return;
    case "fold": {
      const files = view.querySelectorAll<HTMLDetailsElement>(`details.${FILE_CLASS}`);
      const f = files[Math.max(0, state.fileIndex)];
      if (f) f.open = !f.open;
      return;
    }
    case "compose":
      view.querySelector<HTMLTextAreaElement>("form textarea")?.focus();
      return;
    case "help":
      state.help = !state.help;
      renderChrome(state);
      return;
  }
}

function installKeys(state: State): void {
  document.addEventListener("keydown", (ev) => {
    const where = route().route;
    const cmd = keyCommand(
      { key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, editing: ev.isComposing || isEditing(document.activeElement) },
      where,
    );
    if (!cmd) return;
    // Enter on a focused link or button does its own thing.
    if (ev.key === "Enter" && document.activeElement instanceof HTMLElement && document.activeElement.matches("a, button, summary")) return;
    ev.preventDefault();
    if (cmd === "blur") {
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    run(state, cmd, where);
  });
}

type Theme = "auto" | "light" | "dark";
const THEMES: readonly Theme[] = ["auto", "light", "dark"];

function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  byId("theme").textContent = `Theme: ${theme}`;
}

/** A per-browser convenience; storage may be blocked. */
function installTheme(): void {
  let theme: Theme = "auto";
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (saved && (THEMES as readonly string[]).includes(saved)) theme = saved as Theme;
  } catch {
    // Default theme.
  }
  applyTheme(theme);
  byId("theme").onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? "auto";
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Not remembered.
    }
  };
}

/** Which token problem to explain on the sign-in page. */
type SignInReason = "none" | "rejected";

async function start(source: TokenSource): Promise<void> {
  const state: State = {
    gh: new GitHub(() => source.get()),
    source,
    items: [],
    loaded: false,
    boardPublic: true,
    prs: [],
    verdicts: new Map(),
    lastForgePoll: 0,
    forceForge: false,
    forgeKnown: false,
    verdictsRunning: false,
    polling: false,
    entries: [],
    sent: new Set(),
    reviewed: new Set(),
    context: new Map(),
    details: new Map(),
    reloadedFor: new Map(),
    receipts: new Map(),
    fileIndex: -1,
    help: false,
    selected: undefined,
  };
  byId("meta").textContent = "Checking the token…";
  try {
    state.login = await viewer(state.gh);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) {
      await source.signOut();
      showSignIn("rejected");
      return;
    }
    // Anything else (offline, rate limited) the poll reports too.
  }
  const lacking = missingScopes(state.gh.scopes, CLASSIC_SCOPES);
  if (lacking.length) {
    state.tokenWarning = `This token lacks the ${lacking.map((n) => n.any.join(" or ")).join(", ")} scope${lacking.length > 1 ? "s" : ""}; some reads or answers will fail.`;
  }
  byId("signout").hidden = false;
  byId("signout").onclick = () => {
    void source.signOut().finally(() => window.location.reload());
  };
  window.addEventListener("hashchange", () => {
    renderRoute(state);
    if (route().route === "queue") markSelected(state, true);
    else window.scrollTo(0, 0);
  });
  installKeys(state);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll(state);
    else clearTimeout(state.timer);
  });
  renderRoute(state);
  await poll(state);
}

function scopeList(): HTMLElement {
  const list = h("ul", { class: "scopes" });
  for (const need of CLASSIC_SCOPES) {
    const names = need.any.map((s) => h("code", {}, s));
    const label = names.flatMap((n, i) => (i ? [" or ", n] : [n]));
    list.append(h("li", {}, ...label, ` — ${need.why}`));
  }
  return list;
}

function signInView(reason: SignInReason): HTMLElement {
  const input = h("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "GitHub token",
    placeholder: "github_pat_… or ghp_…",
  });
  const remember = h("input", { type: "checkbox", id: "remember" });
  const status = h("p", { class: "status", role: "status" });
  const form = h(
    "form",
    { class: "signin" },
    h("h2", {}, "Sign in with a token"),
    reason === "rejected"
      ? h("p", { class: "warn" }, "GitHub rejected the saved token: it has expired or was revoked. Paste a new one.")
      : null,
    h(
      "p",
      {},
      "Paste a GitHub personal access token. It stays in this browser and is sent only to api.github.com; this page has no server. Everything you see is read with it, so the page shows nothing your token can't read.",
    ),
    input,
    h("label", { class: "check", for: "remember" }, remember, " Remember on this device (localStorage). Otherwise it is forgotten when you close the tab."),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Use token")),
    status,
    h(
      "details",
      { class: "help" },
      h("summary", {}, "Which token?"),
      h(
        "p",
        {},
        "A classic token with a short expiry works everywhere the bot asks you things, including upstream repositories. It needs:",
      ),
      scopeList(),
      h(
        "p",
        {},
        "A fine-grained token acts on one resource owner only: with owner cgwalters-forge and Pull requests: read and write, Issues: read and write, and Contents and Commit statuses: read, it can review forge PRs, but not answer on upstream repositories or write draft items.",
      ),
      h("p", {}, "Anyone who can change this site's code could read a pasted token, so prefer one that expires soon."),
    ),
  );
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    try {
      const persistence: Persistence = remember.checked ? "local" : "session";
      const source = useToken(input.value, persistence);
      input.value = "";
      void start(source);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  return h("main", {}, form);
}

function showSignIn(reason: SignInReason): void {
  byId("meta").textContent = "";
  byId("signout").hidden = true;
  showMain(signInView(reason));
}

/** Keep --header-h at the sticky header's height, for the sticky file names below it. */
function trackHeaderHeight(): void {
  const header = document.querySelector<HTMLElement>("header.top");
  if (!header) return;
  const set = () => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
  new ResizeObserver(set).observe(header);
  set();
}

async function main(): Promise<void> {
  installTheme();
  trackHeaderHeight();
  // A CSP meta tag can't forbid framing, so refuse to run in a frame:
  // otherwise another site could overlay the approve and send buttons.
  if (window.top !== window.self) {
    setNotice("This page refuses to run inside a frame. Open it directly.");
    return;
  }
  const saved = savedToken();
  if (saved) await start(saved);
  else showSignIn("none");
}

main().catch((e: unknown) => {
  setNotice(`The app failed to start: ${e instanceof Error ? e.message : String(e)}`);
});
