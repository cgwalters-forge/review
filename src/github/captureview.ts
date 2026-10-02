// The capture bar at the top of every view: a title, an optional link
// and an optional note, filed with Enter. What it files is decided in
// capture.ts; this is the form, its unsent draft (kept in
// sessionStorage, so a reload keeps it and closing the tab doesn't), and
// the "Filed #N" line. On a narrow screen it folds into a "+ File"
// button (see style.css), open while there is a draft.

import { h, link } from "../dom.ts";
import type { IssueRef } from "./board.ts";
import { type CaptureDraft, EMPTY_DRAFT, type Filed, linkedRef, linkTitle } from "./capture.ts";
import { CAPTURE_DRAFT_KEY } from "./config.ts";

export interface CaptureHooks {
  file(draft: CaptureDraft): Promise<Filed>;
  /** The title of a linked issue or PR, if it can be read. */
  linkTitle(ref: IssueRef): Promise<string | undefined>;
  /** Where the unsent draft is kept; storage may be missing or throw. */
  storage: Storage | undefined;
}

export interface CaptureBar {
  el: HTMLElement;
  /** Focus the title, as the capture key does. */
  focus(): void;
}

export const CAPTURE_CLASS = "capture";
/** Set on the form while folded; only a narrow screen's stylesheet acts on it. */
export const CAPTURE_FOLDED_CLASS = "folded";
const OPEN_LABEL = "+ File";
const CLOSE_LABEL = "Close";

/** A kept draft, and the title the bar suggested for its link (his own if different). */
export interface SavedDraft extends CaptureDraft {
  suggested: string;
}

const EMPTY_SAVED: SavedDraft = { ...EMPTY_DRAFT, suggested: "" };

function isDraft(v: unknown): v is CaptureDraft & { suggested?: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.title === "string" && typeof d.body === "string" && typeof d.url === "string";
}

export function loadDraft(storage: Storage | undefined): SavedDraft {
  try {
    const raw = storage?.getItem(CAPTURE_DRAFT_KEY);
    const v: unknown = raw ? JSON.parse(raw) : undefined;
    if (!isDraft(v)) return { ...EMPTY_SAVED };
    return { title: v.title, body: v.body, url: v.url, suggested: typeof v.suggested === "string" ? v.suggested : "" };
  } catch {
    return { ...EMPTY_SAVED };
  }
}

/** Keep a draft, or drop it when it is empty. */
export function saveDraft(storage: Storage | undefined, d: SavedDraft): void {
  try {
    if (!d.title && !d.body && !d.url) storage?.removeItem(CAPTURE_DRAFT_KEY);
    else storage?.setItem(CAPTURE_DRAFT_KEY, JSON.stringify(d));
  } catch {
    // Blocked or full: the draft just won't survive a reload.
  }
}

/** Drop the draft, e.g. on signing out: it is his, not the next sign-in's. */
export function forgetDraft(storage: Storage | undefined): void {
  saveDraft(storage, EMPTY_SAVED);
}

export function captureBar(hooks: CaptureHooks): CaptureBar {
  const saved = loadDraft(hooks.storage);
  const title = h("input", { type: "text", class: "capture-title", "aria-label": "Title", placeholder: "File to the board… (b)", autocomplete: "off" });
  const url = h("input", { type: "url", class: "capture-url", "aria-label": "Link (optional)", placeholder: "Link (optional)", autocomplete: "off" });
  const body = h("textarea", { class: "capture-body", "aria-label": "Note (optional)", placeholder: "Note (optional; Ctrl+Enter files)", rows: "3" });
  const more = h("button", { type: "button", class: "small", "aria-expanded": "false", title: "Add a note" }, "Note");
  const submit = h("button", { type: "submit", class: "small primary" }, "File");
  const status = h("p", { class: "status capture-status", role: "status" });
  title.value = saved.title;
  url.value = saved.url;
  body.value = saved.body;
  const fold = h("button", { type: "button", class: "small capture-open", "aria-expanded": "false" }, OPEN_LABEL);
  const form = h("form", { class: CAPTURE_CLASS, "aria-label": "File an issue for the bot to triage" }, fold, h("div", { class: "capture-row" }, title, url, more, submit), body, status);
  const setFolded = (folded: boolean) => {
    form.classList.toggle(CAPTURE_FOLDED_CLASS, folded);
    fold.setAttribute("aria-expanded", String(!folded));
    fold.textContent = folded ? OPEN_LABEL : CLOSE_LABEL;
  };
  setFolded(!saved.title && !saved.url && !saved.body);
  fold.addEventListener("click", () => {
    const open = form.classList.contains(CAPTURE_FOLDED_CLASS);
    setFolded(!open);
    if (open) title.focus();
  });

  const expand = (open: boolean) => {
    body.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
  };
  expand(saved.body !== "");
  more.addEventListener("click", () => {
    expand(body.hidden);
    if (!body.hidden) body.focus();
  });

  // A pasted link suggests the title, unless he typed one: first its
  // reference, then its title once read. His own edits are never
  // replaced, and a suggestion goes when its link does.
  let suggested = saved.suggested;
  const draft = (): CaptureDraft => ({ title: title.value, body: body.value, url: url.value });
  const keep = () => saveDraft(hooks.storage, { ...draft(), suggested });
  form.addEventListener("input", keep);
  const suggest = (text: string) => {
    title.value = text;
    suggested = text;
    keep();
  };
  url.addEventListener("input", () => {
    const ref = linkedRef(url.value);
    if (title.value && title.value !== suggested) return;
    if (!ref) {
      if (suggested) suggest("");
      return;
    }
    suggest(linkTitle(ref));
    const asked = url.value;
    void hooks.linkTitle(ref).then((t) => {
      if (t && url.value === asked && title.value === suggested) suggest(linkTitle(ref, t));
    });
  });

  let busy = false;
  const send = async () => {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    status.classList.remove("warn");
    status.replaceChildren("Filing…");
    try {
      const filed = await hooks.file(draft());
      title.value = url.value = body.value = suggested = "";
      expand(false);
      setFolded(true);
      keep();
      status.replaceChildren("Filed ", link(filed.url, `#${filed.number}`), filed.boardError ? ` but it isn't on the board: ${filed.boardError}` : ".");
      status.classList.toggle("warn", filed.boardError !== undefined);
    } catch (e) {
      // The draft stays, to fix and send again.
      status.replaceChildren(`Not filed: ${e instanceof Error ? e.message : String(e)}`);
      status.classList.add("warn");
    } finally {
      busy = false;
      submit.disabled = false;
    }
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });
  body.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void send();
    }
  });

  return {
    el: form,
    focus: () => {
      setFolded(false);
      title.focus();
    },
  };
}
