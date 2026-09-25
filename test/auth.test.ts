import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { detectAuth, isDevHost, useDevToken } from "../src/github/auth.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function relayAnswers(status: number | "down"): void {
  globalThis.fetch = async () => {
    if (status === "down") throw new TypeError("fetch failed");
    return new Response("{}", { status });
  };
}

describe("isDevHost", () => {
  const cases: [string, boolean][] = [
    ["127.0.0.1", true],
    ["localhost", true],
    ["[::1]", true],
    ["forge.example.ts.net", false],
    ["127.0.0.1.evil.example", false],
  ];
  for (const [host, want] of cases) it(host, () => assert.equal(isDevHost(host), want));
});

describe("detectAuth", () => {
  const cases: [string, number | "down", string, string][] = [
    ["relay signed out", 401, "forge.example.ts.net", "relay-signed-out"],
    ["relay broken in production", 502, "forge.example.ts.net", "relay-error"],
    ["no relay in production", 404, "forge.example.ts.net", "relay-error"],
    ["relay unreachable in production", "down", "forge.example.ts.net", "relay-error"],
    ["no relay on loopback", 404, "127.0.0.1", "dev-signed-out"],
    ["relay unreachable on loopback", "down", "localhost", "dev-signed-out"],
  ];
  for (const [name, status, host, want] of cases) {
    it(name, async () => {
      relayAnswers(status);
      assert.equal((await detectAuth(host)).kind, want);
    });
  }

  it("names the failure in production", async () => {
    relayAnswers(502);
    const auth = await detectAuth("forge.example.ts.net");
    assert.match(auth.kind === "relay-error" ? auth.message : "", /HTTP 502/);
  });
});

describe("useDevToken", () => {
  it("refuses outside loopback", () => {
    assert.throws(() => useDevToken("ghp_abc", "forge.example.ts.net"), /only be pasted in development mode/);
  });
  it("refuses something that isn't a token", () => {
    assert.throws(() => useDevToken("not a token!", "127.0.0.1"), /doesn't look like/);
  });
  it("keeps a token on loopback", async () => {
    assert.equal(await useDevToken(" ghp_abc \n", "127.0.0.1").get(), "ghp_abc");
  });
});
