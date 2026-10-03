// Exercise the real static shell and entry point without a token or network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JSDOM } from "jsdom";

const html = readFileSync(new URL("../static/index.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/github/main.ts", import.meta.url), "utf8");

describe("main static shell", () => {
  const dom = new JSDOM(html, { url: "https://review.example/" });
  const ids = [...new Set([...source.matchAll(/byId(?:<[^>]+>)?\("([^"]+)"\)/g)].map((match) => match[1]!))];
  assert.ok(ids.length > 10, "find all literal byId lookups");
  for (const id of ids) it(`supplies exactly one #${id} for byId`, () => {
    assert.equal(dom.window.document.querySelectorAll(`[id="${id}"]`).length, 1);
  });

  it("renders signed out from the real entry point without GitHub access", async () => {
    const { window } = dom;
    let network = 0;
    Object.assign(globalThis, {
      window, document: window.document, Node: window.Node,
      HTMLElement: window.HTMLElement,
      ResizeObserver: class { observe() {} disconnect() {} },
      fetch: async () => { network++; throw new Error("network forbidden in signed-out test"); },
    });
    await import("../src/github/main.ts");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.match(window.document.querySelector("#view")?.textContent ?? "", /Sign in with a token/);
    assert.equal(window.document.querySelector<HTMLInputElement>(".signin input[type=password]")?.value, "");
    assert.equal(window.document.querySelector<HTMLElement>("#capture")?.hidden, true);
    assert.equal(window.document.querySelector<HTMLElement>("#signout")?.hidden, true);
    assert.equal(window.document.querySelector("#notice")?.textContent, "");
    assert.equal(window.document.querySelector("#meta")?.textContent, "");
    assert.equal(network, 0);
    dom.window.close();
  });
});
