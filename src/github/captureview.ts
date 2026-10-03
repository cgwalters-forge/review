// The capture bar at the top of the page, styled as an "Ask anything"
// box: an in-place composer with a persistent draft and a filed issue link.

import { h, link } from "../dom.ts";
import type { IssueRef } from "./board.ts";
import { type CaptureDraft, type CaptureEpic, CaptureUncertain, EMPTY_DRAFT, type Filed, linkedRef, linkTitle } from "./capture.ts";
import { CAPTURE_DRAFT_KEY, TRACKER_REPO } from "./config.ts";

export interface CaptureHooks {
  file(draft: CaptureDraft): Promise<Filed>;
  /** The title of a linked issue or PR, if it can be read. */
  linkTitle(ref: IssueRef): Promise<string | undefined>;
  /** Where the unsent draft is kept; storage may be missing or throw. */
  storage: Storage | undefined;
  labels?(): Promise<string[]>;
  epics?(): Promise<CaptureEpic[]>;
  recentRepos?: string[];
  filed?(draft: CaptureDraft): void;
}

export interface CaptureBar {
  el: HTMLElement;
  /** Focus the title, as the capture key does. */
  focus(): void;
  /** Measure restored text after the form is inserted into a visible slot. */
  mounted(): void;
}

export const CAPTURE_CLASS = "capture";

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
    const d = v as CaptureDraft & { suggested?: unknown };
    return {
      title: d.title, body: d.body, url: d.url, suggested: typeof d.suggested === "string" ? d.suggested : "",
      ...(["P0", "P1", "P2"].includes(d.priority ?? "") ? { priority: d.priority } : {}),
      ...(Number.isSafeInteger(d.epic) && (d.epic ?? 0) > 0 ? { epic: d.epic } : {}),
      ...(Array.isArray(d.labels) && d.labels.every((l) => typeof l === "string") ? { labels: d.labels } : {}),
      ...(typeof d.repo === "string" ? { repo: d.repo } : {}),
    };
  } catch {
    return { ...EMPTY_SAVED };
  }
}

/** Keep a draft, or drop it when it is empty. */
export function saveDraft(storage: Storage | undefined, d: SavedDraft): void {
  try {
    if (!d.title && !d.body && !d.url && !d.priority && !d.epic && !d.labels?.length && !d.repo) storage?.removeItem(CAPTURE_DRAFT_KEY);
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
  const title = h("textarea", { class: "capture-title", "aria-label": "Title", placeholder: "File to the board… (b)", autocomplete: "off", rows: "1", wrap: "soft" });
  const url = h("input", { type: "url", class: "capture-url", "aria-label": "Link (optional)", placeholder: "Link (optional)", autocomplete: "off" });
  const body = h("textarea", { class: "capture-body", "aria-label": "Markdown body (optional)", placeholder: "Markdown body (optional; Ctrl/Cmd+Enter files)", rows: "3" });
  const more = h("button", { type: "button", class: "small", "aria-expanded": "false", title: "Add a link or a note" }, "Note");
  const submit = h("button", { type: "submit", class: "small primary" }, "File");
  const status = h("p", { class: "status capture-status", role: "status" });
  title.value = saved.title;
  url.value = saved.url;
  body.value = saved.body;
  const priority = h("select", { class: "capture-priority", "aria-label": "Priority" }, h("option", { value: "" }, "Priority (triage)"), ...["P0", "P1", "P2"].map((p) => h("option", { value: p }, p)));
  priority.value = saved.priority ?? "";
  const epic = h("select", { class: "capture-epic", "aria-label": "Epic" }, h("option", { value: "" }, "Epic (optional)"));
  if (saved.epic) epic.append(h("option", { value: String(saved.epic) }, `#${saved.epic} (saved epic)`));
  epic.value = saved.epic ? String(saved.epic) : "";
  const repo = h("input", { class: "capture-repo", "aria-label": "Repo", placeholder: "Repo: owner/repo (required for dispatch)", list: "capture-repos" });
  repo.value = saved.repo ?? "";
  const repos = h("datalist", { id: "capture-repos" }, ...(hooks.recentRepos ?? []).map((r) => h("option", { value: r })));
  const labels = h("fieldset", { class: "capture-labels" }, h("legend", {}, "Labels"));
  const selected = new Set(saved.labels ?? []);
  let busy = false;
  let uncertain = false;
  const addLabels = (names: string[]) => {
    const existing = new Set([...labels.querySelectorAll("input")].map((input) => input.value));
    for (const name of names) {
      if (existing.has(name)) continue;
      existing.add(name);
      const input = h("input", { type: "checkbox", value: name });
      input.checked = selected.has(name);
      input.disabled = busy;
      labels.append(h("label", { class: "check" }, input, ` ${name}`));
    }
  };
  addLabels(["dispatch", "escalate", ...selected]);
  const optionsStatus = h("p", { class: "status capture-options", role: "status" });
  const extra = h("div", { class: "capture-extra" }, body, url, h("div", { class: "capture-fields" }, priority, epic), repo, repos, labels, optionsStatus);
  const form = h("form", { class: CAPTURE_CLASS, "aria-label": "File an issue for the bot to triage" }, h("div", { class: "capture-row" }, title, more, submit), extra, status);

  const grow = () => {
    if (!form.isConnected) return;
    title.style.height = "auto";
    title.style.height = `${Math.max(36, title.scrollHeight)}px`;
    if (!extra.hidden) {
      body.style.height = "auto";
      body.style.height = `${Math.max(72, body.scrollHeight)}px`;
    }
  };
  let loaded = false;
  const loadOptions = () => {
    if (loaded) return;
    loaded = true;
    void hooks.labels?.().then(addLabels).catch(() => { optionsStatus.textContent = "Tracker labels unavailable; dispatch/escalate and saved labels are still usable."; });
    void hooks.epics?.().then((items) => {
      const chosen = epic.value;
      epic.replaceChildren(h("option", { value: "" }, "Epic (optional)"), ...items.map((item) => h("option", { value: String(item.number) }, `#${item.number}: ${item.title}`)));
      if (chosen && !items.some((item) => String(item.number) === chosen)) {
        epic.append(h("option", { value: chosen }, `#${chosen} (unavailable; reselect)`));
        optionsStatus.textContent = "Saved epic is no longer in the open epic list. Clear or reselect it before filing.";
      }
      epic.value = chosen;
    }).catch(() => { optionsStatus.textContent = "Epics unavailable; you can file without an epic or keep the saved selection."; });
  };
  const expand = (open: boolean) => {
    extra.hidden = !open;
    more.setAttribute("aria-expanded", String(open));
    form.classList.toggle("expanded", open);
    grow();
    if (open) loadOptions();
  };
  expand(saved.body !== "" || saved.url !== "" || !!saved.priority || !!saved.epic || !!saved.repo || !!saved.labels?.length);
  title.addEventListener("focus", () => expand(true));
  submit.addEventListener("click", (ev) => {
    if (!extra.hidden) return;
    ev.preventDefault();
    expand(true);
    title.focus();
  });
  more.addEventListener("click", () => {
    expand(extra.hidden);
    if (!extra.hidden) url.focus();
  });

  // A pasted link suggests the title, unless he typed one: first its
  // reference, then its title once read. His own edits are never
  // replaced, and a suggestion goes when its link does.
  let suggested = saved.suggested;
  const draft = (): CaptureDraft => ({
    title: title.value, body: body.value, url: url.value,
    ...(priority.value ? { priority: priority.value as NonNullable<CaptureDraft["priority"]> } : {}),
    ...(epic.value ? { epic: Number(epic.value) } : {}),
    ...(selected.size ? { labels: [...selected] } : {}),
    ...(repo.value ? { repo: repo.value } : {}),
  });
  const keep = () => saveDraft(hooks.storage, { ...draft(), suggested });
  form.addEventListener("input", keep);
  form.addEventListener("change", () => {
    selected.clear();
    for (const input of labels.querySelectorAll("input:checked")) selected.add((input as HTMLInputElement).value);
    repo.required = selected.has("dispatch");
    keep();
  });
  repo.required = selected.has("dispatch");
  body.addEventListener("input", grow);
  title.addEventListener("input", () => {
    // Wrapping is visual only: pasted line breaks don't turn the title into a body.
    title.value = title.value.replace(/\s*[\r\n]+\s*/g, " ");
    grow();
    keep();
  });
  const suggest = (text: string) => {
    title.value = text;
    suggested = text;
    grow();
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

  const send = async () => {
    if (busy || uncertain) return;
    busy = true;
    submit.disabled = true;
    status.classList.remove("warn");
    status.replaceChildren("Filing…");
    try {
      const sent = draft();
      // Freeze fields while filing so a successful response cannot erase new edits.
      const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input, textarea, select, button")];
      controls.forEach((control) => { control.disabled = true; });
      let filed: Filed;
      try { filed = await hooks.file(sent); }
      finally { form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input, textarea, select, button").forEach((control) => { control.disabled = false; }); }
      title.value = url.value = body.value = suggested = "";
      priority.value = epic.value = repo.value = "";
      selected.clear();
      labels.querySelectorAll("input").forEach((input) => { input.checked = false; });
      repo.required = false;
      expand(false);
      keep();
      status.replaceChildren("Filed ", link(filed.url, `#${filed.number}`), filed.boardError ? ` but it isn't on the board: ${filed.boardError}` : ".");
      status.classList.toggle("warn", filed.boardError !== undefined);
      if (filed.parentError) {
        status.append(` Epic attachment failed: ${filed.parentError}`);
        status.classList.add("warn");
      }
      if (filed.priorityError) {
        status.append(` Priority update failed: ${filed.priorityError}`);
        status.classList.add("warn");
      }
      // Refresh failures must never turn a created issue into a retryable draft.
      try { hooks.filed?.(sent); } catch { /* Filing already succeeded. */ }
    } catch (e) {
      // The draft stays, to fix and send again.
      uncertain = e instanceof CaptureUncertain;
      status.replaceChildren(`${uncertain ? "Filing outcome unknown" : "Not filed"}: ${e instanceof Error ? e.message : String(e)}`);
      if (uncertain) status.append(" ", link(`https://github.com/${TRACKER_REPO}/issues`, "Check tracker"));
      status.classList.add("warn");
    } finally {
      busy = false;
      submit.disabled = uncertain;
    }
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void send();
  });
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey && (ev.target === title || (ev.target as HTMLElement).tagName === "INPUT")) ev.preventDefault();
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      keep();
      expand(false);
      (document.activeElement as HTMLElement | null)?.blur();
    }
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void send();
    }
  });

  return {
    el: form,
    focus: () => { expand(true); title.focus(); },
    mounted: grow,
  };
}
