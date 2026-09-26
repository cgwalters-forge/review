// The review pane for one forge PR: description, commits with their full
// messages, CI, the diff, and the review form. Commit messages and
// diffs are untrusted too, and go in as text nodes only.

import { h, kids, link, scrollTo } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { BOARD_URL, BOT_LOGIN, FORGE_ORG } from "./config.ts";
import type { Row } from "./diff.ts";
import { FILE_CLASS, type FileHooks, FileView, type Side } from "./diffview.ts";
import {
  type CiState,
  ciSummary,
  DRAFT_LINE,
  type DraftComment,
  parseBotMeta,
  PR_BASE,
  type ReviewAction,
  VERDICT_LABEL,
  withoutBotMeta,
} from "./forge.ts";
import type { Command } from "./keys.ts";
import { type Commit, type FileDiff, MAX_COMPARE_FILES, type PrDetail } from "./prs.ts";
import type { Entry } from "./queue.ts";
import {
  type DiffLayout,
  load,
  loadLayout,
  save,
  saveLayout,
  ViewedMarks,
  viewedKey,
} from "./store.ts";
import { pill, time } from "./view.ts";

export { FILE_CLASS };
/** Classes the keyboard handler looks for. */
export const REVIEW_FORM_CLASS = "review";
export const APPROVE_ACTION = "approve";
/** Files named in the approval's confirmation at most. */
const UNSEEN_NAMES = 6;

export interface PrViewHandlers {
  /**
   * Submit a review with his line comments; resolves to its URL.
   * `sent` is called with each commit whose comments went out, as they do.
   */
  review(action: ReviewAction, text: string, draft: boolean, comments: readonly DraftComment[], sent: (commit: string) => void): Promise<string>;
  /** The files changed from `base` to `to` (commits of the PR). */
  loadRange(base: string, to: string): Promise<FileDiff[]>;
  /** A file's lines at a commit. */
  loadLines(path: string, sha: string): Promise<string[]>;
}

export interface PrViewOptions {
  /** A review was already sent from this tab. */
  reviewedHere: boolean;
}

/** The pane, and the keyboard commands it carries out itself. */
export interface PrPane {
  el: HTMLElement;
  /** Carry out a command; false if it isn't the pane's (or does nothing here). */
  command(cmd: Command): boolean;
  /** Stop observing; call before throwing the pane away. */
  dispose(): void;
}

/** Owners whose bot-authored PRs can be reviewed from here. */
const REVIEWABLE_OWNERS: readonly string[] = [FORGE_ORG, BOT_LOGIN];

/**
 * Whether the pane offers a review form: only for the bot's own PRs in
 * its own space, so a crafted link can't turn this page into a one-click
 * approval of someone else's PR.
 */
export function canReview(d: PrDetail): boolean {
  return d.state === "open" && d.author === BOT_LOGIN && REVIEWABLE_OWNERS.includes(d.ref.owner);
}

/** What he hasn't seen of a PR, for the approval's confirmation. */
export interface Unseen {
  /** Files whose diff was never shown, nor marked viewed. */
  unopened: string[];
  /** Files GitHub gives no diff for. */
  noDiff: number;
  /** Files or commits beyond what the API lists. */
  truncated: boolean;
}

export function unseenNote(u: Unseen): string {
  const names = u.unopened.slice(0, UNSEEN_NAMES).join(", ") + (u.unopened.length > UNSEEN_NAMES ? `, +${u.unopened.length - UNSEEN_NAMES} more` : "");
  const parts = [
    u.unopened.length ? `${u.unopened.length} file${u.unopened.length > 1 ? "s" : ""} never expanded (${names})` : "",
    u.noDiff ? `${u.noDiff} without a diff here` : "",
    u.truncated ? "files or commits beyond what GitHub lists" : "",
  ].filter(Boolean);
  return parts.length ? ` Not seen here: ${parts.join(", ")}.` : "";
}

const CI_LABEL: Record<CiState, string> = {
  success: "CI passed",
  failure: "CI failed",
  pending: "CI running",
  none: "no CI",
};

const short = (sha: string) => sha.slice(0, 10);

function ciBadge(state: CiState): HTMLElement {
  return h("span", { class: `ci ci-${state}` }, CI_LABEL[state]);
}

function linkRow(d: PrDetail, entry: Entry | undefined): HTMLElement {
  const meta = parseBotMeta(d.body);
  const upstream = meta.upstream ?? d.parent;
  const links = h("div", { class: "links" });
  links.append(link(d.url, `${d.ref.owner}/${d.ref.repo}#${d.ref.number}`));
  links.append(link(`${d.url}/files`, "files on GitHub"));
  if (upstream) {
    const base = meta.base ?? d.baseRef;
    links.append(link(`https://github.com/${upstream}`, `upstream ${upstream}${base ? ` (${base})` : ""}`));
    if (base && d.headRef) {
      links.append(link(`https://github.com/${upstream}/compare/${base}...${d.ref.owner}:${d.ref.repo}:${d.headRef}`, "compare with upstream"));
    }
  }
  if (entry?.item?.url) links.append(link(entry.item.url, "tracking issue"));
  links.append(link(BOARD_URL, "board"));
  return links;
}

interface FormHooks {
  unseen(): Unseen;
  /** Drafts on commits of the PR: what goes out with the review. */
  drafts(): readonly DraftComment[];
  /** Drafts on commits no longer in the PR (after a force push): kept to copy from, never sent. */
  orphans(): readonly DraftComment[];
  drop(c: DraftComment): void;
  sent(commit: string): void;
  /** Show a draft's line. */
  jump(c: DraftComment): void;
}

function reviewForm(d: PrDetail, opts: PrViewOptions, handlers: PrViewHandlers, hooks: FormHooks): { form: HTMLElement; refresh(): void } {
  const text = h("textarea", {
    name: "text",
    rows: "3",
    placeholder: "Optional for an approval, or with line comments; otherwise required",
    "aria-label": "Review text",
  });
  const draft = h("input", { type: "checkbox", id: "review-draft" });
  const status = h("p", { class: "status", role: "status" });
  const drafts = h("div", { class: "drafts" });
  const approve = h("button", { type: "button", class: "primary", "data-action": APPROVE_ACTION }, "Approve (a)");
  const changes = h("button", { type: "button", "data-action": "request-changes" }, "Request changes");
  const comment = h("button", { type: "button", "data-action": "comment" }, "Comment");
  const buttons = [approve, changes, comment];
  const forge = d.ref.owner === FORGE_ORG;
  let sent = opts.reviewedHere;
  const enable = () => {
    for (const b of buttons) b.disabled = false;
    // Approving needs the diff shown to be the head's.
    approve.disabled = !d.consistent;
  };
  enable();
  if (!d.consistent) status.textContent = "Approve is off until a reload (r) shows the head's commits.";
  const refresh = () => {
    const list = hooks.drafts();
    drafts.replaceChildren();
    if (list.length === 0) return;
    const ul = h("ul", { class: "draft-list" });
    for (const c of list) {
      const go = h("button", { type: "button", class: "linkish" }, `${c.path}:${c.start_line !== undefined ? `${c.start_line}–` : ""}${c.line}${c.side === "LEFT" ? " (old)" : ""}${c.commit !== d.head ? ` @${c.commit.slice(0, 7)}` : ""}`);
      go.addEventListener("click", () => hooks.jump(c));
      ul.append(h("li", {}, go, h("span", { class: "tag" }, ` ${c.body.replace(/\s+/g, " ").slice(0, 80)}`)));
    }
    drafts.append(h("p", { class: "tag" }, `${list.length} line comment${list.length > 1 ? "s" : ""} will go out with your review:`), ul);
  };
  const orphans = h("details", { class: "orphans" });
  const refreshOrphans = () => {
    const list = hooks.orphans();
    orphans.hidden = list.length === 0;
    const ul = h("ul", { class: "draft-list" });
    for (const c of list) {
      const drop = h("button", { type: "button", class: "small" }, "Discard");
      drop.addEventListener("click", () => hooks.drop(c));
      ul.append(h("li", {}, h("code", {}, `${c.path}:${c.line} @${c.commit.slice(0, 7)}`), " ", drop, h("pre", { class: "msg" }, c.body)));
    }
    orphans.replaceChildren(h("summary", {}, `${list.length} line comment${list.length > 1 ? "s" : ""} written on commits no longer in this PR (not sent; copy what you still need)`), ul);
  };
  const refreshAll = () => {
    refresh();
    refreshOrphans();
  };
  refreshAll();
  const form = h(
    "form",
    { class: REVIEW_FORM_CLASS },
    orphans,
    drafts,
    text,
    forge
      ? h("label", { class: "check", for: "review-draft" }, draft, ` Ask for a draft upstream PR (adds ${DRAFT_LINE}; unchecked doesn't undo an earlier ${DRAFT_LINE})`)
      : null,
    h("div", { class: "actions" }, ...buttons),
    h(
      "p",
      { class: "target" },
      `Reviews head ${short(d.head)} as you.`,
      forge ? " An approval is what bot-pr promote acts on: it opens the upstream PR from exactly this head, signing off where the project wants DCO." : "",
      " If the head moves before you send, nothing is sent.",
    ),
    status,
  );
  form.addEventListener("submit", (ev) => ev.preventDefault());
  const send = (action: ReviewAction) => {
    const wantDraft = action === "approve" && draft.checked;
    const comments = hooks.drafts();
    const what = action === "approve" ? `Approve${wantDraft ? ` (with ${DRAFT_LINE})` : ""}` : action === "comment" ? "Comment on" : "Request changes on";
    const withComments = comments.length ? ` with ${comments.length} line comment${comments.length > 1 ? "s" : ""}` : "";
    const again = sent ? " You already reviewed it from here." : "";
    const note = action === "approve" ? unseenNote(hooks.unseen()) : "";
    if (!window.confirm(`${what} ${d.ref.owner}/${d.ref.repo}#${d.ref.number} at ${short(d.head)}${withComments}?${note}${again}`)) return;
    for (const b of buttons) b.disabled = true;
    status.textContent = "Sending…";
    handlers
      .review(action, text.value, wantDraft, comments, hooks.sent)
      .then((url) => {
        sent = true;
        text.value = "";
        status.textContent = "Sent: ";
        status.append(link(url, url));
        enable();
        refresh();
      })
      .catch((e: unknown) => {
        status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
        enable();
        refresh();
      });
  };
  for (const b of buttons) b.addEventListener("click", () => send(b.dataset.action as ReviewAction));
  return { form, refresh: refreshAll };
}

function commitsSection(d: PrDetail): HTMLElement {
  const s = h("section", { class: "commits" }, h("h3", {}, `Commits · ${d.commitCount}`));
  const open = d.commits.length <= 5;
  for (const c of d.commits) {
    const [subject = "", ...rest] = c.message.replace(/\r\n?/g, "\n").split("\n");
    const body = rest.join("\n").replace(/^\n+/, "").trimEnd();
    const det = h(
      "details",
      { class: "commit" },
      h("summary", {}, h("code", {}, short(c.sha)), " ", h("span", { class: "subject" }, subject), h("span", { class: "tag" }, ` ${c.author}${c.date ? ` · ${time(c.date)}` : ""}`)),
      body ? h("pre", { class: "msg" }, body) : h("p", { class: "note" }, "(no body)"),
      h("p", { class: "note" }, link(c.url, "commit on GitHub")),
    );
    det.open = open;
    s.append(det);
  }
  if (d.commits.length < d.commitCount) s.append(h("p", { class: "note" }, `Showing the first ${d.commits.length}; see the rest on GitHub.`));
  return s;
}

function checksSection(d: PrDetail): HTMLElement {
  const s = h("section", { class: "checks" }, h("h3", {}, "CI ", ciBadge(ciSummary(d.checks))));
  if (d.checks.length === 0) {
    s.append(h("p", { class: "note" }, "No checks on this head. Forge forks run no CI: the description says how it was tested, and upstream CI runs once promoted."));
    return s;
  }
  const list = h("ul", { class: "checklist" });
  for (const c of d.checks) list.append(h("li", { class: `ci-${c.state}` }, h("span", { class: "dot" }), link(c.url, c.name), h("span", { class: "tag" }, ` ${c.detail}`)));
  s.append(list);
  return s;
}

const subject = (c: Commit) => c.message.split("\n", 1)[0] ?? "";

/** A range of the PR's commits by index, inclusive; undefined is the whole PR. */
export interface CommitRange {
  from: number;
  to: number;
}

/**
 * The diff base and end of a range: the first commit's parent, and the
 * last commit. Undefined when the parent isn't known.
 */
export function rangeEnds(commits: readonly Commit[], r: CommitRange): { base: string; to: string } | undefined {
  const first = commits[r.from];
  const last = commits[r.to];
  if (!first?.parent || !last || r.from > r.to) return undefined;
  return { base: first.parent, to: last.sha };
}

/** A tree of paths, directories first, with single-child directories joined. */
interface TreeNode {
  name: string;
  dirs: Map<string, TreeNode>;
  files: number[];
}

export function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: "", dirs: new Map(), files: [] };
  paths.forEach((p, i) => {
    const parts = p.split("/");
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      let next = node.dirs.get(dir);
      if (!next) {
        next = { name: dir, dirs: new Map(), files: [] };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push(i);
  });
  const squash = (n: TreeNode): TreeNode => {
    for (const [k, child] of n.dirs) n.dirs.set(k, squash(child));
    if (n.name && n.files.length === 0 && n.dirs.size === 1) {
      const only = [...n.dirs.values()][0] as TreeNode;
      return { name: `${n.name}/${only.name}`, dirs: only.dirs, files: only.files };
    }
    return n;
  };
  return squash(root);
}

class Pane implements PrPane {
  readonly el: HTMLElement;
  #d: PrDetail;
  #handlers: PrViewHandlers;
  #canReview: boolean;
  #layout: DiffLayout = loadLayout();
  #range: CommitRange | undefined;
  #files: FileView[] = [];
  #current = -1;
  #focusFile: FileView | undefined;
  #viewed = new ViewedMarks();
  /** `path:blob` of every file version whose diff was shown in any view. */
  #seenBlobs = new Set<string>();
  #lines = new Map<string, Promise<string[]>>();
  #drafts: DraftComment[];
  #lazy: IntersectionObserver | undefined;
  #scrollObs: IntersectionObserver | undefined;
  #byEl = new Map<Element, FileView>();
  #loading = 0;
  // Parts redrawn as things change.
  #list = h("div", { class: "file-list" });
  #tree = h("nav", { class: "tree", "aria-label": "Files" });
  #toolbar = h("div", { class: "toolbar" });
  #filesTitle = h("h3", {});
  #form: { form: HTMLElement; refresh(): void } | undefined;

  constructor(d: PrDetail, entry: Entry | undefined, render: Renderer, handlers: PrViewHandlers, opts: PrViewOptions) {
    this.#d = d;
    this.#handlers = handlers;
    this.#canReview = canReview(d);
    this.#drafts = load(this.#draftsKey(), [], (v): v is DraftComment[] => Array.isArray(v) && v.every(isDraft));
    if (typeof IntersectionObserver !== "undefined") {
      this.#lazy = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && this.#byEl.get(e.target)?.near()), { rootMargin: "1500px 0px" });
      // The file whose header is near the top is the current one, for n/p and v.
      this.#scrollObs = new IntersectionObserver(
        (es) => {
          for (const e of es) {
            if (!e.isIntersecting) continue;
            const i = this.#files.findIndex((f) => f.el === e.target);
            if (i >= 0) this.#select(i, false);
          }
        },
        { rootMargin: "-80px 0px -75% 0px" },
      );
    }
    const verdict = d.verdict.state === "none" ? undefined : VERDICT_LABEL[d.verdict.state];
    let form: HTMLElement;
    if (this.#canReview) {
      this.#form = reviewForm(d, opts, handlers, {
        unseen: () => this.unseen(),
        drafts: () => this.#drafts.filter((c) => this.#inPr(c)),
        orphans: () => this.#drafts.filter((c) => !this.#inPr(c)),
        drop: (c) => this.#setDrafts(this.#drafts.filter((x) => x !== c), c.path),
        sent: (commit) => this.#setDrafts(this.#drafts.filter((c) => c.commit !== commit)),
        jump: (c) => void this.#jumpToDraft(c),
      });
      form = this.#form.form;
    } else if (d.state !== "open") form = h("p", { class: "warn" }, `This PR is ${d.state}; there is nothing to review.`);
    else form = h("p", { class: "note" }, `Reviews from here are only for ${BOT_LOGIN}'s PRs in ${REVIEWABLE_OWNERS.join(" and ")}; use GitHub for this one.`);
    const files = h(
      "section",
      { class: "files" },
      h("div", { class: "files-h" }, this.#filesTitle),
      this.#toolbar,
      h("div", { class: "files-layout" }, this.#tree, this.#list),
    );
    this.el = h(
      "main",
      { class: "item pr" },
      h("a", { href: "#", class: "back" }, "← Queue (u)"),
      h(
        "div",
        { class: "hdr" },
        pill(entry?.priority),
        h("span", { class: "tag" }, [entry?.item?.org, d.draft ? "draft PR" : "PR", d.state === "open" ? "" : d.state, d.isPrivate ? "private" : ""].filter(Boolean).join(" · ")),
        ciBadge(ciSummary(d.checks)),
        verdict ? h("span", { class: `state v-${d.verdict.state}` }, d.verdict.url ? link(d.verdict.url, verdict) : verdict) : null,
      ),
      h("h2", {}, d.title),
      linkRow(d, entry),
      ...d.warnings.map((w) => h("p", { class: "warn" }, w)),
      entry?.item?.why ? h("section", {}, h("h3", {}, "Why (board)"), h("div", { class: "md" }, render(entry.item.why))) : null,
      form,
      h("section", {}, h("h3", {}, "Description"), h("div", { class: "md" }, render(withoutBotMeta(d.body) || "(empty)"))),
      checksSection(d),
      commitsSection(d),
      files,
    );
    this.#showFiles(d.files);
  }

  #inPr(c: DraftComment): boolean {
    return this.#d.commits.some((k) => k.sha === c.commit);
  }

  /** The current view's base, as drafts record it. */
  #viewBase(): string {
    const r = this.#range;
    return r ? (rangeEnds(this.#d.commits, r)?.base ?? PR_BASE) : PR_BASE;
  }

  #draftsKey(): string {
    return `drafts.${this.#d.ref.owner}/${this.#d.ref.repo}#${this.#d.ref.number}`;
  }

  /** Replace his drafts; only the files whose drafts changed are redrawn (all, without a path). */
  #setDrafts(list: DraftComment[], path?: string): void {
    this.#drafts = list;
    save(this.#draftsKey(), list.length ? list : undefined);
    this.#form?.refresh();
    for (const f of this.#files) if (path === undefined || f.file.filename === path) f.render();
  }

  /** The view's end commit: the head, or the last commit of the range. */
  #viewEnd(): string {
    const r = this.#range;
    return r ? (this.#d.commits[r.to]?.sha ?? this.#d.head) : this.#d.head;
  }

  /** Hooks shared by the files of the current view; loadLines and drafts are per file. */
  #hooks(): Omit<FileHooks, "loadLines" | "drafts"> {
    const fromBase = !this.#range || this.#range.from === 0;
    const end = this.#viewEnd();
    return {
      layout: () => this.#layout,
      commit: end,
      base: this.#viewBase(),
      commentable: (row: Row, side: Side) => this.#canReview && !row.expanded && (fromBase || (row.kind === "add" && side === "RIGHT")),
      saveDraft: (c, old) => this.#setDrafts([...this.#drafts.filter((x) => x !== old), c], c.path),
      deleteDraft: (c) => this.#setDrafts(this.#drafts.filter((x) => x !== c), c.path),
      focused: (file, item, side) => {
        if (this.#focusFile && this.#focusFile !== file) this.#focusFile.setFocus(undefined);
        this.#focusFile = file;
        file.setFocus(item, side);
        const i = this.#files.indexOf(file);
        if (i >= 0) this.#select(i, false);
      },
      setViewed: (file, on) => this.#setViewed(file, on),
    };
  }

  #loadLines(path: string, sha: string): Promise<string[]> {
    const key = `${sha}:${path}`;
    let p = this.#lines.get(key);
    if (!p) {
      p = this.#handlers.loadLines(path, sha);
      p.catch(() => this.#lines.delete(key));
      this.#lines.set(key, p);
    }
    return p;
  }

  #showFiles(files: readonly FileDiff[]): void {
    for (const f of this.#files) this.#lazy?.unobserve(f.el);
    this.#scrollObs?.disconnect();
    this.#byEl.clear();
    this.#focusFile = undefined;
    const r = this.#range;
    const end = this.#viewEnd();
    const viewBase = this.#viewBase();
    const base = this.#hooks();
    const repo = `${this.#d.ref.owner}/${this.#d.ref.repo}`;
    this.#files = files.map((file) => {
      const hooks: FileHooks = {
        ...base,
        loadLines: () => this.#loadLines(file.filename, end),
        drafts: () => this.#drafts.filter((c) => c.path === file.filename && c.commit === end && (c.base ?? PR_BASE) === viewBase),
      };
      const fv = new FileView({
        file,
        viewed: file.sha !== undefined && this.#viewed.has(viewedKey(repo, file.filename, file.sha)),
        hooks,
        ...(this.#lazy ? { lazy: this.#lazy } : {}),
      });
      this.#byEl.set(fv.el, fv);
      this.#scrollObs?.observe(fv.el);
      fv.el.addEventListener("toggle", () => this.#noteSeen());
      return fv;
    });
    this.#list.replaceChildren(...this.#files.map((f) => f.el));
    const d = this.#d;
    if (!r && d.files.length < d.changedFiles) this.#list.append(h("p", { class: "note" }, `Showing ${d.files.length} of ${d.changedFiles} files; see the rest on GitHub.`));
    if (r && files.length >= MAX_COMPARE_FILES) this.#list.append(h("p", { class: "note" }, `GitHub lists at most ${MAX_COMPARE_FILES} files for a range of commits; there may be more.`));
    this.#current = -1;
    this.#noteSeen();
    this.#drawTitle();
    this.#drawTree();
    this.#drawToolbar();
  }

  /** Remember which file versions were shown, for the approval's note. */
  #noteSeen(): void {
    for (const f of this.#files) if (f.seen() && f.file.sha) this.#seenBlobs.add(`${f.file.filename}:${f.file.sha}`);
  }

  #drawTitle(): void {
    const files = this.#files;
    const add = files.reduce((n, f) => n + f.file.additions, 0);
    const del = files.reduce((n, f) => n + f.file.deletions, 0);
    const viewed = files.filter((f) => f.viewed).length;
    const r = this.#range;
    const what = r ? (r.from === r.to ? `commit ${r.from + 1} of ${this.#d.commits.length}` : `commits ${r.from + 1}–${r.to + 1} of ${this.#d.commits.length}`) : "all commits";
    this.#filesTitle.replaceChildren(
      `Files · ${files.length} · `,
      h("span", { class: "plus" }, `+${add}`),
      " ",
      h("span", { class: "minus" }, `−${del}`),
      h("span", { class: "tag" }, ` · ${what} · ${viewed}/${files.length} viewed`),
    );
  }

  #drawTree(): void {
    const tree = buildTree(this.#files.map((f) => f.file.filename));
    const ul = (n: TreeNode): HTMLElement => {
      const list = h("ul", {});
      for (const dir of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        list.append(h("li", { class: "dir" }, h("span", { class: "dname" }, `${dir.name}/`), ul(dir)));
      }
      for (const i of n.files) {
        const f = this.#files[i] as FileView;
        const name = f.file.filename.split("/").at(-1) ?? f.file.filename;
        const b = h(
          "button",
          { type: "button", class: `tfile s-${f.file.status}${f.viewed ? " viewed" : ""}${i === this.#current ? " sel" : ""}`, title: f.file.filename, "data-i": String(i) },
          h("span", { class: "tname" }, name),
          h("span", { class: "tcounts" }, h("span", { class: "plus" }, `+${f.file.additions}`), " ", h("span", { class: "minus" }, `−${f.file.deletions}`)),
        );
        b.addEventListener("click", () => this.#goFile(i, true));
        list.append(h("li", {}, b));
      }
      return list;
    };
    this.#tree.replaceChildren(ul(tree));
  }

  #drawToolbar(): void {
    const d = this.#d;
    const r = this.#range;
    const from = h("select", { "aria-label": "Show commits from" });
    from.append(h("option", { value: "all" }, `All commits (${d.commits.length})`));
    d.commits.forEach((c, i) => from.append(h("option", { value: String(i) }, `${i + 1}. ${c.sha.slice(0, 7)} ${subject(c)}`)));
    from.value = r ? String(r.from) : "all";
    const to = h("select", { "aria-label": "through" });
    if (r) d.commits.forEach((c, i) => i >= r.from && to.append(h("option", { value: String(i) }, `${i === r.from ? "only this" : `through ${i + 1}. ${c.sha.slice(0, 7)} ${subject(c)}`}`)));
    to.value = r ? String(r.to) : "";
    to.disabled = !r;
    from.addEventListener("change", () => {
      const v = from.value === "all" ? undefined : Number(from.value);
      void this.#setRange(v === undefined ? undefined : { from: v, to: v });
    });
    to.addEventListener("change", () => r && void this.#setRange({ from: r.from, to: Number(to.value) }));
    const layoutBtn = (l: DiffLayout, label: string) => {
      const b = h("button", { type: "button", class: `small${this.#layout === l ? " on" : ""}`, "aria-pressed": String(this.#layout === l) }, label);
      b.addEventListener("click", () => this.#setLayout(l));
      return b;
    };
    const expand = h("button", { type: "button", class: "small" }, "Expand all");
    const collapse = h("button", { type: "button", class: "small" }, "Collapse all");
    expand.addEventListener("click", () => this.#files.forEach((f) => (f.el.open = true)));
    collapse.addEventListener("click", () => this.#files.forEach((f) => (f.el.open = false)));
    const loading = this.#loading ? h("span", { class: "tag" }, "Loading…") : null;
    const noParent = d.commits.length > 0 && !d.commits[0]?.parent;
    this.#toolbar.replaceChildren(...kids(
      h("span", { class: "group" }, from, to, loading),
      h("span", { class: "group seg" }, layoutBtn("unified", "Unified"), layoutBtn("split", "Split")),
      h("span", { class: "group" }, expand, collapse),
      noParent ? h("span", { class: "tag" }, "Commit views need the commits' parents, which GitHub didn't list.") : null,
    ));
  }


  #setLayout(l: DiffLayout): void {
    if (l === this.#layout) return;
    this.#layout = l;
    saveLayout(l);
    for (const f of this.#files) f.render();
    this.#drawToolbar();
  }

  async #setRange(r: CommitRange | undefined): Promise<boolean> {
    const d = this.#d;
    if (!r) {
      if (this.#range === undefined) return true;
      this.#range = undefined;
      this.#showFiles(d.files);
      return true;
    }
    const ends = rangeEnds(d.commits, r);
    if (!ends) return false;
    this.#loading++;
    this.#drawToolbar();
    try {
      const files = await this.#handlers.loadRange(ends.base, ends.to);
      this.#range = r;
      this.#showFiles(files);
      return true;
    } catch (e) {
      this.#toolbar.append(h("span", { class: "warn" }, `Couldn't load the commits: ${e instanceof Error ? e.message : String(e)}`));
      return false;
    } finally {
      this.#loading--;
      this.#drawToolbar();
    }
  }

  #select(i: number, scroll: boolean): void {
    if (i < 0 || i >= this.#files.length) return;
    this.#current = i;
    this.#files.forEach((f, k) => f.el.classList.toggle("sel", k === i));
    for (const b of this.#tree.querySelectorAll<HTMLElement>("button.tfile")) b.classList.toggle("sel", b.dataset.i === String(i));
    const f = this.#files[i] as FileView;
    if (scroll) {
      scrollTo(f.el, "start");
      f.el.querySelector("summary")?.focus({ preventScroll: true });
    }
  }

  #goFile(i: number, open: boolean): void {
    const f = this.#files[i];
    if (!f) return;
    if (open) f.el.open = true;
    this.#select(i, true);
  }

  #setViewed(f: FileView, on: boolean): void {
    const sha = f.file.sha;
    if (sha) this.#viewed.set(viewedKey(`${this.#d.ref.owner}/${this.#d.ref.repo}`, f.file.filename, sha), on);
    f.setViewedBox(on);
    f.el.open = !on;
    if (on && f.file.sha) this.#seenBlobs.add(`${f.file.filename}:${f.file.sha}`);
    this.#drawTitle();
    this.#drawTree();
  }

  /** Move the focused line to the next or previous hunk, across files. */
  #moveHunk(step: 1 | -1): void {
    const files = this.#files;
    if (!files.length) return;
    let fi = this.#focusFile ? files.indexOf(this.#focusFile) : Math.max(0, this.#current);
    let cur = this.#focusFile ? (this.#focusFile.focus?.item ?? -1) : step > 0 ? -1 : Number.MAX_SAFE_INTEGER;
    for (let guard = 0; guard <= files.length; guard++) {
      const f = files[fi];
      if (!f) return;
      if (f.el.open) {
        f.build();
        const starts = f.hunkStarts();
        const target = step > 0 ? starts.find((s) => s > cur) : [...starts].reverse().find((s) => s < cur);
        if (target !== undefined) {
          if (this.#focusFile && this.#focusFile !== f) this.#focusFile.setFocus(undefined);
          this.#focusFile = f;
          const el = f.setFocus(target);
          this.#select(fi, false);
          if (el) scrollTo(el, "center");
          return;
        }
      }
      fi += step;
      cur = step > 0 ? -1 : Number.MAX_SAFE_INTEGER;
      if (fi < 0 || fi >= files.length) return;
    }
  }


  async #jumpToDraft(c: DraftComment): Promise<void> {
    if (c.commit !== this.#viewEnd()) {
      const idx = this.#d.commits.findIndex((k) => k.sha === c.commit);
      if (c.commit === this.#d.head) await this.#setRange(undefined);
      else if (idx >= 0) await this.#setRange({ from: idx, to: idx });
    }
    const f = this.#files.find((x) => x.file.filename === c.path);
    if (!f) return;
    f.el.open = true;
    f.build();
    const item = f.items.findIndex((it) => it.t === "row" && (c.side === "LEFT" ? it.row.old : it.row.new) === c.line && (c.side === "LEFT" || it.row.kind !== "del"));
    scrollTo(f.rowEl(item) ?? f.el, "center");
  }

  unseen(): Unseen {
    this.#noteSeen();
    const d = this.#d;
    const repo = `${d.ref.owner}/${d.ref.repo}`;
    const withDiff = d.files.filter((f) => f.patch !== undefined && f.patch !== "");
    const unopened = withDiff
      .filter((f) => !f.sha || (!this.#seenBlobs.has(`${f.filename}:${f.sha}`) && !this.#viewed.has(viewedKey(repo, f.filename, f.sha))))
      .map((f) => f.filename);
    const out: Unseen = {
      unopened,
      noDiff: d.files.length - withDiff.length,
      truncated: d.files.length < d.changedFiles || d.commits.length < d.commitCount,
    };
    return out;
  }

  command(cmd: Command): boolean {
    switch (cmd) {
      case "next-file":
      case "prev-file": {
        const step = cmd === "next-file" ? 1 : -1;
        this.#goFile(Math.max(0, Math.min(this.#files.length - 1, this.#current + step)), false);
        return true;
      }
      case "next-hunk":
      case "prev-hunk":
        this.#moveHunk(cmd === "next-hunk" ? 1 : -1);
        return true;
      case "fold": {
        const f = this.#files[Math.max(0, this.#current)];
        if (f) f.el.open = !f.el.open;
        return true;
      }
      case "viewed": {
        const i = Math.max(0, this.#current);
        const f = this.#files[i];
        if (!f) return true;
        const on = !f.viewed;
        this.#setViewed(f, on);
        if (on && i + 1 < this.#files.length) this.#goFile(i + 1, false);
        else this.#select(i, true);
        return true;
      }
      case "comment": {
        const f = this.#focusFile;
        const at = f?.focus;
        return f !== undefined && at !== undefined && f.openComposer(at.item, at.side);
      }
      case "layout":
        this.#setLayout(this.#layout === "unified" ? "split" : "unified");
        return true;
      case "prev-commit":
      case "next-commit": {
        const n = this.#d.commits.length;
        const r = this.#range;
        let next: number | undefined;
        if (!r) next = cmd === "next-commit" ? 0 : n - 1;
        else next = (cmd === "next-commit" ? r.to : r.from) + (cmd === "next-commit" ? 1 : -1);
        void this.#setRange(next === undefined || next < 0 || next >= n ? undefined : { from: next, to: next });
        return true;
      }
      default:
        return false;
    }
  }

  dispose(): void {
    this.#lazy?.disconnect();
    this.#scrollObs?.disconnect();
  }
}

function isDraft(v: unknown): v is DraftComment {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.path === "string" &&
    typeof c.line === "number" &&
    (c.side === "LEFT" || c.side === "RIGHT") &&
    typeof c.body === "string" &&
    typeof c.commit === "string" &&
    (c.base === undefined || typeof c.base === "string") &&
    (c.start_line === undefined || typeof c.start_line === "number") &&
    (c.start_side === undefined || c.start_side === "LEFT" || c.start_side === "RIGHT")
  );
}

export function prView(d: PrDetail, entry: Entry | undefined, render: Renderer, handlers: PrViewHandlers, opts: PrViewOptions): PrPane {
  return new Pane(d, entry, render, handlers, opts);
}
