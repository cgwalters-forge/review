// The review pane for one forge PR: description, commits with their full
// messages, CI, a per-file diff, and the review form. Commit messages and
// diffs are untrusted too, and go in as text nodes only.

import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { BOARD_URL, BOT_LOGIN, DIFF_COLLAPSE_LINES, FORGE_ORG } from "./config.ts";
import {
  type CiState,
  ciSummary,
  DRAFT_LINE,
  type DiffLine,
  parseBotMeta,
  parsePatch,
  type ReviewAction,
  VERDICT_LABEL,
  withoutBotMeta,
} from "./forge.ts";
import type { FileDiff, PrDetail } from "./prs.ts";
import type { Entry } from "./queue.ts";
import { pill, time } from "./view.ts";

/** Classes the keyboard handler looks for. */
export const FILE_CLASS = "file";
export const REVIEW_FORM_CLASS = "review";
export const APPROVE_ACTION = "approve";

export interface PrViewHandlers {
  /** Submit a review; resolves to its URL. */
  review(action: ReviewAction, text: string, draft: boolean): Promise<string>;
}

export interface PrViewOptions {
  /** A review was already sent from this tab. */
  reviewedHere: boolean;
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
  /** Files whose diff was never expanded. */
  unopened: number;
  /** Files GitHub gives no diff for. */
  noDiff: number;
  /** Files or commits beyond what the API lists. */
  truncated: boolean;
}

export function unseenNote(u: Unseen): string {
  const parts = [
    u.unopened ? `${u.unopened} file${u.unopened > 1 ? "s" : ""} never expanded` : "",
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

function reviewForm(d: PrDetail, opts: PrViewOptions, handlers: PrViewHandlers, unseen: () => Unseen): HTMLElement {
  const text = h("textarea", {
    name: "text",
    rows: "3",
    placeholder: "Optional for an approval; required to request changes or comment",
    "aria-label": "Review text",
  });
  const draft = h("input", { type: "checkbox", id: "review-draft" });
  const status = h("p", { class: "status", role: "status" });
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
  const form = h(
    "form",
    { class: REVIEW_FORM_CLASS },
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
    const what = action === "approve" ? `Approve${wantDraft ? ` (with ${DRAFT_LINE})` : ""}` : action === "comment" ? "Comment on" : "Request changes on";
    const again = sent ? " You already reviewed it from here." : "";
    const note = action === "approve" ? unseenNote(unseen()) : "";
    if (!window.confirm(`${what} ${d.ref.owner}/${d.ref.repo}#${d.ref.number} at ${short(d.head)}?${note}${again}`)) return;
    for (const b of buttons) b.disabled = true;
    status.textContent = "Sending…";
    handlers
      .review(action, text.value, wantDraft)
      .then((url) => {
        sent = true;
        text.value = "";
        status.textContent = "Sent: ";
        status.append(link(url, url));
        enable();
      })
      .catch((e: unknown) => {
        status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
        enable();
      });
  };
  for (const b of buttons) b.addEventListener("click", () => send(b.dataset.action as ReviewAction));
  return form;
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

function diffTable(lines: readonly DiffLine[]): HTMLElement {
  const table = h("table", { class: "diff" });
  const body = h("tbody");
  for (const l of lines) {
    if (l.kind === "hunk" || l.kind === "note") {
      body.append(h("tr", { class: l.kind }, h("td", { class: "ln", colspan: "2" }), h("td", { class: "code" }, l.text)));
      continue;
    }
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    body.append(
      h(
        "tr",
        { class: l.kind },
        h("td", { class: "ln" }, l.old === undefined ? "" : String(l.old)),
        h("td", { class: "ln" }, l.new === undefined ? "" : String(l.new)),
        h("td", { class: "code" }, sign + l.text),
      ),
    );
  }
  table.append(body);
  return table;
}

interface FileView {
  el: HTMLDetailsElement;
  /** Whether its diff was ever shown. */
  seen(): boolean;
  hasDiff: boolean;
}

function fileView(f: FileDiff): FileView {
  const lines = f.patch === undefined ? undefined : parsePatch(f.patch);
  const hasDiff = lines !== undefined && lines.length > 0;
  const name = f.previous && f.previous !== f.filename ? `${f.previous} → ${f.filename}` : f.filename;
  const det = h(
    "details",
    { class: FILE_CLASS },
    h(
      "summary",
      {},
      h("span", { class: `fstatus s-${f.status}` }, f.status),
      h("span", { class: "fname" }, name),
      h("span", { class: "counts" }, h("span", { class: "plus" }, `+${f.additions}`), " ", h("span", { class: "minus" }, `−${f.deletions}`)),
    ),
  );
  // Build the table on first open: a large PR stays quick to show.
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    if (!lines || !hasDiff) {
      det.append(h("p", { class: "note" }, "No diff to show (binary, too large, or a rename only). ", link(f.url, "View the file")));
    } else {
      det.append(h("div", { class: "diffwrap" }, diffTable(lines)));
    }
  };
  det.addEventListener("toggle", () => {
    if (det.open) build();
  });
  if (!lines || lines.length <= DIFF_COLLAPSE_LINES) {
    det.open = true;
    build();
  }
  return { el: det, seen: () => built, hasDiff };
}

function filesSection(d: PrDetail, files: readonly FileView[]): HTMLElement {
  const expand = h("button", { type: "button", class: "small" }, "Expand all");
  const collapse = h("button", { type: "button", class: "small" }, "Collapse all");
  const s = h(
    "section",
    { class: "files" },
    h(
      "div",
      { class: "files-h" },
      h("h3", {}, `Files · ${d.changedFiles} · `, h("span", { class: "plus" }, `+${d.additions}`), " ", h("span", { class: "minus" }, `−${d.deletions}`)),
      h("span", { class: "tag" }, "j/k file, x fold"),
      expand,
      collapse,
    ),
  );
  s.append(...files.map((f) => f.el));
  expand.addEventListener("click", () => files.forEach((f) => (f.el.open = true)));
  collapse.addEventListener("click", () => files.forEach((f) => (f.el.open = false)));
  if (d.files.length < d.changedFiles) s.append(h("p", { class: "note" }, `Showing ${d.files.length} of ${d.changedFiles} files; see the rest on GitHub.`));
  return s;
}

export function prView(d: PrDetail, entry: Entry | undefined, render: Renderer, handlers: PrViewHandlers, opts: PrViewOptions): HTMLElement {
  const verdict = d.verdict.state === "none" ? undefined : VERDICT_LABEL[d.verdict.state];
  const files = d.files.map(fileView);
  const unseen = (): Unseen => ({
    unopened: files.filter((f) => f.hasDiff && !f.seen()).length,
    noDiff: files.filter((f) => !f.hasDiff).length,
    truncated: d.files.length < d.changedFiles || d.commits.length < d.commitCount,
  });
  let form: HTMLElement;
  if (canReview(d)) form = reviewForm(d, opts, handlers, unseen);
  else if (d.state !== "open") form = h("p", { class: "warn" }, `This PR is ${d.state}; there is nothing to review.`);
  else form = h("p", { class: "note" }, `Reviews from here are only for ${BOT_LOGIN}'s PRs in ${REVIEWABLE_OWNERS.join(" and ")}; use GitHub for this one.`);
  return h(
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
    filesSection(d, files),
  );
}
