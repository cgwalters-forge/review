// The question and answer formats: what the bot writes, what the app
// writes as cgwalters, and what the bot parses back. Forge-neutral, and
// free of DOM and network code so that the bot-side parser can mirror it
// line for line.
//
// A question is an issue the bot opens in the tracker repository,
// labelled `question`. Its body:
//
//     Blocks: https://github.com/cgwalters-forge/tracker/issues/12
//     Context, any number of lines.
//     Q: Which prefix?
//     Options:
//     A) org.example
//     B) io.example
//     Recommended: A, because it is already registered
//
// The first line always names the board item it blocks. Options and the
// recommendation may be absent (an action, or an open question); when
// there is a recommendation, it is option A.
//
// He answers with a plain comment on that issue: GitHub records who wrote
// it, so nothing else vouches for it. A picked option is the comment's
// first line, exactly the letter, optionally followed by his own text:
//
//     B
//     Free markdown from him, any number of lines.
//
// Without a pick, the comment is only his text.

/**
 * Commands the bot acts on when they appear on a line of their own in
 * cgwalters' comments. bot-pr matches `/promote`, `/draft` and `/ready` on
 * any line, after trimming whitespace, so free text must never contain
 * one: an answer saying "ok\n/promote" would promote a fork PR.
 */
export const BOT_COMMANDS: readonly string[] = ["/promote", "/draft", "/ready"];

const CHOICE_RE = /^[A-Z]$/;
// A first line of free text that the bot could read as a pick.
const LETTER_LINE_RE = /^[A-Za-z]$/;

export interface Answer {
  /** The option letter, if he picked one. */
  choice?: string;
  /** His free text, trimmed; may be empty when a choice is given. */
  text: string;
}

export class AnswerError extends Error {
  override name = "AnswerError";
}

/** True if a line of text would read as a bot command. */
export function isCommandLine(line: string): boolean {
  const word = line.trim().split(/\s/, 1)[0] ?? "";
  return BOT_COMMANDS.includes(word);
}

/** Normalize line endings and trim, without touching inner lines. */
function cleanText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function validate(answer: Answer): void {
  if (answer.choice !== undefined && !CHOICE_RE.test(answer.choice)) {
    throw new AnswerError(`invalid choice ${JSON.stringify(answer.choice)}: expected one letter A-Z`);
  }
  const text = cleanText(answer.text);
  if (answer.choice === undefined && text === "") {
    throw new AnswerError("pick an option or write an answer");
  }
  const lines = text.split("\n");
  if (answer.choice === undefined && LETTER_LINE_RE.test(lines[0]?.trim() ?? "")) {
    throw new AnswerError(
      `your text starts with the line ${JSON.stringify(lines[0]?.trim())}, which reads as picking an option; pick it above, or reword`,
    );
  }
  const bad = lines.find(isCommandLine);
  if (bad !== undefined) {
    throw new AnswerError(
      `the line ${JSON.stringify(bad.trim())} would be read as a bot command; reword it (e.g. put it in backticks)`,
    );
  }
}

/**
 * Format an answer as the comment posted on the question issue.
 *
 * Only the letter and his own text go in: option text comes from the bot,
 * and echoing it under his name would let a confused bot put words in his
 * mouth. Text lines that are bot commands are refused (see BOT_COMMANDS),
 * and so is free text whose first line would read as a pick.
 */
export function formatAnswer(answer: Answer): string {
  validate(answer);
  const text = cleanText(answer.text);
  if (answer.choice === undefined) return `${text}\n`;
  return text ? `${answer.choice}\n${text}\n` : `${answer.choice}\n`;
}

/**
 * Read his comment on a question issue as an answer: a first line that is
 * one capital letter (surrounding whitespace aside) is a pick, and the
 * rest is his text. Every comment of his there is an answer.
 */
export function parseAnswer(comment: string): Answer {
  const lines = comment.replace(/\r\n?/g, "\n").split("\n");
  const first = lines[0]?.trim() ?? "";
  if (CHOICE_RE.test(first)) return { choice: first, text: cleanText(lines.slice(1).join("\n")) };
  return { text: cleanText(comment) };
}

/** An option the bot offered. */
export interface Option {
  letter: string;
  text: string;
  recommended: boolean;
}

/** A question issue's body, as far as the app reads it. */
export interface Question {
  /** The URL on the `Blocks:` first line, if there is one. */
  blocks?: string;
  /** The `Q:` line, without its prefix. */
  ask?: string;
  options: Option[];
  /** The `Recommended:` line, without its prefix, e.g. "A, because ...". */
  recommendation?: string;
}

const BLOCKS_RE = /^Blocks:[ \t]*(https:\/\/\S+)[ \t]*$/;
const ASK_RE = /^Q:[ \t]*(.+)$/;
const OPTIONS_RE = /^Options:[ \t]*$/;
// "A) text", also as a markdown list item or with "(A)".
const OPTION_RE = /^(?:[-*][ \t]+)?\(?([A-Z])\)[ \t]+(.+)$/;
const RECOMMENDED_RE = /^Recommended:[ \t]*(\(?([A-Z])\b.*)$/;

/**
 * Parse the options: one per line after a line `Options:`, blank lines
 * allowed between them, up to the first other line. They must be
 * consecutive letters from A, and at least two; anything else is not a
 * choice and yields none.
 */
function parseOptions(lines: readonly string[], recommended: string | undefined): Option[] {
  const start = lines.findIndex((l) => OPTIONS_RE.test(l));
  if (start < 0) return [];
  const options: Option[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") continue;
    const m = OPTION_RE.exec(line);
    if (!m) break;
    const letter = m[1] as string;
    if (letter !== String.fromCharCode("A".charCodeAt(0) + options.length)) return [];
    options.push({ letter, text: (m[2] as string).trim(), recommended: letter === recommended });
  }
  return options.length >= 2 ? options : [];
}

/** Parse a question issue's body (see the format at the top). */
export function parseQuestion(body: string): Question {
  const lines = body.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const q: Question = { options: [] };
  const blocks = BLOCKS_RE.exec(lines[0] ?? "");
  if (blocks) q.blocks = blocks[1] as string;
  const ask = lines.map((l) => ASK_RE.exec(l)).find((m) => m);
  if (ask) q.ask = (ask[1] as string).trim();
  const rec = lines.map((l) => RECOMMENDED_RE.exec(l)).find((m) => m);
  if (rec) q.recommendation = (rec[1] as string).trim();
  q.options = parseOptions(lines, rec?.[2]);
  return q;
}
