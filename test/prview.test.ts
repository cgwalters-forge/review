// The review pane shows untrusted PR text (body, commit messages, file
// names, diffs): check it lands as text, and that its buttons submit
// what the bot keys on.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReviewAction } from "../src/github/forge.ts";
import type { PrDetail } from "../src/github/prs.ts";
import { canReview, prView } from "../src/github/prview.ts";
import { createRenderer } from "../src/markdown.ts";
import { installDom } from "./helpers.ts";

const win = installDom();
const render = createRenderer(win as unknown as Parameters<typeof createRenderer>[0]);
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';
const HEAD = "e".repeat(40);

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
    commitCount: 1,
    commits: [{ sha: HEAD, url: "javascript:alert(3)", message: `subject ${EVIL}\n\nbody line ${EVIL}`, author: "cgwalters-bot" }],
    files: [
      { filename: `src/${EVIL}.rs`, status: "modified", additions: 2, deletions: 1, patch: `@@ -1,2 +1,3 @@\n ctx\n-${EVIL}\n+new\n+more` },
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
  assert.equal(root.querySelectorAll("script, img, iframe, svg, style").length, 0);
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) assert.ok(!/^on/i.test(attr), `${attr} on ${el.tagName}`);
    const href = el.getAttribute("href");
    if (href !== null) assert.match(href, /^(https:|#)/, `href ${href}`);
  }
}

const noReview = { review: async () => "https://github.com/r" };

describe("prView", () => {
  it("shows untrusted text as text, and drops the bot-meta section", () => {
    const root = prView(detail(), undefined, render, noReview, { reviewedHere: false });
    assertNoActiveContent(root);
    const text = root.textContent ?? "";
    assert.ok(text.includes(`widget: ${EVIL}`));
    assert.ok(text.includes(`body line ${EVIL}`));
    assert.ok(text.includes(`src/${EVIL}.rs`));
    assert.ok(!text.includes("Board item"));
    const code = [...root.querySelectorAll("table.diff tr")].map((tr) => [tr.className, tr.querySelector(".code")?.textContent]);
    assert.deepEqual(code, [
      ["hunk", "@@ -1,2 +1,3 @@"],
      ["ctx", " ctx"],
      ["del", `-${EVIL}`],
      ["add", "+new"],
      ["add", "+more"],
    ]);
    assert.match(text, /No diff to show/);
    const links = [...root.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    assert.ok(links.includes("https://github.com/up/widget"));
    assert.ok(links.includes("https://github.com/up/widget/compare/main...cgwalters-forge:widget:bot/fix"));
  });

  it("collapses a large file's diff and builds it when opened", () => {
    const patch = `@@ -1,0 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+line ${i}`).join("\n")}`;
    const root = prView(detail({ files: [{ filename: "big.rs", status: "added", additions: 400, deletions: 0, patch }] }), undefined, render, noReview, { reviewedHere: false });
    const file = root.querySelector("details.file") as HTMLDetailsElement;
    assert.equal(file.open, false);
    assert.equal(file.querySelectorAll("tr").length, 0);
    file.open = true;
    file.dispatchEvent(new win.Event("toggle"));
    assert.equal(file.querySelectorAll("tr").length, 401);
  });

  it("submits the button's action after confirming, with /draft only for approval", async () => {
    const got: [ReviewAction, string, boolean][] = [];
    const confirms: string[] = [];
    win.confirm = (m?: string) => {
      confirms.push(m ?? "");
      return confirms.length !== 2;
    };
    const root = prView(detail(), undefined, render, {
      review: async (action, text, draft) => {
        got.push([action, text, draft]);
        return "https://github.com/r/1";
      },
    }, { reviewedHere: false });
    win.document.body.replaceChildren(root);
    const text = root.querySelector("form.review textarea") as HTMLTextAreaElement;
    const draft = root.querySelector("#review-draft") as HTMLInputElement;
    const click = (action: string) => (root.querySelector(`button[data-action="${action}"]`) as HTMLButtonElement).click();
    const tick = () => new Promise((r) => setTimeout(r, 0));

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
    assert.match(root.querySelector("form.review .status")?.textContent ?? "", /^Sent: /);
  });

  it("shows a refusal and lets him retry", async () => {
    win.confirm = () => true;
    const root = prView(detail(), undefined, render, { review: async () => Promise.reject(new Error("the PR's head moved")) }, { reviewedHere: false });
    (root.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    assert.match(root.querySelector("form.review .status")?.textContent ?? "", /Not sent: the PR's head moved/);
    assert.equal((root.querySelector('button[data-action="approve"]') as HTMLButtonElement).disabled, false);
  });

  it("names unexpanded files and truncation in the approval's confirmation", () => {
    const confirms: string[] = [];
    win.confirm = (m?: string) => (confirms.push(m ?? ""), false);
    const patch = `@@ -1,0 +1,400 @@\n${Array.from({ length: 400 }, (_, i) => `+l${i}`).join("\n")}`;
    const d = detail({ changedFiles: 4, files: [{ filename: "big.rs", status: "added", additions: 400, deletions: 0, patch }, ...detail().files] });
    const root = prView(d, undefined, render, noReview, { reviewedHere: false });
    (root.querySelector('button[data-action="approve"]') as HTMLButtonElement).click();
    assert.match(confirms[0] ?? "", /Not seen here: 1 file never expanded, 1 without a diff here, files or commits beyond what GitHub lists\.$/);
  });

  it("won't approve a diff that may not be the head's", () => {
    const root = prView(detail({ consistent: false }), undefined, render, noReview, { reviewedHere: false });
    assert.equal((root.querySelector('button[data-action="approve"]') as HTMLButtonElement).disabled, true);
    assert.equal((root.querySelector('button[data-action="comment"]') as HTMLButtonElement).disabled, false);
    assert.match(root.querySelector("form.review .status")?.textContent ?? "", /Approve is off until a reload/);
  });

  it("offers a review form only for the bot's PRs in its own space", () => {
    const cases: [Partial<PrDetail>, boolean][] = [
      [{}, true],
      [{ ref: { owner: "cgwalters-bot", repo: "sandbox", number: 1 } }, true],
      [{ ref: { owner: "bootc-dev", repo: "bootc", number: 1 } }, false],
      [{ author: "someone" }, false],
    ];
    for (const [over, want] of cases) {
      const root = prView(detail(over), undefined, render, noReview, { reviewedHere: false });
      assert.equal(root.querySelector("form.review") !== null, want, JSON.stringify(over));
      assert.equal(canReview(detail(over)), want);
    }
  });

  it("offers no review form on a closed PR", () => {
    const root = prView(detail({ state: "merged" }), undefined, render, noReview, { reviewedHere: false });
    assert.equal(root.querySelector("form.review"), null);
    assert.match(root.textContent ?? "", /This PR is merged/);
  });
});
