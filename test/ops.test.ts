import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import type { Item } from "../src/github/board.ts";
import {
  agentRuns,
  botEvents,
  coreHourBuckets,
  coresOf,
  type Devspace,
  devspaceOf,
  history,
  type JobCache,
  loadOps,
  outcomeOf,
  parseDevspaceTitle,
  parseEvent,
  parseJobs,
  type RawEvent,
  type RawJob,
  type RawRun,
  timeLeft,
  workGroups,
} from "../src/github/ops.ts";
import { coreHoursText, duration, leftText, opsView, tickOps } from "../src/github/opsview.ts";
import { fields, fixture, installDom, scriptedFetch } from "./helpers.ts";

installDom();

const API = "https://api.github.com";
const REPO = `${API}/repos/bootc-dev/cgwalters-devspace-sandbox`;
const NOW = Date.parse("2026-09-28T15:12:05Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

// Trimmed from the real API on 2026-09-28: one live devspace, two
// stopped, one that ran out its duration.
const runs = () => fixture<{ workflow_runs: RawRun[] }>("ops-runs.json").workflow_runs;
const jobs = () => fixture<Record<string, RawJob[]>>("ops-jobs.json");
const events = () => fixture<RawEvent[]>("ops-events.json");

function row(id: number): Devspace {
  const run = runs().find((r) => r.id === id);
  assert.ok(run);
  const d = devspaceOf(run, parseJobs(jobs()[String(id)] ?? []));
  assert.ok(d);
  return d;
}

describe("parseDevspaceTitle", () => {
  const cases: [string | undefined, ReturnType<typeof parseDevspaceTitle>][] = [
    ["Devspace review-ops", { name: "review-ops" }],
    ["Devspace bootc-2482 (16c, 120m)", { name: "bootc-2482", cores: 16, durationMin: 120 }],
    [" Devspace a.b_c ", { name: "a.b_c" }],
    ["Devspace ", undefined],
    ["Devspace two words", undefined],
    ["Agent bootc#1", undefined],
    [undefined, undefined],
  ];
  for (const [title, want] of cases) it(JSON.stringify(title), () => assert.deepEqual(parseDevspaceTitle(title), want));
});

describe("coresOf", () => {
  const cases: [string[] | undefined, number | undefined][] = [
    [["rhel10-x86_64-4c-16g"], 4],
    [["rhel10-x86_64-16c-64g"], 16],
    [["self-hosted", "rhel10-x86_64-64c-256g"], 64],
    [["ubuntu-latest"], undefined],
    [["x86_64-abc-16g"], undefined],
    [undefined, undefined],
  ];
  for (const [labels, want] of cases) it(JSON.stringify(labels), () => assert.equal(coresOf(labels), want));
});

describe("outcomeOf", () => {
  const cases: [string | null, string][] = [
    ["cancelled", "stopped"],
    ["success", "expired"],
    ["failure", "failed"],
    ["timed_out", "failed"],
    ["startup_failure", "failed"],
    ["skipped", "other"],
    [null, "other"],
  ];
  for (const [c, want] of cases) it(String(c), () => assert.equal(outcomeOf(c), want));
});

describe("devspaceOf", () => {
  it("makes a live run a row with its host, size and phase", () => {
    assert.deepEqual(row(36439387350), {
      id: 36439387350,
      name: "selinux-3327",
      host: "cgwalters-devspace-36439387350",
      url: "https://github.com/bootc-dev/cgwalters-devspace-sandbox/actions/runs/36439387350",
      phase: "ready",
      cores: 16,
      createdAt: "2026-09-28T14:53:31Z",
      startedAt: "2026-09-28T14:55:34Z",
      readyAt: "2026-09-28T14:56:26Z",
    });
  });
  it("counts a cancelled run as stopped, not failed", () => {
    const d = row(36439856834);
    assert.equal(d.phase, "done");
    assert.equal(d.outcome, "stopped");
    assert.equal(d.endedAt, "2026-09-28T15:04:10Z");
  });
  it("counts a successful run as expired", () => assert.equal(row(36422184366).outcome, "expired"));

  const base: RawRun = { id: 7, html_url: "https://github.com/x/actions/runs/7", display_title: "Devspace n (4c, 30m)", created_at: "2026-09-28T15:00:00Z" };
  const step = (status: string) => [{ name: "Prepare OpenSSH and keep the devspace available", status, started_at: status === "pending" ? null : "2026-09-28T15:02:00Z" }];
  const phases: [string, string, RawJob[] | undefined, string][] = [
    ["queued run", "queued", undefined, "queued"],
    ["in progress, no job yet", "in_progress", undefined, "queued"],
    ["setting up", "in_progress", [{ started_at: "2026-09-28T15:01:00Z", steps: step("pending") }], "starting"],
    ["keep step running", "in_progress", [{ started_at: "2026-09-28T15:01:00Z", steps: step("in_progress") }], "ready"],
    ["keep step done", "in_progress", [{ started_at: "2026-09-28T15:01:00Z", steps: step("completed") }], "ending"],
    ["completed", "completed", undefined, "done"],
  ];
  for (const [what, status, js, want] of phases) {
    it(`phase: ${what}`, () => assert.equal(devspaceOf({ ...base, status }, js ? parseJobs(js) : undefined)?.phase, want));
  }
  it("takes cores and minutes from the title when the job doesn't say", () => {
    const d = devspaceOf({ ...base, status: "queued" }, undefined);
    assert.equal(d?.cores, 4);
    assert.equal(d?.durationMin, 30);
  });
  it("skips runs that aren't devspaces", () => assert.equal(devspaceOf({ ...base, display_title: "Development runner" }, undefined), undefined));
});

describe("timeLeft", () => {
  const base: Devspace = {
    id: 1, name: "n", host: "h", url: "u", phase: "ready", createdAt: "2026-09-28T15:00:00Z",
    startedAt: "2026-09-28T15:00:00Z", readyAt: "2026-09-28T15:02:05Z",
  };
  const { readyAt: _, ...notReady } = base;
  const cases: [string, Devspace, ReturnType<typeof timeLeft>][] = [
    ["known duration, from the keep step", { ...base, durationMin: 30 }, { ms: 20 * MIN, totalMs: 30 * MIN, bound: "known" }],
    ["unknown: bounded by the longest", base, { ms: 230 * MIN, totalMs: 240 * MIN, bound: "max" }],
    ["past its end", { ...base, durationMin: 5 }, { ms: 0, totalMs: 5 * MIN, bound: "known" }],
    ["starting: from the job's start", { ...notReady, phase: "starting", durationMin: 60 }, { ms: 48 * MIN - 5000, totalMs: 60 * MIN, bound: "known" }],
    ["queued", { ...base, phase: "queued" }, undefined],
    ["done", { ...base, phase: "done" }, undefined],
  ];
  const now = Date.parse("2026-09-28T15:12:05Z");
  for (const [what, d, want] of cases) it(what, () => assert.deepEqual(timeLeft(d, now), want));
});

describe("coreHourBuckets and history", () => {
  const dev = (name: string, cores: number | undefined, start: number, end: number | undefined, outcome?: Devspace["outcome"]): Devspace => ({
    id: 1, name, host: "h", url: "u",
    phase: end === undefined ? "ready" : "done",
    createdAt: new Date(start).toISOString(),
    startedAt: new Date(start).toISOString(),
    ...(end !== undefined ? { endedAt: new Date(end).toISOString() } : {}),
    ...(cores ? { cores } : {}),
    ...(outcome ? { outcome } : {}),
  });
  const now = Date.parse("2026-09-28T12:00:00Z");
  const list = [
    // 16 cores for the last 30 minutes, still running: 8 core-hours in the last bucket.
    dev("live", 16, now - 30 * MIN, undefined),
    // 4 cores for two hours ending an hour ago: 4 core-hours in each of the two hours before the last.
    dev("two-hours", 4, now - 3 * HOUR, now - HOUR, "stopped"),
    // Started before the window: only its part inside counts, and it isn't counted as started.
    dev("old", 64, now - 25 * HOUR, now - 23 * HOUR - 30 * MIN, "expired"),
    dev("broken", 16, now - 2 * HOUR, now - 2 * HOUR + 6 * MIN, "failed"),
    dev("unsized", undefined, now - HOUR, now - 30 * MIN, "stopped"),
  ];
  it("spreads runner time over hourly buckets", () => {
    const b = coreHourBuckets(list, now, 4);
    assert.deepEqual(b.map((x) => Math.round(x * 100) / 100), [0, 4, 4 + 1.6, 8]);
  });
  it("sums the window and counts outcomes of devspaces started in it", () => {
    const h = history(list, now, 24);
    assert.equal(h.count, 4);
    assert.equal(Math.round(h.coreHours * 100) / 100, 8 + 8 + 1.6 + 32);
    assert.deepEqual(h.outcomes, { stopped: 2, expired: 0, failed: 1, other: 0 });
    assert.equal(h.unsized, 1);
  });
  it("on the real snapshot: 16 cores each, one still up", () => {
    const all = [36439387350, 36439856834, 36422184366, 36418863271].map(row);
    const h = history(all, NOW, 24);
    assert.equal(h.count, 4);
    assert.deepEqual(h.outcomes, { stopped: 2, expired: 1, failed: 0, other: 0 });
    // 16 × (16m31s live + 6m54s + 60m36s + 8m14s) of runner time.
    const minutes = (16 * 60 + 31 + 6 * 60 + 54 + 60 * 60 + 36 + 8 * 60 + 14) / 60;
    assert.equal(h.coreHours.toFixed(3), ((16 * minutes) / 60).toFixed(3));
  });
});

describe("agentRuns", () => {
  const run = (id: number, status: string, conclusion: string | null = null): RawRun => ({
    id, html_url: `https://github.com/x/actions/runs/${id}`, display_title: `Agent ${id}`, status, conclusion, created_at: "2026-09-28T10:00:00Z",
  });
  it("lists active runs first, then the newest finished", () => {
    const got = agentRuns([run(5, "completed", "success"), run(4, "in_progress"), run(3, "completed", "failure"), run(2, "completed", "cancelled")], 2);
    assert.deepEqual(got.map((r) => [r.id, r.active, r.outcome]), [[4, true, undefined], [5, false, "expired"], [3, false, "failed"]]);
  });
});

describe("workGroups", () => {
  const item = (nodeId: string, url: string | undefined, over: Partial<Item> = {}): Item => ({
    id: 1, nodeId, kind: url ? "issue" : "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [],
    ...(url ? { url, ref: { owner: url.split("/")[3] ?? "", repo: url.split("/")[4] ?? "", number: 1 } } : {}),
    ...over,
  });
  it("splits upstream from the bot's own like the queue's presets, by priority", () => {
    const groups = workGroups([
      item("infra", "https://github.com/cgwalters-bot/cgwalters-bot/issues/11", { org: "cgwalters-bot", priority: "P1" }),
      item("upstream-p2", "https://github.com/fedora-selinux/selinux-policy/pull/3327", { priority: "P2" }),
      item("upstream-p0", "https://github.com/cgwalters-forge/tracker/issues/160", { org: "bootc-dev", priority: "P0" }),
      item("tracker-no-org", "https://github.com/cgwalters-forge/tracker/issues/1"),
    ]);
    assert.deepEqual(groups.map((g) => [g.scope, g.items.map((i) => i.nodeId)]), [
      ["composefs", ["upstream-p0", "upstream-p2"]],
      ["infra", ["infra"]],
      ["none", ["tracker-no-org"]],
    ]);
  });
});

describe("parseEvent", () => {
  const ev = (type: string, payload: NonNullable<RawEvent["payload"]>, repo = "o/r"): RawEvent => ({ id: "1", type, created_at: "2026-09-28T15:00:00Z", repo: { name: repo }, payload });
  const head = "379ba6cfd2dcca2a36722271d8754d783e82312f";
  const cases: [string, RawEvent, Partial<ReturnType<typeof parseEvent>> | undefined][] = [
    ["push", ev("PushEvent", { ref: "refs/heads/bot/x", head }), { kind: "push", verb: "pushed", target: "bot/x", url: `https://github.com/o/r/commit/${head}` }],
    ["push without a head", ev("PushEvent", { ref: "refs/heads/bot/x" }), { url: "https://github.com/o/r" }],
    ["PR opened", ev("PullRequestEvent", { action: "opened", number: 31, pull_request: { number: 31 } }), { kind: "pr", verb: "opened PR", target: "#31", url: "https://github.com/o/r/pull/31" }],
    ["PR closed as merged", ev("PullRequestEvent", { action: "closed", pull_request: { number: 2, merged: true } }), { verb: "merged PR" }],
    ["review", ev("PullRequestReviewEvent", { pull_request: { number: 4 }, review: { state: "APPROVED", html_url: "https://github.com/o/r/pull/4#r" } }), { kind: "review", verb: "reviewed (approved)", url: "https://github.com/o/r/pull/4#r" }],
    ["issue comment", ev("IssueCommentEvent", { issue: { number: 9, title: "T" }, comment: { html_url: "https://github.com/o/r/issues/9#c" } }), { kind: "comment", verb: "commented on", title: "T", url: "https://github.com/o/r/issues/9#c" }],
    ["issue closed", ev("IssuesEvent", { action: "closed", issue: { number: 9, html_url: "https://github.com/o/r/issues/9" } }), { kind: "issue", verb: "closed issue" }],
    ["branch created", ev("CreateEvent", { ref: "bot/y", ref_type: "branch" }), { kind: "branch", verb: "created branch", url: "https://github.com/o/r/tree/bot/y" }],
    ["tag created", ev("CreateEvent", { ref: "v1", ref_type: "tag" }), undefined],
    ["star", ev("WatchEvent", {}), undefined],
    ["bad repo name", ev("PushEvent", { ref: "refs/heads/x" }, "javascript:alert(1)"), undefined],
  ];
  for (const [what, raw, want] of cases) {
    it(what, () => {
      const got = parseEvent(raw);
      if (want === undefined) assert.equal(got, undefined);
      else for (const [k, v] of Object.entries(want)) assert.deepEqual(got?.[k as keyof typeof got], v, k);
    });
  }
});

describe("botEvents", () => {
  it("parses the real snapshot, newest first, skipping nothing it knows", () => {
    const got = botEvents(events());
    assert.equal(got.length, 14);
    assert.deepEqual(got[0], { kind: "pr", repo: "cgwalters-bot/homegit", verb: "opened PR", target: "#31", url: "https://github.com/cgwalters-bot/homegit/pull/31", at: "2026-09-28T15:11:24Z", count: 1 });
    assert.ok(got.every((e, i) => i === 0 || (got[i - 1]?.at ?? "") >= e.at));
  });
  it("folds a run of the same action on the same thing", () => {
    const c = (id: string, at: string, n: number): RawEvent => ({ id, type: "IssueCommentEvent", created_at: at, repo: { name: "o/r" }, payload: { issue: { number: n } } });
    const got = botEvents([c("1", "2026-01-01T00:00:03Z", 1), c("2", "2026-01-01T00:00:02Z", 1), c("3", "2026-01-01T00:00:01Z", 2), c("4", "2026-01-01T00:00:00Z", 1)]);
    assert.deepEqual(got.map((e) => [e.target, e.count]), [["#1", 2], ["#2", 1], ["#1", 1]]);
  });
});

describe("formatting", () => {
  const cases: [string, string][] = [
    [duration(0), "0m 00s"],
    [duration(65_000), "1m 05s"],
    [duration(3 * HOUR + 7 * MIN + 59_000), "3h 07m"],
    [duration(30_000, false), "<1m"],
    [duration(12 * MIN, false), "12m"],
    [leftText(20 * MIN, false), "20m 00s left"],
    [leftText(2 * HOUR, true), "≤ 2h 00m left"],
    [leftText(0, false), "ending now"],
    [coreHoursText(7.44), "7.4"],
    [coreHoursText(123.6), "124"],
  ];
  for (const [got, want] of cases) it(want, () => assert.equal(got, want));
});

describe("loadOps", () => {
  const raw = (status: string, org: string, n: number) => ({
    id: n, node_id: `PVTI_${n}`, content_type: "Issue",
    content: { title: `<b>item ${n}</b>`, html_url: `https://github.com/cgwalters-forge/tracker/issues/${n}`, state: "open" },
    fields: [
      { id: 102, name: "Status", value: { name: { raw: status } } },
      { id: 105, name: "Org", value: { name: { raw: org } } },
      { id: 106, name: "Branch", value: { raw: "https://github.com/cgwalters-forge/bootc/pull/31" } },
    ],
  });
  const script = (agent: "missing" | "present") =>
    scriptedFetch((_m, url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/workflows/devspace.yml/runs")) return { body: { workflow_runs: runs() } };
      if (u.pathname.endsWith("/workflows/agent.yml/runs")) {
        return agent === "missing" ? { status: 404, body: { message: "Not Found" } } : { body: { workflow_runs: [{ id: 1, html_url: "https://github.com/x/actions/runs/1", display_title: "Agent", status: "in_progress", created_at: "2026-09-28T15:00:00Z" }] } };
      }
      const job = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
      if (job?.[1]) return { body: { jobs: jobs()[job[1]] ?? [] } };
      if (u.pathname.endsWith("/projectsV2/1/fields")) return { body: fields() };
      if (u.pathname.endsWith("/projectsV2/1/items")) return { body: [raw("In Progress", "bootc-dev", 1), raw("In Progress", "cgwalters-bot", 2), raw("Draft", "bootc-dev", 3)] };
      if (u.pathname === "/users/cgwalters-bot/events/public") return { body: events() };
      return undefined;
    });

  it("reads every section, and a finished run's job only once", async () => {
    const { fetchImpl, calls } = script("missing");
    const gh = new GitHub(async () => "t", fetchImpl);
    const cache: JobCache = new Map();
    const ops = await loadOps(gh, cache, NOW);
    assert.deepEqual(ops.warnings, []);
    assert.deepEqual(ops.agents, { deployed: false });
    assert.deepEqual(ops.devspaces?.devspaces.map((d) => [d.name, d.phase, d.cores]), [
      ["selinux-finalize", "done", 16],
      ["selinux-3327", "ready", 16],
      ["bootc-2504", "done", 16],
      ["praxis-opencode", "done", 16],
    ]);
    assert.equal(ops.devspaces?.partial, false);
    assert.deepEqual(ops.work?.map((i) => i.nodeId), ["PVTI_1", "PVTI_2"]);
    assert.equal(ops.events?.length, 14);
    assert.equal(new URL(calls.find((c) => c.url.includes("/items"))?.url ?? "").searchParams.get("q"), 'status:"In Progress"');

    const before = calls.length;
    await loadOps(gh, cache, NOW);
    const jobReads = calls.slice(before).filter((c) => c.url.includes("/jobs"));
    assert.deepEqual(jobReads.map((c) => new URL(c.url).pathname), [`${new URL(REPO).pathname}/actions/runs/36439387350/jobs`]);
  });

  it("keeps the other sections when one fails", async () => {
    const failing = scriptedFetch(() => ({ status: 500, body: { message: "boom" } }));
    const ok = script("present");
    const gh = new GitHub(async () => "t", (url, init) => (url.includes("/events/") ? failing.fetchImpl(url, init) : ok.fetchImpl(url, init)));
    const ops = await loadOps(gh, new Map(), NOW);
    assert.equal(ops.events, undefined);
    assert.equal(ops.warnings.length, 1);
    assert.match(ops.warnings[0] ?? "", /cgwalters-bot's recent activity.*HTTP 500/);
    assert.equal(ops.agents?.deployed, true);
    assert.equal(ops.devspaces?.devspaces.length, 4);
  });
});

describe("opsView", () => {
  async function view(agent: "missing" | "present" = "missing") {
    const { fetchImpl } = scriptedFetch((_m, url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/workflows/devspace.yml/runs")) return { body: { workflow_runs: runs() } };
      if (u.pathname.endsWith("/workflows/agent.yml/runs")) return agent === "missing" ? { status: 404, body: {} } : { body: { workflow_runs: [] } };
      const job = /\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
      if (job?.[1]) return { body: { jobs: jobs()[job[1]] ?? [] } };
      if (u.pathname.endsWith("/fields")) return { body: fields() };
      if (u.pathname.endsWith("/items")) return { body: [] };
      if (u.pathname.endsWith("/events/public")) {
        return { body: [{ id: "x", type: "IssueCommentEvent", created_at: "2026-09-28T15:00:00Z", repo: { name: "o/r" }, payload: { issue: { number: 1, title: "<img src=x onerror=alert(1)>" }, comment: { html_url: "javascript:alert(1)" } } }] };
      }
      return undefined;
    });
    return opsView(await loadOps(new GitHub(async () => "t", fetchImpl), new Map(), NOW), NOW);
  }

  it("shows the live devspace with its host, size and a bounded time left", async () => {
    const el = await view();
    const live = el.querySelectorAll(".ds-row");
    assert.equal(live.length, 1);
    const text = live[0]?.textContent ?? "";
    assert.match(text, /selinux-3327/);
    assert.match(text, /cgwalters-devspace-36439387350/);
    assert.match(text, /16c/);
    assert.match(text, /up 16m 31s/);
    // Unknown duration: counted down from the longest, from the keep step's start.
    assert.match(text, /≤ 3h 44m left/);
    assert.equal(el.querySelectorAll("details.history li").length, 3);
    assert.match(el.querySelector(".tiles")?.textContent ?? "", /none failed · 2 stopped · 1 expired/);
    assert.equal(el.querySelectorAll(".spark rect").length, 24);
  });

  it("says agent.yml isn't there yet, and that local agents aren't published", async () => {
    const text = (await view()).textContent ?? "";
    assert.match(text, /Not deployed yet: bootc-dev\/cgwalters-devspace-sandbox has no agent\.yml/);
    assert.match(text, /Local agents: not published yet/);
    assert.match(text, /Nothing is In Progress/);
    assert.match((await view("present")).textContent ?? "", /No agent runs yet/);
  });

  it("renders event text as text, and unsafe links as plain text", async () => {
    const el = await view();
    assert.equal(el.querySelector("img"), null);
    assert.match(el.querySelector(".ev")?.textContent ?? "", /<img src=x onerror=alert\(1\)>/);
    assert.equal([...el.querySelectorAll(".ev a")].length, 0);
  });

  it("ticks the live times in place", async () => {
    const el = await view();
    tickOps(el, NOW + 65_000);
    const text = el.querySelector(".ds-row")?.textContent ?? "";
    assert.match(text, /up 17m 36s/);
    assert.match(text, /≤ 3h 43m left/);
    const bar = el.querySelector(".tick-bar");
    assert.ok(Number(bar?.getAttribute("width")) < 100 * (224 / 240));
  });
});
