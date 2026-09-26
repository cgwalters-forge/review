// Entry point: sign-in, routing between the queue, board items and forge
// PRs, keyboard commands, and polling while the tab is visible.

import { h } from "../dom.ts";
import { createRenderer } from "../markdown.ts";
import { GitHub, GitHubError } from "./api.ts";
import { missingScopes, type Persistence, savedToken, type TokenSource, useToken } from "./auth.ts";
import { answerTarget, type Item } from "./board.ts";
import { type Context, loadAnswered, loadContext, loadQueue, postAnswer, viewer } from "./backend.ts";
import { cachedLabel, type CacheSession, openCache } from "./cache.ts";
import {
  CLASSIC_SCOPES,
  FETCH_CONCURRENCY,
  FORGE_MIN_INTERVAL_MS,
  FORGE_POLL_INTERVAL_MS,
  NEWS_LIMIT,
  OPERATOR,
  POLL_BACKOFF_FACTOR,
  POLL_INTERVAL_MS,
  RATE_LOW_FRACTION,
  THEME_KEY,
} from "./config.ts";
import { composeReviews, type ForgePr, refKey, VERDICT_LABEL } from "./forge.ts";
import { type Command, HELP, keyCommand, parseRoute, type Route, type RouteInfo } from "./keys.ts";
import { type HarnessCache, loadNews, type News } from "./news.ts";
import { newsView } from "./newsview.ts";
import { deleteCacheDatabase, IdbStore } from "./idbstore.ts";
import { loadFileLines, loadForgePrs, loadPrDetail, loadRangeFiles, mapLimit, type PrDetail, refreshVerdicts, submitReview, type VerdictEntry } from "./prs.ts";
import { APPROVE_ACTION, type PrPane, prView, REVIEW_FORM_CLASS } from "./prview.ts";
import { buildEntries, type Entry, itemHref } from "./queue.ts";
import { answerState, type BoardHref, CONTEXT_CLASS, contextView, itemView, queueView, ROW_CLASS, ROW_KEY_ATTR, type RowLabel, STATE_LABEL } from "./view.ts";

const render = createRenderer(window);

interface State {
  gh: GitHub;
  source: TokenSource;
  session: CacheSession;
  /** Set once signed out: nothing renders any more. */
  closed: boolean;
  login?: string;
  items: Item[];
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
  /** Open questions he has answered on GitHub and the bot hasn't acted on, by node id. */
  answered: Set<string>;
  /** Bumped per board change, so an older answered read can't land over a newer one. */
  answeredSeq: number;
  /** PRs reviewed from this tab, by refKey. */
  reviewed: Set<string>;
  /** Context of opened items, by node id. */
  context: Map<string, Context>;
  /** Loaded PR details, by refKey. */
  details: Map<string, PrDetail>;
  /** The search's updated_at a PR was last reloaded for, by refKey. */
  reloadedFor: Map<string, string>;
  /** The open item as it was rendered, to notice changes under it. */
  shown?: { nodeId: string; key: string };
  /** The open PR as it was rendered: its key and updated_at. */
  shownPr?: { key: string; updatedAt: string };
  /** A note about the open item or PR, e.g. that it changed. */
  itemNote?: string;
  /** The news pane's last read, and which merged PRs touched the harness. */
  news?: News;
  harness: HarnessCache;
  /** The open PR's pane, which handles its own keys. */
  pane?: PrPane;
  help: boolean;
  lastPoll?: Date;
  /** The queue shows cached data fetched at this time (epoch ms), until the board is revalidated. */
  cachedAt?: number;
  /** PR details shown from the cache, by refKey: when they were fetched. */
  prCachedAt: Map<string, number>;
  /** The news pane shows cached data fetched at this time. */
  newsCachedAt?: number;
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

/** When what the current view shows was fetched, if it is a cached copy not yet revalidated. */
function cachedSince(state: State): number | undefined {
  const r = route();
  if (r.route === "pr") return state.prCachedAt.get(refKey(r.ref));
  if (r.route === "news") return state.newsCachedAt;
  return state.cachedAt;
}

function renderMeta(state: State): void {
  const parts: (string | Node)[] = [];
  if (state.login) parts.push(`signed in as ${state.login}`);
  const since = cachedSince(state);
  if (since !== undefined) parts.push(h("span", { class: "cached", title: "Shown from this browser's cache; checking GitHub for changes" }, cachedLabel(since, Date.now())));
  else if (state.lastPoll) parts.push(`checked ${state.lastPoll.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  if (state.gh.rate) parts.push(`API ${state.gh.rate.remaining}/${state.gh.rate.limit}`);
  byId("meta").replaceChildren(...parts.flatMap((p, i) => (i ? [" · ", p] : [p])));
}

/** Meta line and notices only: never touches the view, or a half-typed answer. */
function renderChrome(state: State): void {
  renderMeta(state);
  const r = route().route;
  byId("nav-queue").classList.toggle("on", r !== "news");
  byId("nav-news").classList.toggle("on", r === "news");
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
    const st = e.item ? answerState(e.item, state.sent, state.answered) : undefined;
    return st ? { text: STATE_LABEL[st], cls: st } : undefined;
  };
}

/** Link issues that are in the queue to their item view. */
function boardHref(state: State): BoardHref {
  return (ref) => {
    const key = refKey(ref).toLowerCase();
    const item = state.items.find((i) => i.ref && refKey(i.ref).toLowerCase() === key);
    return item ? itemHref(item) : undefined;
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
  state.pane?.dispose();
  delete state.pane;
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
  if (r.route === "news") {
    showMain(newsView(state.news, render));
    if (!state.news) void refreshNews(state);
    return;
  }
  const item = r.route === "item" ? state.items.find((i) => i.nodeId === r.id) : undefined;
  if (!item) {
    if (r.route === "item") setNotice("That item no longer needs you (or isn't on the board).");
    renderQueue(state);
    return;
  }
  const ctx = state.context.get(item.nodeId);
  const target = answerTarget(item);
  state.shown = { nodeId: item.nodeId, key: itemKey(item) };
  const answered = ctx?.answered ? new Set([...state.answered, item.nodeId]) : state.answered;
  const entry = state.entries.find((e) => e.item?.nodeId === item.nodeId);
  showMain(
    itemView(item, { target, context: ctx, state: answerState(item, state.sent, answered), questions: entry?.children ?? [], boardHref: boardHref(state) }, render, {
      send: async (answer) => {
        if (target.kind !== "question") throw new Error(`can't answer here: ${target.reason}`);
        const posted = await postAnswer(state.gh, target.ref, answer);
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
    void loadPr(state, ref, true);
    return;
  }
  // Opening a PR the forge says changed since we read it reads it again,
  // once per search result, in case the two timestamps never agree. (A
  // cached copy is being re-read already.)
  const searched = state.prs.find((p) => refKey(p.ref) === key)?.updatedAt;
  if (searched && detail.updatedAt && searched > detail.updatedAt && !state.prCachedAt.has(key) && state.reloadedFor.get(key) !== searched) {
    state.reloadedFor.set(key, searched);
    state.details.delete(key);
    renderPr(state, ref);
    return;
  }
  state.shownPr = { key, updatedAt: detail.updatedAt };
  const pane = prView(detail, prEntry(state, key), render, {
    review: async (action, text, draft, comments, sent) => {
      const reviews = composeReviews(action, text, detail.head, { draft, comments });
      const url = await submitReview(state.gh, ref, reviews, (i) => sent(reviews[i]?.commit_id ?? ""));
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
    loadRange: (base, to) => loadRangeFiles(state.gh, ref, base, to),
    loadLines: (path, sha) => loadFileLines(state.gh, ref, path, sha),
  }, { reviewedHere: state.reviewed.has(key) });
  state.pane = pane;
  showMain(pane.el);
}

/**
 * Load (or reload) a PR's details, then show them if it is still open.
 * With `cacheFirst`, a cached copy is shown first, marked as such, and
 * replaced only if the fresh one differs. Approving from it is safe:
 * submitReview checks the head against GitHub, never the cache.
 */
async function loadPr(state: State, ref: { owner: string; repo: string; number: number }, cacheFirst = false): Promise<void> {
  const key = refKey(ref);
  const isOpen = () => {
    const r = route();
    return !state.closed && r.route === "pr" && refKey(r.ref) === key;
  };
  if (cacheFirst && !state.details.has(key)) {
    const cached = state.gh.cacheOnly();
    try {
      const detail = await loadPrDetail(cached, ref);
      if (!state.details.has(key)) {
        state.details.set(key, detail);
        state.prCachedAt.set(key, cached.oldest ?? Date.now());
        if (isOpen()) renderRoute(state);
      }
    } catch {
      // Not (all) cached: wait for GitHub.
    }
  }
  let fresh: PrDetail;
  try {
    fresh = await loadPrDetail(state.gh, ref);
  } catch (e) {
    if (!isOpen()) return;
    if (state.prCachedAt.has(key)) {
      state.itemNote = `Couldn't refresh ${key}: ${message(e)}. This is the cached copy; press r to retry.`;
      renderChrome(state);
      return;
    }
    showMain(
      h(
        "main",
        { class: "item" },
        h("a", { href: "#", class: "back" }, "← Queue (u)"),
        h("p", { class: "warn" }, `Couldn't load ${key}: ${message(e)}. Press r to retry.`),
      ),
    );
    return;
  }
  const shown = state.details.get(key);
  const wasCached = state.prCachedAt.delete(key);
  state.details.set(key, fresh);
  if (!isOpen()) return;
  // The cached copy was right: keep the pane (and where he scrolled to).
  if (wasCached && shown && JSON.stringify(shown) === JSON.stringify(fresh)) renderChrome(state);
  else renderRoute(state);
}

/** (Re)load an item's context and update only that part of its view. */
async function refreshContext(state: State, item: Item): Promise<void> {
  const ctx = await loadContext(state.gh, item);
  state.context.set(item.nodeId, ctx);
  if (routeItemId() !== item.nodeId) return;
  const container = byId("view").querySelector(`.${CONTEXT_CLASS}`);
  container?.replaceChildren(contextView(item, ctx, render, boardHref(state)));
}

/**
 * Re-read the news (conditionally), and show it if the pane is open and
 * it changed. The first time, a complete cached copy shows first.
 */
async function refreshNews(state: State): Promise<void> {
  if (!state.news) {
    const cached = state.gh.cacheOnly();
    const news = await loadNews(cached, state.harness, NEWS_LIMIT).catch(() => undefined);
    // Only a complete copy: a repository missing from the cache would read as an error.
    if (news && !news.warnings.length && !state.news) {
      state.news = news;
      state.newsCachedAt = cached.oldest ?? Date.now();
      if (route().route === "news") {
        showMain(newsView(news, render));
        renderChrome(state);
      }
    }
  }
  try {
    const news = await loadNews(state.gh, state.harness, NEWS_LIMIT);
    const first = !state.news;
    delete state.newsCachedAt;
    state.news = news;
    if ((news.changed || first) && route().route === "news") showMain(newsView(news, render));
    renderChrome(state);
  } catch (e) {
    state.error = `Couldn't read the news: ${message(e)}`;
    renderChrome(state);
  }
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

/**
 * Show the queue as the cache last saw it, before GitHub answers: the
 * board, the forge's PRs and their verdicts, and which questions are
 * answered, all read by the same loaders from a cache-only client, so
 * the first render already has its labels and nothing shifts when the
 * fresh answer replaces it. Does nothing if the board isn't cached or
 * the network was faster.
 */
async function showCached(state: State): Promise<void> {
  // The label's age is the board's and the search's: verdicts of PRs
  // that haven't changed are reused without re-reading them.
  const queueReads = state.gh.cacheOnly();
  const otherReads = state.gh.cacheOnly();
  let items: Item[];
  try {
    items = (await loadQueue(queueReads)).items;
  } catch {
    return;
  }
  const prs = await loadForgePrs(queueReads).catch(() => undefined);
  const verdicts = new Map<string, VerdictEntry>();
  const parts = await mapLimit(prs ?? [], FETCH_CONCURRENCY, (p) => refreshVerdicts(otherReads, [p], new Map()).catch(() => new Map<string, VerdictEntry>()));
  for (const part of parts) for (const [k, v] of part) verdicts.set(k, v);
  const answered = await loadAnswered(otherReads, items);
  if (state.loaded || state.closed) return;
  state.items = items;
  if (prs) {
    state.prs = prs;
    state.forgeKnown = true;
  }
  state.verdicts = verdicts;
  state.answered = answered;
  state.loaded = true;
  state.cachedAt = queueReads.oldest ?? Date.now();
  update(state, true, true);
}

/**
 * Re-read which questions he answered, after the queue is on screen (one
 * request per open question with comments, so it shouldn't hold up the
 * first render), and update the view if that changed.
 */
async function refreshAnswered(state: State, items: readonly Item[]): Promise<void> {
  const seq = ++state.answeredSeq;
  const answered = await loadAnswered(state.gh, items);
  if (seq !== state.answeredSeq) return;
  const same = answered.size === state.answered.size && [...answered].every((id) => state.answered.has(id));
  state.answered = answered;
  if (!same) update(state, false, false);
}

function rebuildEntries(state: State): void {
  const verdicts = new Map([...state.verdicts].map(([k, v]) => [k, v.verdict]));
  state.entries = buildEntries(state.items, state.prs, verdicts, state.forgeKnown, new Set([...state.answered, ...state.sent]));
}

/**
 * Rebuild the queue after new data, and refresh the view without losing
 * a half-typed answer or review: only the queue is re-rendered; an open
 * item or PR just gets a note if it changed underneath.
 */
function update(state: State, boardChanged: boolean, first: boolean): void {
  rebuildEntries(state);
  const r = route();
  if (r.route === "news") {
    renderChrome(state);
  } else if (first || r.route === "queue") {
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
  if (route().route === "news") void refreshNews(state);
  // The board and the forge load side by side; whichever answers first shows first.
  const forge = pollForge(state);
  try {
    const q = await loadQueue(state.gh);
    state.lastPoll = new Date();
    delete state.error;
    const first = !state.loaded;
    // The first answer after showing the cached queue: re-read what the
    // cache decided (which questions are answered) even if the board is unchanged.
    const revalidated = state.cachedAt !== undefined;
    delete state.cachedAt;
    if (q.changed || first || revalidated) {
      state.items = q.items;
      // Keep "sent" only for items still waiting on the bot.
      const ids = new Set(q.items.map((i) => i.nodeId));
      for (const s of state.sent) if (!ids.has(s)) state.sent.delete(s);
      state.context.clear();
      state.loaded = true;
      update(state, true, first);
      refreshAnswered(state, q.items).catch((e: unknown) => {
        // The answered labels stay as they were; the next board change retries.
        console.error("review: couldn't update which questions are answered:", e);
      });
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

function run(state: State, cmd: Command, where: Route): void {
  const view = byId("view");
  if (where === "pr" && state.pane?.command(cmd)) return;
  switch (cmd) {
    case "next":
    case "prev": {
      const step = cmd === "next" ? 1 : -1;
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
    case "news":
      window.location.hash = "#news";
      return;
    case "refresh": {
      const r = route();
      if (r.route === "pr") {
        void loadPr(state, r.ref);
        return;
      }
      if (r.route === "news") {
        void refreshNews(state);
        return;
      }
      state.forceForge = true;
      void poll(state);
      return;
    }
    case "approve":
      view.querySelector<HTMLButtonElement>(`.${REVIEW_FORM_CLASS} button[data-action="${APPROVE_ACTION}"]`)?.click();
      return;
    case "compose":
    case "comment":
      // With no line focused in a PR, c goes to the review text.
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

/** Forget cached responses: on sign-out, or when GitHub rejects the token. */
async function forgetCache(session: CacheSession): Promise<void> {
  await session.cache.wipe();
  // Also a store that was never attached, e.g. another login's.
  await (session.store ? session.store.destroy() : deleteCacheDatabase());
}

async function start(source: TokenSource): Promise<void> {
  const session = await openCache(await source.get(), source.persistence === "local", () => IdbStore.open(), () => deleteCacheDatabase());
  const state: State = {
    gh: new GitHub(() => source.get(), undefined, session.cache),
    source,
    session,
    closed: false,
    prCachedAt: new Map(),
    items: [],
    loaded: false,
    prs: [],
    verdicts: new Map(),
    lastForgePoll: 0,
    forceForge: false,
    forgeKnown: false,
    verdictsRunning: false,
    polling: false,
    entries: [],
    sent: new Set(),
    answered: new Set(),
    answeredSeq: 0,
    reviewed: new Set(),
    context: new Map(),
    details: new Map(),
    reloadedFor: new Map(),
    help: false,
    selected: undefined,
    harness: new Map(),
  };
  byId("meta").textContent = "Checking the token…";
  // This token was used here before: show what it saw last time while
  // GitHub confirms it.
  const cached = session.knownLogin ? showCached(state) : Promise.resolve();
  try {
    state.login = await viewer(state.gh);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) {
      state.closed = true;
      await cached;
      await Promise.allSettled([forgetCache(session), source.signOut()]);
      showSignIn("rejected");
      return;
    }
    // Anything else (offline, rate limited) the poll reports too.
  }
  // Persist from now on, as this login's; a store another login filled is wiped.
  if (state.login && session.store) await session.cache.attach(session.store, state.login, session.tokenHash);
  const lacking = missingScopes(state.gh.scopes, CLASSIC_SCOPES);
  if (lacking.length) {
    state.tokenWarning = `This token lacks the ${lacking.map((n) => n.any.join(" or ")).join(", ")} scope${lacking.length > 1 ? "s" : ""}; some reads or answers will fail.`;
  }
  byId("signout").hidden = false;
  byId("nav").hidden = false;
  byId("signout").onclick = () => {
    state.closed = true;
    void Promise.allSettled([forgetCache(session), source.signOut()]).then(() => window.location.reload());
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
  await cached;
  if (state.loaded) renderChrome(state);
  else renderRoute(state);
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
    h("label", { class: "check", for: "remember" }, remember, " Remember on this device: the token in localStorage, and what the app read in IndexedDB so it starts at once. Otherwise both are forgotten when you close the tab."),
    h("div", { class: "actions" }, h("button", { type: "submit", class: "primary" }, "Use token")),
    status,
    h(
      "details",
      { class: "help" },
      h("summary", {}, "Which token?"),
      h(
        "p",
        {},
        "A classic token with a short expiry reads everything the queue shows, upstream repositories included. It needs:",
      ),
      scopeList(),
      h(
        "p",
        {},
        "A fine-grained token acts on one resource owner only: with owner cgwalters-forge and Pull requests: read and write, Issues: read and write, and Contents and Commit statuses: read, it can review forge PRs and answer the bot's questions in cgwalters-forge/tracker.",
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
