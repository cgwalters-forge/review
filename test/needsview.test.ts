// The rows of "Needs you": the action each asks for, the inline answer,
// and untrusted text staying text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Answer } from "../src/answer.ts";
import { type Item } from "../src/github/board.ts";
import { buildNeeds, type Need } from "../src/github/needs.ts";
import { NEEDS_CHANGED_NOTE, needId, type NeedsForm, type NeedsHooks, needRow, needsRedraw, needsSignature } from "../src/github/needsview.ts";
import { buildEntries } from "../src/github/queue.ts";
import { parseDecision } from "../src/github/triage.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const TRACKER = "https://github.com/cgwalters-forge/tracker/issues";
const EVIL = "<img src=x onerror=alert(1)><script>alert(2)</script>[x](javascript:alert(3))";
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

function tracked(nodeId: string, number: number, over: Partial<Item> = {}): Item {
  return {
    id: 0, nodeId, kind: "issue", title: nodeId, body: "", why: "", branch: [], gist: [], labels: [], status: "Needs human",
    url: `${TRACKER}/${number}`, ref: { owner: "cgwalters-forge", repo: "tracker", number }, state: "open", author: "cgwalters-bot", assignees: ["cgwalters"], ...over,
  };
}

const hooks = (sent: [string, Answer][] = [], login: string | undefined = "cgwalters"): NeedsHooks => ({
  login,
  now: Date.parse("2026-02-01T00:00:00Z"),
  render,
  labelOf: () => undefined,
  send: async (n, a) => (sent.push([n.key, a]), "https://github.com/c/1"),
});

const BODY = "Blocks: https://github.com/cgwalters-forge/tracker/issues/9\nQ: Which prefix?\nOptions:\nA) this\nB) that\nRecommended: A, because it is safer\n";
const first = (items: Item[]): Need => buildNeeds({ entries: buildEntries(items, [], new Map(), true) })[0] as Need;

describe("needsRedraw", () => {
  const typed: NeedsForm = { sent: false, text: "my answer", picked: false };
  const picked: NeedsForm = { sent: false, text: "", picked: true };
  const policy = (forms: readonly NeedsForm[], over: Partial<Parameters<typeof needsRedraw>[0]> = {}) => needsRedraw({
    signature: "new", previousSignature: "old", forms, note: undefined, force: false, ...over,
  });

  it("skips an unchanged signature before checking drafts, keeping the notice", () => {
    for (const note of [undefined, NEEDS_CHANGED_NOTE, "Another notice"]) {
      assert.deepEqual(policy([typed, picked], { signature: "old", note }), { action: "skip", note });
    }
  });

  it("defers changed rows for either typed text or a selected radio, with the guard note", () => {
    for (const form of [typed, picked]) {
      assert.deepEqual(policy([form]), { action: "defer", note: NEEDS_CHANGED_NOTE });
    }
  });

  it("redraws changed rows without a draft and clears only the guard note", () => {
    const forms: NeedsForm[] = [{ sent: false, text: " \n\t", picked: false }, { sent: true, text: "sent answer", picked: true }];
    assert.deepEqual(policy(forms, { note: NEEDS_CHANGED_NOTE }), { action: "redraw", note: undefined });
    assert.deepEqual(policy([], { note: "Another notice" }), { action: "redraw", note: "Another notice" });
  });

  it("force bypasses both the draft guard and signature equality", () => {
    for (const signature of ["old", "new"]) {
      assert.deepEqual(policy([typed, picked], { force: true, signature, note: NEEDS_CHANGED_NOTE }), { action: "redraw", note: undefined });
    }
    assert.deepEqual(policy([typed], { force: true, note: "Another notice" }), { action: "redraw", note: "Another notice" });
  });
});

describe("needsSignature", () => {
  it("tracks the exact rendered age label and defers an age-only change under a draft", () => {
    const since = "2026-02-01T00:00:00Z";
    const entry = first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY })]);
    // The concrete ask's age takes precedence over the PR/item creation age.
    const n: Need = { ...entry, since, entry: { ...entry.entry!, since: "2026-01-01T00:00:00Z" } };
    const before = { ...hooks(), now: Date.parse(since) + 59_999 };
    const after = { ...before, now: before.now + 1 };
    const previousSignature = needsSignature([n], before);
    const signature = needsSignature([n], after);
    assert.equal(needRow(n, before).querySelector(".age")?.textContent, "now");
    assert.equal(needRow(n, after).querySelector(".age")?.textContent, "1m");
    assert.equal(JSON.parse(previousSignature)[1][0].at(-1), "now");
    assert.equal(JSON.parse(signature)[1][0].at(-1), "1m");
    assert.notEqual(signature, previousSignature);
    assert.equal(needsSignature([n], { ...after, now: after.now + 1 }), signature);
    assert.deepEqual(needsRedraw({ signature, previousSignature, forms: [{ sent: false, text: "draft", picked: false }], note: undefined, force: false }), { action: "defer", note: NEEDS_CHANGED_NOTE });
  });

  it("uses the need's age for a decision without an entry", () => {
    const d = parseDecision(tracked("I_7", 7, { title: "D3: Promote?", body: BODY, labels: ["question", "decision"], createdAt: "2026-01-31T00:00:00Z" }));
    const needs = buildNeeds({ entries: [], decisions: [d] });
    const view = hooks();
    assert.equal(needRow(needs[0]!, view).querySelector(".age")?.textContent, "1d");
    assert.equal(JSON.parse(needsSignature(needs, view))[1][0].at(-1), "1d");
  });
});

describe("needRow", () => {
  it("answers a question in its row, with its options, and sends the answer as the need", async () => {
    const sent: [string, Answer][] = [];
    const n = first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY, priority: "P0", title: "Prefix?" })]);
    const row = needRow(n, hooks(sent));
    assert.equal(row.getAttribute("data-section"), "needs");
    assert.equal(row.getAttribute("data-key"), "item:PVTI_q");
    assert.equal(row.id, needId(n));
    assert.equal(text(row.querySelector(".action")), "Answer");
    assert.match(text(row.querySelector(".why")), /Which prefix\?/);
    assert.match(text(row), /Recommended: A, because it is safer/);
    assert.deepEqual([...row.querySelectorAll("input[type=radio]")].map((r) => r.id), ["n21-opt-A", "n21-opt-B"]);
    (row.querySelector("#n21-opt-B") as HTMLInputElement).checked = true;
    (row.querySelector("textarea") as HTMLTextAreaElement).value = "ship it";
    row.querySelector("form")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [["item:PVTI_q", { text: "ship it", choice: "B" }]]);
    assert.match(text(row.querySelector(".status")), /Sent:/);
  });

  it("offers no form to anyone else, and none on what is not a question", () => {
    const q = first([tracked("PVTI_q", 21, { labels: ["question"], body: BODY })]);
    const other = needRow(q, hooks([], "someone"));
    assert.equal(other.querySelector("form"), null);
    assert.match(text(other), /Only cgwalters answers; you are signed in as someone/);
    const review = first([tracked("PVTI_r", 22, { labels: ["escalate"], body: "Ask: Look at it\n" })]);
    const row = needRow(review, hooks());
    assert.equal(row.querySelector("form"), null);
    const action = row.querySelector<HTMLAnchorElement>("a.action");
    assert.equal(action?.getAttribute("href"), `${TRACKER}/22`);
    assert.equal(action?.textContent, "Write text");
  });

  it("labels a decision with its D-number, unblocks and whole question, and dims one answered here", () => {
    const body = `Unblocks:\n- https://github.com/cgwalters-forge/bootc/pull/15\n\n${BODY}`;
    const d = parseDecision(tracked("I_7", 7, { title: "D3: Promote?", body, labels: ["question", "decision"] }));
    const n = buildNeeds({ entries: [], decisions: [d] })[0] as Need;
    const row = needRow(n, hooks());
    assert.equal(text(row.querySelector(".dec-id")), "D3");
    assert.match(text(row.querySelector("details.unblocks summary")), /Unblocks 1/);
    assert.deepEqual([...row.querySelectorAll("details.unblocks a")].map((a) => a.textContent), ["forge bootc#15"]);
    assert.match(text(row.querySelector("details.dec-body summary")), /The whole question/);
    const done = needRow({ ...n, done: true }, hooks());
    assert.ok(done.classList.contains("need-done"));
    assert.equal(done.querySelector("form"), null);
    assert.match(text(done.querySelector(".state")), /answered, waiting on the bot/);
  });

  it("puts untrusted text on screen as text", () => {
    const body = `Blocks: ${TRACKER}/9\nQ: ${EVIL}\nOptions:\nA) ${EVIL}\nB) javascript:alert(5)\n${EVIL}`;
    const n = first([tracked("PVTI_q", 21, { labels: ["question"], body, title: EVIL })]);
    const row = needRow(n, hooks());
    assert.equal(row.querySelectorAll("script, img, iframe, svg, style").length, 0, row.outerHTML);
    for (const el of row.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
      const href = el.getAttribute("href");
      if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
    }
    assert.ok(row.textContent?.includes("<script>alert(2)</script>"));
  });

  it("does not invent a decision for an item with no ask", () => {
    assert.equal(first([tracked("PVTI_lonely", 30)]), undefined);
  });
});

describe("needId", () => {
  it("keeps keys that differ apart", () => {
    const n = (key: string) => needId({ key } as Need);
    assert.notEqual(n("pr:a/b-c#1"), n("pr:a-b/c#1"));
    assert.match(n("pr:a/b#1"), /^need-[A-Za-z0-9_-]+$/);
  });
});
