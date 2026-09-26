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
// The first line always names the board item it blocks, by its URL: bare
// for a tracker issue, in a code span for an upstream one, so that the
// mention doesn't show on the upstream timeline:
//
//     Blocks: `https://github.com/example/widget/pull/42`
//
// `Q:`, `Options:` and `Recommended:` count only outside fenced code
// blocks, and `Options:` and `Recommended:` only after the `Q:` line. Each
// option is exactly one line, `A) text`, lettered from A without gaps,
// at least two; an option wrapped onto a second line, or a lone option,
// makes the list unreadable, and the app says so rather than guess.
// Options and the recommendation may be absent (an action, or an open
// question); when there is a recommendation, it is option A.
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
  /** Why an `Options:` list was there but couldn't be read. */
  optionsProblem?: string;
}

// The URL bare, or in a code span: a bare upstream URL in a public issue
// adds a "mentioned this" entry to the upstream timeline, so the bot
// writes those in backticks.
const BLOCKS_RE = /^Blocks:[ \t]*(`?)(https:\/\/[^\s`]+)\1[ \t]*$/;
const ASK_RE = /^Q:[ \t]*(.+)$/;
const OPTIONS_RE = /^Options:[ \t]*$/;
// "A) text", also as a markdown list item or with "(A)".
const OPTION_RE = /^(?:[-*][ \t]+)?\(?([A-Z])\)[ \t]+(.+)$/;
const RECOMMENDED_RE = /^Recommended:[ \t]*(\(?([A-Z])\b.*)$/;

// Stands in for a line inside a fenced code block: never blank, never
// matches anything, so it also ends an option list.
const FENCED = "\u0000";
const FENCE_RE = /^(```|~~~)/;

/** Trimmed lines, with fenced code blocks (fences included) blanked out. */
function unfencedLines(body: string): string[] {
  let fence: string | undefined;
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      const m = FENCE_RE.exec(line);
      if (fence !== undefined) {
        if (m?.[1] === fence) fence = undefined;
        return FENCED;
      }
      if (m) {
        fence = m[1];
        return FENCED;
      }
      return line;
    });
}

type ParsedOptions = { options: Option[]; problem?: string };

/**
 * Parse the options: one per line after a line `Options:`, blank lines
 * allowed between them, up to the first other line. They must be
 * consecutive letters from A, and at least two; anything else is not a
 * choice, and yields none with the reason.
 */
function parseOptions(lines: readonly string[], recommended: string | undefined): ParsedOptions {
  const start = lines.findIndex((l) => OPTIONS_RE.test(l));
  if (start < 0) return { options: [] };
  const options: Option[] = [];
  // The line that ended the list, when it came right after an option.
  let stop: string | undefined;
  let blank = false;
  for (const line of lines.slice(start + 1)) {
    if (line === "") {
      blank = true;
      continue;
    }
    const m = OPTION_RE.exec(line);
    if (!m) {
      if (!blank) stop = line;
      break;
    }
    blank = false;
    const letter = m[1] as string;
    const want = String.fromCharCode("A".charCodeAt(0) + options.length);
    if (letter !== want) return { options: [], problem: `option ${letter}) comes where ${want}) should` };
    options.push({ letter, text: (m[2] as string).trim(), recommended: letter === recommended });
  }
  if (options.length >= 2) {
    // A wrapped option reads as prose right under the last one; say so,
    // but keep the options, whose letters are still right.
    const wrapped = stop !== undefined && stop !== FENCED && !RECOMMENDED_RE.test(stop);
    return wrapped ? { options, problem: `the line after the options (${JSON.stringify(stop)}) may be a wrapped option` } : { options };
  }
  return { options: [], problem: options.length === 1 ? "it has only one option" : "no option follows it" };
}

/** Parse a question issue's body (see the format at the top). */
export function parseQuestion(body: string): Question {
  const lines = unfencedLines(body);
  const q: Question = { options: [] };
  const blocks = BLOCKS_RE.exec(lines[0] ?? "");
  if (blocks) q.blocks = blocks[2] as string;
  const askAt = lines.findIndex((l) => ASK_RE.test(l));
  if (askAt < 0) return q;
  q.ask = (ASK_RE.exec(lines[askAt] as string)?.[1] as string).trim();
  const after = lines.slice(askAt + 1);
  const rec = after.map((l) => RECOMMENDED_RE.exec(l)).find((m) => m);
  if (rec) q.recommendation = (rec[1] as string).trim();
  const parsed = parseOptions(after, rec?.[2]);
  q.options = parsed.options;
  if (parsed.problem) q.optionsProblem = `its Options: list doesn't read as one option per line: ${parsed.problem}`;
  return q;
}
