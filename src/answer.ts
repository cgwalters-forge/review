// The answer format: what the app writes as cgwalters, and what the bot
// parses. Forge-neutral, and free of DOM and network code so that the
// bot-side parser can mirror it line for line.
//
// An answer is a block of text whose first line is the command:
//
//     /answer B
//     Free markdown from him, any number of lines.
//
// The letter is optional (free text only), as is the text (one tap only),
// but not both. The block is the whole comment, on an issue or PR.

/** The command line that starts an answer. */
export const ANSWER_COMMAND = "/answer";

/**
 * Commands the bot acts on when they appear on a line of their own in
 * cgwalters' comments. bot-pr matches `/promote`, `/draft` and `/ready` on
 * any line, after trimming whitespace, so free text must never contain
 * one: an answer saying "ok\n/promote" would promote a fork PR.
 */
export const BOT_COMMANDS: readonly string[] = [ANSWER_COMMAND, "/promote", "/draft", "/ready"];

const CHOICE_RE = /^[A-Z]$/;
const COMMAND_RE = /^\/answer(?:[ \t]+([A-Z]))?[ \t]*$/;

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

function validate(answer: Answer): void {
  if (answer.choice !== undefined && !CHOICE_RE.test(answer.choice)) {
    throw new AnswerError(`invalid choice ${JSON.stringify(answer.choice)}: expected one letter A-Z`);
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
 * Format an answer as posted in an issue or PR comment.
 *
 * Only the letter and his own text go in: option text
 * comes from the bot, and echoing it under his name would let a confused
 * bot put words in his mouth. Text lines that are bot commands are
 * refused (see BOT_COMMANDS).
 */
export function formatAnswer(answer: Answer): string {
  validate(answer);
  const head = answer.choice ? `${ANSWER_COMMAND} ${answer.choice}` : ANSWER_COMMAND;
  const text = cleanText(answer.text);
  return text ? `${head}\n${text}\n` : `${head}\n`;
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
  return answer;
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
