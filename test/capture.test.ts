// The capture bar: what a draft files (title, body with the link, the
// label), the board add and its fallback, and what the bar shows.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { parseItem } from "../src/github/board.ts";
import { captureRequest, type CaptureDraft, CaptureUncertain, fileCapture, type Filed, linkedRef, loadCaptureEpics, loadCaptureLabels } from "../src/github/capture.ts";
import { captureBar, type CaptureHooks, forgetDraft, loadDraft } from "../src/github/captureview.ts";
import { CAPTURE_DRAFT_KEY, CAPTURE_LABEL } from "../src/github/config.ts";
import { installDom, rawBoardItem, type Scripted, scriptedFetch } from "./helpers.ts";

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
    ["pasted title lines stay one title", { title: " First line\r\n second line\nthird " }, { title: "First line second line third", body: "" }],
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
    ["dispatch without repo", { title: "T", labels: ["dispatch"] }, /Repo is required/],
    ["bad repo", { title: "T", repo: "https://github.com/o/r" }, /owner\/repo/],
    ["dot repo", { title: "T", repo: "o/.." }, /owner\/repo/],
    ["invalid epic", { title: "T", epic: -1 }, /epic/],
  ];
  for (const [name, d, re] of bad) it(`refuses ${name}`, () => assert.throws(() => captureRequest(draft(d)), re));
  it("labels it for triage", () => assert.equal(CAPTURE_LABEL, "needs-triage"));
  const composed: [Partial<CaptureDraft>, ReturnType<typeof captureRequest>][] = [
    [{ title: " T ", body: " **markdown**\n\ntext ", priority: "P0" }, { title: "T", body: "**markdown**\n\ntext\n\nPriority: P0", labels: [CAPTURE_LABEL] }],
    [{ title: "T", priority: "P1", repo: " o/r ", labels: ["dispatch", "escalate", "dispatch", CAPTURE_LABEL], epic: 12 }, { title: "T", body: "Priority: P1\nRepo: o/r", labels: [CAPTURE_LABEL, "dispatch", "escalate"], parent: 12 }],
    [{ title: "T", priority: "P2", body: "why", url: "https://example.com/", labels: ["bug"], repo: "o/r.js" }, { title: "T", body: "why\n\nhttps://example.com/\n\nPriority: P2\nRepo: o/r.js", labels: [CAPTURE_LABEL, "bug"] }],
    [{ title: "T", epic: 3 }, { title: "T", body: "", labels: [CAPTURE_LABEL], parent: 3 }],
  ];
  for (const [d, want] of composed) it(`composes ${JSON.stringify(d)}`, () => assert.deepEqual(captureRequest(draft(d)), want));
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
  for (const fails of [false, true]) it(`attaches epic and adds board, attachment fails=${fails}`, async () => {
    const { fetchImpl, calls } = scriptedFetch((method, url) => {
      if (method === "GET" && url === `${ISSUES}/12`) return { body: { state: "open", labels: [{ name: "epic" }] } };
      if (url === ISSUES) return created;
      if (url === `${ISSUES}/12/sub_issues`) return fails ? { status: 403 } : { status: 201 };
      if (url === BOARD) return { status: 201 };
      return undefined;
    });
    const result = await fileCapture(new GitHub(token, fetchImpl), draft({ title: "T", epic: 12 }));
    assert.equal(result.number, 42);
    assert.equal(!!result.parentError, fails);
    assert.deepEqual(calls[2]?.body, { sub_issue_id: 991 });
    assert.equal(calls[3]?.url, BOARD);
    assert.ok(!Object.hasOwn(calls[1]?.body as object, "parent"));
  });
  it("rejects a closed epic before creating anything", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => ({ body: { state: "closed", labels: [{ name: "epic" }] } }));
    await assert.rejects(fileCapture(new GitHub(token, fetchImpl), draft({ title: "T", epic: 12 })), /open tracker issue/);
    assert.deepEqual(calls.map((c) => c.method), ["GET"]);
  });
  for (const status of [undefined, 503]) it(`reports uncertain creation after ${status ?? "a lost response"}`, async () => {
    const gh = new GitHub(token, async () => {
      if (status) return new Response(JSON.stringify({ message: "Unavailable" }), { status });
      throw new Error("Connection lost");
    });
    await assert.rejects(fileCapture(gh, draft({ title: "T" })), (error: unknown) => error instanceof CaptureUncertain && /may have been created/.test(error.message));
  });
  for (const [priority, optionId, fieldId] of [["P0", "urgent-7", "PVSF_changed-8"], ["P1", "normal-2", "PVSF_other-4"], ["P2", "later-9", "PVSF_new-6"]] as const) {
    it(`sets board ${priority} using its named option and dynamically resolved field ID`, async () => {
      const options = [{ name: "P2", id: priority === "P2" ? optionId : "other-later" }, { name: "P0", id: priority === "P0" ? optionId : "other-urgent" }, { name: "P1", id: priority === "P1" ? optionId : "other-normal" }];
      let graphql = 0;
      let selected: string | undefined;
      const { fetchImpl, calls } = scriptedFetch((_method, url) => {
        if (url === ISSUES) return created;
        if (url === BOARD) return { status: 201, body: { id: 87, node_id: "PVTI_created" } };
        if (url === `${API}/graphql`) {
          if (graphql++ === 0) return { body: { data: { organization: { projectV2: { id: "PVT_dynamic", field: { id: fieldId, options } } } } } };
          const variables = (calls.at(-1)?.body as { variables: { option: string } }).variables;
          selected = options.find((option) => option.id === variables.option)?.name;
          return { body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_created" } } } } };
        }
        return undefined;
      });
      const result = await fileCapture(new GitHub(token, fetchImpl), draft({ title: "T", priority }));
      assert.deepEqual(result, { number: 42, url: created.body.html_url });
      assert.equal(calls.filter((call) => call.url === ISSUES).length, 1);
      assert.deepEqual((calls[2]?.body as { variables: unknown }).variables, { owner: "cgwalters-forge", number: 1, field: "Priority" });
      assert.deepEqual((calls[3]?.body as { variables: unknown }).variables, { project: "PVT_dynamic", item: "PVTI_created", field: fieldId, option: optionId });
      assert.match((calls[3]?.body as { query: string }).query, /updateProjectV2ItemFieldValue/);
      assert.equal(parseItem(rawBoardItem(87, { Priority: selected ?? "" })).priority, priority, "the queue reads the updated board field");
    });
  }
  const priorityFailures: [string, Scripted, Scripted, Scripted, RegExp][] = [
    ["missing field", { body: { node_id: "PVTI_created" } }, { body: { data: { organization: { projectV2: { id: "PVT_x", field: null } } } } }, {}, /no single-select field/],
    ["missing option", { body: { node_id: "PVTI_created" } }, { body: { data: { organization: { projectV2: { id: "PVT_x", field: { id: "PVSF_x", options: [{ id: "x", name: "P1" }] } } } } } }, {}, /no option named "P0"/],
    ["lookup GraphQL error", { body: { node_id: "PVTI_created" } }, { body: { errors: [{ message: "Cannot read project" }] } }, {}, /Cannot read project/],
    ["missing item ID", { body: { id: 87 } }, {}, {}, /no board item node ID/],
    ["mutation error", { body: { node_id: "PVTI_created" } }, { body: { data: { organization: { projectV2: { id: "PVT_x", field: { id: "PVSF_x", options: [{ id: "x", name: "P0" }] } } } } } }, { body: { errors: [{ message: "Cannot write Priority" }] } }, /Cannot write Priority/],
    ["unconfirmed mutation", { body: { node_id: "PVTI_created" } }, { body: { data: { organization: { projectV2: { id: "PVT_x", field: { id: "PVSF_x", options: [{ id: "x", name: "P0" }] } } } } } }, { body: { data: { updateProjectV2ItemFieldValue: null } } }, /didn't confirm/],
    ["write HTTP error", { body: { node_id: "PVTI_created" } }, { body: { data: { organization: { projectV2: { id: "PVT_x", field: { id: "PVSF_x", options: [{ id: "x", name: "P0" }] } } } } } }, { status: 403 }, /HTTP 403/],
  ];
  for (const [name, board, lookup, update, message] of priorityFailures) it(`retains the filed issue on Priority ${name}`, async () => {
    let graphql = 0;
    const { fetchImpl, calls } = scriptedFetch((_method, url) => url === ISSUES ? created : url === BOARD ? board : url === `${API}/graphql` ? graphql++ === 0 ? lookup : update : undefined);
    const result = await fileCapture(new GitHub(token, fetchImpl), draft({ title: "T", priority: "P0" }));
    assert.equal(result.url, created.body.html_url);
    assert.equal(result.boardError, undefined);
    assert.match(result.priorityError ?? "", message);
    assert.match(result.priorityError ?? "", /check or set Priority P0.*Do not file it again/);
    assert.equal(calls.filter((call) => call.url === ISSUES).length, 1);
  });
  it("doesn't attempt Priority when adding the item failed", async () => {
    const { fetchImpl, calls } = scriptedFetch((_method, url) => url === ISSUES ? created : url === BOARD ? { status: 403 } : undefined);
    const result = await fileCapture(new GitHub(token, fetchImpl), draft({ title: "T", priority: "P0" }));
    assert.ok(result.boardError);
    assert.equal(result.priorityError, undefined);
    assert.equal(calls.length, 2);
  });
});

describe("capture option loaders", () => {
  it("loads tracker labels and only epic issues, with cache-only reuse", async () => {
    let offline = false;
    const { fetchImpl, calls } = scriptedFetch((_method, url) => url.includes("/labels?")
      ? offline ? { status: 503 } : { body: [{ name: "bug" }, { name: "dispatch" }] }
      : offline ? { status: 503 } : { body: [{ number: 1, title: "Epic" }, { number: 2, title: "PR", pull_request: {} }] });
    const gh = new GitHub(token, fetchImpl);
    assert.deepEqual(await loadCaptureLabels(gh), ["bug", "dispatch"]);
    assert.deepEqual(await loadCaptureEpics(gh), [{ number: 1, title: "Epic" }]);
    assert.deepEqual(await loadCaptureLabels(gh.cacheOnly()), ["bug", "dispatch"]);
    assert.match(calls[1]?.url ?? "", /state=open&labels=epic/);
    assert.equal(calls.length, 2);
    offline = true;
    assert.deepEqual(await loadCaptureLabels(gh), ["bug", "dispatch"]);
    assert.deepEqual(await loadCaptureEpics(gh), [{ number: 1, title: "Epic" }]);
  });
});

/** A bar over STORAGE with the given hooks, and helpers to drive it. */
function mount(storage: Storage, file: CaptureHooks["file"], linkTitle: CaptureHooks["linkTitle"]) {
  const b = captureBar({ file, linkTitle, storage });
  document.body.replaceChildren(b.el);
  b.mounted();
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
    // b expands the composer and focuses the title.
    m.b.focus();
    assert.equal(document.activeElement, m.q(".capture-title"));
    assert.ok(!extra.hidden);
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
  for (const modifier of ["ctrlKey", "metaKey"] as const) it(`${modifier}+Enter files from the title; Enter does not`, async () => {
    let calls = 0;
    const m = mount(mem(), async () => { calls++; return filedOk(); }, async () => undefined);
    m.b.focus();
    m.type(".capture-title", "T");
    const input = m.q<HTMLInputElement>(".capture-title");
    const plain = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(plain);
    assert.ok(plain.defaultPrevented);
    assert.equal(calls, 0);
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", [modifier]: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls, 1);
  });
  it("Escape collapses, stops navigation, and restores all fields after reload", () => {
    const storage = mem();
    const m = mount(storage, filedOk, async () => undefined);
    m.b.focus();
    m.type(".capture-title", "T");
    m.type(".capture-body", "line one\n\n**two**");
    m.type(".capture-priority", "P1");
    m.type(".capture-repo", "o/r");
    const checkbox = m.q<HTMLInputElement>('input[value="dispatch"]');
    checkbox.checked = true;
    checkbox.dispatchEvent(new win.Event("change", { bubbles: true }));
    let escaped = false;
    document.body.addEventListener("keydown", () => { escaped = true; }, { once: true });
    m.q(".capture-body").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(escaped, false);
    assert.ok(m.q<HTMLElement>(".capture-extra").hidden);
    assert.deepEqual(loadDraft(storage), { title: "T", body: "line one\n\n**two**", url: "", suggested: "", priority: "P1", repo: "o/r", labels: ["dispatch"] });
    const restored = mount(storage, filedOk, async () => undefined);
    assert.equal(restored.q<HTMLSelectElement>(".capture-priority").value, "P1");
    assert.equal(restored.q<HTMLInputElement>(".capture-repo").required, true);
  });
  it("autogrows the body and loads options once on expansion", async () => {
    let loads = 0;
    const b = captureBar({ storage: mem(), file: filedOk, linkTitle: async () => undefined, labels: async () => { loads++; return ["bug", "dispatch"]; }, epics: async () => [{ number: 12, title: "Epic" }] });
    document.body.replaceChildren(b.el);
    b.focus(); b.focus();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(loads, 1);
    assert.equal(b.el.querySelectorAll('input[value="dispatch"]').length, 1);
    assert.ok(b.el.querySelector('input[value="bug"]'));
    assert.match(b.el.querySelector(".capture-epic")?.textContent ?? "", /#12: Epic/);
    const body = b.el.querySelector<HTMLTextAreaElement>(".capture-body")!;
    Object.defineProperty(body, "scrollHeight", { value: 200 });
    body.dispatchEvent(new win.Event("input", { bubbles: true }));
    assert.equal(body.style.height, "200px");
  });
  it("partial success clears the draft, links the issue and refreshes once even if refresh throws", async () => {
    const storage = mem();
    let refreshes = 0;
    const b = captureBar({ storage, linkTitle: async () => undefined, file: async () => ({ ...(await filedOk()), parentError: "Attach manually; do not file again." }), filed: () => { refreshes++; throw new Error("refresh failed"); } });
    document.body.replaceChildren(b.el);
    b.focus();
    const title = b.el.querySelector<HTMLTextAreaElement>(".capture-title")!;
    title.value = "T";
    title.dispatchEvent(new win.Event("input", { bubbles: true }));
    b.el.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(refreshes, 1);
    assert.equal(storage.getItem(CAPTURE_DRAFT_KEY), null);
    assert.match(b.el.querySelector(".capture-status")?.textContent ?? "", /Filed #42.*Epic attachment failed/);
    assert.ok(b.el.querySelector(".capture-status a"));
  });
  it("retains an uncertain draft with a tracker link and blocks duplicate submission", async () => {
    let calls = 0;
    const storage = mem();
    const m = mount(storage, async () => { calls++; throw new CaptureUncertain("The issue may have been created. Check tracker before reloading."); }, async () => undefined);
    m.type(".capture-title", "T");
    await m.submit();
    await m.submit();
    assert.equal(calls, 1);
    assert.equal(loadDraft(storage).title, "T");
    assert.equal(m.q<HTMLButtonElement>("button[type=submit]").disabled, true);
    assert.match(m.status().textContent ?? "", /Filing outcome unknown/);
    assert.equal(m.status().querySelector("a")?.getAttribute("href"), "https://github.com/cgwalters-forge/tracker/issues");
  });
  it("measures a long restored body and wrapped title only after visible mount without focus", () => {
    const storage = mem();
    storage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify({ title: "A long title that wraps on a phone".repeat(4), body: "restored line\n".repeat(30), url: "" }));
    const b = captureBar({ storage, file: filedOk, linkTitle: async () => undefined });
    const body = b.el.querySelector<HTMLTextAreaElement>(".capture-body")!;
    const title = b.el.querySelector<HTMLTextAreaElement>(".capture-title")!;
    Object.defineProperty(body, "scrollHeight", { get: () => b.el.isConnected ? 640 : 0 });
    Object.defineProperty(title, "scrollHeight", { get: () => b.el.isConnected ? 112 : 0 });
    assert.equal(body.style.height, "", "don't measure detached text");
    document.body.replaceChildren(b.el);
    b.mounted();
    assert.equal(body.style.height, "640px");
    assert.equal(title.style.height, "112px");
    assert.notEqual(document.activeElement, title);
    assert.notEqual(document.activeElement, body);
  });
  it("the title wraps and autogrows but doesn't insert a newline on Enter", async () => {
    let sent: CaptureDraft | undefined;
    const storage = mem();
    const m = mount(storage, async (draft) => { sent = draft; return filedOk(); }, async () => undefined);
    const title = m.q<HTMLTextAreaElement>(".capture-title");
    assert.equal(title.tagName, "TEXTAREA");
    assert.equal(title.rows, 1);
    assert.equal(title.wrap, "soft");
    Object.defineProperty(title, "scrollHeight", { value: 120 });
    m.type(".capture-title", "First line\nsecond line");
    assert.equal(title.value, "First line second line");
    assert.equal(title.style.height, "120px");
    assert.equal(loadDraft(storage).title, "First line second line");
    const enter = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    title.dispatchEvent(enter);
    assert.ok(enter.defaultPrevented);
    const bodyEnter = new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    m.q(".capture-body").dispatchEvent(bodyEnter);
    assert.equal(bodyEnter.defaultPrevented, false, "the body still allows multiline Markdown");
    await m.submit();
    assert.equal(sent?.title, "First line second line");
  });
  it("Priority partial failure links the created issue, clears the draft, and refreshes", async () => {
    const storage = mem();
    let refreshes = 0;
    const b = captureBar({ storage, file: async () => ({ ...(await filedOk()), priorityError: "Check or set P0 on the board." }), linkTitle: async () => undefined, filed: () => { refreshes++; } });
    document.body.replaceChildren(b.el);
    b.mounted();
    const title = b.el.querySelector<HTMLTextAreaElement>(".capture-title")!;
    title.value = "T";
    title.dispatchEvent(new win.Event("input", { bubbles: true }));
    b.el.dispatchEvent(new win.Event("submit", { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(storage.getItem(CAPTURE_DRAFT_KEY), null);
    const status = b.el.querySelector<HTMLElement>(".capture-status")!;
    assert.match(status.textContent ?? "", /Filed #42\. Priority update failed/);
    assert.ok(status.classList.contains("warn"));
    assert.ok(status.querySelector("a"));
    assert.equal(refreshes, 1);
  });
});
