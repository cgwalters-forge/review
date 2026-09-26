import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Item } from "../src/github/board.ts";
import type { ForgePr, Verdict } from "../src/github/forge.ts";
import { buildEntries, effectivePriority, type Entry, groupRanked, priorityRank, rankEntries, SETTLED_GROUP } from "../src/github/queue.ts";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [], status: "Needs human", ...over };
}

const TRACKER = "https://github.com/cgwalters-forge/tracker/issues";

/** A tracker issue on the board. */
function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return item(nodeId, { kind: "issue", url: `${TRACKER}/${number}`, ref: { owner: "cgwalters-forge", repo: "tracker", number }, state: "open", ...over });
}

/** A question issue in the tracker blocking `blocks`. */
function question(nodeId: string, number: number, blocks: string, over: Partial<Item> = {}): Item {
  return tracked(nodeId, number, { labels: ["question"], body: `Blocks: ${blocks}\nQ: which?\nOptions:\nA) this\nB) that\n`, ...over });
}

function pr(owner: string, repo: string, number: number, over: Partial<ForgePr> = {}): ForgePr {
  return {
    ref: { owner, repo, number },
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `${repo} #${number}`,
    body: "",
    author: "cgwalters-bot",
    createdAt: "2026-01-10T00:00:00Z",
    updatedAt: "2026-01-11T00:00:00Z",
    draft: true,
    ...over,
  };
}

const meta = (item: string) =>
  `Text\n\n<!-- bot-meta -->\n---\n- Upstream: \`up/r\`, base \`main\`\n- Board item: \`${item}\`\n<!-- /bot-meta -->`;

describe("priorityRank", () => {
  const cases: [string | undefined, number][] = [["P0", 0], ["P2", 2], ["P3", 3], ["P9", 4], [undefined, 5]];
  for (const [p, want] of cases) it(String(p), () => assert.equal(priorityRank(p), want));
});

describe("rankEntries", () => {
  it("puts P0 first, then the oldest, undated last, then by key", () => {
    const e = (key: string, priority?: string, since?: string): Entry => ({
      key, kind: "chore", title: key, where: "", href: "#",
      ...(priority ? { priority } : {}),
      ...(since ? { since } : {}),
    });
    const ranked = rankEntries([
      e("new-p1", "P1", "2026-03-01T00:00:00Z"),
      e("none", undefined, "2020-01-01T00:00:00Z"),
      e("old-p1", "P1", "2026-01-01T00:00:00Z"),
      e("undated-p1", "P1"),
      e("bad-date-p1", "P1", "yesterday"),
      e("p0", "P0", "2026-06-01T00:00:00Z"),
      e("odd", "P7", "2026-01-01T00:00:00Z"),
    ]);
    assert.deepEqual(ranked.map((x) => x.key), ["p0", "old-p1", "new-p1", "bad-date-p1", "undated-p1", "odd", "none"]);
    assert.deepEqual(groupRanked(ranked).map((g) => [g.priority, g.entries.length]), [["P0", 1], ["P1", 4], ["P7", 1], ["No priority", 1]]);
  });

  it("puts settled entries last, under their own heading", () => {
    const e = (key: string, priority: string, settled: boolean): Entry => ({ key, kind: "question", title: key, where: "", href: "#", priority, settled });
    const ranked = rankEntries([e("done-p0", "P0", true), e("p2", "P2", false), e("p1", "P1", false), e("done-p1", "P1", true)]);
    assert.deepEqual(ranked.map((x) => x.key), ["p1", "p2", "done-p0", "done-p1"]);
    assert.deepEqual(groupRanked(ranked).map((g) => [g.priority, g.entries.length]), [["P1", 1], ["P2", 1], [SETTLED_GROUP, 2]]);
  });
});

describe("buildEntries", () => {
  const verdicts = (pairs: [string, Verdict["state"]][]) => new Map(pairs.map(([k, state]) => [k, { state }]));

  it("merges board items and forge PRs into one ranked list", () => {
    const items = [
      question("PVTI_q", 2, "https://github.com/elsewhere/r/issues/1", { priority: "P1", createdAt: "2026-01-05T00:00:00Z" }),
      item("PVTI_chore", { why: "Please rerun the job", priority: "P0", createdAt: "2026-02-01T00:00:00Z" }),
      item("PVTI_trackmeta", { status: "Draft", priority: "P0", branch: [] }),
      item("PVTI_trackbranch", { status: "Draft", priority: "P2", branch: ["https://github.com/cgwalters-forge/b/pull/2"] }),
      item("PVTI_stale", { status: "Draft", priority: "P0", branch: ["https://github.com/cgwalters-forge/c/pull/9"] }),
      item("PVTI_gist", { status: "Draft", priority: "P1", gist: ["https://gist.github.com/x/1"], createdAt: "2026-01-01T00:00:00Z" }),
      item("PVTI_todo", { status: "Todo", priority: "P0" }),
    ];
    const prs = [
      pr("cgwalters-forge", "a", 1, { body: meta("PVTI_trackmeta"), createdAt: "2026-01-20T00:00:00Z" }),
      pr("cgwalters-forge", "b", 2),
      pr("cgwalters-forge", "untracked", 3),
    ];
    const entries = buildEntries(items, prs, verdicts([]));
    assert.deepEqual(
      entries.map((e) => [e.key, e.kind, e.priority ?? "-"]),
      [
        ["pr:cgwalters-forge/a#1", "pr", "P0"],
        ["item:PVTI_chore", "item", "P0"],
        ["item:PVTI_gist", "item", "P1"],
        ["item:PVTI_q", "question", "P1"],
        ["pr:cgwalters-forge/b#2", "pr", "P2"],
        ["pr:cgwalters-forge/untracked#3", "pr", "-"],
      ],
    );
    const first = entries[0];
    assert.equal(first?.href, "#pr/cgwalters-forge/a/1");
    assert.equal(first?.item?.nodeId, "PVTI_trackmeta");
    assert.equal(entries.find((e) => e.kind === "question")?.href, "#item/PVTI_q");
  });

  it("keeps a PR while it waits on him, and drops it and its Draft item otherwise", () => {
    const items = [item("PVTI_t", { status: "Draft", priority: "P0", branch: ["https://github.com/cgwalters-forge/a/pull/1"] })];
    const cases: [Verdict["state"], boolean][] = [
      ["none", true],
      ["approved-older", true],
      ["changes-requested-older", true],
      ["approved", false],
      ["changes-requested", false],
      ["promoted", true],
    ];
    for (const [state, listed] of cases) {
      const entries = buildEntries(items, [pr("cgwalters-forge", "a", 1)], verdicts([["cgwalters-forge/a#1", state]]));
      assert.deepEqual(entries.map((e) => e.key), listed ? ["pr:cgwalters-forge/a#1"] : [], state);
      if (listed) assert.equal(entries[0]?.verdict?.state, state);
    }
  });

  it("keeps a Needs human item about a forge PR as its own entry", () => {
    const items = [item("PVTI_nh", { branch: ["https://github.com/cgwalters-forge/a/pull/1"], why: "Please look" })];
    const keys = buildEntries(items, [pr("cgwalters-forge", "a", 1)], verdicts([])).map((e) => e.key);
    assert.deepEqual(keys.sort(), ["item:PVTI_nh", "pr:cgwalters-forge/a#1"]);
  });

  it("takes ask kinds from tracker issues' labels only", () => {
    const items = [
      question("PVTI_q", 1, `${TRACKER}/9`),
      tracked("PVTI_rev", 3, { labels: ["review"], body: `Blocks: ${TRACKER}/9` }),
      tracked("PVTI_do", 4, { labels: ["chore"], body: `Blocks: ${TRACKER}/9` }),
      tracked("PVTI_both", 5, { labels: ["chore", "review"] }),
      tracked("PVTI_plain", 2, { why: "Options:\nA) x\nB) y" }),
      item("PVTI_upstream", { kind: "pr", ref: { owner: "up", repo: "r", number: 1 }, labels: ["question"] }),
      item("PVTI_draft", { body: "Options:\nA) x\nB) y" }),
    ];
    assert.deepEqual(
      buildEntries(items, [], verdicts([])).map((e) => [e.key, e.kind]).sort(),
      [
        ["item:PVTI_both", "item"],
        ["item:PVTI_do", "chore"],
        ["item:PVTI_draft", "item"],
        ["item:PVTI_plain", "item"],
        ["item:PVTI_q", "question"],
        ["item:PVTI_rev", "review"],
        ["item:PVTI_upstream", "item"],
      ],
    );
  });

  it("nests every kind of ask under the item it blocks, and flags Needs human items left without one", () => {
    const upstream = "https://github.com/example-upstream/widget/issues/7";
    const items = [
      item("PVTI_up", { kind: "issue", url: upstream, ref: { owner: "example-upstream", repo: "widget", number: 7 }, priority: "P1" }),
      tracked("PVTI_rev", 24, { labels: ["review"], body: `Blocks: \`${upstream}\`` }),
      tracked("PVTI_do", 25, { labels: ["chore"], body: `Blocks: \`${upstream}\`` }),
      item("PVTI_lonely", { kind: "issue", ref: { owner: "example-upstream", repo: "widget", number: 8 } }),
      item("PVTI_gist", { status: "Draft", gist: ["https://gist.github.com/x/1"] }),
      // Only a closed ask left: still a bug.
      item("PVTI_stale", { kind: "issue", ref: { owner: "example-upstream", repo: "widget", number: 9 } }),
      tracked("PVTI_old", 26, { labels: ["chore"], state: "closed", body: "Blocks: `https://github.com/example-upstream/widget/issues/9`" }),
    ];
    const entries = buildEntries(items, [], verdicts([]));
    assert.deepEqual(
      entries.map((e) => [e.key, e.children?.map((c) => c.kind) ?? [], e.bug ?? false]),
      [
        ["item:PVTI_up", ["chore", "review"], false],
        ["item:PVTI_gist", [], false],
        ["item:PVTI_lonely", [], true],
        ["item:PVTI_stale", ["chore"], true],
      ],
    );
  });

  it("settles questions he answered or the bot closed", () => {
    const items = [
      question("PVTI_open", 1, `${TRACKER}/9`, { priority: "P2" }),
      question("PVTI_answered", 2, `${TRACKER}/9`, { priority: "P0" }),
      question("PVTI_closed", 3, `${TRACKER}/9`, { priority: "P0", state: "closed" }),
    ];
    const entries = buildEntries(items, [], verdicts([]), true, new Set(["PVTI_answered"]));
    assert.deepEqual(entries.map((e) => [e.key, e.settled ?? false]), [
      ["item:PVTI_open", false],
      ["item:PVTI_answered", true],
      ["item:PVTI_closed", true],
    ]);
  });

  it("nests a question under the listed item it blocks", () => {
    const upstream = "https://github.com/example-upstream/widget/pull/42";
    const items = [
      tracked("PVTI_epic", 20, { priority: "P2" }),
      // A sub-issue of the epic, whatever its Blocks: line says.
      question("PVTI_sub", 21, "https://github.com/o/r/issues/1", { parent: { owner: "cgwalters-forge", repo: "tracker", number: 20 }, priority: "P0" }),
      question("PVTI_sub2", 25, `${TRACKER}/20`, { priority: "P1" }),
      item("PVTI_up", { kind: "pr", url: upstream, ref: { owner: "example-upstream", repo: "widget", number: 42 }, priority: "P1" }),
      question("PVTI_upq", 22, upstream),
      // The blocked item isn't in the queue: top-level, noting it.
      question("PVTI_lone", 23, `${TRACKER}/99`, { priority: "P3" }),
      // Questions don't nest under questions.
      question("PVTI_qq", 24, `${TRACKER}/23`, { priority: "P3" }),
    ];
    const entries = buildEntries(items, [], verdicts([]));
    const shape = (es: readonly Entry[]): unknown[] => es.map((e) => (e.children ? [e.key, shape(e.children)] : e.key));
    // The P2 epic ranks as P0 by its P0 sub-issue question.
    assert.deepEqual(shape(entries), [
      ["item:PVTI_epic", ["item:PVTI_sub", "item:PVTI_sub2"]],
      ["item:PVTI_up", ["item:PVTI_upq"]],
      "item:PVTI_lone",
      "item:PVTI_qq",
    ]);
    assert.equal(entries.find((e) => e.key === "item:PVTI_lone")?.blocks, "cgwalters-forge/tracker#99");
    assert.equal(entries.find((e) => e.key === "item:PVTI_qq")?.blocks, "cgwalters-forge/tracker#23");
    assert.equal(entries.find((e) => e.key === "item:PVTI_up")?.blocks, undefined);
  });

  it("nests a question blocking a tracker issue under the forge PR that folded in its Draft item", () => {
    const items = [
      tracked("PVTI_task", 30, { status: "Draft", priority: "P2", branch: ["https://github.com/cgwalters-forge/a/pull/1"] }),
      question("PVTI_sub", 31, `${TRACKER}/30`, { parent: { owner: "cgwalters-forge", repo: "tracker", number: 30 } }),
      question("PVTI_blocks", 32, `${TRACKER}/30`),
      // Needs human, so not folded into its forge PR: its question nests
      // under its own entry, not the PR's.
      tracked("PVTI_nh", 40),
      question("PVTI_nhq", 41, `${TRACKER}/40`, { parent: { owner: "cgwalters-forge", repo: "tracker", number: 40 } }),
    ];
    const prs = [pr("cgwalters-forge", "a", 1), pr("cgwalters-forge", "b", 2, { body: meta("PVTI_nh") })];
    const entries = buildEntries(items, prs, verdicts([]));
    assert.deepEqual(entries.map((e) => [e.key, e.item?.nodeId, e.children?.map((c) => c.key)]), [
      ["pr:cgwalters-forge/a#1", "PVTI_task", ["item:PVTI_blocks", "item:PVTI_sub"]],
      ["pr:cgwalters-forge/b#2", "PVTI_nh", undefined],
      ["item:PVTI_nh", "PVTI_nh", ["item:PVTI_nhq"]],
    ]);
  });

  it("ranks a parent by its most urgent open question, keeping its own priority", () => {
    const items = [
      tracked("PVTI_parent", 20, { priority: "P2", createdAt: "2026-01-01T00:00:00Z" }),
      question("PVTI_p0", 21, `${TRACKER}/20`, { priority: "P0" }),
      question("PVTI_p3", 22, `${TRACKER}/20`, { priority: "P3" }),
      tracked("PVTI_p1", 23, { priority: "P1" }),
      tracked("PVTI_quiet", 24, { priority: "P3" }),
      question("PVTI_answered_p0", 25, `${TRACKER}/24`, { priority: "P0" }),
    ];
    const entries = buildEntries(items, [], verdicts([]), true, new Set(["PVTI_answered_p0"]));
    assert.deepEqual(entries.map((e) => [e.key, e.priority, effectivePriority(e)]), [
      ["item:PVTI_parent", "P2", "P0"],
      ["item:PVTI_p1", "P1", "P1"],
      // An answered question doesn't raise its parent.
      ["item:PVTI_quiet", "P3", "P3"],
    ]);
    assert.deepEqual(groupRanked(entries).map((g) => [g.priority, g.entries.length]), [["P0", 1], ["P1", 1], ["P3", 1]]);
  });

  it("nests a question blocking a forge PR under the PR", () => {
    const items = [question("PVTI_q", 1, "https://github.com/cgwalters-forge/a/pull/1")];
    const entries = buildEntries(items, [pr("cgwalters-forge", "a", 1)], verdicts([]));
    assert.deepEqual(entries.map((e) => [e.key, e.children?.map((c) => c.key)]), [["pr:cgwalters-forge/a#1", ["item:PVTI_q"]]]);
  });

  it("drops no forge-only Draft item before the forge was read", () => {
    const items = [item("PVTI_f", { status: "Draft", branch: ["https://github.com/cgwalters-forge/a/pull/1"] })];
    assert.deepEqual(buildEntries(items, [], verdicts([])).length, 0);
    assert.deepEqual(buildEntries(items, [], verdicts([]), false).map((e) => [e.key, e.kind]), [["item:PVTI_f", "item"]]);
  });

  it("keeps a Draft item whose Branch is not only forge PRs", () => {
    const items = [item("PVTI_up", { status: "Draft", branch: ["https://github.com/up/r/compare/main...cgwalters-bot:bot/x"] })];
    assert.deepEqual(buildEntries(items, [], verdicts([])).map((e) => e.kind), ["item"]);
  });
});
