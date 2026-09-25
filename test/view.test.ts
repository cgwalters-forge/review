// The views put untrusted board and issue text on screen: check that it
// lands as text or sanitized markdown, whatever it contains.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerTarget, type Item, questionOf, queueItems } from "../src/github/board.ts";
import type { Context, ReceiptStatus } from "../src/github/backend.ts";
import { HOME_OWNERS } from "../src/github/config.ts";
import { createRenderer } from "../src/markdown.ts";
import { describeTarget, itemView, queueView } from "../src/github/view.ts";
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
  it("groups by priority and shows untrusted text as text", () => {
    const items = [evilItem(), ...queueItems(rawItems()).slice(1)];
    const root = queueView(items, new Set(), new Map());
    assertNoActiveContent(root);
    assert.deepEqual(
      [...root.querySelectorAll(".group-h")].map((e) => e.textContent),
      ["P0 · 1", "P1 · 1", "P2 · 1", "No priority · 1"],
    );
    assert.ok(root.textContent?.includes("<script>alert(2)</script>"));
  });

  it("trusts a draft's answer section only with a verified receipt", () => {
    const items = queueItems(rawItems());
    const draft = items.find((i) => i.kind === "draft") as Item;
    draft.body += "\n<!-- review-answer BEGIN receipt=https://gist.github.com/abc -->\n/answer A\n<!-- review-answer END -->\n";
    const sent = new Set(["PVTI_synthetic_home_issue"]);
    const labels = (receipts: Map<string, ReceiptStatus>) =>
      [...queueView(items, sent, receipts).querySelectorAll(".state")].map((e) => e.textContent);

    assert.deepEqual(labels(new Map()), ["body claims an answer (unverified)", "answered"]);
    const failed: ReceiptStatus = { url: "https://gist.github.com/abc", check: { ok: false, reason: "not his" } };
    assert.deepEqual(labels(new Map([[draft.nodeId, failed]])), ["body claims an answer (unverified)", "answered"]);
    const good: ReceiptStatus = { url: "https://gist.github.com/abc", check: { ok: true, receipt: { choice: "A", text: "", item: draft.nodeId } } };
    assert.deepEqual(labels(new Map([[draft.nodeId, good]])), ["answered", "answered"]);
  });

  it("says when nothing needs you", () => {
    assert.match(queueView([], new Set(), new Map()).textContent ?? "", /Nothing needs you/);
  });
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

  it("posts the picked option, text and question id, then stays disabled", async () => {
    const sent: unknown[] = [];
    const v = answering("Q#8: which? Options: A) this B) that", async (a) => {
      sent.push(a);
      return "https://github.com/done";
    });
    assert.match(v.root.querySelector(".target")?.textContent ?? "", /^Answering Q#8\./);
    await v.submit("B", "because");
    assert.deepEqual(sent, [{ choice: "B", question: "Q#8", text: "because" }]);
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

  it("won't answer an ambiguous question", () => {
    const v = answering("Q#1: this?\nQ#2: or that? Options: A) this B) that", async () => "https://github.com/x");
    assert.equal(v.button().disabled, true);
    assert.match(v.root.querySelector(".target")?.textContent ?? "", /several ids/);
  });

  it("says plainly that a draft answer on a public board is public", () => {
    const text = describeTarget({ kind: "draft", draftId: "DI_x", boardPublic: true });
    assert.match(text, /anyone can read on this public board/);
    assert.match(text, /treat both as public/);
    assert.doesNotMatch(describeTarget({ kind: "draft", draftId: "DI_x", boardPublic: false }), /public/);
  });
});
