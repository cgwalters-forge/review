import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AdvanceFacts, decideAdvance, EDITED_ATTR, overlayVerdicts, type PendingVerdict, pickNext, queueStops, type Stop, writingElsewhere } from "../src/github/advance.ts";
import { OPTIMISTIC_TTL_MS } from "../src/github/config.ts";
import type { VerdictEntry } from "../src/github/prs.ts";
import type { Entry } from "../src/github/queue.ts";
import { installDom } from "./helpers.ts";

const stop = (key: string, waiting = true): Stop => ({ key, href: `#item/${key}`, title: key, waiting });
const stops = (spec: string) => spec.split(" ").filter(Boolean).map((k) => (k.endsWith("~") ? stop(k.slice(0, -1), false) : stop(k)));

describe("pickNext", () => {
  // [name, list when opened, current, list now ("~" marks a settled row), want]
  const cases: [string, string, string, string, string | undefined][] = [
    ["the next row", "a b c", "b", "a b c", "c"],
    ["the next row, after the current one left the list", "a b c", "b", "a c", "c"],
    ["skips rows that left or settled meanwhile", "a b c d e", "a", "a c~ e", "e"],
    ["keeps the order he saw, not a re-ranked one", "a b c", "a", "c b", "b"],
    ["the last row wraps to the first still waiting", "a b c", "c", "a b c", "a"],
    ["the last row, with only settled rows left: caught up", "a b c", "c", "a~ b~", undefined],
    ["the only row: caught up", "a", "a", "", undefined],
    ["past the end, a row new since", "a b", "b", "x", "x"],
    ["an entry not in the list (e.g. a PR opened from its ask): the first waiting", "a b", "pr", "a b", "a"],
    ["an empty list", "", "a", "", undefined],
  ];
  for (const [name, from, current, now, want] of cases) {
    it(name, () => assert.equal(pickNext(stops(from), current, stops(now))?.key, want));
  }

  it("follows a filtered queue, children after their parent, skipping settled asks", () => {
    const e = (key: string, priority: string, over: Partial<Entry> = {}): Entry => ({ key, kind: "item", title: key, where: "w", href: `#${key}`, priority, ...over });
    const entries = [
      e("p0-a", "P0", { children: [e("p0-a-ask", "P0", { kind: "question" }), e("p0-a-done", "P0", { kind: "question", settled: true })] }),
      e("p1-a", "P1"),
      e("p0-b", "P0"),
      e("p0-c", "P0", { kind: "question", settled: true }),
    ];
    const p0 = queueStops(entries, { scope: "all", priority: "P0" });
    assert.deepEqual(
      p0.map((s) => `${s.key}${s.waiting ? "" : "~"}`),
      ["p0-a", "p0-a-ask", "p0-a-done~", "p0-b", "p0-c~"],
    );
    assert.equal(pickNext(p0, "p0-a-ask", p0)?.key, "p0-b", "past the settled child, and never into the P1 row the filter hides");
    assert.equal(pickNext(p0, "p0-b", p0)?.key, "p0-a", "wraps within the filter");
    assert.equal(pickNext(p0, "p0-b", p0.filter((s) => s.key === "p0-b"))?.key, undefined);
    assert.equal(queueStops(entries, { scope: "all" }).length, 6);
  });

  it("lists the bot's turns without stopping there", () => {
    const pr = (key: string, onBot: boolean): Entry => ({ key, kind: "pr", title: key, where: "w", href: `#pr/${key}`, wait: { reasons: onBot ? [] : ["review-requested"], onBot } });
    const s = queueStops([pr("a", false), pr("b", true), pr("c", false)], { scope: "all" });
    assert.deepEqual(s.map((x) => x.waiting), [true, false, true]);
    assert.equal(pickNext(s, "a", s)?.key, "c");
    assert.equal(pickNext(s, "c", s.slice(1, 3).map((x) => ({ ...x, waiting: false })))?.key, undefined, "caught up with only the bot's turns left");
  });
});

describe("decideAdvance", () => {
  const ok: AdvanceFacts = { enabled: true, ok: true, stillThere: true, writing: false, stillWaiting: false };
  const next = stop("n");
  const cases: [string, Partial<AdvanceFacts>, Stop | undefined, string][] = [
    ["moves on after a success", {}, next, "go n"],
    ["is caught up when nothing is next", {}, undefined, "caught-up"],
    ["stays when the write failed", { ok: false }, next, "stay failed"],
    ["stays when the write failed, even with nothing next", { ok: false }, undefined, "stay failed"],
    ["stays when turned off", { enabled: false }, next, "stay off"],
    ["stays when he left the view meanwhile", { stillThere: false }, next, "stay left"],
    ["stays while he writes elsewhere", { writing: true }, next, "stay writing"],
    ["stays when the entry still waits on him (a comment-only review)", { stillWaiting: true }, next, "stay waiting"],
  ];
  for (const [name, facts, to, want] of cases) {
    it(name, () => {
      const d = decideAdvance({ ...ok, ...facts }, to);
      assert.equal(d.kind === "go" ? `go ${d.to.key}` : d.kind === "stay" ? `stay ${d.why}` : d.kind, want);
    });
  }
});

describe("writingElsewhere", () => {
  function page() {
    installDom();
    const root = document.createElement("div");
    root.innerHTML = `
      <form class="sent"><textarea></textarea></form>
      <details class="mine"><input type="text" class="title"><textarea class="body"></textarea></details>
      <input type="checkbox" class="box">
      <button type="button">x</button>`;
    document.body.append(root);
    const q = <T extends Element>(sel: string) => root.querySelector(sel) as T;
    const sent = q<HTMLFormElement>("form.sent");
    const type = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
      el.value = value;
      el.setAttribute(EDITED_ATTR, "");
    };
    return { root, sent, q, type };
  }

  it("ignores the text that just went out", () => {
    const { root, sent, q, type } = page();
    type(q("form.sent textarea"), "LGTM");
    q<HTMLTextAreaElement>("form.sent textarea").focus();
    assert.equal(writingElsewhere(root, sent, document.activeElement), false);
  });

  it("ignores prefilled fields he didn't touch", () => {
    const { root, sent, q } = page();
    q<HTMLInputElement>("input.title").value = "the bot's title";
    assert.equal(writingElsewhere(root, sent, null), false);
  });

  it("sees text he typed elsewhere, until he clears it", () => {
    const { root, sent, q, type } = page();
    const body = q<HTMLTextAreaElement>("textarea.body");
    type(body, "half a thought");
    assert.equal(writingElsewhere(root, sent, null), true);
    type(body, "  ");
    assert.equal(writingElsewhere(root, sent, null), false);
  });

  it("sees a text field he is in, but not a focused checkbox or button", () => {
    const { root, sent, q } = page();
    assert.equal(writingElsewhere(root, sent, q("textarea.body")), true);
    assert.equal(writingElsewhere(root, sent, q("input.box")), false);
    assert.equal(writingElsewhere(root, sent, q("button")), false);
    assert.equal(writingElsewhere(root, sent, document.body), false, "outside the view");
  });
});

describe("overlayVerdicts", () => {
  const T = 1_000_000;
  const read = (state: VerdictEntry["verdict"]["state"], head = "h1"): VerdictEntry => ({ updatedAt: "2026-09-01T00:00:00Z", head, verdict: { state } });
  const approved: PendingVerdict = { state: "approved", head: "h1", at: T };
  // [name, GitHub's read (if any), now, verdict shown, still pending]
  const cases: [string, VerdictEntry | undefined, number, string | undefined, boolean][] = [
    ["shows his approval before GitHub has one", read("none"), T + 1000, "approved", true],
    ["shows it for a PR whose reviews aren't read yet", undefined, T + 1000, "approved", true],
    ["lets go once GitHub agrees", read("approved"), T + 1000, "approved", false],
    ["lets go when the head moved (a push makes it moot)", read("none", "h2"), T + 1000, "none", false],
    ["lets GitHub win after the time limit", read("none"), T + OPTIMISTIC_TTL_MS + 1, "none", false],
    ["and then, with no read, shows nothing", undefined, T + OPTIMISTIC_TTL_MS + 1, undefined, false],
  ];
  for (const [name, r, now, shown, still] of cases) {
    it(name, () => {
      const got = overlayVerdicts(new Map(r ? [["o/r#1", r]] : []), new Map([["o/r#1", approved]]), now);
      assert.equal(got.verdicts.get("o/r#1")?.state, shown);
      assert.equal(got.pending.has("o/r#1"), still);
    });
  }

  it("leaves other PRs as GitHub read them", () => {
    const got = overlayVerdicts(new Map([["o/r#2", read("changes-requested")]]), new Map([["o/r#1", approved]]), T);
    assert.equal(got.verdicts.get("o/r#2")?.state, "changes-requested");
  });
});
