// The views put untrusted board and issue text on screen: check that it
// lands as text or sanitized markdown, whatever it contains. And that
// only question issues get an answer box.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerTarget, type Item, queueItems } from "../src/github/board.ts";
import type { Context } from "../src/github/backend.ts";
import { createRenderer } from "../src/markdown.ts";
import { buildEntries, type Entry } from "../src/github/queue.ts";
import { age, answerState, type AnswerState, itemView, queueView, STATE_LABEL } from "../src/github/view.ts";
import { installDom, rawItems } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const noSend = { send: async () => "https://github.com/x" };

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>[x](javascript:alert(3))';

function fixture(nodeId: string): Item {
  return queueItems(rawItems()).find((i) => i.nodeId === nodeId) as Item;
}

function evilItem(): Item {
  return {
    ...fixture("PVTI_synthetic_upstream_pr"),
    title: EVIL,
    why: EVIL,
    body: EVIL,
    org: EVIL,
    branch: ["https://ok.example/branch"],
    gist: ["javascript:alert(6)"],
    url: "javascript:alert(7)",
  };
}

function evilQuestion(): Item {
  return {
    ...fixture("PVTI_synthetic_question"),
    title: EVIL,
    body: `Blocks: javascript:alert(8)\n${EVIL}\nQ: ${EVIL}\nOptions:\nA) <b onclick=alert(4)>bold</b>\nB) javascript:alert(5)\nRecommended: A`,
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

describe("answerState", () => {
  const q = fixture("PVTI_synthetic_question");
  const cases: [string, Item, string[], string[], AnswerState][] = [
    ["an open question", q, [], [], undefined],
    ["answered on GitHub", q, [], [q.nodeId], "answered"],
    ["sent from here", q, [q.nodeId], [], "answered"],
    ["closed by the bot", fixture("PVTI_synthetic_closed_question"), [], [], "done"],
    ["another item, whatever the sets say", fixture("PVTI_synthetic_home_issue"), ["PVTI_synthetic_home_issue"], ["PVTI_synthetic_home_issue"], undefined],
  ];
  for (const [name, item, sent, answered, want] of cases) {
    it(name, () => assert.equal(answerState(item, new Set(sent), new Set(answered)), want));
  }
});

describe("queueView", () => {
  const entriesOf = (items: Item[], answered = new Set<string>()) => buildEntries(items, [], new Map(), true, answered);
  const labels = (sent: Set<string>, answered: Set<string>) => (e: Entry) => {
    const st = e.item ? answerState(e.item, sent, answered) : undefined;
    return st ? { text: STATE_LABEL[st], cls: st } : undefined;
  };
  const items = () => [evilItem(), ...queueItems(rawItems()).slice(1)];

  it("ranks by priority, nests questions and shows untrusted text as text", () => {
    const root = queueView(entriesOf(items()), labels(new Set(), new Set()), Date.parse("2026-02-01T00:00:00Z"));
    assertNoActiveContent(root);
    assert.deepEqual(
      [...root.querySelectorAll(".group-h")].map((e) => e.textContent),
      ["P0 · 1", "P1 · 2", "P2 · 1", "No priority · 1", "Answered, waiting on the bot · 1"],
    );
    assert.ok(root.textContent?.includes("<script>alert(2)</script>"));
    const hrefs = (sel: string) => [...root.querySelectorAll(sel)].map((r) => r.getAttribute("href"));
    assert.deepEqual(hrefs(".row"), [
      "#item/PVTI_synthetic_draft",
      "#item/PVTI_synthetic_upstream_pr",
      "#item/PVTI_synthetic_upstream_question",
      "#item/PVTI_synthetic_epic",
      "#item/PVTI_synthetic_question",
      "#item/PVTI_synthetic_redacted",
      "#item/PVTI_synthetic_home_issue",
      "#item/PVTI_synthetic_closed_question",
    ]);
    assert.deepEqual(hrefs(".row.child"), ["#item/PVTI_synthetic_upstream_question", "#item/PVTI_synthetic_question"]);
    const row = (id: string) => root.querySelector(`.row[href="#item/${id}"]`);
    assert.equal(row("PVTI_synthetic_question")?.querySelector(".why")?.textContent, "Which prefix?");
    assert.match(row("PVTI_synthetic_closed_question")?.querySelector(".tag")?.textContent ?? "", /blocks cgwalters-bot\/elsewhere#5/);
    assert.match(root.querySelector(".summary")?.textContent ?? "", /0 PRs to review · 2 questions · 5 other/);
  });

  it("labels answered and closed questions", () => {
    const answered = new Set(["PVTI_synthetic_question"]);
    const root = queueView(entriesOf(items(), answered), labels(new Set(["PVTI_synthetic_home_issue"]), answered));
    const states = [...root.querySelectorAll(".row")].flatMap((r) => {
      const s = r.querySelector(".state")?.textContent;
      return s ? [[r.getAttribute("href"), s]] : [];
    });
    assert.deepEqual(states, [
      ["#item/PVTI_synthetic_question", "answered, waiting on the bot"],
      ["#item/PVTI_synthetic_closed_question", "closed by the bot"],
    ]);
    assert.match(root.querySelector(".summary")?.textContent ?? "", /1 questions/);
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
    warnings: [EVIL],
    comments: [
      { author: "cgwalters-bot", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/c/0", body: "Asked." },
      { author: "cgwalters", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/c/1", body: "B\nfine" },
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
  const view = (item: Item, state: AnswerState = undefined, send = noSend.send, questions: Entry[] = []) =>
    itemView(item, { target: answerTarget(item), context: ctx, state, questions }, render, { send });

  it("renders every untrusted field safely", () => {
    for (const item of [evilItem(), evilQuestion()]) {
      const root = view(item);
      assertNoActiveContent(root);
      assert.equal(root.querySelector("h2")?.textContent, EVIL);
      assert.equal(root.querySelector("pre")?.textContent, EVIL);
    }
  });

  it("gives an upstream item no answer box, and a link to act on GitHub", () => {
    const item = fixture("PVTI_synthetic_upstream_pr");
    const q: Entry = { key: "item:Q", kind: "question", title: "Rerun or rebase?", where: "", href: "#item/Q" };
    const root = view(item, undefined, noSend.send, [q]);
    assert.equal(root.querySelector("form"), null);
    assert.match(root.querySelector(".target")?.textContent ?? "", /^Nothing to answer here: example-upstream\/widget#42 is not an issue/);
    assert.equal(root.querySelector(".links a")?.textContent, "example-upstream/widget#42: act on GitHub");
    assert.deepEqual([...root.querySelectorAll(".questions a")].map((a) => [a.getAttribute("href"), a.textContent]), [["#item/Q", "Rerun or rebase?"]]);
    // Not a question, so his comment there is not an answer.
    assert.equal(root.querySelectorAll(".comment.your-answer").length, 0);
  });

  it("offers a question's options, recommendation first, and names the issue", () => {
    const root = view(fixture("PVTI_synthetic_question"));
    const radios = [...root.querySelectorAll<HTMLInputElement>("input[type=radio]")].map((r) => r.value);
    assert.deepEqual(radios, ["A", "B"]);
    assert.equal(root.querySelector("label[for=opt-A] .rec")?.textContent, "recommended");
    assert.equal(root.querySelector("label[for=opt-B] .rec"), null);
    assert.match(root.querySelector(".target")?.textContent ?? "", /comment as you on cgwalters-forge\/tracker#21; the bot acts on it and closes the issue/);
    assert.deepEqual([...root.querySelectorAll(".links a")].map((a) => a.textContent).slice(0, 2), ["cgwalters-forge/tracker#21", "blocks"]);
    assert.equal(root.querySelector(".comment.your-answer .meta")?.textContent?.endsWith("your answer: B"), true);
  });

  it("shows a closed question as done, with nothing to send", () => {
    const root = view(fixture("PVTI_synthetic_closed_question"), "done");
    assert.equal(root.querySelector("form"), null);
    assert.match(root.textContent ?? "", /The bot acted on this question and closed it/);
  });

  function answering(send: (a: unknown) => Promise<string>, state: AnswerState = undefined) {
    const root = view(fixture("PVTI_synthetic_question"), state, send as typeof noSend.send);
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

  it("sends the picked option and text, then stays disabled", async () => {
    const sent: unknown[] = [];
    const v = answering(async (a) => {
      sent.push(a);
      return "https://github.com/done";
    });
    await v.submit("B", "because");
    assert.deepEqual(sent, [{ choice: "B", text: "because" }]);
    assert.match(v.status(), /^Sent: https:\/\/github\.com\/done/);
    assert.equal(v.button().disabled, true);
  });

  it("shows a refusal and lets him fix it", async () => {
    const v = answering(async (a) => {
      const { formatAnswer } = await import("../src/answer.ts");
      formatAnswer(a as Parameters<typeof formatAnswer>[0]);
      return "https://github.com/done";
    });
    await v.submit("A", "ok\n/promote");
    assert.match(v.status(), /^Not sent: .*would be read as a bot command/);
    assert.equal(v.button().disabled, false);
  });

  it("asks before answering an answered question again", async () => {
    const sent: unknown[] = [];
    const confirms: string[] = [];
    Object.assign(win, { confirm: (m: string) => (confirms.push(m), false) });
    const v = answering(async (a) => (sent.push(a), "https://github.com/x"), "answered");
    assert.match(v.root.textContent ?? "", /You answered; the question stays in the queue/);
    await v.submit("A", "");
    assert.deepEqual(sent, []);
    assert.match(confirms[0] ?? "", /already answered/);
  });
});
