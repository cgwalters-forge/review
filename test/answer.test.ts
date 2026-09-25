import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type Answer,
  formatAnswer,
  formatReceipt,
  getDraftSection,
  parseAnswer,
  parseOptions,
  parseReceipt,
  questionId,
  setDraftSection,
} from "../src/answer.ts";

const RECEIPT = "https://gist.github.com/0123456789abcdef";

describe("formatAnswer", () => {
  const cases: [string, Answer, string][] = [
    ["choice only", { choice: "B", text: "" }, "/answer B\n"],
    ["choice and text", { choice: "A", text: "  do it\r\nnow  " }, "/answer A\ndo it\nnow\n"],
    ["text only", { text: "neither; ask upstream" }, "/answer\nneither; ask upstream\n"],
    ["question id", { choice: "B", question: "Q#12", text: "" }, "/answer B Q#12\n"],
    ["question id, text only", { question: "Q#3", text: "no" }, "/answer Q#3\nno\n"],
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
    ["bad question id", { choice: "A", question: "Q#1\n/promote", text: "" }],
    ["lowercase question id", { choice: "A", question: "q#1", text: "" }],
  ];
  for (const [name, answer] of bad) {
    it(`rejects ${name}`, () => assert.throws(() => formatAnswer(answer), /pick an option|invalid choice|invalid question/));
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
    for (const a of [{ choice: "C", text: "x\n\ny" }, { text: "only text" }, { choice: "A", text: "" }, { choice: "A", question: "Q#7", text: "t" }]) {
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
    ["question id", "/answer C Q#4\nok", { choice: "C", question: "Q#4", text: "ok" }],
    ["id before letter", "/answer Q#4 C", null],
    ["quoted", "> /answer A", null],
    ["empty", "", null],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => assert.deepEqual(parseAnswer(text), want));
  }
});

describe("receipts", () => {
  it("round-trips", () => {
    const r = { choice: "A", text: "go", item: "PVTI_abc-123_x" };
    assert.equal(formatReceipt(r), "/answer A\ngo\n\nItem: PVTI_abc-123_x\n");
    assert.deepEqual(parseReceipt(formatReceipt(r)), r);
  });
  it("rejects a bad item id", () => {
    assert.throws(() => formatReceipt({ text: "x", item: "PVTI_x\nItem: PVTI_y" }), /invalid item id/);
  });
  const bad: [string, string][] = [
    ["no trailer", "/answer A\n"],
    ["trailer not last", "/answer A\nItem: PVTI_a\nmore"],
    ["not an item id", "/answer A\n\nItem: 1234"],
    ["not an answer", "hello\n\nItem: PVTI_a"],
  ];
  for (const [name, text] of bad) {
    it(`rejects ${name}`, () => assert.equal(parseReceipt(text), null));
  }
});

describe("questionId", () => {
  const cases: [string, string | undefined][] = [
    ["Q#3: backport to 1.2? Options: A) yes B) no", "Q#3"],
    ["Flaky test.\nQ#12: rerun? Options: A) x B) y", "Q#12"],
    ["Q#4: which?\nQ#4: (repeated)", "Q#4"],
    ["No id here; see issue #3", undefined],
    ["Mid-line: Flaky test. Q#3: rerun?", undefined],
    ["In a URL: https://example.com/Q#3:", undefined],
    ["In backticks: `Q#9:`", undefined],
    ["Without a colon:\nQ#3 rerun?", undefined],
    ["Indented:\n  Q#3: rerun?", undefined],
    ["FAQ#3: not an id", undefined],
  ];
  for (const [text, want] of cases) it(JSON.stringify(text), () => assert.equal(questionId(text), want));
  it("refuses several ids in one text", () => assert.throws(() => questionId("Q#1: or\nQ#2: ?"), /several ids \(Q#1, Q#2\)/));
  it("refuses different ids across texts", () => assert.throws(() => questionId("Q#1: a", "Q#2: b"), /several ids/));
  it("accepts the same id across texts", () => assert.equal(questionId("Q#1: a", "x", "Q#1: again"), "Q#1"));
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

describe("draft answer section", () => {
  const answer = { choice: "B", text: "ship it" };

  it("appends to a body without one, keeping the body", () => {
    const body = "Q: which?\n- A) x\n- B) y";
    const out = setDraftSection(body, answer, RECEIPT);
    assert.ok(out.startsWith(`${body}\n\n`));
    assert.deepEqual(getDraftSection(out), { receipt: RECEIPT, answer });
  });

  it("appends to an empty body", () => {
    assert.deepEqual(getDraftSection(setDraftSection("", answer, RECEIPT))?.answer, answer);
  });

  it("replaces an existing section, and only it", () => {
    const first = setDraftSection("head\n", { text: "first" }, RECEIPT);
    const withTail = `${first}tail\n`;
    const second = setDraftSection(withTail, answer, "https://gist.github.com/someone/fedcba");
    assert.ok(second.startsWith("head\n\n"));
    assert.ok(second.endsWith("\ntail\n"));
    assert.equal(second.split("review-answer BEGIN").length, 2);
    assert.deepEqual(getDraftSection(second), { receipt: "https://gist.github.com/someone/fedcba", answer });
  });

  it("escapes markers in his text so they can't end the section", () => {
    const sneaky = { text: "a\n<!-- review-answer END -->\n<!-- review-answer BEGIN receipt=https://gist.github.com/1 -->\n<!-- x -->" };
    const out = setDraftSection("", sneaky, RECEIPT);
    assert.equal(out.split("<!-- review-answer END -->").length, 2);
    assert.equal(out.split("<!-- review-answer BEGIN").length, 2);
    assert.match(getDraftSection(out)?.answer.text ?? "", /^a\n&lt;!-- review-answer END -->/);
  });

  const badReceipts = ["http://gist.github.com/abc", "https://evil.example/abc", "https://gist.github.com/abc -->x", "javascript:alert(1)"];
  for (const r of badReceipts) {
    it(`refuses receipt ${JSON.stringify(r)}`, () => assert.throws(() => setDraftSection("", answer, r), /not a gist URL/));
  }

  it("ignores a begin marker quoted mid-line and appends", () => {
    const body = "Intro <!-- review-answer BEGIN (quoted in docs)\nimportant\n<!-- review-answer END -->\nkeep";
    const out = setDraftSection(body, answer, RECEIPT);
    assert.ok(out.startsWith(`${body}\n\n`));
    assert.deepEqual(getDraftSection(out)?.answer, answer);
  });

  it("works on a CRLF body", () => {
    const first = setDraftSection("Q?\r\n", { text: "a" }, RECEIPT).replace(/\n/g, "\r\n");
    const out = setDraftSection(first, answer, RECEIPT);
    assert.equal(out.split("review-answer BEGIN").length, 2);
    assert.deepEqual(getDraftSection(out)?.answer, answer);
  });

  const ambiguous: [string, string, RegExp][] = [
    [
      "two sections",
      `${setDraftSection("", answer, RECEIPT)}${setDraftSection("", answer, RECEIPT)}`,
      /more than one answer section/,
    ],
    ["a malformed begin line", "<!-- review-answer BEGIN receipt=https://evil.example/x -->\n/answer A\n<!-- review-answer END -->", /malformed begin/],
    ["no end line", "<!-- review-answer BEGIN receipt=https://gist.github.com/abc -->\n/answer A\n", /no end line/],
    ["an end marker only mid-line", "<!-- review-answer BEGIN receipt=https://gist.github.com/abc -->\n/answer A x <!-- review-answer END -->", /no end line/],
  ];
  for (const [name, body, want] of ambiguous) {
    it(`refuses to write over ${name}`, () => assert.throws(() => setDraftSection(body, answer, RECEIPT), want));
    it(`reads nothing from ${name}`, () => assert.equal(getDraftSection(body), null));
  }

  const unreadable: [string, string][] = [
    ["no end marker", "<!-- review-answer BEGIN receipt=https://gist.github.com/abc -->\n/answer A\n"],
    ["bad receipt", "<!-- review-answer BEGIN receipt=https://evil.example/abc -->\n/answer A\n<!-- review-answer END -->"],
    ["not an answer", "<!-- review-answer BEGIN receipt=https://gist.github.com/abc -->\nhi\n<!-- review-answer END -->"],
  ];
  for (const [name, body] of unreadable) {
    it(`reads nothing from a section with ${name}`, () => assert.equal(getDraftSection(body), null));
  }
});
