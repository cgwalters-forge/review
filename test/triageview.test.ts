import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Item, parseItem } from "../src/github/board.ts";
import { createRenderer } from "../src/markdown.ts";
import { triageView, type TriageHooks } from "../src/github/triageview.ts";
import { installDom, rawBoardItem } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';

const item = (n: number, fields: Record<string, string>, title?: string) => parseItem(rawBoardItem(n, fields, title));

const hooks = (open: string[] = [], inQueue: number[] = [], setFilter: TriageHooks["setFilter"] = () => {}): TriageHooks => ({
  itemHref: (i) => (inQueue.includes(i.id) ? `#item/${i.nodeId}` : undefined),
  open: new Set(open),
  toggled: () => {},
  setFilter,
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
    const chosen: string[] = [];
    const view = triageView({ items, missing: [] }, "close", hooks([], [], (f) => chosen.push(f)));
    const groups = [...view.querySelectorAll<HTMLDetailsElement>("details.theme")];
    assert.deepEqual(groups.map((g) => [text(g.querySelector(".theme-name")), g.open]), [["harness", true]]);
    const on = view.querySelector(".chip.on");
    assert.equal(on?.firstChild?.textContent, "close");
    assert.equal(text(on?.querySelector(".count")), "1");
    // Clicking the chosen verdict again clears it; another one chooses it.
    (on as HTMLElement).click();
    (view.querySelector(".chip:not(.on)") as HTMLElement).click();
    assert.deepEqual(chosen, ["all", "all"]);
    const merge = [...view.querySelectorAll<HTMLElement>(".chip")].find((c) => c.firstChild?.textContent === "merge");
    merge?.click();
    assert.deepEqual(chosen, ["all", "all", "merge"]);
  });

  it("keeps the verdict label apart from its wrapping chips", () => {
    const row = triageView({ items, missing: [] }, "all", hooks()).querySelector(".filters > .chips");
    assert.equal(row?.children.length, 2);
    assert.equal(row?.querySelector(":scope > .chips-h")?.textContent, "Verdict");
    assert.ok(row?.querySelector(":scope > .chips-list > .chip"));
    assert.equal(row?.querySelector(":scope > .chip"), null);
  });

  it("says which triage fields the board lacks", () => {
    const view = triageView({ items: [], missing: ["Theme", "Verdict"] }, "all", hooks());
    assert.match(text(view.querySelector(".warn")), /no "Theme", "Verdict" field/);
  });
});
