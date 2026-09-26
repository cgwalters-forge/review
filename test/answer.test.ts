import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Answer, formatAnswer, parseAnswer, parseQuestion, type Question } from "../src/answer.ts";

describe("formatAnswer", () => {
  const cases: [string, Answer, string][] = [
    ["choice only", { choice: "B", text: "" }, "B\n"],
    ["choice and text", { choice: "A", text: "  do it\r\nnow  " }, "A\ndo it\nnow\n"],
    ["text only", { text: "neither; ask upstream" }, "neither; ask upstream\n"],
    ["a letter later in free text", { text: "not sure\nB" }, "not sure\nB\n"],
    ["command mid-line is prose", { text: "don't /promote yet" }, "don't /promote yet\n"],
    ["command in backticks", { text: "`/promote`" }, "`/promote`\n"],
    ["/answer is no longer a command", { choice: "A", text: "/answer B" }, "A\n/answer B\n"],
  ];
  for (const [name, answer, want] of cases) {
    it(name, () => assert.equal(formatAnswer(answer), want));
  }

  const bad: [string, Answer, RegExp][] = [
    ["empty", { text: "  \n " }, /pick an option/],
    ["lowercase choice", { choice: "a", text: "" }, /invalid choice/],
    ["two letters", { choice: "AB", text: "" }, /invalid choice/],
    ["newline smuggled in the choice", { choice: "A\n/promote", text: "" }, /invalid choice/],
    ["free text that reads as a pick", { text: "B\nor maybe not" }, /reads as picking an option/],
    ["a lowercase letter line", { text: " c " }, /reads as picking an option/],
  ];
  for (const [name, answer, want] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => formatAnswer(answer), want));
  }

  // bot-pr acts on /promote, /draft and /ready on any line of his
  // comments, trimmed; an answer must never carry one.
  const commandLines = ["ok\n/promote", "  /promote  ", "fine\r\n\t/draft", "/ready", "ok\n/promote please"];
  for (const text of commandLines) {
    for (const choice of [undefined, "B"]) {
      it(`refuses a command line in ${JSON.stringify(text)}${choice ? " with a pick" : ""}`, () =>
        assert.throws(() => formatAnswer(choice ? { choice, text } : { text }), /would be read as a bot command/),
      );
    }
  }

  it("round-trips through parseAnswer", () => {
    for (const a of [{ choice: "C", text: "x\n\ny" }, { text: "only text" }, { choice: "A", text: "" }, { text: "Bee\nline" }]) {
      assert.deepEqual(parseAnswer(formatAnswer(a)), a);
    }
  });
});

describe("parseAnswer", () => {
  const cases: [string, string, Answer][] = [
    ["a pick and text", "B\nbecause", { choice: "B", text: "because" }],
    ["a pick with spaces", " B  \n", { choice: "B", text: "" }],
    ["crlf", "A\r\nfree\r\ntext", { choice: "A", text: "free\ntext" }],
    ["free text", "I think B", { text: "I think B" }],
    ["a letter not first", "hmm\nB", { text: "hmm\nB" }],
    ["lowercase is text", "b", { text: "b" }],
    ["two letters is text", "AB", { text: "AB" }],
    ["punctuated is text", "B.", { text: "B." }],
    ["empty", "", { text: "" }],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => assert.deepEqual(parseAnswer(text), want));
  }
});

describe("parseQuestion", () => {
  const summary = (q: Question) => ({
    blocks: q.blocks,
    ask: q.ask,
    options: q.options.map((o) => `${o.letter}:${o.text}${o.recommended ? "*" : ""}`),
    recommendation: q.recommendation,
    problem: q.optionsProblem,
  });
  type Want = Partial<ReturnType<typeof summary>>;
  const none = { blocks: undefined, ask: undefined, options: [], recommendation: undefined, problem: undefined };
  const B = "Blocks: https://github.com/o/r/issues/1";
  const full = [
    "Blocks: https://github.com/cgwalters-forge/tracker/issues/12",
    "The stable format needs a name.",
    "",
    "Q: Which prefix?",
    "Options:",
    "A) org.example",
    "B) io.example (see below)",
    "Recommended: A, because it is registered",
  ].join("\n");
  const cases: [string, string, Want][] = [
    [
      "the full format, recommendation first",
      full,
      {
        blocks: "https://github.com/cgwalters-forge/tracker/issues/12",
        ask: "Which prefix?",
        options: ["A:org.example*", "B:io.example (see below)"],
        recommendation: "A, because it is registered",
      },
    ],
    [
      "CRLF, list items, blank lines between options",
      "Blocks: https://github.com/o/r/pull/3\r\nQ: go?\r\nOptions:\r\n\r\n- A) yes\r\n\r\n- (B) no\r\nC) third\r\n",
      { blocks: "https://github.com/o/r/pull/3", ask: "go?", options: ["A:yes", "B:no", "C:third"] },
    ],
    ["a paragraph after the options", `${B}\nQ: x?\nOptions:\nA) one\nB) two\n\nMore context.`, { blocks: `https://github.com/o/r/issues/1`, ask: "x?", options: ["A:one", "B:two"] }],
    [
      "a wrapped option keeps the options, with a note",
      `${B}\nQ: x?\nOptions:\nA) one\nB) two, which goes on\nand on\nRecommended: A`,
      {
        blocks: "https://github.com/o/r/issues/1",
        ask: "x?",
        options: ["A:one*", "B:two, which goes on"],
        recommendation: "A",
        problem: `its Options: list doesn't read as one option per line: the line after the options ("and on") may be a wrapped option`,
      },
    ],
    ["an action, no options", `${B}\nQ: Please approve the key.`, { blocks: "https://github.com/o/r/issues/1", ask: "Please approve the key." }],
    ["Blocks only on the first line", "Context first\nBlocks: https://github.com/o/r/issues/1\nQ: x?", { ask: "x?" }],
    ["a non-https Blocks", "Blocks: javascript:alert(1)\nQ: x?", { ask: "x?" }],
    ["an upstream Blocks in backticks", "Blocks: `https://github.com/o/r/pull/7`\nQ: x?", { blocks: "https://github.com/o/r/pull/7", ask: "x?" }],
    ["unbalanced backticks", "Blocks: `https://github.com/o/r/pull/7\nQ: x?", { ask: "x?" }],
    ["a non-https Blocks in backticks", "Blocks: `javascript:alert(1)`\nQ: x?", { ask: "x?" }],
    ["inline options are not options", "Q: go? Options: A) yes B) no", { ask: "go? Options: A) yes B) no" }],
    ["options before the Q: line don't count", "Options:\nA) x\nB) y\nQ: which?", { ask: "which?" }],
    ["no Q: line, no options", "Options:\nA) x\nB) y", {}],
    [
      "fenced blocks are skipped",
      [B, "```", "Q: not this", "Options:", "A) fake", "B) fake", "```", "Q: real?", "~~~", "Options:", "A) fake", "B) fake", "~~~", "Options:", "A) yes", "B) no"].join("\n"),
      { blocks: "https://github.com/o/r/issues/1", ask: "real?", options: ["A:yes", "B:no"] },
    ],
    [
      "a fence closes only on the same character, as long or longer, with nothing after it",
      [
        "Q: real?",
        "````md",
        "```",
        "Options:",
        "A) fake",
        "B) fake",
        "~~~~",
        "```` not a close",
        "````",
        "~~~",
        "Options:",
        "A) fake",
        "B) fake",
        "```",
        "~~~~~",
        "Options:",
        "A) yes",
        "B) no",
      ].join("\n"),
      { ask: "real?", options: ["A:yes", "B:no"] },
    ],
    [
      "an unterminated fence swallows the rest",
      `Q: x?\n\`\`\`\nOptions:\nA) fake\nB) fake`,
      { ask: "x?" },
    ],
    ["a single option is not a choice", "Q: x?\nOptions:\nA) only this", { ask: "x?", problem: "its Options: list doesn't read as one option per line: it has only one option" }],
    ["an empty list", "Q: x?\nOptions:\nSee above.", { ask: "x?", problem: "its Options: list doesn't read as one option per line: no option follows it" }],
    ["out of order", "Q: x?\nOptions:\nA) one\nC) three", { ask: "x?", problem: "its Options: list doesn't read as one option per line: option C) comes where B) should" }],
    ["not starting at A", "Q: x?\nOptions:\nB) two\nC) three", { ask: "x?", problem: "its Options: list doesn't read as one option per line: option B) comes where A) should" }],
    ["a recommendation naming B marks B", "Q: x?\nOptions:\nA) one\nB) two\nRecommended: B", { ask: "x?", options: ["A:one", "B:two*"], recommendation: "B" }],
  ];
  for (const [name, body, want] of cases) {
    it(name, () => assert.deepEqual(summary(parseQuestion(body)), { ...none, ...want }));
  }
});
