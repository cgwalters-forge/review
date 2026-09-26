// The two views, queue and item, built with plain DOM calls. Rendered
// markdown comes from the sanitizing renderer as a DocumentFragment.

import { type Answer, getDraftSection, parseAnswer } from "../answer.ts";
import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { AnswerTarget, Item, Question } from "./board.ts";
import type { Context, ReceiptStatus } from "./backend.ts";
import { BOARD_URL, OPERATOR } from "./config.ts";
import { type Entry, type EntryKind, groupRanked } from "./queue.ts";

/** Characters of Why shown on a queue row. */
const WHY_EXCERPT = 160;

function refLabel(item: Item): string {
  if (item.ref) return `${item.ref.owner}/${item.ref.repo}#${item.ref.number}`;
  return item.kind === "draft" ? "draft item" : "item";
}

export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function time(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const AGE_UNITS: [number, string][] = [
  [7 * 24 * 3600_000, "w"],
  [24 * 3600_000, "d"],
  [3600_000, "h"],
  [60_000, "m"],
];

/** A compact age, e.g. "3d", or "" for no or a bad date. */
export function age(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(t)) return "";
  const ms = Math.max(0, now - t);
  for (const [unit, suffix] of AGE_UNITS) if (ms >= unit) return `${Math.floor(ms / unit)}${suffix}`;
  return "now";
}

export function pill(priority: string | undefined): HTMLElement {
  const p = priority ?? "–";
  return h("span", { class: `pill ${/^P[0-3]$/.test(p) ? p.toLowerCase() : "pn"}` }, p);
}

export type AnswerState = "answered" | "claimed" | undefined;

/**
 * Has this item been answered? Yes if sent from this tab, or if a draft's
 * answer section points to a receipt that checked out. A section alone is
 * only a claim: anyone who can edit the board can write one.
 */
export function answerState(
  item: Item,
  sent: ReadonlySet<string>,
  receipts: ReadonlyMap<string, ReceiptStatus>,
): AnswerState {
  if (sent.has(item.nodeId)) return "answered";
  if (item.kind !== "draft" || getDraftSection(item.body) === null) return undefined;
  return receipts.get(item.nodeId)?.check.ok ? "answered" : "claimed";
}

export const STATE_LABEL: Record<NonNullable<AnswerState>, string> = {
  answered: "answered",
  claimed: "body claims an answer (unverified)",
};

/** A short status shown on a queue row, e.g. "answered". */
export interface RowLabel {
  text: string;
  cls: string;
}

const KIND_LABEL: Record<EntryKind, string> = { pr: "PR", question: "Q", chore: "act" };
const KIND_TITLE: Record<EntryKind, string> = { pr: "forge PR to review", question: "question for you", chore: "action for you" };

/** The class queue rows carry, and the attribute holding their key. */
export const ROW_CLASS = "row";
export const ROW_KEY_ATTR = "data-key";

export function queueView(
  entries: readonly Entry[],
  labelOf: (e: Entry) => RowLabel | undefined,
  now: number = Date.now(),
): HTMLElement {
  const root = h("main", { class: "queue" });
  if (entries.length === 0) {
    root.append(h("p", { class: "empty" }, "Nothing needs you right now."));
    return root;
  }
  const counts = { pr: 0, question: 0, chore: 0 };
  for (const e of entries) counts[e.kind]++;
  root.append(
    h("p", { class: "summary" }, `${counts.pr} PRs to review · ${counts.question} questions · ${counts.chore} other · j/k to move, o to open, ? for keys`),
  );
  for (const group of groupRanked(entries)) {
    const section = h("section", { class: "group" }, h("h2", { class: "group-h" }, `${group.priority} · ${group.entries.length}`));
    for (const e of group.entries) {
      const label = labelOf(e);
      const why = e.item?.why ? excerpt(e.item.why, WHY_EXCERPT) : "";
      section.append(
        h(
          "a",
          { class: `${ROW_CLASS} k-${e.kind}${label ? ` ${label.cls}` : ""}`, href: e.href, [ROW_KEY_ATTR]: e.key },
          h("span", { class: `kind k-${e.kind}`, title: KIND_TITLE[e.kind] }, KIND_LABEL[e.kind]),
          h(
            "span",
            { class: "main" },
            h("span", { class: "title" }, e.title),
            h(
              "span",
              { class: "sub" },
              pill(e.priority),
              h("span", { class: "tag" }, [e.item?.org, e.where].filter(Boolean).join(" · ")),
              label ? h("span", { class: `state ${label.cls}` }, label.text) : null,
            ),
            why ? h("span", { class: "why" }, why) : null,
          ),
          h("span", { class: "age", title: e.since ? `waiting since ${time(e.since)}` : "" }, age(e.since, now)),
        ),
      );
    }
    root.append(section);
  }
  return root;
}

export interface ItemViewHandlers {
  /** Post the answer; resolves to the URL of what was written. */
  send(answer: Answer): Promise<string>;
}

export function describeTarget(target: AnswerTarget): string {
  switch (target.kind) {
    case "comment": {
      const r = target.ref;
      const where = `${r.owner}/${r.repo}#${r.number}`;
      return target.confirmPublic
        ? `Posts a public comment as you on ${where}, which is outside the bot's repositories. You'll be asked to confirm.`
        : `Posts a comment as you on ${where}.`;
    }
    case "draft":
      return target.boardPublic
        ? "Writes your answer into the draft's body, which anyone can read on this public board, and saves it as an unlisted gist under your account (the receipt the bot verifies). The body links to that gist, so treat both as public."
        : "Writes your answer into the draft's body and saves it as an unlisted gist under your account (the receipt the bot verifies).";
    case "none":
      return `Can't answer here: ${target.reason}.`;
  }
}

function questionNote(question: Question): string {
  if (question.error) return `Can't answer: ${question.error}.`;
  if (question.id) return `Answering ${question.id}.`;
  return "This question has no id, so the bot can only check your answer by when you sent it.";
}

interface FormOptions {
  /** An answer was already sent from this tab; confirm another. */
  alreadySent: boolean;
}

function answerForm(target: AnswerTarget, question: Question, opts: FormOptions, handlers: ItemViewHandlers): HTMLElement {
  const { options } = question;
  const form = h("form", { class: "answer" });
  const status = h("p", { class: "status", role: "status" });
  if (options.length) {
    const fs = h("fieldset", {}, h("legend", {}, "Choose"));
    for (const o of options) {
      const id = `opt-${o.letter}`;
      fs.append(
        h(
          "label",
          { class: "opt", for: id },
          h("input", { type: "radio", name: "choice", id, value: o.letter }),
          h("span", {}, h("b", {}, `${o.letter}) `), o.text, o.recommended ? h("span", { class: "rec" }, "recommended") : null),
        ),
      );
    }
    form.append(fs);
  }
  const text = h("textarea", {
    name: "text",
    rows: "4",
    placeholder: options.length ? "Anything to add (optional)" : "Your answer",
    "aria-label": "Answer text",
  });
  const button = h("button", { type: "submit", class: "primary" }, "Send answer");
  let sent = opts.alreadySent;
  const blocked = target.kind === "none" || question.error !== undefined;
  button.disabled = blocked;
  form.append(
    text,
    h("p", { class: "target" }, questionNote(question), " ", describeTarget(target)),
    h("div", { class: "actions" }, button),
    status,
  );

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (blocked) return;
    const picked = form.querySelector<HTMLInputElement>("input[name=choice]:checked");
    const answer: Answer = { text: text.value };
    if (picked) answer.choice = picked.value;
    if (question.id) answer.question = question.id;
    if (!picked && !text.value.trim()) {
      status.textContent = "Pick an option or write an answer.";
      text.focus();
      return;
    }
    if (sent && !window.confirm("You already answered this from here. Send another answer?")) return;
    if (target.kind === "comment" && target.confirmPublic) {
      const r = target.ref;
      if (!window.confirm(`Post this as a public comment on ${r.owner}/${r.repo}#${r.number}?`)) return;
    }
    button.disabled = true;
    status.textContent = "Sending…";
    handlers
      .send(answer)
      .then((url) => {
        sent = true;
        status.textContent = "Sent: ";
        status.append(link(url, url));
        // The button stays disabled: one tap, one answer.
      })
      .catch((e: unknown) => {
        status.textContent = `Not sent: ${e instanceof Error ? e.message : String(e)}`;
        button.disabled = false;
      });
  });
  return form;
}

function commentView(c: Context["comments"][number], render: Renderer): HTMLElement {
  const isAnswer = c.author === OPERATOR && parseAnswer(c.body) !== null;
  return h(
    "article",
    { class: `comment${isAnswer ? " your-answer" : ""}` },
    h("div", { class: "meta" }, link(c.url, `${c.author} · ${time(c.createdAt)}`), isAnswer ? " · your answer" : ""),
    h("div", { class: "md" }, render(c.body)),
  );
}

function receiptNote(receipt: ReceiptStatus): HTMLElement {
  if (receipt.check.ok) {
    const { choice } = receipt.check.receipt;
    return h(
      "p",
      { class: "note" },
      `Answered${choice ? ` (${choice})` : ""}, verified by your `,
      link(receipt.url, "receipt"),
      ". Sending again replaces the body's section.",
    );
  }
  return h(
    "p",
    { class: "warn" },
    "The draft body claims an answer, but its ",
    link(receipt.url, "receipt"),
    ` doesn't verify: ${receipt.check.reason}. The bot will ignore it.`,
  );
}

/** The part of the item view that needs the loaded context. */
export function contextView(item: Item, context: Context | undefined, render: Renderer): DocumentFragment {
  const out = document.createDocumentFragment();
  if (!context) {
    out.append(h("p", { class: "note" }, "Loading comments and gists…"));
    return out;
  }
  if (context.receipt) out.append(receiptNote(context.receipt));
  else if (item.kind === "draft" && getDraftSection(item.body)) {
    out.append(h("p", { class: "warn" }, "The draft body claims an answer, but its receipt link isn't one this app can check."));
  }
  for (const w of context.warnings) out.append(h("p", { class: "warn" }, w));
  for (const g of context.gists) {
    const s = h("section", { class: "gist" }, h("h3", {}, "Gist ", link(g.url, g.owner ? `by ${g.owner}` : "")));
    for (const f of g.files) {
      const isMarkdown = f.language === "Markdown" || /\.(md|markdown)$/i.test(f.name);
      s.append(
        h("h4", {}, f.name, f.truncated ? " (truncated)" : ""),
        isMarkdown ? h("div", { class: "md" }, render(f.content)) : h("pre", {}, f.content),
      );
    }
    out.append(s);
  }
  if (context.comments.length) {
    const s = h("section", { class: "comments" }, h("h3", {}, "Latest comments"));
    for (const c of context.comments) s.append(commentView(c, render));
    out.append(s);
  }
  return out;
}

/** The class of the element contextView fills, so it can be refreshed alone. */
export const CONTEXT_CLASS = "context";

export function itemView(
  item: Item,
  target: AnswerTarget,
  question: Question,
  context: Context | undefined,
  render: Renderer,
  alreadySent: boolean,
  handlers: ItemViewHandlers,
): HTMLElement {
  const links = h("div", { class: "links" });
  if (item.url) links.append(link(item.url, refLabel(item)));
  for (const u of item.branch) links.append(link(u, "branch"));
  for (const u of item.gist) links.append(link(u, "gist"));
  links.append(link(BOARD_URL, "board"));

  return h(
    "main",
    { class: "item" },
    h("a", { href: "#", class: "back" }, "← Queue (u)"),
    h(
      "div",
      { class: "hdr" },
      pill(item.priority),
      h("span", { class: "tag" }, [item.org, item.kind, item.state].filter(Boolean).join(" · ")),
    ),
    h("h2", {}, item.title),
    links,
    h("section", {}, h("h3", {}, "Why"), h("div", { class: "md" }, render(item.why || "(empty)"))),
    alreadySent ? h("p", { class: "note" }, "Your answer was sent from here; the item stays in the queue until the bot acts on it.") : null,
    answerForm(target, question, { alreadySent }, handlers),
    item.body.trim()
      ? h("section", {}, h("h3", {}, item.kind === "draft" ? "Draft" : "Description"), h("div", { class: "md" }, render(item.body)))
      : null,
    h("div", { class: CONTEXT_CLASS }, contextView(item, context, render)),
  );
}
