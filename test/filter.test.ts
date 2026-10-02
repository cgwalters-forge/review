import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Item, NO_PRIORITY } from "../src/github/board.ts";
import { ALL, applyFilter, chips, entryOrg, filterText, filterToken, NO_ORG, parseFilterToken, type QueueFilter } from "../src/github/filter.ts";
import type { ForgePr } from "../src/github/forge.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [], status: "Needs human", ...over };
}

/** An issue on the board at `owner/repo#number`. */
function issue(nodeId: string, owner: string, repo: string, number: number, over: Partial<Item> = {}): Item {
  const url = `https://github.com/${owner}/${repo}/issues/${number}`;
  return item(nodeId, { kind: "issue", url, ref: { owner, repo, number }, state: "open", ...over });
}

function forgePr(repo: string, number: number, body = ""): ForgePr {
  return {
    ref: { owner: "cgwalters-forge", repo, number },
    url: `https://github.com/cgwalters-forge/${repo}/pull/${number}`,
    title: `${repo} #${number}`,
    body,
    author: "cgwalters-bot",
    createdAt: "2026-01-10T00:00:00Z",
    updatedAt: "2026-01-11T00:00:00Z",
    draft: true,
  };
}

const upstreamMeta = (upstream: string) => `Text\n\n<!-- bot-meta -->\n---\n- Upstream: \`${upstream}\`, base \`main\`\n<!-- /bot-meta -->`;

/** A queue with upstream and own work at each priority, and a nested ask. */
function queue(): Entry[] {
  const items = [
    issue("org-field", "cgwalters-bot", "praxis", 2, { org: "bootc-dev", priority: "P0" }),
    issue("target-label", "cgwalters-forge", "tracker", 5, { labels: ["P0", "target:composefs"], priority: "P0" }),
    issue("harness", "cgwalters-forge", "tracker", 54, { labels: ["target:cgwalters-bot"], priority: "P1" }),
    issue("untargeted", "cgwalters-forge", "tracker", 60, { priority: "P2" }),
    issue("upstream", "coreos", "bootupd", 1119, { priority: "P2" }),
    item("draft-no-org", { priority: "P1" }),
    // A question nested under the composefs issue: it goes where its parent goes.
    issue("ask", "cgwalters-forge", "tracker", 70, { labels: ["question"], parent: { owner: "cgwalters-forge", repo: "tracker", number: 5 }, priority: "P1" }),
  ];
  const prs = [forgePr("bootc", 30, upstreamMeta("bootc-dev/bootc")), forgePr("homegit", 31)];
  return buildEntries(items, prs, new Map());
}

const keysOf = (entries: readonly Entry[]) => entries.map((e) => e.key.replace(/^item:/, ""));

describe("entryOrg", () => {
  it("prefers the Org field, then a target label, then the owner; a forge PR is its upstream", () => {
    const got = Object.fromEntries(queue().map((e) => [e.key.replace(/^item:/, ""), entryOrg(e) ?? NO_ORG]));
    assert.deepEqual(got, {
      "org-field": "bootc-dev",
      "target-label": "composefs",
      harness: "cgwalters-bot",
      // The tracker's owner isn't a target.
      untargeted: NO_ORG,
      upstream: "coreos",
      "draft-no-org": NO_ORG,
      "pr:cgwalters-forge/bootc#30": "bootc-dev",
      "pr:cgwalters-forge/homegit#31": "cgwalters-forge",
    });
  });

  it("takes a forge PR's org from its board item when bot-meta names no upstream", () => {
    const tracking = issue("t", "cgwalters-forge", "tracker", 9, { status: "Draft", org: "ostreedev", branch: ["https://github.com/cgwalters-forge/ostree/pull/4"] });
    const [e] = buildEntries([tracking], [forgePr("ostree", 4)], new Map());
    assert.equal(e?.kind, "pr");
    assert.equal(entryOrg(e as Entry), "ostreedev");
  });
});

describe("applyFilter", () => {
  const cases: [string, QueueFilter, string[]][] = [
    ["all", ALL, ["org-field", "target-label", "draft-no-org", "harness", "untargeted", "upstream", "pr:cgwalters-forge/bootc#30", "pr:cgwalters-forge/homegit#31"]],
    ["composefs", { scope: "composefs" }, ["org-field", "target-label", "upstream", "pr:cgwalters-forge/bootc#30"]],
    ["infra", { scope: "infra" }, ["harness", "pr:cgwalters-forge/homegit#31"]],
    ["one org", { scope: { org: "composefs" } }, ["target-label"]],
    ["no org", { scope: { org: NO_ORG } }, ["draft-no-org", "untargeted"]],
    ["composefs P0", { scope: "composefs", priority: "P0" }, ["org-field", "target-label"]],
    ["no priority", { scope: "all", priority: "No priority" }, ["pr:cgwalters-forge/bootc#30", "pr:cgwalters-forge/homegit#31"]],
  ];
  for (const [name, f, want] of cases) it(name, () => assert.deepEqual(keysOf(applyFilter(queue(), f)), want));

  it("keeps nested asks with their entry", () => {
    const [e] = applyFilter(queue(), { scope: { org: "composefs" } });
    assert.deepEqual(e?.children?.map((c) => c.key), ["item:ask"]);
  });
});

describe("chips", () => {
  const summary = (list: ReturnType<typeof chips>[keyof ReturnType<typeof chips>]) =>
    list.map((c) => `${c.label} ${c.count}${c.on ? " on" : ""} -> ${filterToken(c.filter)}`);

  it("counts rows per chip, faceted by the other choice", () => {
    const c = chips(queue(), { scope: "composefs", priority: "P0" });
    // Rows include the nested ask.
    assert.deepEqual(summary(c.presets), ["All 3 -> all+P0", "Composefs 3 on -> composefs+P0", "Our infra 0 -> infra+P0"]);
    assert.deepEqual(summary(c.orgs), [
      // Upstream, then own, then unknown, each by total rows, whatever the priority.
      "bootc-dev 1 -> org:bootc-dev+P0",
      "composefs 2 -> org:composefs+P0",
      "coreos 0 -> org:coreos+P0",
      "cgwalters-bot 0 -> org:cgwalters-bot+P0",
      "cgwalters-forge 0 -> org:cgwalters-forge+P0",
      "no org 0 -> org:none+P0",
    ]);
    // Clicking the chosen priority clears it.
    assert.deepEqual(summary(c.priorities), ["P0 3 on -> composefs", "P1 0 -> composefs+P1", "P2 1 -> composefs+P2", "No priority 1 -> composefs+none"]);
  });

  it("keeps chosen chips that match nothing, so they can be cleared", () => {
    const c = chips(queue(), { scope: { org: "gone" }, priority: "P9" });
    assert.deepEqual(summary(c.orgs.filter((x) => x.on)), ["gone 0 on -> all+P9"]);
    assert.deepEqual(summary(c.priorities.filter((x) => x.on)), ["P9 0 on -> org:gone"]);
  });

  it("makes no chip for a priority no token can name", () => {
    const entries = queue().map((e) => (e.key === "item:upstream" ? { ...e, priority: "urgent" } : e));
    assert.ok(!chips(entries, ALL).priorities.some((x) => x.label === "urgent"));
  });

  it("clears a chosen org when clicked again", () => {
    const c = chips(queue(), { scope: { org: "coreos" } });
    assert.deepEqual(summary(c.orgs.filter((x) => x.on)), ["coreos 1 on -> all"]);
    assert.ok(c.presets.every((x) => !x.on));
  });
});

describe("filter tokens", () => {
  const round: [string, QueueFilter][] = [
    ["all", ALL],
    ["composefs", { scope: "composefs" }],
    ["infra+P1", { scope: "infra", priority: "P1" }],
    ["org:composefs", { scope: { org: "composefs" } }],
    ["org:bootc-dev+P0", { scope: { org: "bootc-dev" }, priority: "P0" }],
    ["org:none+none", { scope: { org: NO_ORG }, priority: "No priority" }],
  ];
  for (const [token, f] of round) {
    it(token, () => {
      assert.deepEqual(parseFilterToken(token), f);
      assert.equal(filterToken(f), token);
    });
  }
  const bad = ["", "news", "item/PVTI_x", "org:", "org:a/b", "org:<x>", "all+P", "all+high", "all+P0+P1", "Composefs"];
  for (const token of bad) it(`rejects ${JSON.stringify(token)}`, () => assert.equal(parseFilterToken(token), undefined));
  it("lowercases an org", () => assert.deepEqual(parseFilterToken("org:Bootc-Dev"), { scope: { org: "bootc-dev" } }));
});

describe("filterText", () => {
  const cases: [QueueFilter, string][] = [
    [ALL, "All"],
    [{ scope: "infra" }, "Our infra"],
    [{ scope: "composefs", priority: "P0" }, "Composefs · P0"],
    [{ scope: { org: "bootc-dev" }, priority: NO_PRIORITY }, "bootc-dev · No priority"],
    [{ scope: { org: NO_ORG } }, "no org"],
  ];
  for (const [f, want] of cases) it(want, () => assert.equal(filterText(f), want));
});
