import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commentNote, itemAction, parseAskBody, parsePrUrl, reviewAskFor, reviewComment } from "../src/github/asks.ts";
import { type Item, queueItems } from "../src/github/board.ts";
import { rawItems } from "./helpers.ts";

const SHA = "a".repeat(40);

function fixture(nodeId: string): Item {
  return queueItems(rawItems()).find((i) => i.nodeId === nodeId) as Item;
}

describe("parsePrUrl", () => {
  const prs: [string, boolean][] = [
    ["https://github.com/bootc-dev/bootc/pull/2500", true],
    ["https://github.com/o/r.x_y-z/pull/1", true],
    ["https://github.com/bootc-dev/bootc/pull/2500/files", false],
    ["https://github.com/bootc-dev/bootc/pull/2500#x", false],
    ["https://github.com/bootc-dev/bootc/issues/2500", false],
    ["https://github.com/o/../pull/1", false],
    ["https://github.com/o/./pull/1", false],
    ["https://github.com/o/r/pull/0", false],
    ["http://github.com/o/r/pull/1", false],
    ["https://github.example/o/r/pull/1", false],
  ];
  for (const [url, ok] of prs) it(`PR ${url}`, () => assert.equal(parsePrUrl(url) !== undefined, ok));
});

describe("parseAskBody", () => {
  const summary = (body: string) => {
    const b = parseAskBody(body);
    return {
      blocks: b.blocks,
      ask: b.ask,
      reviews: b.reviews.map((r) => `${r.ref.owner}/${r.ref.repo}#${r.ref.number}@${r.head.slice(0, 4)}`),
      problems: b.problems.length,
    };
  };
  const none = { blocks: undefined, ask: undefined, reviews: [], problems: 0 };
  const B = "Blocks: `https://github.com/bootc-dev/bootc/issues/2256`";
  const cases: [string, string, Partial<ReturnType<typeof summary>>][] = [
    [
      "a review, backticked",
      `${B}\nAsk: Re-approve at the new head\nReview: \`https://github.com/bootc-dev/bootc/pull/2500\` at ${SHA}`,
      { blocks: "https://github.com/bootc-dev/bootc/issues/2256", ask: "Re-approve at the new head", reviews: ["bootc-dev/bootc#2500@aaaa"] },
    ],
    ["a review, bare", `Review: https://github.com/o/r/pull/3 at ${SHA}`, { reviews: ["o/r#3@aaaa"] }],
    ["two reviews", `Review: https://github.com/o/r/pull/3 at ${SHA}\nReview: \`https://github.com/o/r/pull/4\` at ${"b".repeat(40)}`, { reviews: ["o/r#3@aaaa", "o/r#4@bbbb"] }],
    ["a short sha", "Review: `https://github.com/o/r/pull/3` at aec657dd", { problems: 1 }],
    ["an uppercase sha", `Review: \`https://github.com/o/r/pull/3\` at ${"A".repeat(40)}`, { problems: 1 }],
    ["no head", "Review: `https://github.com/o/r/pull/3`", { problems: 1 }],
    ["an issue URL", `Review: \`https://github.com/o/r/issues/3\` at ${SHA}`, { problems: 1 }],
    ["unbalanced backticks", `Review: \`https://github.com/o/r/pull/3 at ${SHA}`, { problems: 1 }],
    ["trailing words", `Review: \`https://github.com/o/r/pull/3\` at ${SHA} please`, { problems: 1 }],
    ["lines in a fenced block don't count", `Ask: x\n\`\`\`\nReview: https://github.com/o/r/pull/3 at ${SHA}\n\`\`\``, { ask: "x" }],
    ["only the first Ask: counts", "Ask: first\nAsk: second", { ask: "first" }],
    ["prose mentioning Review mid-line is nothing", `Ask: see the Review: https://github.com/o/r/pull/3 at ${SHA} line`, { ask: `see the Review: https://github.com/o/r/pull/3 at ${SHA} line` }],
  ];
  for (const [name, body, want] of cases) it(name, () => assert.deepEqual(summary(body), { ...none, ...want }));
});

describe("comments the app writes", () => {
  const pr = { owner: "bootc-dev", repo: "bootc", number: 2500 };
  it("says what it reviewed, with the head", () => {
    assert.equal(reviewComment("approve", pr, SHA, "https://r"), `Approved bootc-dev/bootc#2500 at ${SHA}: https://r\n`);
    assert.equal(reviewComment("request-changes", pr, SHA, "https://r"), `Requested changes on bootc-dev/bootc#2500 at ${SHA}: https://r\n`);
    assert.equal(reviewComment("comment", pr, SHA, "https://r"), undefined);
  });
});

describe("itemAction", () => {
  const cases: [string, Item, number, string][] = [
    ["an open question", fixture("PVTI_synthetic_question"), 0, "answer"],
    ["a review ask", fixture("PVTI_synthetic_review_ask"), 0, "review"],
    ["a chore", fixture("PVTI_synthetic_chore_ask"), 0, "comment"],
    ["a closed question", fixture("PVTI_synthetic_closed_question"), 0, "done"],
    ["an upstream item with open asks", fixture("PVTI_synthetic_upstream_issue"), 2, "asks"],
    ["an upstream item without", fixture("PVTI_synthetic_upstream_issue"), 0, "bug"],
    ["a Needs human tracker issue without asks", fixture("PVTI_synthetic_epic"), 0, "bug"],
    ["a Draft item", { ...fixture("PVTI_synthetic_draft"), status: "Draft" }, 0, "read"],
    ["an ask not assigned to him", { ...fixture("PVTI_synthetic_review_ask"), assignees: [] }, 0, "blocked"],
    ["an ask someone else opened", { ...fixture("PVTI_synthetic_chore_ask"), author: "someone" }, 0, "blocked"],
    ["a chore without runs", { ...fixture("PVTI_synthetic_chore_ask"), body: "Blocks: `https://github.com/o/r/issues/1`\nAsk: Log in and approve" }, 0, "comment"],
    ["a review with a bad line", { ...fixture("PVTI_synthetic_review_ask"), body: "Ask: x\nReview: `https://github.com/o/r/pull/1` at abc" }, 0, "comment"],
  ];
  for (const [name, item, open, want] of cases) it(name, () => assert.equal(itemAction(item, open).kind, want));

  it("says why a review fell back to a comment box", () => {
    const note = (item: Item) => {
      const a = itemAction(item, 0);
      return a.kind === "comment" ? commentNote(a) : `not a comment box: ${a.kind}`;
    };
    const review = fixture("PVTI_synthetic_review_ask");
    assert.match(note({ ...review, body: "Ask: x" }) ?? "", /names no PR to review/);
    assert.match(note({ ...review, body: "Ask: x\nReview: `https://github.com/o/r/pull/1` at abc" }) ?? "", /can't read "Review:/);
    assert.equal(note({ ...fixture("PVTI_synthetic_chore_ask"), body: "Ask: Log in and approve" }), undefined);
  });
});

describe("reviewAskFor", () => {
  const items = queueItems(rawItems());
  it("finds the open review ask naming a PR, in any case", () => {
    const found = reviewAskFor(items, { owner: "Example-Upstream", repo: "widget", number: 50 });
    assert.equal(found?.item.nodeId, "PVTI_synthetic_review_ask");
    assert.deepEqual(found?.ref, { owner: "cgwalters-forge", repo: "tracker", number: 24 });
    assert.equal(found?.target.head, SHA);
  });
  it("finds nothing for another PR, or an ask it can't act on", () => {
    assert.equal(reviewAskFor(items, { owner: "example-upstream", repo: "widget", number: 51 }), undefined);
    const unassigned = items.map((i) => (i.nodeId === "PVTI_synthetic_review_ask" ? { ...i, assignees: [] } : i));
    assert.equal(reviewAskFor(unassigned, { owner: "example-upstream", repo: "widget", number: 50 }), undefined);
    const closed = items.map((i) => (i.nodeId === "PVTI_synthetic_review_ask" ? { ...i, state: "closed" } : i));
    assert.equal(reviewAskFor(closed, { owner: "example-upstream", repo: "widget", number: 50 }), undefined);
  });
});
