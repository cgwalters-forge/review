// Entry point: sign-in, routing between queue and item, and polling.

import { h } from "../dom.ts";
import { createRenderer } from "../markdown.ts";
import { GitHub, GitHubError } from "./api.ts";
import { missingScopes, type Persistence, savedToken, type TokenSource, useToken } from "./auth.ts";
import { answerTarget, type Item, questionOf } from "./board.ts";
import { type Context, loadContext, loadQueue, postAnswer, type ReceiptStatus, verifyReceipt, viewer } from "./backend.ts";
import {
  CLASSIC_SCOPES,
  HOME_OWNERS,
  OPERATOR,
  POLL_BACKOFF_FACTOR,
  POLL_INTERVAL_MS,
  RATE_LOW_FRACTION,
} from "./config.ts";
import { CONTEXT_CLASS, contextView, itemView, queueView } from "./view.ts";

const render = createRenderer(window);

interface State {
  gh: GitHub;
  source: TokenSource;
  login?: string;
  items: Item[];
  boardPublic: boolean;
  loaded: boolean;
  /** Items answered from this tab, until the bot moves them on. */
  sent: Set<string>;
  /** Context of opened items, by node id. */
  context: Map<string, Context>;
  /** Checked receipts of drafts that claim an answer, by node id. */
  receipts: Map<string, ReceiptStatus>;
  /** The open item as it was rendered, to notice changes under it. */
  shown?: { nodeId: string; key: string };
  /** A note about the open item, e.g. that it changed on the board. */
  itemNote?: string;
  lastPoll?: Date;
  error?: string;
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

function routeItemId(): string | undefined {
  return /^#item\/(PVTI_[A-Za-z0-9_-]+)$/.exec(window.location.hash)?.[1];
}

/** What the open item view shows; a change means the view is stale. */
function itemKey(item: Item): string {
  return JSON.stringify([item.title, item.why, item.body, item.priority, item.status]);
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
  const warnings = [state.error, state.tokenWarning, routeItemId() ? state.itemNote : undefined];
  if (state.login && state.login !== OPERATOR) {
    warnings.push(`You are signed in as ${state.login}; the bot acts only on answers from ${OPERATOR}.`);
  }
  if (state.gh.rateLow(RATE_LOW_FRACTION)) warnings.push("The API rate budget is low; polling less often.");
  setNotice(warnings.filter(Boolean).join(" ") || undefined);
}

/** Rebuild the whole view for the current route. */
function renderRoute(state: State): void {
  delete state.shown;
  delete state.itemNote;
  renderChrome(state);
  if (!state.loaded) {
    showMain(h("p", { class: "empty" }, "Loading…"));
    return;
  }
  const id = routeItemId();
  const item = id ? state.items.find((i) => i.nodeId === id) : undefined;
  if (!item) {
    if (id) setNotice("That item no longer needs you (or isn't on the board).");
    showMain(queueView(state.items, state.sent, state.receipts));
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

async function poll(state: State): Promise<void> {
  clearTimeout(state.timer);
  try {
    const q = await loadQueue(state.gh);
    state.lastPoll = new Date();
    delete state.error;
    const first = !state.loaded;
    if (q.changed || first) {
      state.items = q.items;
      state.boardPublic = q.boardPublic;
      state.loaded = true;
      // Keep "sent" only for items still waiting on the bot.
      const ids = new Set(q.items.map((i) => i.nodeId));
      for (const s of state.sent) if (!ids.has(s)) state.sent.delete(s);
      state.context.clear();
      await refreshReceipts(state);
      const open = routeItemId();
      if (first || !open || !state.shown) {
        renderRoute(state);
      } else {
        // Keep the open item's form (and whatever is typed in it); say
        // if the item changed, and reload its context.
        const item = q.items.find((i) => i.nodeId === open);
        if (!item) state.itemNote = "This item no longer needs you; the bot may have acted on it.";
        else if (itemKey(item) !== state.shown.key) {
          state.itemNote = "This item changed on the board since you opened it; go back and reopen it to see the new version.";
        }
        if (item) void refreshContext(state, item);
        renderChrome(state);
      }
    } else {
      renderChrome(state);
    }
  } catch (e) {
    state.error = `Couldn't read the board: ${e instanceof Error ? e.message : String(e)}`;
    if (state.loaded) renderChrome(state);
    else renderRoute(state);
  }
  schedule(state);
}

function schedule(state: State): void {
  if (document.hidden) return;
  const slow = state.gh.rateLow(RATE_LOW_FRACTION) ? POLL_BACKOFF_FACTOR : 1;
  state.timer = setTimeout(() => void poll(state), POLL_INTERVAL_MS * slow);
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
    sent: new Set(),
    context: new Map(),
    receipts: new Map(),
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
  window.addEventListener("hashchange", () => renderRoute(state));
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

async function main(): Promise<void> {
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
