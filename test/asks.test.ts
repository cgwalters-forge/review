import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commentNote,
  itemAction,
  parseAskBody,
  parsePrUrl,
  parseRunUrl,
  type RawJob,
  type RawRun,
  rerunComment,
  rerunProblem,
  reviewAskFor,
  reviewComment,
} from "../src/github/asks.ts";
import { type Item, queueItems } from "../src/github/board.ts";
import { rawItems } from "./helpers.ts";

const SHA = "a".repeat(40);
const RUN = "https://github.com/example-upstream/widget/actions/runs/777";

function fixture(nodeId: string): Item {
  return queueItems(rawItems()).find((i) => i.nodeId === nodeId) as Item;
}

describe("parsePrUrl and parseRunUrl", () => {
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

  const runs: [string, ReturnType<typeof parseRunUrl>][] = [
    [RUN, { url: RUN, owner: "example-upstream", repo: "widget", id: "777" }],
    [`${RUN}/`, undefined],
    [`${RUN}/job/123`, undefined],
    [`${RUN}/attempts/2`, undefined],
    [`${RUN}?pr=1`, undefined],
    [`${RUN}#summary`, undefined],
    ["https://github.com/o/../actions/runs/1", undefined],
    ["https://github.com/o/r/actions/runs/0", undefined],
    ["https://github.com/o/r/actions/runs/123456789012345678901", undefined],
    ["https://github.com/o/r/actions/workflows/ci.yml", undefined],
    ["https://api.github.com/repos/o/r/actions/runs/1", undefined],
    ["https://github.com/-o/r/actions/runs/1", undefined],
  ];
  for (const [url, want] of runs) it(`run ${url}`, () => assert.deepEqual(parseRunUrl(url), want));
});

describe("parseAskBody", () => {
  const summary = (body: string) => {
    const b = parseAskBody(body);
    return {
      blocks: b.blocks,
      ask: b.ask,
      reviews: b.reviews.map((r) => `${r.ref.owner}/${r.ref.repo}#${r.ref.number}@${r.head.slice(0, 4)}`),
      reruns: b.reruns.map((r) => r.id),
      problems: b.problems.length,
    };
  };
  const none = { blocks: undefined, ask: undefined, reviews: [], reruns: [], problems: 0 };
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
    [
      "reruns, deduplicated",
      `${B}\nAsk: Rerun the UKI legs\nRerun: \`${RUN}\`\nRerun: ${RUN}\nRerun: \`https://github.com/o/r/actions/runs/5\``,
      { blocks: "https://github.com/bootc-dev/bootc/issues/2256", ask: "Rerun the UKI legs", reruns: ["777", "5"] },
    ],
    ["a job URL", `Rerun: \`${RUN}/job/1\``, { problems: 1 }],
    ["an attempt URL", `Rerun: \`${RUN}/attempts/2\``, { problems: 1 }],
    ["lines in a fenced block don't count", `Ask: x\n\`\`\`\nRerun: \`${RUN}\`\nReview: https://github.com/o/r/pull/3 at ${SHA}\n\`\`\``, { ask: "x" }],
    ["only the first Ask: counts", "Ask: first\nAsk: second", { ask: "first" }],
    ["prose mentioning Rerun mid-line is nothing", `Ask: see the Rerun: ${RUN} line`, { ask: `see the Rerun: ${RUN} line` }],
  ];
  for (const [name, body, want] of cases) it(name, () => assert.deepEqual(summary(body), { ...none, ...want }));
});

describe("rerunProblem", () => {
  const run = parseRunUrl(RUN) as NonNullable<ReturnType<typeof parseRunUrl>>;
  const raw: RawRun = { id: 777, html_url: RUN, status: "completed", conclusion: "failure", repository: { full_name: "example-upstream/widget" } };
  const failed: RawJob[] = [
    { name: "build", status: "completed", conclusion: "success" },
    { name: "uki (x86_64)", status: "completed", conclusion: "failure" },
  ];
  const cases: [string, RawRun, RawJob[], RegExp | undefined][] = [
    ["a failed run", raw, failed, undefined],
    ["a cancelled run with a cancelled job", { ...raw, conclusion: "cancelled" }, [{ status: "completed", conclusion: "cancelled" }], undefined],
    ["a running run", { ...raw, status: "in_progress", conclusion: null }, failed, /is in_progress, not completed/],
    ["a queued run", { ...raw, status: "queued", conclusion: null }, failed, /is queued/],
    ["a successful run", { ...raw, conclusion: "success" }, failed, /ended success; only a failed run/],
    ["a skipped run", { ...raw, conclusion: "skipped" }, failed, /ended skipped/],
    ["no failed jobs", raw, [{ status: "completed", conclusion: "success" }], /no failed jobs/],
    ["a failed job still running", raw, [{ status: "in_progress", conclusion: "failure" }], /no failed jobs/],
    ["another run's URL", { ...raw, html_url: "https://github.com/example-upstream/widget/actions/runs/778" }, failed, /different run/],
    ["another run's id", { ...raw, id: 778 }, failed, /different run/],
    ["another repository", { ...raw, repository: { full_name: "evil/widget" } }, failed, /not in example-upstream\/widget/],
    ["no repository", { ...raw, repository: null }, failed, /not in example-upstream\/widget/],
  ];
  for (const [name, r, jobs, want] of cases) {
    it(name, () => {
      const got = rerunProblem(run, r, jobs);
      if (want) assert.match(got ?? "", want);
      else assert.equal(got, undefined);
    });
  }
});

describe("comments the app writes", () => {
  const pr = { owner: "bootc-dev", repo: "bootc", number: 2500 };
  it("says what it reviewed, with the head", () => {
    const url = "https://github.com/bootc-dev/bootc/pull/2500#pullrequestreview-1";
    assert.equal(reviewComment("approve", pr, SHA, url), `Approved \`bootc-dev/bootc#2500\` at \`${SHA}\`: \`${url}\`\n`);
    assert.equal(reviewComment("request-changes", pr, SHA, url), `Requested changes on \`bootc-dev/bootc#2500\` at \`${SHA}\`: \`${url}\`\n`);
    // Nothing that would mention the upstream PR is outside a code span.
    const outside = (reviewComment("approve", pr, SHA, url) ?? "").split("`").filter((_, i) => i % 2 === 0).join("");
    assert.doesNotMatch(outside, /#\d|https?:/);
    assert.equal(reviewComment("comment", pr, SHA, "https://r"), undefined);
  });
  it("says which run it reran", () => {
    assert.equal(rerunComment(parseRunUrl(RUN) as NonNullable<ReturnType<typeof parseRunUrl>>), `Reran the failed jobs of ${RUN}\n`);
  });
});

describe("itemAction", () => {
  const cases: [string, Item, number, string][] = [
    ["an open question", fixture("PVTI_synthetic_question"), 0, "answer"],
    ["a review ask", fixture("PVTI_synthetic_review_ask"), 0, "review"],
    ["a rerun chore", fixture("PVTI_synthetic_chore_ask"), 0, "rerun"],
    ["a closed question", fixture("PVTI_synthetic_closed_question"), 0, "done"],
    ["an upstream item with open asks", fixture("PVTI_synthetic_upstream_issue"), 2, "asks"],
    ["an upstream item without", fixture("PVTI_synthetic_upstream_issue"), 0, "bug"],
    ["a Needs human tracker issue without asks", fixture("PVTI_synthetic_epic"), 0, "bug"],
    ["a Draft item", { ...fixture("PVTI_synthetic_draft"), status: "Draft" }, 0, "read"],
    ["an ask not assigned to him", { ...fixture("PVTI_synthetic_review_ask"), assignees: [] }, 0, "blocked"],
    ["an ask someone else opened", { ...fixture("PVTI_synthetic_chore_ask"), author: "someone" }, 0, "blocked"],
    ["a chore without runs", { ...fixture("PVTI_synthetic_chore_ask"), body: "Blocks: `https://github.com/o/r/issues/1`\nAsk: Log in and approve" }, 0, "comment"],
    ["a review with a bad line", { ...fixture("PVTI_synthetic_review_ask"), body: "Ask: x\nReview: `https://github.com/o/r/pull/1` at abc" }, 0, "comment"],
    ["a chore with a bad Rerun: line besides a good one", { ...fixture("PVTI_synthetic_chore_ask"), body: `Ask: x\nRerun: \`${RUN}\`\nRerun: \`${RUN}/job/1\`` }, 0, "comment"],
    ["a review ask with a Rerun: line", { ...fixture("PVTI_synthetic_review_ask"), body: `Ask: x\nReview: https://github.com/o/r/pull/1 at ${SHA}\nRerun: ${RUN}` }, 0, "comment"],
  ];
  for (const [name, item, open, want] of cases) it(name, () => assert.equal(itemAction(item, open).kind, want));

  it("says why a review or rerun fell back to a comment box", () => {
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
