import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReceipt, getDraftSection, parseReceipt, setDraftSection } from "../src/answer.ts";
import { GitHub } from "../src/github/api.ts";
import { answerTarget, type Item } from "../src/github/board.ts";
import { gistId, loadContext, loadQueue, postAnswer, verifyReceipt } from "../src/github/backend.ts";
import { HOME_OWNERS } from "../src/github/config.ts";
import { fields, rawItems, scriptedFetch } from "./helpers.ts";

const token = async () => "t";
const API = "https://api.github.com";
const PROJECT = `${API}/users/cgwalters-bot/projectsV2/1`;

async function queue(): Promise<Map<string, Item>> {
  const { fetchImpl } = scriptedFetch((_m, url) => {
    if (url === PROJECT) return { body: { public: true } };
    if (url.startsWith(`${PROJECT}/fields`)) return { body: fields() };
    if (url.startsWith(`${PROJECT}/items`)) return { body: rawItems() };
    return undefined;
  });
  const q = await loadQueue(new GitHub(token, fetchImpl));
  return new Map(q.items.map((i) => [i.nodeId, i]));
}

describe("loadQueue", () => {
  it("asks for the needed fields and the Needs human filter", async () => {
    let boardPublic = true;
    const { fetchImpl, calls } = scriptedFetch((_m, url, headers) => {
      if (url === PROJECT) {
        if (headers["If-None-Match"] === `"p${boardPublic}"`) return { status: 304 };
        return { body: { public: boardPublic }, headers: { etag: `"p${boardPublic}"` } };
      }
      if (headers["If-None-Match"]) return { status: 304 };
      if (url.startsWith(`${PROJECT}/fields`)) return { body: fields(), headers: { etag: '"f"' } };
      if (url.startsWith(`${PROJECT}/items`)) return { body: rawItems(), headers: { etag: '"i"' } };
      return undefined;
    });
    const gh = new GitHub(token, fetchImpl);
    const first = await loadQueue(gh);
    assert.equal(first.changed, true);
    assert.equal(first.boardPublic, true);
    assert.equal(first.items.length, 4);
    const itemsUrl = new URL(calls[2]?.url ?? "");
    assert.equal(itemsUrl.searchParams.get("fields"), "102,104,103,105,106,107");
    assert.equal(itemsUrl.searchParams.get("q"), 'status:"Needs human","Draft"');

    assert.equal((await loadQueue(gh)).changed, false);
    boardPublic = false;
    const flipped = await loadQueue(gh);
    assert.deepEqual([flipped.changed, flipped.boardPublic], [true, false]);
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
    const posted = await postAnswer(new GitHub(token, fetchImpl), item, answerTarget(item, HOME_OWNERS), { choice: "B", text: "ok" });
    assert.equal(posted.url, "https://github.com/cgwalters-bot/example-tool/issues/7#issuecomment-1");
    assert.deepEqual(calls[0]?.body, { body: "/answer B\nok\n" });
  });

  it("answers a draft with a secret receipt gist, then the body section over the fresh body", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_draft") as Item;
    const receiptUrl = "https://gist.github.com/fedcba98";
    const freshBody = "Q: which prefix?\n\n- A) org.example\n- B) io.example\n\nEdited meanwhile.\n";
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method === "POST" && url === `${API}/gists`) return { status: 201, body: { html_url: receiptUrl } };
      if (method === "GET" && url === `${PROJECT}/items/9002`) return { body: { ...rawItems()[1], content: { body: freshBody } } };
      if (method === "POST" && url === `${API}/graphql`) return { body: { data: { updateProjectV2DraftIssue: { draftIssue: { id: "DI" } } } } };
      return undefined;
    });
    const posted = await postAnswer(new GitHub(token, fetchImpl), item, answerTarget(item, HOME_OWNERS), {
      choice: "A",
      question: "Q#2",
      text: "",
    });
    assert.equal(posted.url, receiptUrl);

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [`GET ${PROJECT}/items/9002`, `POST ${API}/gists`, `POST ${API}/graphql`],
    );
    const gist = calls[1]?.body as { public: boolean; files: Record<string, { content: string }> };
    assert.equal(gist.public, false);
    assert.deepEqual(parseReceipt(gist.files["answer.md"]?.content ?? ""), {
      choice: "A",
      question: "Q#2",
      text: "",
      item: "PVTI_synthetic_draft",
    });

    const mutation = calls[2]?.body as { variables: { id: string; body: string } };
    assert.equal(mutation.variables.id, "DI_synthetic_draft");
    assert.ok(mutation.variables.body.startsWith(freshBody));
    assert.deepEqual(getDraftSection(mutation.variables.body), {
      receipt: receiptUrl,
      answer: { choice: "A", question: "Q#2", text: "" },
    });
  });

  it("says where the receipt went when the draft write fails", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_draft") as Item;
    const { fetchImpl } = scriptedFetch((method, url) => {
      if (url === `${API}/gists`) return { status: 201, body: { html_url: "https://gist.github.com/abc" } };
      if (method === "GET") return { body: rawItems()[1] };
      return { body: { errors: [{ message: "Resource not accessible by integration" }] } };
    });
    await assert.rejects(
      postAnswer(new GitHub(token, fetchImpl), item, answerTarget(item, HOME_OWNERS), { text: "x" }),
      /created the receipt https:\/\/gist\.github\.com\/abc, but could not write the draft body: GraphQL: Resource not accessible/,
    );
  });

  it("refuses a body with two answer sections before creating a receipt", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_draft") as Item;
    const section = setDraftSection("", { choice: "A", text: "" }, "https://gist.github.com/abc");
    const { fetchImpl, calls } = scriptedFetch((method) =>
      method === "GET" ? { body: { ...rawItems()[1], content: { body: section + section } } } : undefined,
    );
    await assert.rejects(
      postAnswer(new GitHub(token, fetchImpl), item, answerTarget(item, HOME_OWNERS), { choice: "B", text: "" }),
      /more than one answer section/,
    );
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

  it("refuses a command line in free text before any request", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_draft") as Item;
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    await assert.rejects(
      postAnswer(new GitHub(token, fetchImpl), item, answerTarget(item, HOME_OWNERS), { choice: "B", text: "ok\n/promote" }),
      /bot command/,
    );
    assert.equal(calls.length, 0);
  });

  it("refuses an empty answer before any request", async () => {
    const items = await queue();
    const item = items.get("PVTI_synthetic_home_issue") as Item;
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    await assert.rejects(postAnswer(new GitHub(token, fetchImpl), item, answerTarget(item, HOME_OWNERS), { text: " " }), /pick an option/);
    assert.equal(calls.length, 0);
  });
});

describe("verifyReceipt", () => {
  const receiptGist = (content: string, owner = "cgwalters") => ({
    html_url: "https://gist.github.com/cgwalters/abc123",
    owner: { login: owner },
    history: [{ user: { login: owner } }],
    files: { "answer.md": { filename: "answer.md", truncated: false, content } },
  });

  async function check(body: string, gist: unknown) {
    const item = (await queue()).get("PVTI_synthetic_draft") as Item;
    item.body = body;
    const { fetchImpl, calls } = scriptedFetch((_m, url) => (url === `${API}/gists/abc123` ? { body: gist } : undefined));
    return { status: await verifyReceipt(new GitHub(token, fetchImpl), item), calls };
  }
  const withSection = (url: string) => setDraftSection("Q#2: which? Options: A) x B) y", { choice: "A", text: "" }, url);

  it("verifies his receipt, fetched by id", async () => {
    const content = formatReceipt({ choice: "A", question: "Q#2", text: "", item: "PVTI_synthetic_draft" });
    // The URL names someone else; only the gist's own owner counts.
    const { status, calls } = await check(withSection("https://gist.github.com/someone-else/abc123"), receiptGist(content));
    assert.equal(status?.check.ok, true);
    assert.equal(calls[0]?.url, `${API}/gists/abc123`);
  });

  it("rejects a receipt owned by someone else", async () => {
    const content = formatReceipt({ choice: "A", question: "Q#2", text: "", item: "PVTI_synthetic_draft" });
    const { status } = await check(withSection("https://gist.github.com/abc123"), receiptGist(content, "cgwalters-bot"));
    assert.equal(status?.check.ok, false);
  });

  it("rejects a gist that is not a receipt", async () => {
    const { status } = await check(withSection("https://gist.github.com/abc123"), undefined);
    assert.equal(status?.check.ok, false);
  });

  it("does nothing without a section", async () => {
    const { status, calls } = await check("no answer here", {});
    assert.equal(status, undefined);
    assert.equal(calls.length, 0);
  });
});
