import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Item } from "../src/github/board.ts";
import type { ForgePr, Verdict } from "../src/github/forge.ts";
import { buildEntries, type Entry, groupRanked, priorityRank, rankEntries } from "../src/github/queue.ts";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], status: "Needs human", ...over };
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
});

describe("buildEntries", () => {
  const verdicts = (pairs: [string, Verdict["state"]][]) => new Map(pairs.map(([k, state]) => [k, { state }]));

  it("merges board items and forge PRs into one ranked list", () => {
    const items = [
      item("PVTI_q", { why: "Q#2: which? Options: A) this B) that", priority: "P1", createdAt: "2026-01-05T00:00:00Z" }),
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
        ["item:PVTI_chore", "chore", "P0"],
        ["item:PVTI_gist", "chore", "P1"],
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
    const items = [item("PVTI_nh", { branch: ["https://github.com/cgwalters-forge/a/pull/1"], why: "Q#1: ok? Options: A) yes B) no" })];
    const keys = buildEntries(items, [pr("cgwalters-forge", "a", 1)], verdicts([])).map((e) => e.key);
    assert.deepEqual(keys.sort(), ["item:PVTI_nh", "pr:cgwalters-forge/a#1"]);
  });

  it("drops no forge-only Draft item before the forge was read", () => {
    const items = [item("PVTI_f", { status: "Draft", branch: ["https://github.com/cgwalters-forge/a/pull/1"] })];
    assert.deepEqual(buildEntries(items, [], verdicts([])).length, 0);
    assert.deepEqual(buildEntries(items, [], verdicts([]), false).map((e) => [e.key, e.kind]), [["item:PVTI_f", "chore"]]);
  });

  it("keeps a Draft item whose Branch is not only forge PRs", () => {
    const items = [item("PVTI_up", { status: "Draft", branch: ["https://github.com/up/r/compare/main...cgwalters-bot:bot/x"] })];
    assert.deepEqual(buildEntries(items, [], verdicts([])).map((e) => e.kind), ["chore"]);
  });
});
