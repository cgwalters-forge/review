import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Item } from "../src/github/board.ts";
import { gistId, loadAnswered, loadContext, loadQueue, postAnswer } from "../src/github/backend.ts";
import { fields, rawItems, scriptedFetch } from "./helpers.ts";

const token = async () => "t";
const API = "https://api.github.com";
const PROJECT = `${API}/users/cgwalters-bot/projectsV2/1`;

async function queue(): Promise<Map<string, Item>> {
  const { fetchImpl } = scriptedFetch((_m, url) => {
    if (url.startsWith(`${PROJECT}/fields`)) return { body: fields() };
    if (url.startsWith(`${PROJECT}/items`)) return { body: rawItems() };
    return undefined;
  });
  const q = await loadQueue(new GitHub(token, fetchImpl));
  return new Map(q.items.map((i) => [i.nodeId, i]));
}

describe("loadQueue", () => {
  it("asks for the needed fields and the Needs human filter", async () => {
    const { fetchImpl, calls } = scriptedFetch((_m, url, headers) => {
      if (headers["If-None-Match"]) return { status: 304 };
      if (url.startsWith(`${PROJECT}/fields`)) return { body: fields(), headers: { etag: '"f"' } };
      if (url.startsWith(`${PROJECT}/items`)) return { body: rawItems(), headers: { etag: '"i"' } };
      return undefined;
    });
    const gh = new GitHub(token, fetchImpl);
    const first = await loadQueue(gh);
    assert.equal(first.changed, true);
    assert.equal(first.items.length, 8);
    const itemsUrl = new URL(calls[1]?.url ?? "");
    assert.equal(itemsUrl.searchParams.get("fields"), "102,104,103,105,106,107");
    assert.equal(itemsUrl.searchParams.get("q"), 'status:"Needs human","Draft"');

    assert.equal((await loadQueue(gh)).changed, false);
  });
});

describe("gistId", () => {
  const cases: [string, string | undefined][] = [
    ["https://gist.github.com/someone/0123abcd", "0123abcd"],
    ["https://gist.github.com/0123abcd", "0123abcd"],
    ["https://gist.github.com/someone/0123abcd#file-a-md", "0123abcd"],
    ["https://gist.example/someone/0123abcd", undefined],
    ["https://gist.github.com/someone/../../user", undefined],
  ];
  for (const [url, want] of cases) it(url, () => assert.equal(gistId(url), want));
});

const TRACKER = `${API}/repos/cgwalters-forge/tracker/issues`;

/** A raw comment by `login`, on day `day` of January. */
function comment(login: string, day: number, body = `comment ${day}`) {
  return {
    user: { login },
    created_at: `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    html_url: `https://github.com/c/${day}`,
    body,
  };
}

describe("loadContext", () => {
  it("reads recent comments and gists, and reports failures", async () => {
    const items = await queue();
    const home = items.get("PVTI_synthetic_home_issue") as Item;
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url.startsWith(`${API}/repos/cgwalters-bot/example-tool/issues/7/comments`)) {
        return { body: Array.from({ length: 7 }, (_, i) => comment(i === 6 ? "cgwalters" : "someone", i + 1)) };
      }
      return undefined;
    });
    const ctx = await loadContext(new GitHub(token, fetchImpl), home);
    assert.deepEqual(ctx.comments.map((c) => c.body), ["comment 3", "comment 4", "comment 5", "comment 6", "comment 7"]);
    // Not a question, so no answered state.
    assert.equal(ctx.answered, undefined);
    assert.deepEqual(ctx.warnings, []);

    const draft = items.get("PVTI_synthetic_draft") as Item;
    const failing = scriptedFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    const dctx = await loadContext(new GitHub(token, failing.fetchImpl), draft);
    assert.equal(dctx.gists.length, 0);
    assert.match(dctx.warnings[0] ?? "", /gists\/0123abcd failed with HTTP 404/);
  });

  it("says whether he answered a question, from all its comments", async () => {
    const q = (await queue()).get("PVTI_synthetic_question") as Item;
    const all = [comment("cgwalters", 1), comment("cgwalters-bot", 2), ...Array.from({ length: 6 }, (_, i) => comment("someone", i + 3))];
    for (const [comments, want] of [[all, false], [[...all, comment("cgwalters", 20)], true]] as const) {
      const { fetchImpl } = scriptedFetch((_m, url) => (url.startsWith(`${TRACKER}/21/comments`) ? { body: comments } : undefined));
      const ctx = await loadContext(new GitHub(token, fetchImpl), q);
      assert.equal(ctx.answered, want);
      assert.equal(ctx.comments.length, 5);
    }
  });
});

describe("loadAnswered", () => {
  it("reads comments only of open questions that have some, conditionally", async () => {
    const items = [...(await queue()).values()];
    const { fetchImpl, calls } = scriptedFetch((_m, url, headers) => {
      if (headers["If-None-Match"]) return { status: 304 };
      if (url.startsWith(`${TRACKER}/21/comments`)) {
        return { body: [comment("cgwalters-bot", 1), comment("cgwalters", 2, "B")], headers: { etag: '"c21"' } };
      }
      return undefined;
    });
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual([...(await loadAnswered(gh, items))], ["PVTI_synthetic_question"]);
    // #22 has no comments and #23 is closed: neither is read.
    assert.deepEqual(calls.map((c) => new URL(c.url).pathname), ["/repos/cgwalters-forge/tracker/issues/21/comments"]);
    assert.deepEqual([...(await loadAnswered(gh, items))], ["PVTI_synthetic_question"]);
    assert.equal(calls[1]?.headers["If-None-Match"], '"c21"');
  });

  it("counts a question it can't read as unanswered", async () => {
    const items = [...(await queue()).values()];
    const { fetchImpl } = scriptedFetch(() => ({ status: 500, body: { message: "oops" } }));
    assert.equal((await loadAnswered(new GitHub(token, fetchImpl), items)).size, 0);
  });
});

describe("postAnswer", () => {
  const ref = { owner: "cgwalters-forge", repo: "tracker", number: 21 };
  const openQuestion = { html_url: "https://github.com/cgwalters-forge/tracker/issues/21", state: "open", labels: [{ name: "question" }] };
  const commentUrl = "https://github.com/cgwalters-forge/tracker/issues/21#issuecomment-1";

  function github(issue: unknown) {
    return scriptedFetch((method, url) => {
      if (method === "GET" && url === `${TRACKER}/21`) return { body: issue };
      if (method === "POST" && url === `${TRACKER}/21/comments`) return { status: 201, body: { html_url: commentUrl } };
      return undefined;
    });
  }

  const posts: [string, { choice?: string; text: string }, string][] = [
    ["a pick", { choice: "B", text: "" }, "B\n"],
    ["a pick and text", { choice: "B", text: "ok" }, "B\nok\n"],
    ["free text", { text: "neither" }, "neither\n"],
  ];
  for (const [name, answer, body] of posts) {
    it(`posts ${name} after checking the issue fresh`, async () => {
      const { fetchImpl, calls } = github(openQuestion);
      const posted = await postAnswer(new GitHub(token, fetchImpl), ref, answer);
      assert.equal(posted.url, commentUrl);
      assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
      assert.deepEqual(calls[1]?.body, { body });
    });
  }

  const refusals: [string, unknown, RegExp][] = [
    ["a closed question", { ...openQuestion, state: "closed" }, /is closed/],
    ["an issue without the label", { ...openQuestion, labels: [] }, /not labelled "question"/],
    ["a PR", { ...openQuestion, pull_request: {} }, /not an issue/],
    ["a transferred issue", { ...openQuestion, html_url: "https://github.com/example-upstream/widget/issues/3" }, /is now https:\/\/github\.com\/example-upstream/],
  ];
  for (const [name, issue, want] of refusals) {
    it(`refuses ${name} without commenting`, async () => {
      const { fetchImpl, calls } = github(issue);
      await assert.rejects(postAnswer(new GitHub(token, fetchImpl), ref, { choice: "A", text: "" }), want);
      assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    });
  }

  it("refuses an upstream issue or PR", async () => {
    const pr = { owner: "example-upstream", repo: "widget", number: 42 };
    const { fetchImpl, calls } = scriptedFetch((method) =>
      method === "GET" ? { body: { html_url: "https://github.com/example-upstream/widget/pull/42", state: "open", labels: ["question"], pull_request: {} } } : undefined,
    );
    await assert.rejects(postAnswer(new GitHub(token, fetchImpl), pr, { choice: "B", text: "" }), /not answering/);
    assert.equal(calls.length, 1);
  });

  it("answers in another repository when told to, as the sandbox check does", async () => {
    const sandbox = { owner: "cgwalters-bot", repo: "review-sandbox", number: 4 };
    const base = `${API}/repos/cgwalters-bot/review-sandbox/issues/4`;
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method === "GET" && url === base) {
        return { body: { html_url: "https://github.com/cgwalters-bot/review-sandbox/issues/4", state: "open", labels: [{ name: "question" }] } };
      }
      if (method === "POST" && url === `${base}/comments`) return { status: 201, body: { html_url: `${base}#c` } };
      return undefined;
    });
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(postAnswer(gh, sandbox, { choice: "A", text: "" }), /not in cgwalters-forge\/tracker/);
    await postAnswer(gh, sandbox, { choice: "A", text: "" }, "cgwalters-bot/review-sandbox");
    assert.deepEqual(calls.at(-1)?.body, { body: "A\n" });
  });

  const invalid: [string, { choice?: string; text: string }, RegExp][] = [
    ["a command line in free text", { choice: "B", text: "ok\n/promote" }, /bot command/],
    ["an empty answer", { text: " " }, /pick an option/],
    ["free text that reads as a pick", { text: "C" }, /reads as picking an option/],
  ];
  for (const [name, answer, want] of invalid) {
    it(`refuses ${name} before any request`, async () => {
      const { fetchImpl, calls } = scriptedFetch(() => undefined);
      await assert.rejects(postAnswer(new GitHub(token, fetchImpl), ref, answer), want);
      assert.equal(calls.length, 0);
    });
  }
});
