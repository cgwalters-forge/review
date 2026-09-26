import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { answerTarget, type Item } from "../src/github/board.ts";
import { gistId, loadContext, loadQueue, postAnswer } from "../src/github/backend.ts";
import { HOME_OWNERS } from "../src/github/config.ts";
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
    assert.equal(first.items.length, 4);
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

describe("loadContext", () => {
  it("reads visibility, recent comments and gists, and reports failures", async () => {
    const items = await queue();
    const home = items.get("PVTI_synthetic_home_issue") as Item;
    const { fetchImpl } = scriptedFetch((_m, url) => {
      if (url === `${API}/repos/cgwalters-bot/example-tool`) return { body: { private: true } };
      if (url.startsWith(`${API}/repos/cgwalters-bot/example-tool/issues/7/comments`)) {
        return {
          body: Array.from({ length: 7 }, (_, i) => ({
            user: { login: i === 6 ? "cgwalters" : "someone" },
            created_at: `2026-01-0${i + 1}T00:00:00Z`,
            html_url: `https://github.com/c/${i}`,
            body: i === 6 ? "/answer A" : `comment ${i}`,
          })),
        };
      }
      return undefined;
    });
    const ctx = await loadContext(new GitHub(token, fetchImpl), home);
    assert.equal(ctx.isPrivate, true);
    assert.deepEqual(ctx.comments.map((c) => c.body), ["comment 2", "comment 3", "comment 4", "comment 5", "/answer A"]);
    assert.deepEqual(ctx.warnings, []);

    const draft = items.get("PVTI_synthetic_draft") as Item;
    const failing = scriptedFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    const dctx = await loadContext(new GitHub(token, failing.fetchImpl), draft);
    assert.equal(dctx.gists.length, 0);
    assert.match(dctx.warnings[0] ?? "", /gists\/0123abcd failed with HTTP 404/);
  });
});

describe("postAnswer", () => {
  it("comments on an issue with only the letter and his text", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_home_issue") as Item;
    const { fetchImpl, calls } = scriptedFetch((method, url) =>
      method === "POST" && url === `${API}/repos/cgwalters-bot/example-tool/issues/7/comments`
        ? { status: 201, body: { html_url: "https://github.com/cgwalters-bot/example-tool/issues/7#issuecomment-1" } }
        : undefined,
    );
    const posted = await postAnswer(new GitHub(token, fetchImpl), answerTarget(item, HOME_OWNERS), { choice: "B", text: "ok" });
    assert.equal(posted.url, "https://github.com/cgwalters-bot/example-tool/issues/7#issuecomment-1");
    assert.deepEqual(calls[0]?.body, { body: "/answer B\nok\n" });
  });

  it("refuses a command line in free text before any request", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_home_issue") as Item;
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    await assert.rejects(
      postAnswer(new GitHub(token, fetchImpl), answerTarget(item, HOME_OWNERS), { choice: "B", text: "ok\n/promote" }),
      /bot command/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses an empty answer before any request", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_home_issue") as Item;
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    await assert.rejects(postAnswer(new GitHub(token, fetchImpl), answerTarget(item, HOME_OWNERS), { text: " " }), /pick an option/);
    assert.equal(calls.length, 0);
  });
});
