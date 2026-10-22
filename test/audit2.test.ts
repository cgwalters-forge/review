import assert from "node:assert/strict";
import { it } from "node:test";
import { GitHub } from "../src/github/api.ts";
import { loadPeople } from "../src/github/people.ts";

it("notifications read: is the second poll conditional?", async () => {
  const seen: { url: string; inm: string | undefined }[] = [];
  const gh = new GitHub(async () => "ghp_x", async (url, init) => {
    const h = init?.headers as Record<string, string>;
    seen.push({ url, inm: h["If-None-Match"] });
    if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("[]", { status: 200, headers: { "content-type": "application/json", etag: '"abc"' } });
  });
  const t0 = Date.parse("2026-10-20T12:00:00Z");
  await loadPeople(gh, t0, true);
  await loadPeople(gh, t0 + 60_000, true);
  const notif = seen.filter((s) => s.url.startsWith("https://api.github.com/notifications"));
  console.log(notif);
  assert.equal(notif.length, 2);
  assert.equal(notif[0]!.url, notif[1]!.url, "the URL changes with the clock, so no entry is revalidated");
  assert.equal(notif[1]!.inm, '"abc"');
});
