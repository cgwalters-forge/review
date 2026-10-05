import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GitHub, type Fetch } from "../github/api.ts";
import type { RawItem } from "../github/board.ts";
import { heartbeatPath } from "../github/heartbeat.ts";
import { usagePath } from "../github/usage.ts";
import { loadPageState } from "../github/state.ts";
import { tokenFrom } from "./queue.ts";

/** Offline API fixtures still pass through the production parsers/loaders. */
export function fixtureFetch(directory: string): Fetch {
  return async (input, init) => {
    const url = new URL(input);
    const path = url.pathname + url.search;
    let file: string | undefined;
    if (url.pathname.endsWith("/fields")) file = "fields.json";
    else if (url.pathname.endsWith("/items")) file = "items.json";
    else if (path === heartbeatPath) file = "heartbeat-comments.json";
    else if (path === usagePath) file = "usage-comments.json";
    else if (url.pathname.includes("/actions/workflows/")) {
      const raw = JSON.parse(await readFile(resolve(directory, "state-runs.json"), "utf8")) as { workflow_runs: { status: string }[] };
      const runs = raw.workflow_runs.filter((r) => !url.searchParams.has("status") || r.status === url.searchParams.get("status"));
      return Response.json({ workflow_runs: runs, total_count: runs.length }, { headers: { etag: '"fixture"' } });
    } else if (url.pathname.includes("/actions/runs/")) file = "state-jobs.json";
    else if (url.pathname === "/graphql" && init?.method === "POST") {
      return Response.json({ data: { organization: { projectV2: { statusUpdates: { nodes: [] } } } } });
    } else if (url.pathname === "/search/issues") return Response.json({ items: [], total_count: 0 });
    else if (url.pathname.endsWith("/issues") && url.searchParams.get("labels") === "question") {
      const items = JSON.parse(await readFile(resolve(directory, "items.json"), "utf8")) as RawItem[];
      return Response.json(items.filter((item) => item.content_type === "Issue" && item.content?.state === "open" && item.content.labels?.some((label) => (typeof label === "string" ? label : label.name) === "question")).map((item) => item.content));
    }
    else if (/\/(issues|comments|pulls)$/.test(url.pathname)) return Response.json([]);
    if (!file) throw new Error(`No fixture for ${url.pathname}`);
    return new Response(await readFile(resolve(directory, file), "utf8"), { headers: { "content-type": "application/json", etag: '"fixture"' } });
  };
}

export async function runState(argv: string[], env: NodeJS.ProcessEnv, stdout: (text: string) => void, stderr: (text: string) => void): Promise<number> {
  try {
    let directory: string | undefined;
    let now = Date.now();
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--json") continue;
      if (arg === "--help" || arg === "-h") {
        stdout("Usage: node src/cli/state.ts --json [--fixture DIRECTORY] [--now ISO_TIME]\nToken: GH_TOKEN, else GITHUB_TOKEN. Partial/unavailable sources are explicit in sources.\n");
        return 0;
      }
      if (arg === "--fixture") {
        directory = argv[++i];
        if (!directory) throw new Error("--fixture needs a directory");
      } else if (arg === "--now") {
        now = Date.parse(argv[++i] ?? "");
        if (!Number.isFinite(now)) throw new Error("--now needs an ISO timestamp");
      } else throw new Error(`Unknown argument: ${arg}`);
    }
    const token = directory ? async () => "fixture" : tokenFrom(env, async () => { throw new Error("set GH_TOKEN or GITHUB_TOKEN"); });
    // Validate before fan-out, so a missing token is a useful CLI error.
    await token();
    const state = await loadPageState(new GitHub(token, directory ? fixtureFetch(directory) : undefined), now);
    stdout(JSON.stringify(state, null, 2) + "\n");
    return 0;
  } catch (e) {
    stderr(`state: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}
