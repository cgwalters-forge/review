import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReceipt } from "../src/answer.ts";
import { checkReceipt, type RawReceiptGist } from "../src/github/receipt.ts";

const ITEM = "PVTI_synthetic_draft";
const OPERATOR = "cgwalters";

function gist(over: Partial<RawReceiptGist> = {}, content = formatReceipt({ choice: "B", question: "Q#3", text: "go", item: ITEM })): RawReceiptGist {
  return {
    html_url: "https://gist.github.com/cgwalters/abc",
    owner: { login: OPERATOR },
    history: [{ user: { login: OPERATOR } }],
    files: { "answer.md": { filename: "answer.md", truncated: false, content } },
    ...over,
  };
}

describe("checkReceipt", () => {
  it("accepts his untouched receipt for this item and question", () => {
    assert.deepEqual(checkReceipt(gist(), ITEM, OPERATOR, "Q#3"), {
      ok: true,
      receipt: { choice: "B", question: "Q#3", text: "go", item: ITEM },
    });
  });

  it("accepts an answer without an id to a question without one", () => {
    assert.equal(checkReceipt(gist({}, formatReceipt({ choice: "B", text: "", item: ITEM })), ITEM, OPERATOR, undefined).ok, true);
  });

  const bad: [string, RawReceiptGist, string | undefined, RegExp][] = [
    ["someone else's gist", gist({ owner: { login: "cgwalters-bot" } }), "Q#3", /belongs to cgwalters-bot/],
    ["no owner", gist({ owner: null }), "Q#3", /belongs to nobody/],
    ["a fork", gist({ fork_of: { id: "x" } }), "Q#3", /fork/],
    ["an edited gist", gist({ history: [{ user: { login: OPERATOR } }, { user: { login: OPERATOR } }] }), "Q#3", /2 revisions/],
    ["a revision by someone else", gist({ history: [{ user: { login: "mallory" } }] }), "Q#3", /revision is not by/],
    ["no history", gist({ history: [] }), "Q#3", /0 revisions/],
    [
      "an extra file",
      gist({ files: { ...gist().files, "x.md": { filename: "x.md", content: "" } } }),
      "Q#3",
      /exactly answer\.md/,
    ],
    ["a differently named file", gist({ files: { "a.md": { filename: "a.md", content: "" } } }), "Q#3", /exactly answer\.md/],
    ["truncated content", gist({ files: { "answer.md": { truncated: true, content: "" } } }), "Q#3", /truncated/],
    ["not an answer", gist({}, "hello\n\nItem: PVTI_synthetic_draft\n"), "Q#3", /not an answer/],
    ["another item", gist({}, formatReceipt({ choice: "B", question: "Q#3", text: "", item: "PVTI_other" })), "Q#3", /another item \(PVTI_other\)/],
    ["an older question", gist(), "Q#4", /answers Q#3, not Q#4/],
    ["no question id", gist({}, formatReceipt({ choice: "B", text: "", item: ITEM })), "Q#4", /without an id, not Q#4/],
    ["an id when the question has none", gist(), undefined, /answers Q#3, but the question has no id/],
  ];
  for (const [name, g, question, want] of bad) {
    it(`rejects ${name}`, () => {
      const r = checkReceipt(g, ITEM, OPERATOR, question);
      assert.equal(r.ok, false);
      assert.match(r.ok ? "" : r.reason, want);
    });
  }
});
