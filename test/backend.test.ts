import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Item } from "../src/github/board.ts";
import { FETCH_CONCURRENCY } from "../src/github/config.ts";
import {
  gistId,
  loadAnswered,
  loadContext,
  loadQueue,
  loadRuns,
  loadSubIssues,
  postAnswer,
  postAskComment,
  rerunFailedJobs,
} from "../src/github/backend.ts";
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
    assert.equal(first.items.length, 11);
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

describe("loadSubIssues", () => {
  const sub = (n: number, state: string, extra: object = {}) => ({
    html_url: `https://github.com/cgwalters-forge/tracker/issues/${n}`,
    title: `sub ${n}`,
    state,
    labels: [],
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
    ...extra,
  });

  it("lists a tracker parent's sub-issues with their state and progress", async () => {
    const items = await queue();
    const { fetchImpl, calls } = scriptedFetch((_m, url) =>
      url.startsWith(`${TRACKER}/20/sub_issues`)
        ? {
            body: [
              sub(21, "open", { labels: [{ name: "question" }] }),
              sub(30, "closed"),
              sub(31, "open", { sub_issues_summary: { total: 2, completed: 1, percent_completed: 50 } }),
              { html_url: "javascript:alert(1)", title: "bad" },
            ],
          }
        : undefined,
    );
    const ctx = await loadContext(new GitHub(token, fetchImpl), items.get("PVTI_synthetic_epic") as Item);
    assert.deepEqual(
      ctx.subIssues?.map((s) => [s.ref.number, s.state, s.labels.join(","), s.progress?.completed]),
      [
        [21, "open", "question", undefined],
        [30, "closed", "", undefined],
        [31, "open", "", 1],
      ],
    );
    assert.ok(calls.some((c) => c.url === `${TRACKER}/20/sub_issues?per_page=100`));
  });

  it("reads nothing for items without sub-issues, or outside the tracker", async () => {
    const items = await queue();
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    const gh = new GitHub(token, fetchImpl);
    const upstream = { ...(items.get("PVTI_synthetic_upstream_pr") as Item), kind: "issue" as const, subIssues: { total: 2, completed: 0, percent_completed: 0 } };
    for (const item of [items.get("PVTI_synthetic_question") as Item, items.get("PVTI_synthetic_home_issue") as Item, upstream]) {
      assert.equal(await loadSubIssues(gh, item), undefined, item.nodeId);
    }
    assert.equal(calls.length, 0);
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

  it("reads at most FETCH_CONCURRENCY at once", async () => {
    const base = (await queue()).get("PVTI_synthetic_question") as Item;
    const many = Array.from({ length: 20 }, (_, n) => ({
      ...base,
      nodeId: `PVTI_q${n}`,
      ref: { owner: "cgwalters-forge", repo: "tracker", number: 100 + n },
    }));
    let inFlight = 0;
    let peak = 0;
    const gh = new GitHub(token, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return new Response(JSON.stringify([comment("cgwalters", 1)]), { status: 200 });
    });
    assert.equal((await loadAnswered(gh, many)).size, 20);
    assert.equal(peak, FETCH_CONCURRENCY);
  });

  it("counts a question it can't read as unanswered", async () => {
    const items = [...(await queue()).values()];
    const { fetchImpl } = scriptedFetch(() => ({ status: 500, body: { message: "oops" } }));
    assert.equal((await loadAnswered(new GitHub(token, fetchImpl), items)).size, 0);
  });
});

describe("postAnswer", () => {
  const ref = { owner: "cgwalters-forge", repo: "tracker", number: 21 };
  const openQuestion = {
    html_url: "https://github.com/cgwalters-forge/tracker/issues/21",
    state: "open",
    labels: [{ name: "question" }],
    assignees: [{ login: "cgwalters" }],
    user: { login: "cgwalters-bot" },
    body: "Blocks: https://github.com/cgwalters-forge/tracker/issues/20\nQ: which?\nOptions:\nA) x\nB) y\nRecommended: A",
  };
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
    ["an issue not assigned to him", { ...openQuestion, assignees: [{ login: "cgwalters-bot" }] }, /not assigned to cgwalters/],
    ["a letter when the options are gone", { ...openQuestion, body: "Q: just do it" }, /has no option A; it no longer offers options\. Reload it\./],
    ["a transferred issue", { ...openQuestion, html_url: "https://github.com/example-upstream/widget/issues/3" }, /is now https:\/\/github\.com\/example-upstream/],
  ];
  for (const [name, issue, want] of refusals) {
    it(`refuses ${name} without commenting`, async () => {
      const { fetchImpl, calls } = github(issue);
      await assert.rejects(postAnswer(new GitHub(token, fetchImpl), ref, { choice: "A", text: "" }), want);
      assert.deepEqual(calls.map((c) => c.method), ["GET"]);
    });
  }

  it("refuses a letter the question no longer offers", async () => {
    const { fetchImpl, calls } = github(openQuestion);
    await assert.rejects(
      postAnswer(new GitHub(token, fetchImpl), ref, { choice: "C", text: "" }),
      /cgwalters-forge\/tracker#21 has no option C; it now offers A, B\. Reload it\./,
    );
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });

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
        return {
          body: {
            html_url: "https://github.com/cgwalters-bot/review-sandbox/issues/4",
            state: "open",
            labels: [{ name: "question" }],
            assignees: [{ login: "cgwalters-bot" }],
            user: { login: "cgwalters-bot" },
            body: "Q: ok?\nOptions:\nA) yes\nB) no",
          },
        };
      }
      if (method === "POST" && url === `${base}/comments`) return { status: 201, body: { html_url: `${base}#c` } };
      return undefined;
    });
    const gh = new GitHub(token, fetchImpl);
    await assert.rejects(postAnswer(gh, sandbox, { choice: "A", text: "" }), /not in cgwalters-forge\/tracker/);
    await postAnswer(gh, sandbox, { choice: "A", text: "" }, { repo: "cgwalters-bot/review-sandbox", assignee: "cgwalters-bot", author: "cgwalters-bot" });
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

const RUN = "https://github.com/example-upstream/widget/actions/runs/777";
const RUN_API = `${API}/repos/example-upstream/widget/actions/runs/777`;
const CHORE = { owner: "cgwalters-forge", repo: "tracker", number: 25 };
const chore = {
  html_url: "https://github.com/cgwalters-forge/tracker/issues/25",
  state: "open",
  labels: [{ name: "chore" }],
  assignees: [{ login: "cgwalters" }],
  user: { login: "cgwalters-bot" },
  body: `Blocks: \`https://github.com/example-upstream/widget/issues/7\`\nAsk: Rerun the arm legs\nRerun: \`${RUN}\`\n`,
};
const failedRun = { id: 777, html_url: RUN, name: "CI", status: "completed", conclusion: "failure", run_attempt: 1, repository: { full_name: "example-upstream/widget" } };
const jobs = {
  jobs: [
    { name: "build", status: "completed", conclusion: "success", html_url: `${RUN}/job/1` },
    { name: "uki (arm)", status: "completed", conclusion: "failure", html_url: `${RUN}/job/2` },
  ],
};

/** A GitHub that serves the chore, the run and its jobs, and takes the rerun and the comment. */
function rerunGitHub(over: { issue?: unknown; run?: unknown; jobs?: unknown } = {}) {
  return scriptedFetch((method, url) => {
    if (method === "GET" && url === `${TRACKER}/25`) return { body: over.issue ?? chore };
    if (method === "GET" && url.startsWith(`${TRACKER}/25/comments`)) return { body: [] };
    if (method === "GET" && url === RUN_API) return { body: over.run ?? failedRun };
    if (method === "GET" && url === `${RUN_API}/jobs?filter=latest&per_page=100`) return { body: over.jobs ?? jobs };
    if (method === "POST" && url === `${RUN_API}/rerun-failed-jobs`) return { status: 201, body: {} };
    if (method === "POST" && url === `${TRACKER}/25/comments`) return { status: 201, body: { html_url: `${chore.html_url}#c1` } };
    return undefined;
  });
}

describe("postAskComment", () => {
  it("posts his text on a chore after checking it fresh", async () => {
    const { fetchImpl, calls } = rerunGitHub();
    const posted = await postAskComment(new GitHub(token, fetchImpl), CHORE, "chore", "  done  ");
    assert.equal(posted.url, `${chore.html_url}#c1`);
    assert.deepEqual(calls.map((c) => c.method), ["GET", "POST"]);
    assert.deepEqual(calls[1]?.body, { body: "done\n" });
  });

  const refusals: [string, string, unknown, RegExp][] = [
    ["a command line", "ok\n/promote", chore, /bot command/],
    ["an empty comment", " ", chore, /write a comment/],
    ["a chore as a review", "done", { ...chore, labels: [{ name: "review" }] }, /not labelled "chore"/],
    ["a chore someone else opened", "done", { ...chore, user: { login: "someone" } }, /not opened by cgwalters-bot/],
    ["a closed chore", "done", { ...chore, state: "closed" }, /is closed/],
  ];
  for (const [name, text, issue, want] of refusals) {
    it(`refuses ${name} without commenting`, async () => {
      const { fetchImpl, calls } = rerunGitHub({ issue });
      await assert.rejects(postAskComment(new GitHub(token, fetchImpl), CHORE, "chore", text), want);
      assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    });
  }
});

describe("loadRuns", () => {
  it("lists each run's failed jobs, and why one can't be rerun", async () => {
    const { fetchImpl } = rerunGitHub({ run: { ...failedRun, status: "in_progress", conclusion: null } });
    const [r] = await loadRuns(new GitHub(token, fetchImpl), [{ url: RUN, owner: "example-upstream", repo: "widget", id: "777" }]);
    assert.deepEqual(r?.failed, [{ name: "uki (arm)", url: `${RUN}/job/2` }]);
    assert.match(r?.problem ?? "", /in_progress, not completed/);
    const ok = await loadRuns(new GitHub(token, rerunGitHub().fetchImpl), [{ url: RUN, owner: "example-upstream", repo: "widget", id: "777" }]);
    assert.deepEqual([ok[0]?.problem, ok[0]?.status, ok[0]?.conclusion, ok[0]?.attempt], [undefined, "completed", "failure", 1]);
  });

  it("reports a run it can't read instead of failing", async () => {
    const { fetchImpl } = scriptedFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    const [r] = await loadRuns(new GitHub(token, fetchImpl), [{ url: RUN, owner: "example-upstream", repo: "widget", id: "777" }]);
    assert.match(r?.problem ?? "", /couldn't read the run: .*404/);
  });

  it("is read with a rerun chore's context", async () => {
    const item = (await queue()).get("PVTI_synthetic_chore_ask") as Item;
    const ctx = await loadContext(new GitHub(token, rerunGitHub().fetchImpl), item);
    assert.deepEqual(ctx.warnings, []);
    assert.deepEqual(ctx.runs?.map((r) => [r.run.id, r.failed.length, r.problem]), [["777", 1, undefined]]);
    // A review ask reads no runs.
    const review = (await queue()).get("PVTI_synthetic_review_ask") as Item;
    const { fetchImpl, calls } = scriptedFetch((_m, u) => (u.includes("/comments") ? { body: [] } : undefined));
    assert.equal((await loadContext(new GitHub(token, fetchImpl), review)).runs, undefined);
    assert.equal(calls.length, 1);
  });
});

describe("rerunFailedJobs", () => {
  it("reruns the failed jobs of a run the chore names, then says so", async () => {
    const { fetchImpl, calls } = rerunGitHub();
    const posted = await rerunFailedJobs(new GitHub(token, fetchImpl), CHORE, RUN);
    assert.equal(posted.url, `${chore.html_url}#c1`);
    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url.replace(API, "")}`),
      [
        "GET /repos/cgwalters-forge/tracker/issues/25",
        "GET /repos/example-upstream/widget/actions/runs/777",
        "GET /repos/example-upstream/widget/actions/runs/777/jobs?filter=latest&per_page=100",
        "POST /repos/example-upstream/widget/actions/runs/777/rerun-failed-jobs",
        "POST /repos/cgwalters-forge/tracker/issues/25/comments",
      ],
    );
    assert.deepEqual(calls.at(-1)?.body, { body: `Reran the failed jobs of ${RUN}\n` });
  });

  const other = "https://github.com/example-upstream/widget/actions/runs/778";
  const refusals: [string, string, Parameters<typeof rerunGitHub>[0], RegExp][] = [
    ["a URL that isn't a run", `${RUN}/job/2`, {}, /not a workflow run URL/],
    ["a run the chore doesn't name", other, {}, /doesn't ask to rerun .*runs\/778/],
    ["a run in another repository, same id", "https://github.com/evil/widget/actions/runs/777", {}, /doesn't ask to rerun/],
    ["a chore with an unreadable Rerun: line", RUN, { issue: { ...chore, body: `Ask: x\nRerun: \`${RUN}\`\nRerun: \`${RUN}/attempts/2\`` } }, /can't read "Rerun:/],
    ["a review ask", RUN, { issue: { ...chore, labels: [{ name: "review" }] } }, /not labelled "chore"/],
    ["a chore not assigned to him", RUN, { issue: { ...chore, assignees: [] } }, /not assigned to cgwalters/],
    ["a chore someone else opened", RUN, { issue: { ...chore, user: { login: "someone" } } }, /not opened by cgwalters-bot/],
    ["a closed chore", RUN, { issue: { ...chore, state: "closed" } }, /is closed/],
    ["a running run", RUN, { run: { ...failedRun, status: "in_progress", conclusion: null } }, /not completed/],
    ["a successful run", RUN, { run: { ...failedRun, conclusion: "success" } }, /ended success/],
    ["a run with no failed jobs", RUN, { jobs: { jobs: [{ name: "b", status: "completed", conclusion: "success" }] } }, /no failed jobs/],
    ["a run GitHub reports in another repository", RUN, { run: { ...failedRun, repository: { full_name: "evil/widget" } } }, /not in example-upstream\/widget/],
  ];
  for (const [name, url, over, want] of refusals) {
    it(`refuses ${name}, rerunning nothing`, async () => {
      const { fetchImpl, calls } = rerunGitHub(over);
      await assert.rejects(rerunFailedJobs(new GitHub(token, fetchImpl), CHORE, url), want);
      assert.equal(calls.filter((c) => c.method === "POST").length, 0);
    });
  }

  it("says the rerun happened when the comment then fails", async () => {
    const base = rerunGitHub();
    const fetchImpl = async (url: string, init?: RequestInit) =>
      init?.method === "POST" && url.endsWith("/comments") ? new Response(JSON.stringify({ message: "nope" }), { status: 403 }) : base.fetchImpl(url, init);
    await assert.rejects(rerunFailedJobs(new GitHub(token, fetchImpl), CHORE, RUN), /reran the failed jobs of .*runs\/777, but couldn't say so on cgwalters-forge\/tracker#25.*Comment there yourself/);
  });
});
