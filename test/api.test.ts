import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub, GitHubError, nextLink } from "../src/github/api.ts";
import { scriptedFetch } from "./helpers.ts";

const token = async () => "t0ken";

describe("nextLink", () => {
  const cases: [string | null, string | undefined][] = [
    [null, undefined],
    ['<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"', "https://api.github.com/x?page=2"],
    ['<https://api.github.com/x?page=1>; rel="prev"', undefined],
  ];
  for (const [link, want] of cases) it(String(link), () => assert.equal(nextLink(link), want));
});

describe("GitHub.get", () => {
  it("sends the token, then revalidates with the ETag and reuses data on 304", async () => {
    let n = 0;
    const { fetchImpl, calls } = scriptedFetch((_m, _u, headers) => {
      n++;
      if (headers["If-None-Match"] === 'W/"v1"') return { status: 304, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999" } };
      return { body: { n }, headers: { etag: 'W/"v1"' } };
    });
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual(await gh.get("/x"), { data: { n: 1 }, changed: true });
    assert.deepEqual(await gh.get("/x"), { data: { n: 1 }, changed: false });
    assert.equal(calls[0]?.headers.Authorization, "Bearer t0ken");
    assert.equal(calls[0]?.headers["If-None-Match"], undefined);
    assert.equal(calls[1]?.headers["If-None-Match"], 'W/"v1"');
    assert.equal(calls[0]?.url, "https://api.github.com/x");
    assert.deepEqual(gh.rate, { limit: 5000, remaining: 4999, reset: 0 });
    assert.equal(gh.rateLow(0.1), false);
  });

  it("explains an auth failure", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(gh.get("/user"), (e: unknown) => {
      assert.ok(e instanceof GitHubError);
      assert.equal(e.status, 401);
      assert.match(e.message, /Bad credentials.*sign in again/);
      return true;
    });
  });

  it("refuses paths that would leave the API origin", async () => {
    const gh = new GitHub(token, scriptedFetch(() => ({})).fetchImpl);
    await assert.rejects(gh.get("https://evil.example/x"), /refusing to send the token outside/);
    await assert.rejects(gh.get("x"), /must start with \//);
  });

  it("refuses a next page outside the API origin", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: [1], headers: { link: '<https://evil.example/x?page=2>; rel="next"' } }));
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(gh.getAll("/x"), /refusing to send the token outside/);
    assert.equal(calls.length, 1);
  });

  it("notes a classic token's scopes", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ body: {}, headers: { "x-oauth-scopes": "gist, repo" } }));
    const gh = new GitHub(token, fetchImpl);
    assert.equal(gh.scopes, undefined);
    await gh.get("/user");
    assert.equal(gh.scopes, "gist, repo");
  });
});

describe("GitHub.getAll", () => {
  it("follows pages and reports a change on any page", async () => {
    const page2 = "https://api.github.com/list?page=2";
    let second = 0;
    const { fetchImpl } = scriptedFetch((_m, url, headers) => {
      if (url === page2) {
        second++;
        if (second === 2 && headers["If-None-Match"]) return { status: 304 };
        return { body: [3], headers: { etag: `"p2-${second}"` } };
      }
      if (headers["If-None-Match"]) return { status: 304 };
      return { body: [1, 2], headers: { etag: '"p1"', link: `<${page2}>; rel="next"` } };
    });
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual(await gh.getAll("/list"), { data: [1, 2, 3], changed: true });
    assert.deepEqual(await gh.getAll("/list"), { data: [1, 2, 3], changed: false });
    // Page 2 changes; page 1 still 304.
    second = 5;
    assert.deepEqual(await gh.getAll("/list"), { data: [1, 2, 3], changed: true });
  });

  it("stops at the page limit", async () => {
    const { fetchImpl } = scriptedFetch((_m, url) => ({ body: [1], headers: { link: `<${url}x>; rel="next"` } }));
    await assert.rejects(new GitHub(token, fetchImpl).getAll("/loop", 3), /more than 3 pages/);
  });
});

describe("GitHub.graphql", () => {
  it("surfaces GraphQL errors", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ body: { errors: [{ message: "Resource not accessible by integration" }] } }));
    await assert.rejects(new GitHub(token, fetchImpl).graphql("q", {}), /Resource not accessible by integration/);
  });
});
