import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerTarget, fieldIds, type Item, parseIssueUrl, questionOf, queueItems } from "../src/github/board.ts";
import { HOME_OWNERS } from "../src/github/config.ts";
import { fields, rawItems } from "./helpers.ts";

describe("fieldIds", () => {
  it("maps the fields the app reads", () => {
    assert.deepEqual(fieldIds(fields()), [102, 104, 103, 105, 106, 107]);
  });
  it("names a missing field", () => {
    assert.throws(() => fieldIds(fields().filter((f) => f.name !== "Why")), /no field named "Why"/);
  });
});

describe("parseIssueUrl", () => {
  const cases: [string, ReturnType<typeof parseIssueUrl>][] = [
    ["https://github.com/o/r/issues/12", { owner: "o", repo: "r", number: 12 }],
    ["https://github.com/o-x/r.y_z/pull/3", { owner: "o-x", repo: "r.y_z", number: 3 }],
    ["https://github.com/o/r/pull/3/files", undefined],
    ["https://evil.example/o/r/issues/1", undefined],
    ["http://github.com/o/r/issues/1", undefined],
  ];
  for (const [url, want] of cases) it(url, () => assert.deepEqual(parseIssueUrl(url), want));
});

describe("queueItems", () => {
  const items = queueItems(rawItems());
  const byId = new Map(items.map((i) => [i.nodeId, i]));

  it("keeps unarchived Needs human and Draft items only, in board order", () => {
    assert.deepEqual(
      items.map((i) => i.nodeId),
      ["PVTI_synthetic_upstream_pr", "PVTI_synthetic_draft", "PVTI_synthetic_home_issue", "PVTI_synthetic_redacted"],
    );
  });

  it("parses a PR item", () => {
    const pr = byId.get("PVTI_synthetic_upstream_pr");
    assert.equal(pr?.kind, "pr");
    assert.deepEqual(pr?.ref, { owner: "example-upstream", repo: "widget", number: 42 });
    assert.equal(pr?.priority, "P1");
    assert.equal(pr?.org, "other");
    assert.equal(pr?.isPrivate, false);
    assert.equal(pr?.state, "open");
    assert.match(pr?.why ?? "", /^CI is red/);
  });

  it("keeps only https URLs from Branch", () => {
    assert.deepEqual(byId.get("PVTI_synthetic_upstream_pr")?.branch, ["https://github.com/example-forge/widget/pull/3"]);
  });

  it("parses a draft item", () => {
    const d = byId.get("PVTI_synthetic_draft");
    assert.equal(d?.kind, "draft");
    assert.equal(d?.url, undefined);
    assert.deepEqual(d?.gist, ["https://gist.github.com/cgwalters-bot/0123abcd"]);
  });

  it("survives an item it can't see", () => {
    const r = byId.get("PVTI_synthetic_redacted");
    assert.equal(r?.kind, "unknown");
    assert.equal(r?.title, "(no title or no access)");
    assert.equal(r?.ref, undefined);
  });
});

describe("answerTarget", () => {
  const items = new Map(queueItems(rawItems()).map((i) => [i.nodeId, i]));
  const get = (id: string) => items.get(id) as Item;

  it("asks before commenting on a public upstream PR", () => {
    assert.deepEqual(answerTarget(get("PVTI_synthetic_upstream_pr"), HOME_OWNERS, false), {
      kind: "comment",
      ref: { owner: "example-upstream", repo: "widget", number: 42 },
      confirmPublic: true,
    });
  });
  it("treats unknown visibility upstream as public", () => {
    const t = answerTarget(get("PVTI_synthetic_upstream_pr"), HOME_OWNERS, undefined);
    assert.equal(t.kind === "comment" && t.confirmPublic, true);
  });
  it("doesn't ask on a private repository", () => {
    const t = answerTarget(get("PVTI_synthetic_upstream_pr"), HOME_OWNERS, true);
    assert.equal(t.kind === "comment" && t.confirmPublic, false);
  });
  it("doesn't ask in the bot's own repositories", () => {
    const t = answerTarget(get("PVTI_synthetic_home_issue"), HOME_OWNERS, undefined);
    assert.equal(t.kind === "comment" && t.confirmPublic, false);
  });
  it("refuses an item with nowhere to answer", () => {
    for (const id of ["PVTI_synthetic_redacted", "PVTI_synthetic_draft"]) assert.equal(answerTarget(get(id), HOME_OWNERS).kind, "none", id);
  });
});

describe("questionOf", () => {
  const base = queueItems(rawItems()).find((i) => i.nodeId === "PVTI_synthetic_draft") as Item;
  const pr = queueItems(rawItems()).find((i) => i.kind === "pr") as Item;
  const letters = (item: Item) => questionOf(item).options.map((o) => o.letter).join("");
  const cases: [string, Item, string][] = [
    ["options in Why", { ...pr, why: "rerun? Options: A) yes B) no" }, "AB"],
    ["draft body when Why has none", base, "AB"],
    ["Why before the draft body", { ...base, why: "Options: A) x B) y C) z" }, "ABC"],
    ["never a PR body", { ...pr, why: "No question", body: "Options: A) a B) b" }, ""],
  ];
  for (const [name, item, want] of cases) it(name, () => assert.equal(letters(item), want));
});
