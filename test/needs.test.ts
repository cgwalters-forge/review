import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Item } from "../src/github/board.ts";
import type { ForgePr, Verdict } from "../src/github/forge.ts";
import { buildNeeds, type Need, needStops, waitingCount } from "../src/github/needs.ts";
import { buildEntries } from "../src/github/queue.ts";
import { parseDecision } from "../src/github/triage.ts";
import type { PrWait } from "../src/github/waiting.ts";

const TRACKER = "https://github.com/cgwalters-forge/tracker/issues";

function item(nodeId: string, over: Partial<Item> = {}): Item {
  return { id: 0, nodeId, kind: "draft", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], assignees: [], status: "Needs human", ...over };
}

/** A tracker issue on the board. */
function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return item(nodeId, { kind: "issue", url: `${TRACKER}/${number}`, ref: { owner: "cgwalters-forge", repo: "tracker", number }, state: "open", author: "cgwalters-bot", assignees: ["cgwalters"], ...over });
}

const QUESTION = "Q: which?\nOptions:\nA) this\nB) that\n";

/** An ask in the tracker blocking `blocks`. */
function ask(nodeId: string, number: number, label: string, blocks: string, body = QUESTION, over: Partial<Item> = {}): Item {
  return tracked(nodeId, number, { labels: [label], body: `Blocks: ${blocks}\n${body}`, ...over });
}

function pr(owner: string, repo: string, number: number): ForgePr {
  return {
    ref: { owner, repo, number },
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    title: `${repo} #${number}`,
    body: "",
    author: "cgwalters-bot",
    createdAt: "2026-01-10T00:00:00Z",
    updatedAt: "2026-01-11T00:00:00Z",
    draft: true,
  };
}

const rows = (needs: readonly Need[]) => needs.map((n) => [n.key, n.action]);
const entriesOf = (items: Item[], answered: string[] = []) => buildEntries(items, [], new Map(), true, new Set(answered));

describe("buildNeeds", () => {
  it("asks one action per row: answer, review, write, and a bug flagged as such", () => {
    const home = tracked("PVTI_home", 7, { title: "Home", priority: "P2" });
    const items = [
      ask("PVTI_q", 21, "question", `${TRACKER}/7`, QUESTION, { priority: "P0" }),
      ask("PVTI_review", 22, "review", `${TRACKER}/7`, "Ask: Re-approve it\nReview: `https://github.com/o/r/pull/50` at 0123456789012345678901234567890123456789\n"),
      ask("PVTI_chore", 23, "chore", `${TRACKER}/7`, "Ask: Fix the thing by hand\n"),
      home,
      item("PVTI_lonely", { title: "Nobody asks", priority: "P1" }),
    ];
    const needs = buildNeeds({ entries: entriesOf(items) });
    // The item with asks under it is only their context: its asks are the rows.
    assert.deepEqual(rows(needs), [
      ["item:PVTI_q", "answer"],
      ["item:PVTI_lonely", "fix"],
      ["item:PVTI_chore", "write"],
      ["item:PVTI_review", "review"],
    ]);
    assert.equal(needs[0]?.inPlace, true);
    assert.equal(needs[2]?.inPlace, false);
    assert.equal(needs[3]?.inPlace, false);
    assert.equal(needs[0]?.parent?.title, "Home");
    assert.equal(waitingCount(needs), 4);
  });

  it("leaves out what is answered, closed, or waiting on the bot", () => {
    const items = [
      ask("PVTI_a", 30, "question", `${TRACKER}/9`),
      ask("PVTI_b", 31, "question", `${TRACKER}/9`),
      ask("PVTI_c", 32, "question", `${TRACKER}/9`, QUESTION, { state: "closed" }),
    ];
    assert.deepEqual(rows(buildNeeds({ entries: entriesOf(items, ["PVTI_a"]) })), [["item:PVTI_b", "answer"]]);
  });

  it("keeps a row he answered from the page, dimmed, after it stops waiting", () => {
    const items = [ask("PVTI_a", 30, "question", `${TRACKER}/9`), ask("PVTI_b", 31, "question", `${TRACKER}/9`)];
    const needs = buildNeeds({ entries: entriesOf(items, ["PVTI_a"]), answeredHere: new Set(["item:PVTI_a"]) });
    assert.deepEqual(needs.map((n) => [n.key, n.done ?? false]), [["item:PVTI_b", false], ["item:PVTI_a", true]]);
    assert.equal(waitingCount(needs), 1);
    // Done rows are listed but never next.
    assert.deepEqual(needStops(needs).map((s) => [s.key, s.waiting]), [["item:PVTI_b", true], ["item:PVTI_a", false]]);
  });

  it("asks for the action a PR needs: promote a forge draft, review, re-sign, rerun", () => {
    const wait = (reasons: PrWait["reasons"], onBot = false): PrWait => ({ reasons, onBot });
    const none: Verdict = { state: "none" };
    const forge = pr("cgwalters-forge", "bootc", 1);
    const others = [
      { pr: pr("o", "r", 2), wait: wait(["review-requested"]) },
      { pr: pr("o", "r", 3), wait: wait(["resign"]) },
      { pr: pr("o", "r", 4), wait: wait(["rerun", "review-requested"]) },
      { pr: pr("o", "r", 5), wait: wait(["updated"]) },
      { pr: pr("o", "r", 6), wait: wait([], true) },
    ];
    const entries = buildEntries([], [forge], new Map<string, Verdict>([["cgwalters-forge/bootc#1", none]]), true, new Set(), { others });
    const got = Object.fromEntries(rows(buildNeeds({ entries })));
    assert.deepEqual(got, {
      "pr:cgwalters-forge/bootc#1": "promote",
      "pr:o/r#2": "review",
      "pr:o/r#3": "resign",
      "pr:o/r#4": "rerun",
      "pr:o/r#5": "review",
    });
  });

  it("does not ask again for a PR he sent /promote on", () => {
    const forge = pr("cgwalters-forge", "bootc", 1);
    const entries = buildEntries([], [forge], new Map<string, Verdict>([["cgwalters-forge/bootc#1", { state: "promoted" }]]), true);
    assert.deepEqual(buildNeeds({ entries }), []);
  });

  describe("decisions", () => {
    const decision = (nodeId: string, number: number, title: string, body = `Unblocks:\n- ${TRACKER}/9\n\n${QUESTION}`) =>
      parseDecision(tracked(nodeId, number, { title, body, labels: ["question", "decision"] }));

    it("lists a decision of its own, and folds one that is also a question in the queue into that row", () => {
      const q = ask("PVTI_q", 21, "question", `${TRACKER}/9`, QUESTION, { title: "D1: Which?", priority: "P1" });
      const same = decision("I_21", 21, "D1: Which?");
      const other = decision("I_40", 40, "D2: Another?");
      const needs = buildNeeds({ entries: entriesOf([q]), decisions: [same, other] });
      assert.deepEqual(rows(needs), [["item:PVTI_q", "answer"], ["decision:I_40", "answer"]]);
      assert.equal(needs[0]?.decision?.number, 1);
      assert.equal(needs[1]?.inPlace, true);
      assert.equal(needs[1]?.href, "#item/I_40");
    });

    it("drops one he answered, unless he did from the page", () => {
      const d = decision("I_40", 40, "D2: Another?");
      assert.deepEqual(buildNeeds({ entries: [], decisions: [d], decisionsAnswered: new Set(["I_40"]) }), []);
      const kept = buildNeeds({ entries: [], decisions: [d], decisionsAnswered: new Set(["I_40"]), answeredHere: new Set(["decision:I_40"]) });
      assert.deepEqual(kept.map((n) => [n.key, n.done]), [["decision:I_40", true]]);
    });

    it("is not attached to a row that is not a question", () => {
      const entries = buildEntries([], [pr("cgwalters-forge", "tracker", 9)], new Map<string, Verdict>([["cgwalters-forge/tracker#9", { state: "none" }]]), true);
      const needs = buildNeeds({ entries, decisions: [decision("I_9", 9, "D3: x")] });
      assert.deepEqual(rows(needs), [["pr:cgwalters-forge/tracker#9", "promote"], ["decision:I_9", "answer"]]);
      assert.equal(needs[0]?.decision, undefined);
    });
  });

  it("ranks by priority, then the oldest", () => {
    const items = [
      ask("PVTI_new", 41, "question", `${TRACKER}/9`, QUESTION, { priority: "P1", createdAt: "2026-03-01T00:00:00Z" }),
      ask("PVTI_old", 42, "question", `${TRACKER}/9`, QUESTION, { priority: "P1", createdAt: "2026-01-01T00:00:00Z" }),
      ask("PVTI_top", 43, "question", `${TRACKER}/9`, QUESTION, { priority: "P0", createdAt: "2026-06-01T00:00:00Z" }),
    ];
    assert.deepEqual(buildNeeds({ entries: entriesOf(items) }).map((n) => n.key), ["item:PVTI_top", "item:PVTI_old", "item:PVTI_new"]);
  });

  it("steps through questions in place and opens the rest", () => {
    const items = [ask("PVTI_q", 21, "question", `${TRACKER}/9`), ask("PVTI_r", 22, "review", `${TRACKER}/9`, "Ask: look\n")];
    const stops = needStops(buildNeeds({ entries: entriesOf(items) }));
    assert.deepEqual(stops.map((s) => [s.key, s.href, s.inPlace]), [["item:PVTI_q", "#", true], ["item:PVTI_r", "#item/PVTI_r", false]]);
  });
});
