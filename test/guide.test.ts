import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawReview } from "../src/github/forge.ts";
import { findGuide, GUIDE_SCHEMA, GuideError, parseGuideBody, validateGuide, worst } from "../src/github/guide.ts";
import { fixture } from "./helpers.ts";

const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const C1 = "c".repeat(40);
const ref = { owner: "cgwalters-forge", repo: "widget", number: 7 };

function guide(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: GUIDE_SCHEMA,
    repo: "cgwalters-forge/widget",
    pr: 7,
    head: HEAD,
    summary: "Adds X.\nRisk is in Y.",
    hotspots: [{ path: "src/a.rs", commit: C1, start: 10, end: 12, severity: "risky", category: "logic", reason: "Off by one when n is 0." }],
    skim: [{ path: "Cargo.lock", reason: "generated" }, { path: "src/b.rs", start: 1, end: 4, reason: "rename" }],
    ...over,
  };
}

const hotspot = (over: Record<string, unknown>) => guide({ hotspots: [{ ...(guide().hotspots as object[])[0], ...over }] });

/** A body as bin/bot-review-guide writes it: prose, then the marker with <, > and & escaped. */
function body(g: unknown, prose = "**Review guide**"): string {
  const json = JSON.stringify(g).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${prose}\n\n<!-- ${GUIDE_SCHEMA} ${json} -->`;
}

describe("validateGuide", () => {
  it("accepts a good guide", () => {
    const g = validateGuide(guide());
    assert.equal(g.hotspots[0]?.severity, "risky");
    assert.deepEqual(g.skim[1], { path: "src/b.rs", start: 1, end: 4, reason: "rename" });
  });

  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["another schema", guide({ schema: "review-guide/v2" }), /schema/],
    ["an unknown key", guide({ extra: 1 }), /unknown key extra/],
    ["a short head", guide({ head: "abc" }), /head/],
    ["a bad repo", guide({ repo: "../x" }), /repo/],
    ["no summary", guide({ summary: "  " }), /summary/],
    ["a long summary", guide({ summary: "x".repeat(2001) }), /longer than 2000/],
    ["a bidi override", guide({ summary: "ok‮evil" }), /control or formatting/],
    ["a tab", guide({ summary: "a\tb" }), /control or formatting/],
    ["an Arabic letter mark", guide({ summary: "a\u061cb" }), /control or formatting/],
    ["a line separator", guide({ summary: "a\u2028b" }), /control or formatting/],
    ["a deprecated format character", guide({ summary: "a\u206ab" }), /control or formatting/],
    ["a newline in a reason", hotspot({ reason: "a\nb" }), /reason/],
    ["a zero-width space in a path", hotspot({ path: "src/a​.rs" }), /path/],
    ["an absolute path", hotspot({ path: "/etc/passwd" }), /not a repository path/],
    ["a dot-dot path", hotspot({ path: "a/../b" }), /not a repository path/],
    ["a bad severity", hotspot({ severity: "critical" }), /severity: expected one of risky, look-closely, note/],
    ["a bad category", hotspot({ category: "style" }), /category/],
    ["end before start", hotspot({ start: 5, end: 4 }), /end before start/],
    ["line zero", hotspot({ start: 0 }), /line number/],
    ["a fractional line", hotspot({ end: 12.5 }), /line number/],
    ["a short commit", hotspot({ commit: "abc1234" }), /commit/],
    ["an unknown hotspot key", hotspot({ url: "https://x" }), /unknown key url/],
    ["half a skim range", guide({ skim: [{ path: "a", start: 1, reason: "r" }] }), /skim\[0\]\.end/],
    ["too many hotspots", guide({ hotspots: Array.from({ length: 51 }, () => (guide().hotspots as object[])[0]) }), /more than 50/],
    ["not an object", [] as unknown as Record<string, unknown>, /JSON object/],
  ];
  for (const [name, g, re] of bad) it(`refuses ${name}`, () => assert.throws(() => validateGuide(g), (e: unknown) => e instanceof GuideError && re.test(e.message)));
});

describe("parseGuideBody", () => {
  it("round-trips text that would end an HTML comment", () => {
    const g = guide({ summary: "a --> <script>alert(1)</script> & b" });
    assert.equal(parseGuideBody(body(g))?.summary, "a --> <script>alert(1)</script> & b");
  });
  it("reads the last marker", () => {
    const two = `${body(guide({ summary: "first" }))}\n${body(guide({ summary: "second" }))}`;
    assert.equal(parseGuideBody(two)?.summary, "second");
  });
  it("has nothing to say without a marker", () => assert.equal(parseGuideBody("LGTM"), undefined));
  it("refuses broken JSON and an unclosed marker", () => {
    assert.throws(() => parseGuideBody(`<!-- ${GUIDE_SCHEMA} {"a": -->`), /valid JSON/);
    assert.throws(() => parseGuideBody(`<!-- ${GUIDE_SCHEMA} {}`), /isn't closed/);
  });
  it("reads what bin/bot-review-guide posted", () => {
    const review = fixture<RawReview>("guide-review.json");
    const g = parseGuideBody(review.body ?? "");
    assert.equal(g?.head, review.commit_id);
    assert.ok((g?.hotspots.length ?? 0) > 0);
  });
});

describe("findGuide", () => {
  const review = (over: Partial<RawReview> & { g?: unknown } = {}): RawReview => {
    const { g, ...rest } = over;
    return { user: { login: "cgwalters-bot" }, state: "COMMENTED", commit_id: HEAD, submitted_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/r/1", body: body(g ?? guide()), ...rest };
  };
  const cases: [string, RawReview[], string, string | RegExp][] = [
    ["none", [], HEAD, "none"],
    ["the bot's, for this head", [review()], HEAD, "current"],
    ["the bot's, for an older head", [review()], MOVED, "stale"],
    ["someone else's", [review({ user: { login: "mallory" } })], HEAD, "none"],
    ["an approval by the bot", [review({ state: "APPROVED" })], HEAD, "none"],
    ["for another PR", [review({ g: guide({ pr: 8 }) })], HEAD, /not this PR/],
    ["for another repository", [review({ g: guide({ repo: "x/widget" }) })], HEAD, /not this PR/],
    ["posted at another commit", [review({ commit_id: MOVED })], HEAD, /commit isn't the head/],
    ["invalid", [review({ body: body(guide({ summary: "" })) })], HEAD, /summary/],
    ["the latest of two", [review({ g: guide({ summary: "new" }), submitted_at: "2026-01-03T00:00:00Z" }), review({ commit_id: MOVED, g: guide({ head: MOVED }) })], HEAD, "current"],
    ["a later invalid one hides an older good one", [review(), review({ body: `<!-- ${GUIDE_SCHEMA} x -->`, submitted_at: "2026-01-03T00:00:00Z" })], HEAD, /valid JSON/],
  ];
  for (const [name, reviews, head, want] of cases) {
    it(name, () => {
      const s = findGuide(reviews, ref, head);
      if (typeof want === "string") assert.equal(s.state, want);
      else {
        assert.equal(s.state, "invalid");
        assert.match(s.state === "invalid" ? s.error : "", want);
      }
    });
  }
  it("keeps the review's link", () => {
    const s = findGuide([review()], ref, HEAD);
    assert.equal(s.state === "current" ? s.url : undefined, "https://github.com/r/1");
  });
});

describe("worst", () => {
  const hs = (severity: string) => ({ severity }) as never;
  it("ranks risky over look-closely over note", () => {
    assert.equal(worst([hs("note"), hs("risky"), hs("look-closely")]), "risky");
    assert.equal(worst([hs("note"), hs("look-closely")]), "look-closely");
    assert.equal(worst([]), undefined);
  });
});
