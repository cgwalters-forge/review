import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { composeReview, type ForgePr } from "../src/github/forge.ts";
import { FORGE_QUERY, loadForgePrs, loadPrDetail, mapLimit, refreshVerdicts, submitReview, type VerdictEntry } from "../src/github/prs.ts";
import { scriptedFetch } from "./helpers.ts";

const token = async () => "t";
const API = "https://api.github.com";
const HEAD = "c".repeat(40);
const MOVED = "d".repeat(40);
const ref = { owner: "cgwalters-forge", repo: "widget", number: 7 };
const PULL = `${API}/repos/cgwalters-forge/widget/pulls/7`;

function pull(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    html_url: "https://github.com/cgwalters-forge/widget/pull/7",
    title: "widget: Fix it",
    body: "Body",
    draft: true,
    state: "open",
    user: { login: "cgwalters-bot" },
    head: { sha: HEAD, ref: "bot/fix" },
    base: { ref: "main" },
    additions: 3,
    deletions: 1,
    changed_files: 1,
    commits: 1,
    ...over,
  };
}

describe("loadForgePrs", () => {
  it("searches the bot's open forge drafts, page by page", async () => {
    const item = (n: number) => ({ html_url: `https://github.com/cgwalters-forge/r/pull/${n}`, pull_request: {}, title: `#${n}` });
    const { fetchImpl, calls } = scriptedFetch((_m, url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) return { body: { total_count: 101, items: Array.from({ length: 100 }, (_, i) => item(i + 1)) } };
      if (page === 2) return { body: { total_count: 101, items: [item(101), { html_url: "https://github.com/x/y/issues/1" }] } };
      return undefined;
    });
    const prs = await loadForgePrs(new GitHub(token, fetchImpl));
    assert.equal(prs.length, 101);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0]?.url ?? "").searchParams.get("q"), FORGE_QUERY);
    assert.match(FORGE_QUERY, /is:open draft:true org:cgwalters-forge author:cgwalters-bot/);
  });
});

describe("mapLimit", () => {
  it("keeps order and bounds concurrency", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });
});

describe("refreshVerdicts", () => {
  const forgePr = (n: number, updatedAt: string): ForgePr => ({
    ref: { owner: "cgwalters-forge", repo: "widget", number: n },
    url: `https://github.com/cgwalters-forge/widget/pull/${n}`,
    title: "",
    body: "",
    author: "cgwalters-bot",
    createdAt: "",
    updatedAt,
    draft: true,
  });

  it("re-reads only PRs that changed, against their current heads", async () => {
    const { fetchImpl, calls } = scriptedFetch((_m, url) => {
      if (url.startsWith(`${API}/repos/cgwalters-forge/widget/pulls?`)) {
        return { body: [pull({ number: 1, head: { sha: HEAD } }), pull({ number: 2, head: { sha: MOVED } })] };
      }
      if (url.startsWith(`${API}/repos/cgwalters-forge/widget/pulls/2/reviews`)) {
        return { body: [{ user: { login: "cgwalters" }, state: "APPROVED", commit_id: HEAD, submitted_at: "2026-01-01T00:00:00Z" }] };
      }
      if (url.startsWith(`${API}/repos/cgwalters-forge/widget/issues/2/comments`)) return { body: [] };
      return undefined;
    });
    const known = new Map<string, VerdictEntry>([
      ["cgwalters-forge/widget#1", { updatedAt: "u1", head: HEAD, verdict: { state: "approved" } }],
      ["cgwalters-forge/widget#3", { updatedAt: "gone", head: HEAD, verdict: { state: "none" } }],
    ]);
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(1, "u1"), forgePr(2, "u2")], known);
    assert.deepEqual([...out.keys()].sort(), ["cgwalters-forge/widget#1", "cgwalters-forge/widget#2"]);
    assert.equal(out.get("cgwalters-forge/widget#1")?.verdict.state, "approved");
    assert.equal(out.get("cgwalters-forge/widget#2")?.verdict.state, "approved-older");
    assert.equal(out.get("cgwalters-forge/widget#2")?.head, MOVED);
    assert.equal(calls.filter((c) => c.url.includes("/reviews")).length, 1);
  });

  it("marks a PR the open list no longer has as undecided", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => (url.includes("/pulls?") ? { body: [] } : undefined));
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(5, "u")], new Map());
    assert.deepEqual(out.get("cgwalters-forge/widget#5")?.verdict, { state: "none" });
  });

  it("counts a /promote comment", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url.includes("/pulls?")) return { body: [pull({ number: 6 })] };
      if (url.includes("/pulls/6/reviews")) return { body: [] };
      if (url.includes("/issues/6/comments")) return { body: [{ user: { login: "cgwalters" }, body: "/promote", created_at: "2026-01-01T00:00:00Z" }] };
      return undefined;
    });
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(6, "u")], new Map());
    assert.equal(out.get("cgwalters-forge/widget#6")?.verdict.state, "promoted");
  });

  it("makes no requests when nothing changed", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    const known = new Map<string, VerdictEntry>([["cgwalters-forge/widget#1", { updatedAt: "u1", head: HEAD, verdict: { state: "none" } }]]);
    const out = await refreshVerdicts(new GitHub(token, fetchImpl), [forgePr(1, "u1")], known);
    assert.equal(out.size, 1);
    assert.equal(calls.length, 0);
  });
});

describe("loadPrDetail", () => {
  const route = (commitSha: string, commitsTotal = 1) => (method: string, url: string, headers: Record<string, string>) => {
    if (url === PULL) return method === "GET" && headers["If-None-Match"] ? { status: 304 } : { body: pull({ commits: commitsTotal }), headers: { etag: '"p"' } };
    if (url.startsWith(`${PULL}/commits`)) {
      return { body: [{ sha: commitSha, html_url: "https://github.com/c", commit: { message: "widget: Fix it\n\nBecause.", author: { name: "Bot", date: "2026-01-01T00:00:00Z" } }, author: { login: "cgwalters-bot" } }] };
    }
    if (url.startsWith(`${PULL}/files`)) return { body: [] };
    if (url.startsWith(`${PULL}/reviews`) || url.includes("/issues/7/comments")) return { body: [] };
    if (url.includes("/check-runs")) return { body: { check_runs: [] } };
    if (url.endsWith("/status")) return { body: { statuses: [] } };
    if (url === `${API}/repos/cgwalters-forge/widget`) return { body: {} };
    if (method === "POST") return { body: { html_url: "https://github.com/review/2" } };
    return undefined;
  };

  it("flags a commit list that doesn't end at the head", async () => {
    const cases: [string, number, boolean][] = [[HEAD, 1, true], [MOVED, 1, false], [MOVED, 2, false], [MOVED, 300, true]];
    for (const [sha, total, want] of cases) {
      const d = await loadPrDetail(new GitHub(token, scriptedFetch(route(sha, total)).fetchImpl), ref);
      assert.equal(d.consistent, want, `${sha.slice(0, 4)} of ${total}`);
      assert.equal(d.warnings.length, want ? 0 : 1);
    }
  });

  it("re-reads the PR unconditionally before reviewing, even when cached", async () => {
    const { fetchImpl, calls } = scriptedFetch(route(HEAD));
    const gh = new GitHub(token, fetchImpl);
    await loadPrDetail(gh, ref);
    await submitReview(gh, ref, composeReview("comment", "hi", HEAD));
    const gets = calls.filter((c) => c.url === PULL && c.method === "GET");
    assert.equal(gets.length, 2);
    assert.equal(gets[1]?.headers["If-None-Match"], undefined);
  });

  it("gathers the PR, commits, files, checks and verdict; optional parts only warn", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url === PULL) return { body: pull() };
      if (url.startsWith(`${PULL}/commits`)) {
        return { body: [{ sha: HEAD, html_url: "https://github.com/c", commit: { message: "widget: Fix it\n\nBecause.", author: { name: "Bot", date: "2026-01-01T00:00:00Z" } }, author: { login: "cgwalters-bot" } }] };
      }
      if (url.includes("/issues/7/comments")) return { body: [] };
      if (url.startsWith(`${PULL}/files`)) return { body: [{ filename: "src/a.rs", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" }] };
      if (url.startsWith(`${PULL}/reviews`)) return { body: [] };
      if (url.includes(`/commits/${HEAD}/check-runs`)) return { status: 403, body: { message: "Resource not accessible" } };
      if (url.endsWith(`/commits/${HEAD}/status`)) return { body: { statuses: [{ context: "DCO", state: "success" }] } };
      if (url === `${API}/repos/cgwalters-forge/widget`) return { body: { private: false, parent: { full_name: "up/widget" } } };
      return undefined;
    });
    const d = await loadPrDetail(new GitHub(token, fetchImpl), ref);
    assert.equal(d.head, HEAD);
    assert.equal(d.parent, "up/widget");
    assert.equal(d.baseRef, "main");
    assert.equal(d.commits[0]?.message, "widget: Fix it\n\nBecause.");
    assert.equal(d.files[0]?.patch, "@@ -1 +1 @@\n-a\n+b");
    assert.deepEqual(d.checks.map((c) => c.name), ["DCO"]);
    assert.equal(d.verdict.state, "none");
    assert.equal(d.warnings.length, 1);
    assert.match(d.warnings[0] ?? "", /check runs.*403/);
  });
});

describe("submitReview", () => {
  const run = async (fresh: Record<string, unknown>) => {
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method === "GET" && url === PULL) return { body: pull(fresh) };
      if (method === "POST" && url === `${PULL}/reviews`) return { body: { html_url: "https://github.com/review/1" } };
      return undefined;
    });
    const review = composeReview("approve", "", HEAD, { draft: true });
    const result = await submitReview(new GitHub(token, fetchImpl), ref, review).then(
      (url) => ({ url }),
      (e: Error) => ({ error: e.message }),
    );
    return { result, posts: calls.filter((c) => c.method === "POST") };
  };

  it("approves the head he saw", async () => {
    const { result, posts } = await run({});
    assert.deepEqual(result, { url: "https://github.com/review/1" });
    assert.deepEqual(posts[0]?.body, { commit_id: HEAD, event: "APPROVE", body: "/draft" });
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ["a moved head", { head: { sha: MOVED } }, /head moved to dddddddddddd.*nothing was sent/],
    ["a closed PR", { state: "closed" }, /PR is closed/],
    ["a merged PR", { state: "closed", merged_at: "2026-01-01T00:00:00Z" }, /PR is merged/],
  ];
  for (const [name, fresh, re] of refusals) {
    it(`sends nothing on ${name}`, async () => {
      const { result, posts } = await run(fresh);
      assert.match("error" in result ? result.error : "", re);
      assert.equal(posts.length, 0);
    });
  }
});
