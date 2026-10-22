// Audit probes: each `it` demonstrates a suspected defect with a concrete input.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { markPeopleDone } from "../src/github/people.ts";
import { buildNeeds } from "../src/github/needs.ts";
import { parseRoute } from "../src/github/keys.ts";
import { parseDecision } from "../src/github/triage.ts";
import { parseItem } from "../src/github/board.ts";
import { needsSignature, needsRedraw, NEEDS_CHANGED_NOTE } from "../src/github/needsview.ts";
import { installDom } from "./helpers.ts";
import { createRenderer } from "../src/markdown.ts";

const win = installDom();

describe("api.send on a 205 Reset Content answer (PATCH /notifications/threads/{id})", () => {
  it("resolves instead of failing on the empty body", async () => {
    const calls: string[] = [];
    const gh = new GitHub(async () => "ghp_x", async (url, init) => {
      calls.push(`${init?.method} ${url}`);
      // GitHub answers "mark a thread as read" with 205 and no body.
      return new Response(null, { status: 205 });
    });
    await markPeopleDone(gh, "106");
    assert.deepEqual(calls, ["PATCH https://api.github.com/notifications/threads/106"]);
  });
});

describe("needs: a legacy decision that isn't a queue entry", () => {
  it("links to a route parseRoute accepts", () => {
    // loadDecisions builds items from the issues API: node_id is the issue's (I_...), not a board item's (PVTI_...).
    const item = parseItem({ id: 0, node_id: "I_kwDOP9abcd", content_type: "Issue", content: {
      title: "D7: Which prefix?", html_url: "https://github.com/cgwalters-forge/tracker/issues/901", state: "open",
      body: "Blocks: https://github.com/cgwalters-forge/tracker/issues/12\nQ: Which prefix?\nOptions:\nA) one\nB) two\n", labels: [{ name: "question" }, { name: "decision" }],
      user: { login: "cgwalters-bot" }, assignees: [{ login: "cgwalters" }], created_at: "2026-10-01T00:00:00Z",
    } });
    const needs = buildNeeds({ entries: [], decisions: [parseDecision(item)] });
    assert.equal(needs.length, 1);
    const href = needs[0]!.href;
    assert.equal(href, "#item/I_kwDOP9abcd");
    assert.equal(parseRoute(href).route, "item", `the row's title links to ${href}, which the router treats as ${parseRoute(href).route}`);
  });
});

describe("needs: age ticks alone", () => {
  it("does not claim that what waits on him changed", () => {
    const item = parseItem({ id: 1, node_id: "PVTI_1", content_type: "Issue", content: {
      title: "Q?", html_url: "https://github.com/cgwalters-forge/tracker/issues/5", state: "open", body: "Q: x?\nOptions:\nA) a\nB) b\n",
      labels: [{ name: "question" }], user: { login: "cgwalters-bot" }, assignees: [{ login: "cgwalters" }], created_at: "2026-10-20T10:00:00Z",
    }, fields: [{ id: 1, name: "Status", value: { name: { raw: "Needs human" } } }] });
    const entry = { key: "item:PVTI_1", kind: "question" as const, title: "Q?", where: "x", href: "#item/PVTI_1", item, since: item.createdAt! };
    const needs = buildNeeds({ entries: [entry] });
    const hooks = { login: "cgwalters", now: Date.parse("2026-10-20T10:10:00Z"), labelOf: () => undefined };
    const before = needsSignature(needs, hooks);
    const after = needsSignature(needs, { ...hooks, now: hooks.now + 60_000 });
    const policy = needsRedraw({ signature: after, previousSignature: before, forms: [{ sent: false, text: "half an answer", picked: false }], note: undefined, force: false });
    assert.notEqual(policy.note, NEEDS_CHANGED_NOTE, `one minute later, with a half-written answer, the page says: ${policy.note}`);
  });
});

describe("markdown probes", () => {
  const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
  const dom = (s: string, repo?: string) => { const d = win.document.createElement("div"); d.append(render(s, repo)); return d; };
  it("reference linkifier with dot-dot repository", () => {
    const hrefs = [...dom("see a/..#5 and b/.git#6", "o/r").querySelectorAll("a")].map((a) => a.getAttribute("href"));
    console.log("dotdot hrefs:", hrefs);
  });
  it("misc payloads", () => {
    for (const s of [
      "[x](https://a.example 'onmouseover=alert(1)')",
      "<a href=\"https://x\" target=_top>y</a>",
      "[y](HTTPS://x.example)",
      "[z](mailto:a@b?subject=<script>)",
      "[w](https://a.example/#javascript:alert(1))",
      "www.example.com/#1 foo#2 (bar/baz#3)",
      "![img](https://a.example/x.png \"t\")",
      "<details><summary>x</summary>hidden</details>",
    ]) console.log(JSON.stringify(s), "=>", dom(s, "o/r").innerHTML);
  });
});
