// The two views, queue and item, built with plain DOM calls. Rendered
// markdown comes from the sanitizing renderer as a DocumentFragment.

import { type Answer, parseAnswer, type Question } from "../answer.ts";
import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { type AnswerTarget, type IssueRef, isQuestion, type Item, questionOf, type SubIssueSummary } from "./board.ts";
import type { Context, SubIssue } from "./backend.ts";
import { BOARD_URL, OPERATOR, QUESTION_LABEL } from "./config.ts";
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

export type AnswerState = "answered" | "done" | undefined;

/**
 * Where a question stands: done once the bot closed it; answered once
 * sent from this tab or he commented after the bot last did (`answered`,
 * by node id), until the bot acts. Other items take no answers, so have
 * no state.
 */
export function answerState(item: Item, sent: ReadonlySet<string>, answered: ReadonlySet<string>): AnswerState {
  if (!isQuestion(item)) return undefined;
  if (item.state === "closed") return "done";
  return sent.has(item.nodeId) || answered.has(item.nodeId) ? "answered" : undefined;
}

export const STATE_LABEL: Record<NonNullable<AnswerState>, string> = {
  answered: "answered, waiting on the bot",
  done: "closed by the bot",
};

/** Sub-issue progress, e.g. "1/3 sub-issues done". */
export function progressText(p: SubIssueSummary): string {
  return `${p.completed}/${p.total} sub-issues done`;
}

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

/** The row's one-line summary: a question's ask, else Why. */
function rowText(e: Entry): string {
  const text = (e.item ? questionOf(e.item).ask : undefined) ?? e.item?.why ?? "";
  return text ? excerpt(text, WHY_EXCERPT) : "";
}

function row(e: Entry, labelOf: (e: Entry) => RowLabel | undefined, now: number, child: boolean): HTMLElement {
  const label = labelOf(e);
  const why = rowText(e);
  const progress = e.item?.subIssues ? progressText(e.item.subIssues) : undefined;
  const where = [e.item?.org, e.where, e.blocks ? `blocks ${e.blocks}` : undefined, progress].filter(Boolean).join(" · ");
  return h(
    "a",
    { class: `${ROW_CLASS} k-${e.kind}${child ? " child" : ""}${label ? ` ${label.cls}` : ""}`, href: e.href, [ROW_KEY_ATTR]: e.key },
    h("span", { class: `kind k-${e.kind}`, title: KIND_TITLE[e.kind] }, KIND_LABEL[e.kind]),
    h(
      "span",
      { class: "main" },
      h("span", { class: "title" }, e.title),
      h(
        "span",
        { class: "sub" },
        pill(e.priority),
        h("span", { class: "tag" }, where),
        label ? h("span", { class: `state ${label.cls}` }, label.text) : null,
      ),
      why ? h("span", { class: "why" }, why) : null,
    ),
    h("span", { class: "age", title: e.since ? `waiting since ${time(e.since)}` : "" }, age(e.since, now)),
  );
}

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
  for (const e of entries) for (const x of [e, ...(e.children ?? [])]) if (!x.settled) counts[x.kind]++;
  root.append(
    h("p", { class: "summary" }, `${counts.pr} PRs to review · ${counts.question} questions · ${counts.chore} other · j/k to move, o to open, ? for keys`),
  );
  for (const group of groupRanked(entries)) {
    const section = h("section", { class: "group" }, h("h2", { class: "group-h" }, `${group.priority} · ${group.entries.length}`));
    for (const e of group.entries) {
      section.append(row(e, labelOf, now, false));
      for (const c of e.children ?? []) section.append(row(c, labelOf, now, true));
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
    case "question": {
      const r = target.ref;
      return `Posts a comment as you on ${r.owner}/${r.repo}#${r.number}; the bot acts on it and closes the issue.`;
    }
    case "none":
      return `Nothing to answer here: ${target.reason}.`;
  }
}

function answerForm(target: AnswerTarget & { kind: "question" }, question: Question, answered: boolean, handlers: ItemViewHandlers): HTMLElement {
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
  let sent = answered;
  form.append(text, h("p", { class: "target" }, describeTarget(target)), h("div", { class: "actions" }, button), status);

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const picked = form.querySelector<HTMLInputElement>("input[name=choice]:checked");
    const answer: Answer = { text: text.value };
    if (picked) answer.choice = picked.value;
    if (!picked && !text.value.trim()) {
      status.textContent = "Pick an option or write an answer.";
      text.focus();
      return;
    }
    if (sent && !window.confirm("You already answered this. Send another answer?")) return;
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

/** "your answer", or "your answer: B" when it picks an option. */
function answerLabel(body: string): string {
  const { choice } = parseAnswer(body);
  return choice ? ` · your answer: ${choice}` : " · your answer";
}

function commentView(c: Context["comments"][number], render: Renderer, onQuestion: boolean): HTMLElement {
  // On a question issue, every comment of his is an answer.
  const isAnswer = onQuestion && c.author === OPERATOR;
  return h(
    "article",
    { class: `comment${isAnswer ? " your-answer" : ""}` },
    h("div", { class: "meta" }, link(c.url, `${c.author} · ${time(c.createdAt)}`), isAnswer ? answerLabel(c.body) : ""),
    h("div", { class: "md" }, render(c.body)),
  );
}

/** The app route of an issue that is on the board, if it is. */
export type BoardHref = (ref: IssueRef) => string | undefined;

function subIssueView(s: SubIssue, boardHref: BoardHref): HTMLElement {
  const href = boardHref(s.ref);
  const where = `${s.ref.owner}/${s.ref.repo}#${s.ref.number}`;
  const notes = [s.labels.includes(QUESTION_LABEL) ? "question" : "", s.progress ? progressText(s.progress) : ""].filter(Boolean).join(" · ");
  return h(
    "li",
    { class: `sub-issue ${s.state === "closed" ? "closed" : "open"}` },
    h("span", { class: "sub-state" }, s.state),
    " ",
    href ? h("a", { href }, s.title) : link(s.url, s.title),
    " ",
    h("span", { class: "tag" }, notes ? `${where} · ${notes}` : where),
  );
}

function subIssuesView(item: Item, subs: readonly SubIssue[], boardHref: BoardHref): HTMLElement {
  const summary = item.subIssues ? ` · ${progressText(item.subIssues)} (${item.subIssues.percent_completed}%)` : "";
  return h("section", { class: "sub-issues" }, h("h3", {}, `Sub-issues${summary}`), h("ul", {}, ...subs.map((s) => subIssueView(s, boardHref))));
}

/** The part of the item view that needs the loaded context. */
export function contextView(item: Item, context: Context | undefined, render: Renderer, boardHref: BoardHref = () => undefined): DocumentFragment {
  const out = document.createDocumentFragment();
  if (!context) {
    out.append(h("p", { class: "note" }, "Loading comments, gists and sub-issues…"));
    return out;
  }
  for (const w of context.warnings) out.append(h("p", { class: "warn" }, w));
  if (context.subIssues?.length) out.append(subIssuesView(item, context.subIssues, boardHref));
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
    for (const c of context.comments) s.append(commentView(c, render, isQuestion(item)));
    out.append(s);
  }
  return out;
}

/** The class of the element contextView fills, so it can be refreshed alone. */
export const CONTEXT_CLASS = "context";

/** What the item view shows besides the item. */
export interface ItemViewData {
  target: AnswerTarget;
  context: Context | undefined;
  state: AnswerState;
  /** The questions nested under this item in the queue. */
  questions?: readonly Entry[];
  /** Links sub-issues on the board to their item view. */
  boardHref?: BoardHref;
}

const STATE_NOTE: Record<NonNullable<AnswerState>, string> = {
  answered: "You answered; the question stays in the queue until the bot acts on it and closes the issue.",
  done: "The bot acted on this question and closed it.",
};

export function itemView(item: Item, data: ItemViewData, render: Renderer, handlers: ItemViewHandlers): HTMLElement {
  const { target, context, state } = data;
  const question = questionOf(item);
  const onQuestion = isQuestion(item);
  const links = h("div", { class: "links" });
  if (item.url) links.append(link(item.url, onQuestion || !item.ref ? refLabel(item) : `${refLabel(item)}: act on GitHub`));
  if (question.blocks) links.append(link(question.blocks, "blocks"));
  for (const u of item.branch) links.append(link(u, "branch"));
  for (const u of item.gist) links.append(link(u, "gist"));
  links.append(link(BOARD_URL, "board"));

  const questions = data.questions?.length
    ? h(
        "section",
        { class: "questions" },
        h("h3", {}, "Questions about this"),
        h("ul", {}, ...data.questions.map((q) => h("li", {}, h("a", { href: q.href }, q.title)))),
      )
    : null;

  return h(
    "main",
    { class: "item" },
    h("a", { href: "#", class: "back" }, "← Queue (u)"),
    h(
      "div",
      { class: "hdr" },
      pill(item.priority),
      h(
        "span",
        { class: "tag" },
        [item.org, onQuestion ? "question" : item.kind, item.state, item.subIssues ? progressText(item.subIssues) : undefined].filter(Boolean).join(" · "),
      ),
    ),
    h("h2", {}, item.title),
    links,
    h("section", {}, h("h3", {}, "Why"), h("div", { class: "md" }, render(item.why || "(empty)"))),
    questions,
    state ? h("p", { class: "note" }, STATE_NOTE[state]) : null,
    target.kind === "question"
      ? answerForm(target, question, state === "answered", handlers)
      : h("p", { class: "target" }, describeTarget(target)),
    item.body.trim()
      ? h("section", {}, h("h3", {}, onQuestion ? "Question" : item.kind === "draft" ? "Draft" : "Description"), h("div", { class: "md" }, render(item.body)))
      : null,
    h("div", { class: CONTEXT_CLASS }, contextView(item, context, render, data.boardHref)),
  );
}
