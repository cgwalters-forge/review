import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ciChecks,
  hasPromoteLine,
  ciSummary,
  composeReview,
  parseBotMeta,
  parsePatch,
  parseSearchPr,
  type RawIssueComment,
  type RawReview,
  reviewVerdict,
  waitsOnReviewer,
  withoutBotMeta,
} from "../src/github/forge.ts";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

describe("parseSearchPr", () => {
  it("parses a PR result", () => {
    const pr = parseSearchPr({
      html_url: "https://github.com/cgwalters-forge/bootc/pull/30",
      title: " tests: Cover it ",
      body: null,
      user: { login: "cgwalters-bot" },
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
      draft: true,
      pull_request: {},
    });
    assert.deepEqual(pr, {
      ref: { owner: "cgwalters-forge", repo: "bootc", number: 30 },
      url: "https://github.com/cgwalters-forge/bootc/pull/30",
      title: "tests: Cover it",
      body: "",
      author: "cgwalters-bot",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      draft: true,
    });
  });
  const rejects: [string, Parameters<typeof parseSearchPr>[0]][] = [
    ["an issue", { html_url: "https://github.com/o/r/issues/1" }],
    ["no pull_request", { html_url: "https://github.com/o/r/pull/1" }],
    ["another host", { html_url: "https://evil.example/o/r/pull/1", pull_request: {} }],
  ];
  for (const [name, raw] of rejects) it(`skips ${name}`, () => assert.equal(parseSearchPr(raw), undefined));
});

describe("parseBotMeta and withoutBotMeta", () => {
  const body = [
    "The change.",
    "",
    "Generated-by: x",
    "",
    "<!-- bot-meta -->",
    "---",
    "- Upstream: `bootc-dev/bootc`, base `main`",
    "- Board item: `PVTI_lAHOAQ_SPs4Bj2Gizg8vse8`",
    "<!-- /bot-meta -->",
  ].join("\r\n");
  it("reads the upstream, base and item", () => {
    assert.deepEqual(parseBotMeta(body), { upstream: "bootc-dev/bootc", base: "main", item: "PVTI_lAHOAQ_SPs4Bj2Gizg8vse8" });
  });
  it("ignores the same lines outside the section", () => {
    assert.deepEqual(parseBotMeta("- Upstream: `evil/x`, base `main`\n- Board item: `PVTI_x`"), {});
  });
  it("strips the section", () => {
    assert.equal(withoutBotMeta(body), "The change.\r\n\r\nGenerated-by: x");
    assert.equal(withoutBotMeta("no meta\n"), "no meta\n");
  });
});

describe("reviewVerdict", () => {
  const r = (login: string, state: string, commit: string, at: string): RawReview => ({
    user: { login },
    state,
    commit_id: commit,
    submitted_at: at,
    html_url: `https://github.com/r/${at}`,
  });
  const cases: [string, RawReview[], string, boolean][] = [
    ["no reviews", [], "none", true],
    ["approved the head", [r("cgwalters", "APPROVED", HEAD, "2026-01-02")], "approved", false],
    ["approved an older head", [r("cgwalters", "APPROVED", OLD, "2026-01-02")], "approved-older", true],
    ["changes on the head", [r("cgwalters", "CHANGES_REQUESTED", HEAD, "2026-01-02")], "changes-requested", false],
    ["changes, then a push", [r("cgwalters", "CHANGES_REQUESTED", OLD, "2026-01-02")], "changes-requested-older", true],
    ["someone else's approval", [r("someone", "APPROVED", HEAD, "2026-01-02")], "none", true],
    ["comments don't decide", [r("cgwalters", "APPROVED", HEAD, "2026-01-01"), r("cgwalters", "COMMENTED", HEAD, "2026-01-03")], "approved", false],
    ["the latest decides", [r("cgwalters", "APPROVED", HEAD, "2026-01-03"), r("cgwalters", "CHANGES_REQUESTED", HEAD, "2026-01-02")], "approved", false],
    ["dismissed", [r("cgwalters", "APPROVED", HEAD, "2026-01-01"), r("cgwalters", "DISMISSED", HEAD, "2026-01-02")], "none", true],
  ];
  for (const [name, reviews, state, waits] of cases) {
    it(name, () => {
      const v = reviewVerdict(reviews, HEAD, "cgwalters");
      assert.equal(v.state, state);
      assert.equal(waitsOnReviewer(v), waits);
    });
  }

  it("ignores undated reviews and keeps API order on ties", () => {
    const undated = { ...r("cgwalters", "APPROVED", HEAD, "x"), submitted_at: null };
    assert.equal(reviewVerdict([undated], HEAD, "cgwalters").state, "none");
    const tie = [r("cgwalters", "APPROVED", HEAD, "2026-01-02T00:00:00Z"), r("cgwalters", "CHANGES_REQUESTED", HEAD, "2026-01-02T00:00:00Z")];
    assert.equal(reviewVerdict(tie, HEAD, "cgwalters").state, "changes-requested");
  });

  describe("with /promote comments, as bot-pr counts them", () => {
    const c = (login: string, body: string, at: string): RawIssueComment => ({ user: { login }, body, created_at: at, html_url: `https://github.com/c/${at}` });
    const cases: [string, RawReview[], RawIssueComment[], string, boolean][] = [
      ["a /promote comment", [], [c("cgwalters", "looks good\n  /promote\t", "2026-01-02T00:00:00Z")], "promoted", true],
      ["/promote --human-text", [], [c("cgwalters", "/promote --human-text", "2026-01-02T00:00:00Z")], "promoted", true],
      ["a later approval wins", [r("cgwalters", "APPROVED", HEAD, "2026-01-03T00:00:00Z")], [c("cgwalters", "/promote", "2026-01-02T00:00:00Z")], "approved", false],
      ["a later /promote wins", [r("cgwalters", "APPROVED", HEAD, "2026-01-01T00:00:00Z")], [c("cgwalters", "/promote", "2026-01-02T00:00:00Z")], "promoted", true],
      ["someone else's /promote", [], [c("someone", "/promote", "2026-01-02T00:00:00Z")], "none", true],
      ["/promote in prose", [], [c("cgwalters", "I'll /promote it later", "2026-01-02T00:00:00Z")], "none", true],
    ];
    for (const [name, reviews, comments, state, waits] of cases) {
      it(name, () => {
        const v = reviewVerdict(reviews, HEAD, "cgwalters", comments);
        assert.equal(v.state, state);
        assert.equal(waitsOnReviewer(v), waits);
      });
    }
  });
});

describe("hasPromoteLine", () => {
  const cases: [string, boolean][] = [
    ["/promote", true],
    ["ok\r\n /promote \r\n", true],
    ["/promote --human-text", true],
    ["/promote now", false],
    ["`/promote`", false],
    ["\u00a0/promote", false],
  ];
  for (const [body, want] of cases) it(JSON.stringify(body), () => assert.equal(hasPromoteLine(body), want));
});

describe("parsePatch", () => {
  it("numbers lines per side", () => {
    const lines = parsePatch("@@ -10,3 +10,4 @@ fn x() {\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n");
    assert.deepEqual(
      lines.map((l) => [l.kind, l.old ?? null, l.new ?? null, l.text]),
      [
        ["hunk", null, null, "@@ -10,3 +10,4 @@ fn x() {"],
        ["ctx", 10, 10, "a"],
        ["del", 11, null, "b"],
        ["add", null, 11, "c"],
        ["add", null, 12, "d"],
        ["ctx", 12, 13, "e"],
        ["note", null, null, "\\ No newline at end of file"],
      ],
    );
  });
  it("handles a new file and an empty patch", () => {
    assert.deepEqual(parsePatch("@@ -0,0 +1 @@\n+only").map((l) => [l.kind, l.new ?? null]), [["hunk", null], ["add", 1]]);
    assert.deepEqual(parsePatch(""), []);
  });
});

describe("ciChecks and ciSummary", () => {
  it("merges runs and statuses, failures first", () => {
    const checks = ciChecks(
      [
        { name: "build", status: "completed", conclusion: "success", html_url: "https://x/1" },
        { name: "lint", status: "completed", conclusion: "skipped" },
        { name: "tests", status: "in_progress", conclusion: null },
        { name: "vm", status: "completed", conclusion: "timed_out" },
      ],
      [{ context: "DCO", state: "error", target_url: null }],
    );
    assert.deepEqual(checks.map((c) => [c.name, c.state, c.detail]), [
      ["DCO", "failure", "error"],
      ["vm", "failure", "timed_out"],
      ["tests", "pending", "in_progress"],
      ["build", "success", "success"],
      ["lint", "success", "skipped"],
    ]);
    assert.equal(checks.find((c) => c.name === "build")?.url, "https://x/1");
    assert.equal(ciSummary(checks), "failure");
  });
  const summaries: [string[], string][] = [[[], "none"], [["success"], "success"], [["success", "pending"], "pending"]];
  for (const [states, want] of summaries) {
    it(`summary of ${states.join(",") || "nothing"}`, () => {
      const runs = states.map((s) => ({ name: s, status: s === "pending" ? "queued" : "completed", conclusion: s }));
      assert.equal(ciSummary(ciChecks(runs, [])), want);
    });
  }
});

describe("composeReview", () => {
  it("approves the given head, with or without text and /draft", () => {
    assert.deepEqual(composeReview("approve", "  ", HEAD), { commit_id: HEAD, event: "APPROVE", body: "" });
    assert.deepEqual(composeReview("approve", "LGTM\r\n", HEAD, { draft: true }), { commit_id: HEAD, event: "APPROVE", body: "LGTM\n\n/draft" });
    assert.deepEqual(composeReview("approve", "", HEAD, { draft: true }).body, "/draft");
  });
  it("requests changes and comments with text", () => {
    assert.deepEqual(composeReview("request-changes", "Split this commit", HEAD), { commit_id: HEAD, event: "REQUEST_CHANGES", body: "Split this commit" });
    assert.equal(composeReview("comment", "a `/promote` in backticks is fine", HEAD).event, "COMMENT");
  });
  const refusals: [string, () => unknown, RegExp][] = [
    ["empty change request", () => composeReview("request-changes", " ", HEAD), /say what to change/],
    ["empty comment", () => composeReview("comment", "", HEAD), /write a comment/],
    ["a /promote line", () => composeReview("comment", "ok\n  /promote", HEAD), /bot command/],
    ["a /draft line in a change request", () => composeReview("request-changes", "fix\n/draft", HEAD), /bot command/],
    ["a typed /ready in an approval", () => composeReview("approve", "/ready", HEAD), /bot command/],
    ["/promote --human-text", () => composeReview("comment", "/promote --human-text", HEAD), /bot command/],
    ["an /answer line", () => composeReview("comment", "/answer A", HEAD), /bot command/],
    ["/draft without approving", () => composeReview("comment", "x", HEAD, { draft: true }), /only with an approval/],
    ["a short sha", () => composeReview("approve", "", "abc123"), /not a commit id/],
  ];
  for (const [name, f, re] of refusals) it(`refuses ${name}`, () => assert.throws(f, re));
});
