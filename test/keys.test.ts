import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyCommand, parseRoute, type Route } from "../src/github/keys.ts";

describe("keyCommand", () => {
  const press = (key: string, over: Partial<Parameters<typeof keyCommand>[0]> = {}) => ({
    key, ctrlKey: false, metaKey: false, altKey: false, editing: false, ...over,
  });
  const cases: [string, Route, Partial<Parameters<typeof keyCommand>[0]>, string | undefined][] = [
    ["j", "queue", {}, "next"],
    ["k", "queue", {}, "prev"],
    ["o", "queue", {}, "open"],
    ["Enter", "queue", {}, "open"],
    ["a", "queue", {}, undefined],
    ["n", "queue", {}, "news"],
    ["n", "news", {}, "back"],
    ["j", "news", {}, undefined],
    ["d", "queue", {}, "ops"],
    ["d", "news", {}, "ops"],
    ["d", "ops", {}, "back"],
    ["u", "ops", {}, "back"],
    ["n", "ops", {}, "news"],
    ["j", "ops", {}, undefined],
    ["t", "queue", {}, "triage"],
    ["q", "queue", {}, "decisions"],
    ["t", "triage", {}, "back"],
    ["q", "triage", {}, "decisions"],
    ["q", "decisions", {}, "back"],
    ["t", "decisions", {}, "triage"],
    ["t", "ops", {}, "triage"],
    ["q", "news", {}, "decisions"],
    ["j", "decisions", {}, undefined],
    ["t", "item", {}, undefined],
    ["a", "pr", {}, "approve"],
    ["x", "pr", {}, "fold"],
    ["n", "pr", {}, "next-file"],
    ["p", "pr", {}, "prev-file"],
    ["j", "pr", {}, "next-hunk"],
    ["k", "pr", {}, "prev-hunk"],
    ["v", "pr", {}, "viewed"],
    ["c", "pr", {}, "comment"],
    ["c", "item", {}, "compose"],
    ["g", "pr", {}, "guide"],
    ["s", "pr", {}, "layout"],
    ["[", "pr", {}, "prev-commit"],
    ["]", "pr", {}, "next-commit"],
    ["g", "queue", {}, undefined],
    ["v", "pr", { editing: true }, undefined],
    ["u", "pr", {}, "back"],
    ["Escape", "item", {}, "back"],
    ["r", "item", {}, "refresh"],
    ["?", "pr", {}, "help"],
    ["a", "pr", { editing: true }, undefined],
    ["Escape", "pr", { editing: true }, "blur"],
    ["j", "queue", { ctrlKey: true }, undefined],
    ["r", "queue", { metaKey: true }, undefined],
    ...(["queue", "news", "ops", "triage", "decisions", "item", "pr"] as const).map((r): [string, Route, object, string] => ["b", r, {}, "capture"]),
    ["b", "queue", { editing: true }, undefined],
  ];
  for (const [key, route, over, want] of cases) {
    it(`${key} on ${route}${Object.keys(over).length ? ` ${JSON.stringify(over)}` : ""}`, () => assert.equal(keyCommand(press(key, over), route), want));
  }
});

describe("parseRoute", () => {
  const cases: [string, ReturnType<typeof parseRoute>][] = [
    ["", { route: "queue" }],
    ["#", { route: "queue" }],
    ["#news", { route: "news" }],
    ["#news/x", { route: "queue" }],
    ["#ops", { route: "ops" }],
    ["#ops/x", { route: "queue" }],
    ["#triage", { route: "triage", filter: "all" }],
    ["#triage/merge", { route: "triage", filter: "merge" }],
    ["#triage/none", { route: "triage", filter: "none" }],
    ["#triage/bogus", { route: "queue" }],
    ["#decisions", { route: "decisions" }],
    ["#decisions/x", { route: "queue" }],
    ["#item/PVTI_abc-_1", { route: "item", id: "PVTI_abc-_1" }],
    ["#pr/cgwalters-forge/bootc/30", { route: "pr", ref: { owner: "cgwalters-forge", repo: "bootc", number: 30 } }],
    ["#pr/o/r.s_t/1", { route: "pr", ref: { owner: "o", repo: "r.s_t", number: 1 } }],
    ["#pr/o/r/0", { route: "queue" }],
    ["#pr/o/../1", { route: "queue" }],
    ["#pr/o/./1", { route: "queue" }],
    ["#pr/o/r/1/extra", { route: "queue" }],
    ["#item/<script>", { route: "queue" }],
    ["#composefs", { route: "queue", filter: { scope: "composefs" } }],
    ["#org:bootc-dev+P0", { route: "queue", filter: { scope: { org: "bootc-dev" }, priority: "P0" } }],
    ["#org:../x", { route: "queue" }],
  ];
  for (const [hash, want] of cases) it(JSON.stringify(hash), () => assert.deepEqual(parseRoute(hash), want));
});
