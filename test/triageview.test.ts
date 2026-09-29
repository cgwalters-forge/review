import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Item, parseItem } from "../src/github/board.ts";
import { createRenderer } from "../src/markdown.ts";
import { parseDecision } from "../src/github/triage.ts";
import { decisionsView, triageView, type TriageHooks } from "../src/github/triageview.ts";
import { installDom, rawBoardItem } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';

const item = (n: number, fields: Record<string, string>, title?: string) => parseItem(rawBoardItem(n, fields, title));

const hooks = (open: string[] = [], inQueue: number[] = []): TriageHooks => ({
  itemHref: (i) => (inQueue.includes(i.id) ? `#item/${i.nodeId}` : undefined),
  open: new Set(open),
  toggled: () => {},
});

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("triageView", () => {
  const items: Item[] = [
    item(1, { Status: "Needs human", Priority: "P0", Theme: "composefs-stable", Verdict: "keep" }, EVIL),
    item(2, { Status: "Todo", Priority: "P1", Theme: "composefs-stable", Verdict: "merge", "Verdict target": "https://github.com/cgwalters-forge/tracker/issues/33" }),
    item(3, { Status: "Todo", Priority: "P2", Theme: "harness", Verdict: "close", "Verdict target": "javascript:alert(1)" }),
    item(4, { Status: "Todo" }),
  ];

  it("shows the P0 lane, one group per theme and the untriaged, text only", () => {
    const view = triageView({ items, missing: [] }, "all", hooks(["harness"], [1]));
    assert.equal(view.querySelector("script, img"), null);
    const lane = view.querySelectorAll(".p0-lane .tri-item");
    assert.equal(lane.length, 1);
    // An item in the queue opens in the app.
    assert.equal(lane[0]?.querySelector(".tri-title a")?.getAttribute("href"), "#item/PVTI_t1");
    const groups = [...view.querySelectorAll<HTMLDetailsElement>("details.theme")];
    assert.deepEqual(
      groups.map((g) => [text(g.querySelector(".theme-name")), g.open, g.querySelectorAll(".tri-item").length]),
      [
        ["composefs-stable", false, 2],
        ["harness", true, 1],
        ["No theme (untriaged)", false, 1],
      ],
    );
    assert.equal(groups[0]?.querySelectorAll(".vbar span").length, 2);
  });

  it("shows a merge or close target, as a link only when it is https", () => {
    const view = triageView({ items, missing: [] }, "all", hooks());
    const rows = [...view.querySelectorAll(".themes .tri-item")];
    assert.equal(text(rows[1]?.querySelector(".verdict")), "merge");
    assert.equal(rows[1]?.querySelector(".tri-meta .tag a")?.getAttribute("href"), "https://github.com/cgwalters-forge/tracker/issues/33");
    assert.match(text(rows[1]), /→ tracker#33/);
    assert.equal(rows[2]?.querySelector(".tri-meta .tag a"), null);
  });

  it("filters by verdict and opens what it keeps", () => {
    const view = triageView({ items, missing: [] }, "close", hooks());
    const groups = [...view.querySelectorAll<HTMLDetailsElement>("details.theme")];
    assert.deepEqual(groups.map((g) => [text(g.querySelector(".theme-name")), g.open]), [["harness", true]]);
    const on = view.querySelector(".chip.on");
    assert.equal(on?.firstChild?.textContent, "close");
    assert.equal(text(on?.querySelector(".count")), "1");
    // Clicking the chosen verdict again clears it.
    assert.equal(on?.getAttribute("href"), "#triage");
  });

  it("says which triage fields the board lacks", () => {
    const view = triageView({ items: [], missing: ["Theme", "Verdict"] }, "all", hooks());
    assert.match(text(view.querySelector(".warn")), /no "Theme", "Verdict" field/);
  });
});

describe("decisionsView", () => {
  const body = [
    "Blocks: https://github.com/cgwalters-forge/tracker/issues/1",
    "",
    "Unblocks:",
    "- https://github.com/cgwalters-forge/bootc/pull/15",
    "- https://github.com/bootc-dev/bootc/pull/2516",
    "",
    `Q: Promote it now? ${EVIL}`,
    "",
    "Options:",
    "A) Later",
    "B) Now",
    "",
    "Recommended: A, because it is safer",
  ].join("\n");
  const decisions = [7, 8].map((n) =>
    parseDecision({
      ...item(n, { Status: "Needs human" }, `D${n - 6}: Promote?`),
      nodeId: `I_${n}`,
      body,
      labels: ["question", "decision"],
      assignees: ["cgwalters"],
      author: "cgwalters-bot",
    }),
  );

  it("offers each decision's options to him, recommended marked, with unblocks", async () => {
    const sent: [string, unknown][] = [];
    const view = decisionsView(decisions, { login: "cgwalters", answered: new Set(["I_8"]), send: async (d, a) => (sent.push([d.item.nodeId, a]), "https://github.com/c/1") }, render);
    assert.equal(view.querySelector("script, img"), null);
    const cards = [...view.querySelectorAll(".decision")];
    assert.deepEqual(cards.map((c) => text(c.querySelector(".dec-id"))), ["D1", "D2"]);
    assert.ok(cards[1]?.classList.contains("answered"));
    const first = cards[0] as HTMLElement;
    assert.deepEqual([...first.querySelectorAll("input[type=radio]")].map((r) => r.id), ["d7-opt-A", "d7-opt-B"]);
    assert.match(text(first.querySelector("label.opt .rec")), /recommended/);
    assert.match(text(first.querySelector("details.unblocks summary")), /Unblocks 2/);
    assert.deepEqual([...first.querySelectorAll("details.unblocks a")].map((a) => a.textContent), ["forge bootc#15", "bootc#2516"]);

    (first.querySelector("#d7-opt-B") as HTMLInputElement).checked = true;
    (first.querySelector("textarea") as HTMLTextAreaElement).value = "ship it";
    first.querySelector("form")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(sent, [["I_7", { text: "ship it", choice: "B" }]]);
  });

  it("offers no form to anyone else", () => {
    const view = decisionsView(decisions, { login: "someone", answered: new Set(), send: async () => "" }, render);
    assert.equal(view.querySelector("form"), null);
    assert.match(text(view), /Only cgwalters answers decisions/);
  });
});
