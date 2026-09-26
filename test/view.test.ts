// The views put untrusted board and issue text on screen: check that it
// lands as text or sanitized markdown, whatever it contains.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerTarget, type Item, questionOf, queueItems } from "../src/github/board.ts";
import type { Context } from "../src/github/backend.ts";
import { HOME_OWNERS } from "../src/github/config.ts";
import { createRenderer } from "../src/markdown.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { age, answerState, itemView, queueView, STATE_LABEL } from "../src/github/view.ts";
import { installDom, rawItems } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const noSend = { send: async () => "https://github.com/x" };

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>[x](javascript:alert(3))';

function evilItem(): Item {
  const item = queueItems(rawItems()).find((i) => i.nodeId === "PVTI_synthetic_upstream_pr") as Item;
  return {
    ...item,
    title: EVIL,
    why: `${EVIL} Options: A) <b onclick=alert(4)>bold</b> B) javascript:alert(5)`,
    body: EVIL,
    org: EVIL,
    branch: ["https://ok.example/branch"],
    gist: ["javascript:alert(6)"],
    url: "javascript:alert(7)",
  };
}

function assertNoActiveContent(root: Element): void {
  assert.equal(root.querySelectorAll("script, img, iframe, svg, style").length, 0, root.outerHTML);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
    const href = el.getAttribute("href");
    if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
  }
}

describe("queueView", () => {
  const entriesOf = (items: Item[]) => buildEntries(items, [], new Map());
  const labels = (sent: Set<string>) => (e: Entry) => {
    const st = e.item ? answerState(e.item, sent) : undefined;
    return st ? { text: STATE_LABEL[st], cls: st } : undefined;
  };

  it("ranks by priority and shows untrusted text as text", () => {
    const items = [evilItem(), ...queueItems(rawItems()).slice(1)];
    const root = queueView(entriesOf(items), labels(new Set()), Date.parse("2026-02-01T00:00:00Z"));
    assertNoActiveContent(root);
    assert.deepEqual(
      [...root.querySelectorAll(".group-h")].map((e) => e.textContent),
      ["P0 · 1", "P1 · 1", "P2 · 1", "No priority · 1"],
    );
    assert.ok(root.textContent?.includes("<script>alert(2)</script>"));
    assert.deepEqual(
      [...root.querySelectorAll(".row")].map((r) => r.getAttribute("href")),
      ["#item/PVTI_synthetic_draft", "#item/PVTI_synthetic_upstream_pr", "#item/PVTI_synthetic_redacted", "#item/PVTI_synthetic_home_issue"],
    );
  });

  it("labels items answered from this tab", () => {
    const items = queueItems(rawItems());
    const shown = [...queueView(entriesOf(items), labels(new Set(["PVTI_synthetic_home_issue"]))).querySelectorAll(".state")];
    assert.deepEqual(shown.map((e) => e.textContent), ["answered"]);
  });

  it("says when nothing needs you", () => {
    assert.match(queueView([], () => undefined).textContent ?? "", /Nothing needs you/);
  });
});

describe("age", () => {
  const now = Date.parse("2026-01-15T12:00:00Z");
  const cases: [string | undefined, string][] = [
    [undefined, ""],
    ["not a date", ""],
    ["2026-01-15T11:59:50Z", "now"],
    ["2026-01-15T11:15:00Z", "45m"],
    ["2026-01-15T02:00:00Z", "10h"],
    ["2026-01-12T12:00:00Z", "3d"],
    ["2025-12-01T12:00:00Z", "6w"],
    ["2026-01-16T00:00:00Z", "now"],
  ];
  for (const [iso, want] of cases) it(String(iso), () => assert.equal(age(iso, now), want));
});

describe("itemView", () => {
  const ctx: Context = {
    isPrivate: false,
    warnings: [EVIL],
    comments: [
      { author: "cgwalters", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/c/1", body: "/answer A\nfine" },
      { author: "someone", createdAt: "2026-01-02T00:00:00Z", url: "javascript:alert(8)", body: EVIL },
    ],
    gists: [
      {
        url: "https://gist.github.com/abc",
        owner: EVIL,
        files: [
          { name: "notes.md", content: EVIL, truncated: false },
          { name: "log.txt", content: EVIL, truncated: true },
        ],
      },
    ],
  };

  it("renders every untrusted field safely", () => {
    const item = evilItem();
    const root = itemView(item, answerTarget(item, HOME_OWNERS, false), questionOf(item), ctx, render, false, noSend);
    assertNoActiveContent(root);
    assert.equal(root.querySelector("h2")?.textContent, EVIL);
    assert.equal(root.querySelector("pre")?.textContent, EVIL);
  });

  it("offers the parsed options and names the upstream comment target", () => {
    const item = evilItem();
    const root = itemView(item, answerTarget(item, HOME_OWNERS, false), questionOf(item), ctx, render, false, noSend);
    const radios = [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => r.value);
    assert.deepEqual(radios, ["A", "B"]);
    assert.match(root.querySelector(".target")?.textContent ?? "", /public comment as you on example-upstream\/widget#42.*confirm/);
    assert.equal(root.querySelectorAll(".comment.your-answer").length, 1);
  });

  it("disables sending when there's nowhere to answer", () => {
    const item = queueItems(rawItems()).find((i) => i.kind === "unknown") as Item;
    const root = itemView(item, answerTarget(item, HOME_OWNERS), questionOf(item), undefined, render, false, noSend);
    assert.equal(root.querySelector<HTMLButtonElement>("button[type=submit]")?.disabled, true);
  });

  function answering(why: string, send: (a: unknown) => Promise<string>, alreadySent = false) {
    const item = queueItems(rawItems()).find((i) => i.nodeId === "PVTI_synthetic_home_issue") as Item;
    item.why = why;
    const root = itemView(item, answerTarget(item, HOME_OWNERS, true), questionOf(item), ctx, render, alreadySent, { send });
    win.document.body.replaceChildren(root);
    const submit = async (letter: string | undefined, text: string) => {
      const b = letter ? root.querySelector<HTMLInputElement>(`input[value=${letter}]`) : null;
      if (b) b.checked = true;
      const ta = root.querySelector("textarea");
      if (ta) ta.value = text;
      root.querySelector("form")?.dispatchEvent(new win.Event("submit", { cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    };
    const button = () => root.querySelector<HTMLButtonElement>("button[type=submit]") as HTMLButtonElement;
    const status = () => root.querySelector(".status")?.textContent ?? "";
    return { root, submit, button, status };
  }

  it("posts the picked option and text, then stays disabled", async () => {
    const sent: unknown[] = [];
    const v = answering("which? Options: A) this B) that", async (a) => {
      sent.push(a);
      return "https://github.com/done";
    });
    await v.submit("B", "because");
    assert.deepEqual(sent, [{ choice: "B", text: "because" }]);
    assert.match(v.status(), /^Sent: https:\/\/github\.com\/done/);
    assert.equal(v.button().disabled, true);
  });

  it("shows a refusal and lets him fix it", async () => {
    const v = answering("Options: A) this B) that", async (a) => {
      const { formatAnswer } = await import("../src/answer.ts");
      formatAnswer(a as Parameters<typeof formatAnswer>[0]);
      return "https://github.com/done";
    });
    await v.submit("A", "ok\n/promote");
    assert.match(v.status(), /^Not sent: .*would be read as a bot command/);
    assert.equal(v.button().disabled, false);
  });

  it("asks before a second answer from this tab", async () => {
    const sent: unknown[] = [];
    const confirms: string[] = [];
    Object.assign(win, { confirm: (m: string) => (confirms.push(m), false) });
    const v = answering("Options: A) this B) that", async (a) => (sent.push(a), "https://github.com/x"), true);
    await v.submit("A", "");
    assert.deepEqual(sent, []);
    assert.match(confirms[0] ?? "", /already answered/);
  });
});
