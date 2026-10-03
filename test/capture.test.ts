// The capture bar: what a draft files (title, body with the link, the
// label), the board add and its fallback, and what the bar shows.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { captureRequest, type CaptureDraft, fileCapture, type Filed, linkedRef } from "../src/github/capture.ts";
import { captureBar, type CaptureHooks, forgetDraft, loadDraft } from "../src/github/captureview.ts";
import { CAPTURE_DRAFT_KEY, CAPTURE_LABEL } from "../src/github/config.ts";
import { installDom, type Scripted, scriptedFetch } from "./helpers.ts";

const win = installDom();
const API = "https://api.github.com";
const token = async () => "t";
const draft = (over: Partial<CaptureDraft>): CaptureDraft => ({ title: "", body: "", url: "", ...over });

describe("linkedRef", () => {
  const cases: [string, string | undefined][] = [
    ["https://github.com/bootc-dev/bootc/issues/12", "bootc-dev/bootc#12"],
    ["https://github.com/bootc-dev/bootc/pull/2500/files#diff-1", "bootc-dev/bootc#2500"],
    [" https://github.com/o/r.js/pull/3?w=1 ", "o/r.js#3"],
    ["https://github.com/o/r", undefined],
    ["http://github.com/o/r/issues/1", undefined],
    ["https://github.example.com/o/r/issues/1", undefined],
    ["not a url", undefined],
  ];
  for (const [url, want] of cases) {
    it(url, () => {
      const r = linkedRef(url);
      assert.equal(r && `${r.owner}/${r.repo}#${r.number}`, want);
    });
  }
});

describe("captureRequest", () => {
  const ok: [string, Partial<CaptureDraft>, { title: string; body: string }][] = [
    ["a title alone", { title: "  Look at X " }, { title: "Look at X", body: "" }],
    ["a title and a note", { title: "T", body: "why\nit matters\n" }, { title: "T", body: "why\nit matters" }],
    ["a GitHub link, no title", { url: "https://github.com/o/r/pull/7#x" }, { title: "o/r#7", body: "https://github.com/o/r/pull/7#x" }],
    ["his title wins over the link's", { title: "Mine", body: "n", url: "https://github.com/o/r/issues/1" }, { title: "Mine", body: "n\n\nhttps://github.com/o/r/issues/1" }],
    ["any https link", { title: "T", url: "https://example.com/a b" }, { title: "T", body: "https://example.com/a%20b" }],
  ];
  for (const [name, d, want] of ok) {
    it(name, () => assert.deepEqual(captureRequest(draft(d)), { ...want, labels: [CAPTURE_LABEL] }));
  }
  const bad: [string, Partial<CaptureDraft>, RegExp][] = [
    ["nothing", {}, /Type a title/],
    ["a note only", { body: "x" }, /Type a title/],
    ["a non-GitHub link and no title", { url: "https://example.com/" }, /Type a title/],
    ["an http link", { title: "T", url: "http://example.com/" }, /https/],
    ["a javascript: link", { title: "T", url: "javascript:alert(1)" }, /https/],
    ["no URL at all", { title: "T", url: "example" }, /isn't a URL/],
  ];
  for (const [name, d, re] of bad) it(`refuses ${name}`, () => assert.throws(() => captureRequest(draft(d)), re));
  it("labels it for triage", () => assert.equal(CAPTURE_LABEL, "needs-triage"));
});

describe("fileCapture", () => {
  const ISSUES = `${API}/repos/cgwalters-forge/tracker/issues`;
  const BOARD = `${API}/orgs/cgwalters-forge/projectsV2/1/items`;
  const created = { body: { id: 991, number: 42, html_url: "https://github.com/cgwalters-forge/tracker/issues/42" }, status: 201 };
  const run = (issue: Scripted, board: Scripted) => {
    const { fetchImpl, calls } = scriptedFetch((m, url) => (m === "POST" && url === ISSUES ? issue : m === "POST" && url === BOARD ? board : undefined));
    return { calls, result: fileCapture(new GitHub(token, fetchImpl), draft({ title: "T", url: "https://github.com/o/r/issues/1" })) };
  };
  it("creates the labelled issue, then adds it to the board by id", async () => {
    const { calls, result } = run(created, { status: 201, body: { id: 5 } });
    assert.deepEqual(await result, { number: 42, url: "https://github.com/cgwalters-forge/tracker/issues/42" });
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [["POST", ISSUES], ["POST", BOARD]]);
    assert.deepEqual(calls[0]?.body, { title: "T", body: "https://github.com/o/r/issues/1", labels: [CAPTURE_LABEL] });
    assert.deepEqual(calls[1]?.body, { type: "Issue", id: 991 });
  });
  it("keeps the issue when the board add fails, and says why and what to do", async () => {
    const { result } = run(created, { status: 403, body: { message: "Resource not accessible by personal access token" } });
    const filed = await result;
    assert.equal(filed.number, 42);
    assert.match(filed.boardError ?? "", /HTTP 403: Resource not accessible by personal access token/);
    assert.match(filed.boardError ?? "", /bot adds it when it triages.*projects\/1.*project scope.*Projects: read and write/);
  });
  it("fails, adding nothing, when the issue can't be created", async () => {
    const { calls, result } = run({ status: 422, body: { message: "Validation Failed" } }, { status: 201 });
    await assert.rejects(result, /HTTP 422: Validation Failed/);
    assert.equal(calls.length, 1);
  });
  it("sends nothing for an invalid draft", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => undefined);
    await assert.rejects(fileCapture(new GitHub(token, fetchImpl), draft({})), /Type a title/);
    assert.equal(calls.length, 0);
  });
});

/** A bar over STORAGE with the given hooks, and helpers to drive it. */
function mount(storage: Storage, file: CaptureHooks["file"], linkTitle: CaptureHooks["linkTitle"]) {
  const b = captureBar({ file, linkTitle, storage });
  document.body.replaceChildren(b.el);
  const q = <T extends Element>(sel: string) => b.el.querySelector(sel) as unknown as T;
  const type = (sel: string, v: string) => {
    const el = q<HTMLInputElement>(sel);
    el.value = v;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  const submit = async () => {
    b.el.dispatchEvent(new win.Event("submit", { cancelable: true }));
    // Let the file promise and its handlers run.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { b, q, type, submit, status: () => q<HTMLElement>(".capture-status") };
}

class MemStorage {
  #m = new Map<string, string>();
  getItem(k: string) {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.#m.set(k, v);
  }
  removeItem(k: string) {
    this.#m.delete(k);
  }
}
const mem = () => new MemStorage() as unknown as Storage;
const filedOk = async (): Promise<Filed> => ({ number: 42, url: "https://github.com/cgwalters-forge/tracker/issues/42" });

describe("captureBar", () => {
  it("files the draft, shows Filed #N with a link, and clears the form and the draft", async () => {
    let sent: CaptureDraft | undefined;
    const storage = mem();
    const m = mount(storage, async (d) => ((sent = d), filedOk()), async () => undefined);
    m.type(".capture-title", "Look at X");
    assert.ok(storage.getItem(CAPTURE_DRAFT_KEY));
    await m.submit();
    assert.deepEqual(sent, { title: "Look at X", body: "", url: "" });
    assert.equal(m.status().textContent, "Filed #42.");
    assert.equal(m.status().querySelector("a")?.getAttribute("href"), "https://github.com/cgwalters-forge/tracker/issues/42");
    assert.ok(!m.status().classList.contains("warn"));
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "");
    assert.equal(storage.getItem(CAPTURE_DRAFT_KEY), null);
  });
  it("shows the board note when the add failed", async () => {
    const m = mount(mem(), async () => ({ ...(await filedOk()), boardError: "HTTP 403. Add it by hand." }), async () => undefined);
    m.type(".capture-title", "T");
    await m.submit();
    assert.equal(m.status().textContent, "Filed #42 but it isn't on the board: HTTP 403. Add it by hand.");
    assert.ok(m.status().classList.contains("warn"));
  });
  it("shows an error, as text, and keeps the draft to retry", async () => {
    const storage = mem();
    const m = mount(storage, async () => {
      throw new Error("POST failed with HTTP 422 <b>x</b>");
    }, async () => undefined);
    m.type(".capture-title", "T");
    await m.submit();
    assert.equal(m.status().textContent, "Not filed: POST failed with HTTP 422 <b>x</b>");
    assert.equal(m.status().querySelector("b"), null);
    assert.ok(m.status().classList.contains("warn"));
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "T");
    assert.deepEqual(loadDraft(storage), { title: "T", body: "", url: "", suggested: "" });
    assert.equal(m.q<HTMLButtonElement>("button[type=submit]").disabled, false);
  });
  it("sends one request per submit while one is in flight", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const m = mount(mem(), () => {
      calls++;
      return new Promise<Filed>((r) => (release = () => r({ number: 1, url: "https://github.com/x" })));
    }, async () => undefined);
    m.type(".capture-title", "T");
    await m.submit();
    await m.submit();
    assert.equal(calls, 1);
    release();
  });
  it("restores a draft after a reload, with the note open", () => {
    const storage = mem();
    storage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify({ title: "a", body: "b", url: "https://x.example/" }));
    const m = mount(storage, filedOk, async () => undefined);
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "a");
    assert.equal(m.q<HTMLInputElement>(".capture-url").value, "https://x.example/");
    assert.equal(m.q<HTMLTextAreaElement>(".capture-body").value, "b");
    assert.equal(m.q<HTMLElement>(".capture-extra").hidden, false);
  });
  it("keeps the link and note behind a button unless there is a draft of them, and closes them once filed", async () => {
    const m = mount(mem(), filedOk, async () => undefined);
    const extra = m.q<HTMLElement>(".capture-extra");
    const more = m.q<HTMLButtonElement>("button[aria-expanded]");
    assert.ok(extra.hidden);
    assert.equal(more.getAttribute("aria-expanded"), "false");
    more.click();
    assert.ok(!extra.hidden);
    assert.equal(document.activeElement, m.q(".capture-url"));
    more.click();
    assert.ok(extra.hidden);
    // b focuses the title, which is always on the page.
    m.b.focus();
    assert.equal(document.activeElement, m.q(".capture-title"));
    more.click();
    m.type(".capture-title", "T");
    await m.submit();
    assert.ok(extra.hidden);
    assert.equal(m.status().textContent, "Filed #42.");

    const storage = mem();
    storage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify({ title: "a", body: "", url: "" }));
    assert.ok(mount(storage, filedOk, async () => undefined).q<HTMLElement>(".capture-extra").hidden, "a title alone needs no more");
    storage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify({ title: "a", body: "", url: "https://x.example/" }));
    assert.ok(!mount(storage, filedOk, async () => undefined).q<HTMLElement>(".capture-extra").hidden);
  });
  it("ignores a malformed saved draft", () => {
    const storage = mem();
    storage.setItem(CAPTURE_DRAFT_KEY, '{"title": 3}');
    assert.deepEqual(loadDraft(storage), { title: "", body: "", url: "", suggested: "" });
    assert.deepEqual(loadDraft(undefined), { title: "", body: "", url: "", suggested: "" });
  });
  it("suggests the title from a pasted link, then its real title, but never over his", async () => {
    const m = mount(mem(), filedOk, async () => "Fix the frobnicator");
    m.type(".capture-url", "https://github.com/o/r/pull/7");
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "o/r#7");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "o/r#7: Fix the frobnicator");
    m.type(".capture-title", "My words");
    m.type(".capture-url", "https://github.com/o/r/pull/8");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "My words");
  });
  it("drops a suggested title with its link, also after a reload, but never his own", async () => {
    const storage = mem();
    let m = mount(storage, filedOk, async () => undefined);
    m.type(".capture-url", "https://github.com/o/r/pull/7");
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "o/r#7");
    // Reloaded: the suggestion is still known as one.
    m = mount(storage, filedOk, async () => undefined);
    m.type(".capture-url", "https://example.com/");
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "");
    m.type(".capture-title", "Mine");
    m.type(".capture-url", "");
    assert.equal(m.q<HTMLInputElement>(".capture-title").value, "Mine");
  });
  it("forgets the draft", () => {
    const storage = mem();
    storage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify({ title: "a", body: "", url: "" }));
    forgetDraft(storage);
    assert.equal(storage.getItem(CAPTURE_DRAFT_KEY), null);
  });
});
