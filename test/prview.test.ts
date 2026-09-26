// The review pane shows untrusted PR text (body, commit messages, file
// names, diffs): check it lands as text, that
// the diff viewer lays it out right, and that its buttons submit what
// the bot keys on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DraftComment, ReviewAction } from "../src/github/forge.ts";
import type { PrDetail } from "../src/github/prs.ts";
import { buildTree, canReview, type PrViewHandlers, prView, rangeEnds, unseenNote } from "../src/github/prview.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const HEAD = "e".repeat(40);
const C1 = "1".repeat(40);
const BASE = "0".repeat(40);
const tick = () => new Promise((r) => setTimeout(r, 0));

function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    ref: { owner: "cgwalters-forge", repo: "widget", number: 7 },
    url: "https://github.com/cgwalters-forge/widget/pull/7",
    title: `widget: ${EVIL}`,
    body: `Why ${EVIL}\n\n<!-- bot-meta -->\n- Upstream: \`up/widget\`, base \`main\`\n- Board item: \`PVTI_x\`\n<!-- /bot-meta -->`,
    author: "cgwalters-bot",
    state: "open",
    draft: true,
    head: HEAD,
    headRef: "bot/fix",
    baseRef: "main",
    additions: 2,
    deletions: 1,
    changedFiles: 2,
    commitCount: 2,
    commits: [
      { sha: C1, parent: BASE, url: "javascript:alert(3)", message: `first ${EVIL}`, author: "cgwalters-bot" },
      { sha: HEAD, parent: C1, url: "javascript:alert(3)", message: `subject ${EVIL}\n\nbody line ${EVIL}`, author: "cgwalters-bot" },
    ],
    files: [
      { filename: `src/${EVIL}.rs`, sha: "f".repeat(40), status: "modified", additions: 2, deletions: 1, patch: `@@ -1,2 +1,3 @@\n ctx\n-${EVIL} old\n+${EVIL} new\n+more` },
      { filename: "big.bin", status: "added", additions: 0, deletions: 0 },
    ],
    checks: [],
    verdict: { state: "none" },
    consistent: true,
    updatedAt: "2026-01-01T00:00:00Z",
    warnings: [],
    ...over,
  };
}

function assertNoActiveContent(root: Element): void {
  assert.equal(root.querySelectorAll("script, img, iframe, svg, style, object, embed").length, 0);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
    const href = el.getAttribute("href");
    if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
  }
}

function handlers(over: Partial<PrViewHandlers> = {}): PrViewHandlers {
  return {
    review: async () => "https://github.com/r",
    loadRange: async () => [],
    loadLines: async () => [],
    ...over,
  };
}

const opts = { reviewedHere: false };
const pane = (d: PrDetail, h: PrViewHandlers = handlers()) => {
  const p = prView(d, undefined, render, h, opts);
  win.document.body.replaceChildren(p.el);
  return p;
};
const codeRows = (root: Element) =>
  [...root.querySelectorAll("table.diff tr")].map((tr) => [tr.className, [...tr.querySelectorAll("td.code")].map((td) => td.textContent).join(" | ")]);

describe("prView", () => {
  it("shows untrusted text as text, and drops the bot-meta section", () => {
    const { el } = pane(detail());
    assertNoActiveContent(el);
    const text = el.textContent ?? "";
    assert.ok(text.includes(`widget: ${EVIL}`));
    assert.ok(text.includes(`body line ${EVIL}`));
    assert.ok(text.includes(`src/${EVIL}.rs`));
    assert.ok(!text.includes("Board item"));
    assert.deepEqual(codeRows(el), [
      ["ctx", " ctx"],
      ["del", `-${EVIL} old`],
      ["add", `+${EVIL} new`],
      ["add", "+more"],
      ["gap", ""],
    ]);
    // Word-level: only the changed word is marked in the paired lines.
    assert.deepEqual([...el.querySelectorAll("tr.del .wd, tr.add .wd")].map((s) => s.textContent), ["old", "new"]);
    assert.match(text, /No diff to show/);
    const links = [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    assert.ok(links.includes("https://github.com/up/widget"));
    assert.ok(links.includes("https://github.com/up/widget/compare/main...cgwalters-forge:widget:bot/fix"));
  });

  it("colors code by language", () => {
    const d = detail({ files: [{ filename: "src/lib.rs", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n fn main() {}\n+let x = \"s\";" }] });
    const { el } = pane(d);
    const kinds = [...el.querySelectorAll("td.code span[class*=hljs]")].map((s) => [s.className, s.textContent]);
    assert.ok(kinds.some(([c, t]) => c?.includes("hljs-keyword") && t === "fn"), JSON.stringify(kinds));
    assert.ok(kinds.some(([c, t]) => c?.includes("hljs-string") && t === '"s"'));
  });

  it("lays the same rows out side by side, and remembers nothing it can't store", () => {
    const p = pane(detail());
    assert.equal(p.command("layout"), true);
    assert.deepEqual(codeRows(p.el), [
      ["split", " ctx |  ctx"],
      ["split", `-${EVIL} old | +${EVIL} new`],
      ["split", " | +more"],
      ["gap", ""],
    ]);
    p.command("layout");
    assert.equal(p.el.querySelectorAll("table.diff.unified").length, 1);
  });

  it("expands context from the file at the head", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const asked: [string, string][] = [];
    const d = detail({ files: [{ filename: "a.txt", status: "modified", additions: 1, deletions: 1, patch: "@@ -60,3 +60,3 @@\n line 60\n-x\n+line 61\n line 62" }] });
    const { el } = pane(d, handlers({ loadLines: async (path, sha) => (asked.push([path, sha]), lines) }));
    const buttons = () => [...el.querySelectorAll<HTMLButtonElement>("tr.gap button.expand")];
    assert.deepEqual(buttons().map((b) => b.textContent), ["↑ 20", "Show all 59", "↓ Show the rest"]);
    buttons()[0]?.click();
    await tick();
    assert.deepEqual(asked, [["a.txt", HEAD]]);
    const rows = [...el.querySelectorAll("tr.expanded td.code")].map((td) => td.textContent);
    assert.equal(rows.length, 20);
    assert.equal(rows[0], " line 40");
    assert.deepEqual(buttons().map((b) => b.textContent), ["↕ Show 39 lines", "↕ Show 38 lines"]);
  });

  it("collapses generated files and keeps big ones closed until opened", () => {
    const patch = `@@ -1,0 +1,1200 @@\n${Array.from({ length: 1200 }, (_, i) => `+line ${i}`).join("\n")}`;
    const d = detail({
      files: [
        { filename: "Cargo.lock", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "big.rs", status: "added", additions: 1200, deletions: 0, patch },
      ],
    });
    const { el } = pane(d);
    const [lock, big] = [...el.querySelectorAll<HTMLDetailsElement>("details.file")];
    assert.equal(lock?.open, false);
    assert.match(lock?.textContent ?? "", /generated/);
    assert.equal(big?.open, false);
    assert.equal(big?.querySelectorAll("tr").length, 0);
    (big as HTMLDetailsElement).open = true;
    big?.dispatchEvent(new win.Event("toggle"));
    assert.equal(big?.querySelectorAll("tr").length, 1200);
  });

  it("builds a file tree and steps through files and hunks with the keys", () => {
    const d = detail({
      files: [
        { filename: "src/a/x.rs", status: "modified", additions: 2, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b\n@@ -10 +11,2 @@\n c\n+d" },
        { filename: "src/b.rs", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+z" },
      ],
    });
    const p = pane(d);
    assert.deepEqual([...p.el.querySelectorAll("nav.tree .dname, nav.tree .tname")].map((e) => e.textContent), ["src/", "a/", "x.rs", "b.rs"]);
    const focused = () => p.el.querySelector("tr.focus td.code")?.textContent;
    p.command("next-hunk");
    assert.equal(focused(), " a");
    p.command("next-hunk");
    assert.equal(focused(), " c");
    p.command("next-hunk");
    assert.equal(focused(), "+z");
    p.command("prev-hunk");
    assert.equal(focused(), " c");
    p.command("next-file");
    assert.ok(p.el.querySelectorAll("details.file")[1]?.classList.contains("sel"));
  });

  it("marks files viewed, folding them, and counts them", () => {
    const p = pane(detail());
    const file = p.el.querySelector<HTMLDetailsElement>("details.file");
    assert.equal(file?.open, true);
    p.command("viewed");
    assert.equal(file?.open, false);
    assert.equal(p.el.querySelector<HTMLInputElement>("input.viewed")?.checked, true);
    assert.match(p.el.querySelector(".files-h")?.textContent ?? "", /1\/2 viewed/);
  });

  it("submits the button's action after confirming, with /draft only for approval", async () => {
    const got: [ReviewAction, string, boolean][] = [];
    const confirms: string[] = [];
    win.confirm = (m?: string) => {
      confirms.push(m ?? "");
      return confirms.length !== 2;
    };
    const { el } = pane(detail(), handlers({
      review: async (action, text, draft) => {
        got.push([action, text, draft]);
        return "https://github.com/r/1";
      },
    }));
    const text = el.querySelector("form.review textarea") as HTMLTextAreaElement;
    const draft = el.querySelector("#review-draft") as HTMLInputElement;
    const click = (action: string) => (el.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement).click();

    text.value = "LGTM";
    draft.checked = true;
    click("approve");
    await tick();
    click("comment"); // refused at the confirm
    await tick();
    text.value = "nit";
    click("request-changes");
    await tick();
    assert.deepEqual(got, [["approve", "LGTM", true], ["request-changes", "nit", false]]);
    assert.match(confirms[0] ?? "", /^Approve \(with \/draft\) cgwalters-forge\/widget#7 at eeeeeeeeee\? Not seen here: 1 without a diff here\.$/);
    assert.match(confirms[2] ?? "", /You already reviewed it from here/);
    assert.match(el.querySelector("form.review .status")?.textContent ?? "", /^Sent: /);
  });

  it("adds line comments to the review and sends them with it", async () => {
    win.confirm = () => true;
    let sentWith: readonly DraftComment[] = [];
    const p = pane(detail(), handlers({
      review: async (_a, _t, _d, comments, sent) => {
        sentWith = comments;
        sent(HEAD);
        return "https://github.com/r/2";
      },
    }));
    // Click the new-side line number of "+more" (line 3).
    const row = [...p.el.querySelectorAll("tr.add")].find((tr) => tr.textContent?.includes("more"));
    row?.querySelectorAll<HTMLElement>("td.ln")[1]?.click();
    const box = p.el.querySelector<HTMLTextAreaElement>("tr.composer textarea");
    assert.ok(box);
    (box as HTMLTextAreaElement).value = `Why ${EVIL}?`;
    p.el.querySelector<HTMLButtonElement>("tr.composer button.primary")?.click();
    assert.match(p.el.querySelector("tr.draft")?.textContent ?? "", /Pending comment on line 3/);
    assert.match(p.el.querySelector("form.review .drafts")?.textContent ?? "", /1 line comment will go out/);
    assertNoActiveContent(p.el);
    (p.el.querySelector('button[data-action="comment"]') as HTMLButtonElement).click();
    await tick();
    assert.deepEqual(sentWith.map((c) => [c.path, c.line, c.side, c.commit, c.body]), [[`src/${EVIL}.rs`, 3, "RIGHT", HEAD, `Why ${EVIL}?`]]);
    assert.equal(p.el.querySelectorAll("tr.draft").length, 0);
  });

  it("keeps drafts from commits no longer in the PR, without sending them", async () => {
    win.confirm = () => true;
    const gone = "9".repeat(40);
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    storage.setItem("review.drafts.cgwalters-forge/widget#7", JSON.stringify([
      { path: "a.rs", line: 1, side: "RIGHT", body: `old thought ${EVIL}`, commit: gone },
      { path: `src/${EVIL}.rs`, line: 3, side: "RIGHT", body: "kept", commit: HEAD },
    ]));
    let sentWith: readonly DraftComment[] = [];
    const p = pane(detail(), handlers({ review: async (_a, _t, _d, comments, sent) => ((sentWith = comments), sent(HEAD), "https://github.com/r/3") }));
    assert.match(p.el.querySelector("details.orphans summary")?.textContent ?? "", /1 line comment written on commits no longer in this PR/);
    assert.ok(p.el.querySelector("details.orphans pre")?.textContent?.includes(`old thought ${EVIL}`));
    assertNoActiveContent(p.el);
    (p.el.querySelector('button[data-action="comment"]') as HTMLButtonElement).click();
    await tick();
    assert.deepEqual(sentWith.map((c) => c.body), ["kept"]);
    p.el.querySelector<HTMLButtonElement>("details.orphans button")?.click();
    assert.equal(p.el.querySelector<HTMLElement>("details.orphans")?.hidden, true);
    assert.deepEqual(JSON.parse(mem.get("review.drafts.cgwalters-forge/widget#7") ?? "null"), null, "all sent or discarded");
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("flags bidirectional control characters in code", () => {
    const d = detail({ files: [{ filename: "a.rs", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+/* \u202e } \u2066 */" }] });
    assert.equal(pane(d).el.querySelectorAll("td.code .bidi").length, 1);
  });

  it("puts c on the focused line", () => {
    const p = pane(detail());
    assert.equal(p.command("comment"), false);
    p.command("next-hunk");
    assert.equal(p.command("comment"), true);
    assert.ok(p.el.querySelector("tr.composer textarea"));
  });

  it("shows one commit at a time, and allows only its added lines a comment", async () => {
    const asked: [string, string][] = [];
    const p = pane(detail(), handlers({
      loadRange: async (base, to) => {
        asked.push([base, to]);
        return [{ filename: "one.rs", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n a\n-b\n+c" }];
      },
    }));
    p.command("next-commit");
    await tick();
    assert.deepEqual(asked, [[BASE, C1]]);
    assert.match(p.el.querySelector(".files-h")?.textContent ?? "", /commit 1 of 2/);
    assert.equal(p.el.querySelectorAll("td.ln.can-comment").length, 4, "from the base, every hunk line, either side of context");
    p.command("next-commit");
    await tick();
    assert.deepEqual(asked.at(-1), [C1, HEAD]);
    const commentable = [...p.el.querySelectorAll("td.ln.can-comment")].map((td) => td.closest("tr")?.className);
    assert.deepEqual(commentable, ["add"]);
    p.command("next-commit");
    await tick();
    assert.match(p.el.querySelector(".files-h")?.textContent ?? "", /all commits/);
  });

  it("names unexpanded files and truncation in the approval's confirmation", () => {
    const confirms: string[] = [];
    win.confirm = (m?: string) => (confirms.push(m ?? ""), false);
    const patch = `@@ -1,0 +1,1200 @@\n${Array.from({ length: 1200 }, (_, i) => `+l${i}`).join("\n")}`;
    const d = detail({ changedFiles: 4, files: [{ filename: "big.rs", sha: "9".repeat(40), status: "added", additions: 1200, deletions: 0, patch }, ...detail().files] });
    const { el } = pane(d);
    (el.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
    assert.match(confirms[0] ?? "", /Not seen here: 1 file never expanded \(big\.rs\), 1 without a diff here, files or commits beyond what GitHub lists\.$/);
  });

  it("won't approve a diff that may not be the head's", () => {
    const { el } = pane(detail({ consistent: false }));
    assert.equal((el.querySelector('button[data-action="approve"]') as HTMLButtonElement).disabled, true);
    assert.equal((el.querySelector('button[data-action="comment"]') as HTMLButtonElement).disabled, false);
    assert.match(el.querySelector("form.review .status")?.textContent ?? "", /Approve is off until a reload/);
  });

  it("offers a review form only for the bot's PRs in its own space", () => {
    const cases: [Partial<PrDetail>, boolean][] = [
      [{}, true],
      [{ ref: { owner: "cgwalters-bot", repo: "sandbox", number: 1 } }, true],
      [{ ref: { owner: "bootc-dev", repo: "bootc", number: 1 } }, false],
      [{ author: "someone" }, false],
    ];
    for (const [over, want] of cases) {
      const { el } = pane(detail(over));
      assert.equal(el.querySelector("form.review") !== null, want, JSON.stringify(over));
      assert.equal(el.querySelectorAll("td.ln.can-comment").length > 0, want, "line comments only with a form");
      assert.equal(canReview(detail(over)), want);
    }
  });

  it("offers no review form on a closed PR", () => {
    const { el } = pane(detail({ state: "merged" }));
    assert.equal(el.querySelector("form.review"), null);
    assert.match(el.textContent ?? "", /This PR is merged/);
  });
});


describe("pane helpers", () => {
  it("rangeEnds diffs a range from its first commit's parent", () => {
    const commits = detail().commits;
    assert.deepEqual(rangeEnds(commits, { from: 1, to: 1 }), { base: C1, to: HEAD });
    assert.deepEqual(rangeEnds(commits, { from: 0, to: 1 }), { base: BASE, to: HEAD });
    assert.equal(rangeEnds([{ ...commits[0], parent: undefined } as never], { from: 0, to: 0 }), undefined);
  });

  it("buildTree joins single-child directories", () => {
    const t = buildTree(["a/b/c/x.rs", "a/b/c/y.rs", "a/z.rs", "top.md"]);
    assert.deepEqual([...t.dirs.keys()], ["a"]);
    assert.deepEqual([...(t.dirs.get("a")?.dirs.values() ?? [])].map((d) => d.name), ["b/c"]);
    assert.deepEqual(t.files, [3]);
  });

  it("unseenNote lists a few names", () => {
    const names = Array.from({ length: 8 }, (_, i) => `f${i}`);
    assert.equal(unseenNote({ unopened: names, noDiff: 0, truncated: false }), " Not seen here: 8 files never expanded (f0, f1, f2, f3, f4, f5, +2 more).");
    assert.equal(unseenNote({ unopened: [], noDiff: 0, truncated: false }), "");
  });
});
