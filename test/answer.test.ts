import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Answer, formatAnswer, parseAnswer, parseOptions } from "../src/answer.ts";

describe("formatAnswer", () => {
  const cases: [string, Answer, string][] = [
    ["choice only", { choice: "B", text: "" }, "/answer B\n"],
    ["choice and text", { choice: "A", text: "  do it\r\nnow  " }, "/answer A\ndo it\nnow\n"],
    ["text only", { text: "neither; ask upstream" }, "/answer\nneither; ask upstream\n"],
    ["command mid-line is prose", { text: "don't /promote yet" }, "/answer\ndon't /promote yet\n"],
    ["command in backticks", { text: "`/promote`" }, "/answer\n`/promote`\n"],
  ];
  for (const [name, answer, want] of cases) {
    it(name, () => assert.equal(formatAnswer(answer), want));
  }

  const bad: [string, Answer][] = [
    ["empty", { text: "  \n " }],
    ["lowercase choice", { choice: "a", text: "" }],
    ["two letters", { choice: "AB", text: "" }],
    ["newline smuggled in the choice", { choice: "A\n/promote", text: "" }],
  ];
  for (const [name, answer] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => formatAnswer(answer), /pick an option|invalid choice/));
  }

  // bot-pr acts on /promote, /draft and /ready on any line of his
  // comments, trimmed; an answer must never carry one.
  const commandLines = [
    "ok\n/promote",
    "  /promote  ",
    "fine\r\n\t/draft",
    "/ready",
    "x\n/answer A",
    "x\n/promote please",
  ];
  for (const text of commandLines) {
    it(`refuses a command line in ${JSON.stringify(text)}`, () =>
      assert.throws(() => formatAnswer({ choice: "B", text }), /would be read as a bot command/),
    );
  }

  it("round-trips through parseAnswer", () => {
    for (const a of [{ choice: "C", text: "x\n\ny" }, { text: "only text" }, { choice: "A", text: "" }]) {
      assert.deepEqual(parseAnswer(formatAnswer(a)), a);
    }
  });
});

describe("parseAnswer", () => {
  const cases: [string, string, Answer | null][] = [
    ["plain", "/answer B\nbecause", { choice: "B", text: "because" }],
    ["trailing space", "/answer B  \n", { choice: "B", text: "" }],
    ["crlf", "/answer\r\nfree\r\ntext", { text: "free\ntext" }],
    ["not on the first line", "I think\n/answer B", null],
    ["prose mention", "/answering later", null],
    ["lowercase letter", "/answer b", null],
    ["two letters", "/answer AB", null],
    ["trailing words", "/answer C Q#4\nok", null],
    ["quoted", "> /answer A", null],
    ["empty", "", null],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => assert.deepEqual(parseAnswer(text), want));
  }
});



describe("parseOptions", () => {
  const cases: [string, string, [string, string, boolean][]][] = [
    [
      "bot Why convention",
      "Flaky test. Q: backport? Options: A) Backport to 1.2 B) Main only; C) Drop it. Recommend B because it's small",
      [
        ["A", "Backport to 1.2", false],
        ["B", "Main only", true],
        ["C", "Drop it", false],
      ],
    ],
    [
      "markdown list",
      "Which prefix?\n\n- A) org.example\n- B) io.example (recommended below)\n\nRecommended: A",
      [
        ["A", "org.example", true],
        ["B", "io.example (recommended below)", false],
      ],
    ],
    ["parenthesized letters", "Options: (A) yes (B) no", [["A", "yes", false], ["B", "no", false]]],
    ["no options", "Just a status update, no question.", []],
    ["single option is not a choice", "Options: A) only this", []],
    ["out of order", "Options: A) one C) three", []],
    ["not starting at A", "see (B) above and C) below", []],
    ["empty option", "Options: A) B) something", []],
  ];
  for (const [name, text, want] of cases) {
    it(name, () =>
      assert.deepEqual(
        parseOptions(text).map((o) => [o.letter, o.text, o.recommended]),
        want,
      ),
    );
  }
});
