// The answer format: what the app writes as cgwalters, and what the bot
// parses. Forge-neutral, and free of DOM and network code so that the
// bot-side parser can mirror it line for line.
//
// An answer is a block of text whose first line is the command:
//
//     /answer B Q#3
//     Free markdown from him, any number of lines.
//
// The letter is optional (free text only), as is the text (one tap only),
// but not both. `Q#3` is the id of the question being answered, copied
// from the bot's question when it has one, so that the bot can reject an
// answer to a question it no longer asks (a replayed comment, or options
// that changed while the view was open). On an issue or PR the block is
// the whole comment. A draft item has no comments, so the block goes into
// a marked section of the draft body, next to the URL of a gist "receipt"
// that holds the same block plus an `Item:` trailer; see docs/design.md
// for why the receipt, and not the body, is what the bot trusts.

/** The command line that starts an answer. */
export const ANSWER_COMMAND = "/answer";
/** Trailer binding a receipt to one board item. */
export const ITEM_TRAILER = "Item";
/** Markers around the answer section of a draft body. */
export const SECTION_BEGIN = "<!-- review-answer BEGIN";
export const SECTION_END = "<!-- review-answer END -->";

/**
 * Commands the bot acts on when they appear on a line of their own in
 * cgwalters' comments. bot-pr matches `/promote`, `/draft` and `/ready` on
 * any line, after trimming whitespace, so free text must never contain
 * one: an answer saying "ok\n/promote" would promote a fork PR.
 */
export const BOT_COMMANDS: readonly string[] = [ANSWER_COMMAND, "/promote", "/draft", "/ready"];

const CHOICE_RE = /^[A-Z]$/;
const QUESTION_ID_RE = /^Q#[0-9]{1,9}$/;
const COMMAND_RE = /^\/answer(?:[ \t]+([A-Z]))?(?:[ \t]+(Q#[0-9]{1,9}))?[ \t]*$/;
// A question id in bot-written text: "Q#3:" at the start of a line, so an
// id in a URL, backticks or prose ("see Q#3") never counts.
const QUESTION_IN_TEXT_RE = /^Q#([0-9]{1,9}):/gm;
const ITEM_ID_RE = /^PVTI_[A-Za-z0-9_-]+$/;
const TRAILER_RE = /^Item:[ \t]*(\S+)[ \t]*$/;
// Accept only https gist URLs in the section marker; anything else is
// ignored rather than rendered or followed.
const RECEIPT_RE = /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?[0-9a-f]+$/;

export interface Answer {
  /** The option letter, if he picked one. */
  choice?: string;
  /** The id of the question answered, e.g. "Q#3", if it had one. */
  question?: string;
  /** His free text, trimmed; may be empty when a choice is given. */
  text: string;
}

export interface Receipt extends Answer {
  /** The board item node id (PVTI_...) this receipt answers. */
  item: string;
}

export class AnswerError extends Error {
  override name = "AnswerError";
}

/** True if a line of text would read as a bot command. */
export function isCommandLine(line: string): boolean {
  const word = line.trim().split(/\s/, 1)[0] ?? "";
  return BOT_COMMANDS.includes(word);
}

function validate(answer: Answer): void {
  if (answer.choice !== undefined && !CHOICE_RE.test(answer.choice)) {
    throw new AnswerError(`invalid choice ${JSON.stringify(answer.choice)}: expected one letter A-Z`);
  }
  if (answer.question !== undefined && !QUESTION_ID_RE.test(answer.question)) {
    throw new AnswerError(`invalid question id ${JSON.stringify(answer.question)}: expected Q# and a number`);
  }
  if (answer.choice === undefined && answer.text.trim() === "") {
    throw new AnswerError("pick an option or write an answer");
  }
  const bad = cleanText(answer.text).split("\n").find(isCommandLine);
  if (bad !== undefined) {
    throw new AnswerError(
      `the line ${JSON.stringify(bad.trim())} would be read as a bot command; reword it (e.g. put it in backticks)`,
    );
  }
}

/** Normalize line endings and trim, without touching inner lines. */
function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * The id of the question in bot-written texts, or undefined if they have
 * none. An id counts only as `Q#n:` at the start of a line. Several
 * different ids, within one text or across them, make the question
 * ambiguous, and throw.
 */
export function questionId(...texts: string[]): string | undefined {
  const ids = new Set(texts.flatMap((t) => [...t.matchAll(QUESTION_IN_TEXT_RE)].map((m) => `Q#${m[1]}`)));
  if (ids.size > 1) {
    throw new AnswerError(`the question names several ids (${[...ids].join(", ")}); ask the bot to fix it`);
  }
  return ids.values().next().value;
}

/**
 * Format an answer as posted in an issue or PR comment.
 *
 * Only the letter, the question id and his own text go in: option text
 * comes from the bot, and echoing it under his name would let a confused
 * bot put words in his mouth. Text lines that are bot commands are
 * refused (see BOT_COMMANDS).
 */
export function formatAnswer(answer: Answer): string {
  validate(answer);
  const head = [ANSWER_COMMAND, answer.choice, answer.question].filter(Boolean).join(" ");
  const text = cleanText(answer.text);
  return text ? `${head}\n${text}\n` : `${head}\n`;
}

/** Format a gist receipt: the answer plus its item trailer. */
export function formatReceipt(receipt: Receipt): string {
  if (!ITEM_ID_RE.test(receipt.item)) {
    throw new AnswerError(`invalid item id ${JSON.stringify(receipt.item)}`);
  }
  return `${formatAnswer(receipt)}\n${ITEM_TRAILER}: ${receipt.item}\n`;
}

/**
 * Parse an answer block, or return null if the text isn't one. Only a
 * first line that is exactly the command counts, so prose that mentions
 * /answer is not an answer. (Stricter than bot-pr's `/promote`, which
 * counts on any line; see BOT_COMMANDS.)
 */
export function parseAnswer(text: string): Answer | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const m = COMMAND_RE.exec(lines[0] ?? "");
  if (!m) return null;
  const rest = cleanText(lines.slice(1).join("\n"));
  const answer: Answer = { text: rest };
  if (m[1]) answer.choice = m[1];
  if (m[2]) answer.question = m[2];
  return answer;
}

/** Parse a gist receipt; its last non-empty line must be the item trailer. */
export function parseReceipt(text: string): Receipt | null {
  const lines = cleanText(text).split("\n");
  const last = lines.pop() ?? "";
  const m = TRAILER_RE.exec(last);
  if (!m || !ITEM_ID_RE.test(m[1] ?? "")) return null;
  const answer = parseAnswer(lines.join("\n"));
  if (!answer) return null;
  return { ...answer, item: m[1] as string };
}

/** An option the bot offered, e.g. from "Options: A) ... B) ...". */
export interface Option {
  letter: string;
  text: string;
  recommended: boolean;
}

// "A) text" either at the start of a line (markdown lists welcome) or
// inline after whitespace, as the bot writes them in the one-line Why
// field: "Q: ...? Options: A) foo B) bar. Recommend A because ...".
const OPTION_RE = /(?<=^|\s)(?:[-*][ \t]+)?\(?([A-Z])\)[ \t]+/gm;
const RECOMMEND_RE = /\b[Rr]ecommend(?:ed|s)?:?[ \t]+(?:option[ \t]+)?\(?([A-Z])\b/;
const OPTIONS_START_RE = /\bOptions:/;

/**
 * Extract lettered options from bot-written text. Options must be
 * consecutive letters starting at A; anything else is not a list of
 * options (e.g. "see (B) above") and yields none.
 */
export function parseOptions(text: string): Option[] {
  const start = OPTIONS_START_RE.exec(text);
  const scope = start ? text.slice(start.index + start[0].length) : text;
  const recommend = RECOMMEND_RE.exec(scope);
  const body = recommend ? scope.slice(0, recommend.index) : scope;
  const marks = [...body.matchAll(OPTION_RE)];
  const options: Option[] = [];
  for (const [i, m] of marks.entries()) {
    const letter = m[1] as string;
    if (letter !== String.fromCharCode("A".charCodeAt(0) + i)) return [];
    const from = (m.index ?? 0) + m[0].length;
    const to = marks[i + 1]?.index ?? body.length;
    const optionText = body.slice(from, to).trim().replace(/[.;,]$/, "").trim();
    if (!optionText) return [];
    options.push({ letter, text: optionText, recommended: recommend?.[1] === letter });
  }
  // A single "A)" is not a choice.
  return options.length >= 2 ? options : [];
}

/** The answer section of a draft body. */
export interface DraftSection {
  receipt: string;
  answer: Answer;
}

/** Escape anything in his text that could end or fake the section. */
function escapeSectionText(text: string): string {
  return text.replace(/<!--/g, "&lt;!--");
}

const SECTION_BEGIN_LINE_RE = /^<!-- review-answer BEGIN receipt=(\S+) -->$/;

type Bounds =
  | { kind: "none" }
  | { kind: "bad"; reason: string }
  | { kind: "ok"; begin: number; end: number; receipt: string; inner: string };

/**
 * Find the one answer section: a line that is exactly the begin marker,
 * then a later line that is exactly the end marker. Any other line
 * starting with the begin marker, or a second section, makes the body
 * ambiguous, and nothing is read or written.
 */
function sectionBounds(body: string): Bounds {
  const raw = body.split("\n");
  // Compare without a trailing CR, but measure offsets on the raw lines.
  const lines = raw.map((l) => l.replace(/\r$/, ""));
  const begins = lines.flatMap((l, i) => (l.startsWith(SECTION_BEGIN) ? [i] : []));
  if (begins.length === 0) return { kind: "none" };
  if (begins.length > 1) return { kind: "bad", reason: "the draft has more than one answer section" };
  const b = begins[0] as number;
  const m = SECTION_BEGIN_LINE_RE.exec(lines[b] ?? "");
  if (!m || !RECEIPT_RE.test(m[1] ?? "")) return { kind: "bad", reason: "the draft's answer section has a malformed begin line" };
  const e = lines.findIndex((l, i) => i > b && l === SECTION_END);
  if (e < 0) return { kind: "bad", reason: "the draft's answer section has no end line" };
  const offset = (i: number) => raw.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  return {
    kind: "ok",
    begin: offset(b),
    end: offset(e) + SECTION_END.length,
    receipt: m[1] as string,
    inner: lines.slice(b + 1, e).join("\n"),
  };
}

/**
 * Return the draft body with its answer section set to this answer and
 * receipt: replaced if there is one, otherwise appended. Everything
 * outside the section is kept byte for byte. Throws on an ambiguous or
 * malformed section rather than guess which text to replace.
 */
export function setDraftSection(body: string, answer: Answer, receiptUrl: string): string {
  if (!RECEIPT_RE.test(receiptUrl)) {
    throw new AnswerError(`not a gist URL: ${JSON.stringify(receiptUrl)}`);
  }
  const block = formatAnswer({ ...answer, text: escapeSectionText(answer.text) });
  const section = `${SECTION_BEGIN} receipt=${receiptUrl} -->\n${block}${SECTION_END}`;
  const bounds = sectionBounds(body);
  switch (bounds.kind) {
    case "ok":
      return body.slice(0, bounds.begin) + section + body.slice(bounds.end);
    case "bad":
      throw new AnswerError(`${bounds.reason}; fix the draft body by hand`);
    case "none": {
      const sep = body === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
      return `${body}${sep}${section}\n`;
    }
  }
}

/**
 * Read the answer section of a draft body, if it has exactly one
 * well-formed one. What it says is a claim: anyone who can edit the board
 * can write it. Only the receipt it points to can be verified.
 */
export function getDraftSection(body: string): DraftSection | null {
  const bounds = sectionBounds(body);
  if (bounds.kind !== "ok") return null;
  const answer = parseAnswer(bounds.inner);
  if (!answer) return null;
  return { receipt: bounds.receipt, answer };
}

/** The draft body without its answer section, for reading the question. */
export function withoutDraftSection(body: string): string {
  const bounds = sectionBounds(body);
  return bounds.kind === "ok" ? body.slice(0, bounds.begin) + body.slice(bounds.end) : body;
}
