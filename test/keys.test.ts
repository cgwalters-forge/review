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
    ["a", "pr", {}, "approve"],
    ["x", "pr", {}, "fold"],
    ["u", "pr", {}, "back"],
    ["Escape", "item", {}, "back"],
    ["r", "item", {}, "refresh"],
    ["?", "pr", {}, "help"],
    ["a", "pr", { editing: true }, undefined],
    ["Escape", "pr", { editing: true }, "blur"],
    ["j", "queue", { ctrlKey: true }, undefined],
    ["r", "queue", { metaKey: true }, undefined],
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
    ["#item/PVTI_abc-_1", { route: "item", id: "PVTI_abc-_1" }],
    ["#pr/cgwalters-forge/bootc/30", { route: "pr", ref: { owner: "cgwalters-forge", repo: "bootc", number: 30 } }],
    ["#pr/o/r.s_t/1", { route: "pr", ref: { owner: "o", repo: "r.s_t", number: 1 } }],
    ["#pr/o/r/0", { route: "queue" }],
    ["#pr/o/../1", { route: "queue" }],
    ["#pr/o/./1", { route: "queue" }],
    ["#pr/o/r/1/extra", { route: "queue" }],
    ["#item/<script>", { route: "queue" }],
  ];
  for (const [hash, want] of cases) it(JSON.stringify(hash), () => assert.deepEqual(parseRoute(hash), want));
});
