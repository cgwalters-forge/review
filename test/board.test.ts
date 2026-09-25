import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setDraftSection } from "../src/answer.ts";
import { answerTarget, fieldIds, groupByPriority, type Item, parseIssueUrl, questionOf, queueItems } from "../src/github/board.ts";
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

  it("keeps unarchived Needs human items only, in board order", () => {
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
    assert.equal(d?.draftId, "DI_synthetic_draft");
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

describe("groupByPriority", () => {
  it("orders P0 first and unprioritised last, keeping board order", () => {
    const mk = (nodeId: string, priority?: string): Item => ({
      id: 0, nodeId, kind: "issue", title: nodeId, body: "", why: "", branch: [], gist: [],
      ...(priority ? { priority } : {}),
    });
    const groups = groupByPriority([mk("a", "P2"), mk("b"), mk("c", "P0"), mk("d", "P2"), mk("e", "P9")]);
    assert.deepEqual(
      groups.map((g) => [g.priority, g.items.map((i) => i.nodeId)]),
      [["P0", ["c"]], ["P2", ["a", "d"]], ["P9", ["e"]], ["No priority", ["b"]]],
    );
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
  it("writes drafts through the draft body", () => {
    assert.deepEqual(answerTarget(get("PVTI_synthetic_draft"), HOME_OWNERS), {
      kind: "draft",
      draftId: "DI_synthetic_draft",
      boardPublic: true,
    });
    const t = answerTarget(get("PVTI_synthetic_draft"), HOME_OWNERS, undefined, false);
    assert.equal(t.kind === "draft" && t.boardPublic, false);
  });
  it("refuses an item with nowhere to answer", () => {
    assert.equal(answerTarget(get("PVTI_synthetic_redacted"), HOME_OWNERS).kind, "none");
  });
});

describe("questionOf", () => {
  const base = queueItems(rawItems()).find((i) => i.nodeId === "PVTI_synthetic_draft") as Item;
  const pr = queueItems(rawItems()).find((i) => i.kind === "pr") as Item;
  const summary = (item: Item) => {
    const q = questionOf(item);
    return { letters: q.options.map((o) => o.letter).join(""), id: q.id, error: q.error };
  };
  const several = "the question names several ids (Q#1, Q#2); ask the bot to fix it";
  const cases: [string, Item, ReturnType<typeof summary>][] = [
    ["options in Why", { ...pr, why: "Q#5: rerun? Options: A) yes B) no" }, { letters: "AB", id: "Q#5", error: undefined }],
    ["draft body when Why has none", base, { letters: "AB", id: undefined, error: undefined }],
    [
      "draft body id, ignoring the answer section's",
      { ...base, body: setDraftSection("Q#7: which?\n- A) x\n- B) y", { choice: "A", question: "Q#6", text: "" }, "https://gist.github.com/1") },
      { letters: "AB", id: "Q#7", error: undefined },
    ],
    ["options in Why, id in the draft body", { ...base, why: "Options: A) x B) y", body: "Q#5: which?" }, { letters: "AB", id: "Q#5", error: undefined }],
    ["the same id in both", { ...base, why: "Q#5: which? Options: A) x B) y", body: "Q#5: details" }, { letters: "AB", id: "Q#5", error: undefined }],
    ["different ids in Why and body", { ...base, why: "Q#1: which? Options: A) x B) y", body: "Q#2: other" }, { letters: "AB", id: undefined, error: several }],
    ["never a PR body", { ...pr, why: "No question", body: "Q#9: Options: A) a B) b" }, { letters: "", id: undefined, error: undefined }],
    ["several ids in Why", { ...pr, why: "Q#1: this?\nQ#2: or that? Options: A) a B) b" }, { letters: "AB", id: undefined, error: several }],
    ["an id mid-line doesn't count", { ...pr, why: "Flaky. Q#3: rerun? Options: A) a B) b" }, { letters: "AB", id: undefined, error: undefined }],
  ];
  for (const [name, item, want] of cases) it(name, () => assert.deepEqual(summary(item), want));
});
