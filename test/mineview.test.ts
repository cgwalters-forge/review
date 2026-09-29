// The "Make it mine" form: prefilled without the bot's Generated-by
// lines, nothing saved before the confirmation, and untrusted text kept
// as text.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Identity, MineEdit } from "../src/github/mine.ts";
import { confirmNotes, type MineHooks, mineSection } from "../src/github/mineview.ts";
import type { PrDetail } from "../src/github/prs.ts";
import { prView } from "../src/github/prview.ts";
import type { Verdict } from "../src/github/forge.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const EVIL = "<img src=x onerror=alert(1)>";
const C1 = "1".repeat(40);
const HEAD = "e".repeat(40);
const META = "<!-- bot-meta -->\n- Upstream: `up/widget`, base `main`\n<!-- /bot-meta -->";
const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fresh in-memory localStorage (jsdom's about:blank has none). */
function freshStorage(): Map<string, string> {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  return mem;
}

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: { owner: "cgwalters-forge", repo: "widget", number: 7 },
    url: "https://github.com/cgwalters-forge/widget/pull/7",
    updatedAt: "2026-09-01T10:00:00Z",
    title: `widget: ${EVIL}`,
    body: `Why ${EVIL}\n\nGenerated-by: https://github.com/cgwalters/#llms\n\n${META}`,
    author: "cgwalters-bot",
    state: "open",
    draft: true,
    head: HEAD,
    headRef: "bot/fix",
    headRepo: "cgwalters-forge/widget",
    parent: "up/widget",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitCount: 2,
    commits: [
      { sha: C1, parent: "0".repeat(40), url: "https://github.com/c", message: `first ${EVIL}\n\nGenerated-by: AI`, author: "cgwalters-bot" },
      { sha: HEAD, parent: C1, url: "https://github.com/c", message: "second\n\nGenerated-by: AI", author: "cgwalters-bot" },
    ],
    files: [],
    checks: [],
    verdict: { state: "none" },
    guide: { state: "none" },
    consistent: true,
    warnings: [],
    ...over,
  };
}

interface Saved {
  edit: MineEdit;
  committer: Identity;
  promote: boolean;
  ownText: boolean;
}

function hooks(saved: Saved[], over: Partial<MineHooks> = {}): MineHooks {
  return {
    login: "cgwalters",
    scopes: () => "public_repo",
    unseen: () => " Not seen here: 1 file never expanded (a.rs).",
    save: async (edit, committer, { promote, ownText }, progress) => {
      progress("Writing");
      saved.push({ edit, committer, promote, ownText });
      return { head: "f".repeat(40), titleSet: true, bodySet: true, commentUrl: "https://github.com/comment" };
    },
    ...over,
  };
}

const APPROVED: Verdict = { state: "approved" };
const buttonNamed = (root: Element, text: RegExp) => [...root.querySelectorAll("button")].find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement;
const field = <T extends Element>(root: Element, sel: string) => root.querySelector(sel) as T;

/** Make every field his: a new title, and no Generated-by line anywhere. */
function makeMine(el: Element, title = "widget: Mine"): void {
  field<HTMLInputElement>(el, ".mine-title").value = title;
  field<HTMLTextAreaElement>(el, ".mine-body").value = "My why.";
  for (const [i, ta] of [...el.querySelectorAll<HTMLTextAreaElement>(".mine-msg")].entries()) ta.value = `my commit ${i}`;
  field<HTMLInputElement>(el, "#mine-own").checked = true;
}

function mount(d: PrDetail, h: MineHooks): HTMLElement {
  const el = mineSection(d, h);
  win.document.body.replaceChildren(el);
  return el;
}

describe("mineSection", () => {
  it("prefills the bot's text verbatim, as text, and promote's committer", () => {
    freshStorage();
    const el = mount(detail(), hooks([]));
    assert.equal(el.querySelectorAll("img, script").length, 0);
    assert.equal(field<HTMLInputElement>(el, ".mine-title").value, `widget: ${EVIL}`);
    assert.equal(field<HTMLTextAreaElement>(el, ".mine-body").value, `Why ${EVIL}\n\nGenerated-by: https://github.com/cgwalters/#llms`);
    assert.deepEqual([...el.querySelectorAll<HTMLTextAreaElement>(".mine-msg")].map((t) => t.value), [`first ${EVIL}\n\nGenerated-by: AI`, "second\n\nGenerated-by: AI"]);
    assert.equal(field<HTMLInputElement>(el, ".mine-name").value, "Colin Walters");
    assert.equal(field<HTMLInputElement>(el, ".mine-email").value, "walters@verbum.org");
    assert.equal(field<HTMLInputElement>(el, "#mine-own").checked, false);
  });

  it("offers /promote --human-text by default only over his approval of the head", () => {
    assert.equal(field<HTMLInputElement>(mount(detail(), hooks([])), "#mine-promote").checked, false);
    assert.equal(field<HTMLInputElement>(mount(detail({ verdict: APPROVED }), hooks([])), "#mine-promote").checked, true);
  });

  const unavailable: [string, Partial<PrDetail>, MineHooks, RegExp][] = [
    ["a non-bot branch", { headRef: "main" }, hooks([]), /Not available: its branch main is not a bot\/ branch/],
    [
      "workflow changes without the scope",
      { files: [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0 }] },
      hooks([]),
      /Not available: this PR changes \.github\/workflows\/.*workflow scope/,
    ],
  ];
  for (const [what, over, h, want] of unavailable) {
    it(`says why it isn't available: ${what}`, () => {
      const el = mount(detail(over), h);
      assert.match(el.textContent ?? "", want);
      assert.equal(el.querySelector("textarea"), null);
    });
  }

  const refused: [string, (el: Element) => void, RegExp][] = [
    ["the untouched bot text", () => {}, /Fix first: .*description still has a Generated-by line.*commit 1111111111 still has a Generated-by line/],
    ["without \"This text is mine\"", (el) => {
      makeMine(el);
      field<HTMLInputElement>(el, "#mine-own").checked = false;
    }, /Fix first: tick "This text is mine"/],
    ["the bot's title with promote", (el) => {
      makeMine(el, `widget: ${EVIL}`);
      field<HTMLInputElement>(el, "#mine-promote").checked = true;
    }, /Fix first: the title is the bot's/],
  ];
  for (const [what, prep, want] of refused) {
    it(`refuses to confirm ${what}`, () => {
      const el = mount(detail(), hooks([]));
      prep(el);
      buttonNamed(el, /Review changes/).click();
      assert.match(field(el, ".status").textContent ?? "", want);
      assert.equal(field<HTMLElement>(el, ".mine-confirm").hidden, true);
    });
  }

  it("shows the diff and saves only after the confirmation", async () => {
    const mem = freshStorage();
    const saved: Saved[] = [];
    const el = mount(detail({ verdict: APPROVED }), hooks(saved));
    makeMine(el);
    buttonNamed(el, /Review changes/).click();
    assert.equal(saved.length, 0);
    const confirm = field<HTMLElement>(el, ".mine-confirm");
    assert.equal(confirm.hidden, false);
    assert.deepEqual([...confirm.querySelectorAll(".d-add")].map((s) => s.textContent), ["+ widget: Mine", "+ My why.", "+ my commit 0", "+ my commit 1"]);
    assert.match(confirm.textContent ?? "", /committer Colin Walters <walters@verbum.org>.*from eeeeeeeeee.*\/promote --human-text/s);
    // He approved this head: no approval warning.
    assert.equal(confirm.querySelectorAll(".warn").length, 0);
    assert.equal(confirm.querySelectorAll("img").length, 0);
    buttonNamed(el, /Push as cgwalters/).click();
    await tick();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.edit.title, "widget: Mine");
    assert.equal(saved[0]?.edit.messages.get(HEAD), "my commit 1");
    assert.deepEqual([saved[0]?.promote, saved[0]?.ownText], [true, true]);
    assert.match(field(el, ".status").textContent ?? "", /is now ffffffffff.*posted/);
    // Remembered for next time.
    assert.deepEqual(JSON.parse(mem.get("review.committer") ?? "null"), { name: "Colin Walters", email: "walters@verbum.org" });
  });

  it("warns, as Approve does, when promoting a head he hasn't approved", () => {
    const el = mount(detail(), hooks([]));
    makeMine(el);
    field<HTMLInputElement>(el, "#mine-promote").checked = true;
    buttonNamed(el, /Review changes/).click();
    assert.match(field(el, ".mine-confirm .warn").textContent ?? "", /haven't approved eeeeeeeeee.*Not seen here: 1 file never expanded/);
  });

  it("shows why a save stopped and lets him retry", async () => {
    const el = mount(detail(), hooks([], { save: async () => Promise.reject(new Error("the branch moved")) }));
    makeMine(el);
    buttonNamed(el, /Review changes/).click();
    const push = buttonNamed(el, /Push as/);
    push.click();
    await tick();
    assert.match(field(el, ".status").textContent ?? "", /Stopped: the branch moved/);
    assert.equal(push.disabled, false);
  });
});

describe("confirmNotes", () => {
  it("warns about an unapproved head, another login, and workflow files", () => {
    const d = detail({ files: [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0 }] });
    const notes = confirmNotes(d, "cgwalters-bot", true, " Not seen here: x.").join("\n");
    assert.match(notes, /haven't approved.* Not seen here: x\./);
    assert.match(notes, /signed in as cgwalters-bot/);
    assert.match(notes, /workflow scope/);
    assert.deepEqual(confirmNotes(detail(), "cgwalters", false, ""), []);
    assert.deepEqual(confirmNotes(detail({ verdict: APPROVED }), "cgwalters", true, ""), []);
  });
});

describe("prView with mine hooks", () => {
  const base = { review: async () => "", loadRange: async () => [], loadLines: async () => [] };
  it("offers the form on the bot's forge PRs only", () => {
    assert.ok(prView(detail(), undefined, render, { ...base, mine: hooks([]) }, { reviewedHere: false }).el.querySelector("details.mine"));
    assert.equal(prView(detail(), undefined, render, base, { reviewedHere: false }).el.querySelector("details.mine"), null);
    const upstream = detail({ ref: { owner: "bootc-dev", repo: "widget", number: 7 } });
    assert.equal(prView(upstream, undefined, render, { ...base, mine: hooks([]) }, { reviewedHere: false }).el.querySelector("details.mine"), null);
  });
});
