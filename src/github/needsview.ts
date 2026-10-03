// The rows of the "Needs you" section: one per thing that waits on him,
// each with the single action it asks for. A question is answered right
// in its row, with the same form as the item view; everything else has
// its action as a link to the pane where it is done.

import type { Answer } from "../answer.ts";
import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import { questionOf } from "./board.ts";
import { OPERATOR } from "./config.ts";
import type { Entry } from "./queue.ts";
import { ACTION_LABEL, ACTION_TITLE, type Need } from "./needs.ts";
import { decisionLabel, shortRef } from "./triage.ts";
import { age, answerForm, askText, BUG_LABEL, excerpt, KIND_LABEL, KIND_TITLE, pill, ROW_CLASS, ROW_HREF_ATTR, ROW_KEY_ATTR, ROW_SECTION_ATTR, type RowLabel, rowText, STATE_LABEL, time } from "./view.ts";

/** Characters of the ask shown on a row before "The whole question". */
const ASK_EXCERPT = 240;

/** The class of a need's row, and of one answered from this page. */
export const NEED_CLASS = "need";
export const NEED_DONE_CLASS = "need-done";

export interface NeedsHooks {
  /** The signed-in login: only OPERATOR's answers count, so only he gets the forms. */
  login?: string | undefined;
  now: number;
  render: Renderer;
  /** The label on a row's entry (answered, review requested, ...). */
  labelOf: (e: Entry) => RowLabel | undefined;
  /** Post the answer to a row's question; resolves to the comment's URL. */
  send(need: Need, answer: Answer): Promise<string>;
}

/** What the rows show, so an unchanged list is not redrawn under his hands. */
export function needsSignature(needs: readonly Need[], hooks: Pick<NeedsHooks, "login" | "now" | "labelOf">): string {
  return JSON.stringify([
    hooks.login,
    needs.map((n) => [n.key, n.action, n.title, n.priority, n.done === true, n.parent?.key, n.decision?.item.nodeId, n.decision?.item.body, n.entry?.item?.body, n.entry ? hooks.labelOf(n.entry)?.text : undefined, age(n.entry?.since ?? n.since, hooks.now)]),
  ]);
}

/** An answer form's snapshot, without its DOM nodes. */
export interface NeedsForm {
  sent: boolean;
  text: string;
  picked: boolean;
}

export const NEEDS_CHANGED_NOTE = "What waits on you changed; press r to reload it (unsent picks and notes are lost).";

/** Decide whether to redraw, keeping half-written answers and unrelated notices. */
export function needsRedraw(input: {
  signature: string;
  previousSignature: string | undefined;
  forms: readonly NeedsForm[];
  note: string | undefined;
  force: boolean;
}): { action: "skip" | "defer" | "redraw"; note: string | undefined } {
  if (!input.force && input.signature === input.previousSignature) return { action: "skip", note: input.note };
  const draft = input.forms.some((f) => !f.sent && (f.text.trim() !== "" || f.picked));
  if (!input.force && draft) return { action: "defer", note: NEEDS_CHANGED_NOTE };
  return { action: "redraw", note: input.note === NEEDS_CHANGED_NOTE ? undefined : input.note };
}

/** The element id of a need's row. */
export const needId = (n: Need): string => `need-${n.key.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;

function unblocks(urls: readonly string[]): HTMLElement {
  return h("details", { class: "unblocks" }, h("summary", {}, `Unblocks ${urls.length}`), h("ul", {}, ...urls.map((u) => h("li", {}, link(u, shortRef(u))))));
}

/** The form, or why there is none, for a question that is answered in its row. */
function answerPart(n: Need, hooks: NeedsHooks): Node {
  const item = n.decision?.item ?? n.entry?.item;
  if (!item?.ref) return h("p", { class: "warn" }, "This question has no issue to answer on.");
  if (hooks.login !== OPERATOR) return h("p", { class: "note" }, `Only ${OPERATOR} answers; you are signed in as ${hooks.login ?? "nobody yet"}.`);
  const question = n.decision?.question ?? questionOf(item);
  return answerForm(item.ref, question, false, (a) => hooks.send(n, a), `n${item.ref.number}-`);
}

export function needRow(n: Need, hooks: NeedsHooks): HTMLElement {
  const e = n.entry;
  const item = n.decision?.item ?? e?.item;
  const label = e ? hooks.labelOf(e) : undefined;
  const question = n.action === "answer" ? (n.decision?.question ?? (item ? questionOf(item) : undefined)) : undefined;
  // What it asks, when the title doesn't say: a question's ask, else the entry's one-liner.
  const ask = question ? question.ask : e ? rowText(e) : item ? askText(item) : undefined;
  const sub = h(
    "span",
    { class: "sub" },
    pill(n.priority),
    h("a", { class: `action a-${n.action}`, href: n.href, title: ACTION_TITLE[n.action] }, ACTION_LABEL[n.action]),
    n.decision ? h("span", { class: "dec-id", title: "a decision" }, decisionLabel(n.decision)) : null,
    h("span", { class: "tag" }, [item?.org, n.where, n.parent ? `for ${excerpt(n.parent.title, 48)}` : undefined].filter(Boolean).join(" · ")),
    n.done ? h("span", { class: "state answered" }, STATE_LABEL.answered) : label ? h("span", { class: `state ${label.cls}` }, label.text) : null,
    n.action === "fix" ? h("span", { class: "state bug" }, BUG_LABEL) : null,
  );
  const main = h("div", { class: "main" }, h("span", { class: "title" }, h("a", { href: n.href }, n.title)), sub);
  if (ask && ask !== n.title) main.append(h("span", { class: "why", title: ask }, excerpt(ask, ASK_EXCERPT)));
  if (question?.recommendation) main.append(h("p", { class: "note" }, `Recommended: ${question.recommendation}`));
  if (question?.optionsProblem) {
    main.append(h("p", { class: "warn" }, `Not every option can be offered: ${question.optionsProblem}. Read the question below, and answer in your own words if one is missing.`));
  }
  if (n.inPlace && !n.done) main.append(answerPart(n, hooks));
  if (n.decision?.unblocks.length) main.append(unblocks(n.decision.unblocks));
  if (question && item?.body.trim()) main.append(h("details", { class: "dec-body" }, h("summary", {}, "The whole question"), h("div", { class: "md" }, hooks.render(item.body))));
  const kind = e?.kind ?? "question";
  const since = e?.since ?? n.since;
  const row = h(
    "article",
    {
      class: `${ROW_CLASS} ${NEED_CLASS} k-${kind}${n.done ? ` ${NEED_DONE_CLASS}` : ""}`,
      id: needId(n),
      // Focusable, so moving on after an answer can land on it.
      tabindex: "-1",
      [ROW_KEY_ATTR]: n.key,
      [ROW_HREF_ATTR]: n.href,
      [ROW_SECTION_ATTR]: "needs",
    },
    h("span", { class: `kind k-${kind}`, title: KIND_TITLE[kind] }, KIND_LABEL[kind]),
    main,
    h("span", { class: "age", title: since ? `waiting since ${time(since)}` : "", ...(since ? { "data-since": since } : {}) }, age(since, hooks.now)),
  );
  return row;
}
