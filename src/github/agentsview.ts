// The active agents strip atop the queue: the agents working now against
// the target (agents.ts), each with its item, status and age, and the
// newest board changes since he last marked them seen, folded into one
// line. The ops view has the detail; the strip links there.

import { h, link } from "../dom.ts";
import { type Active, type ActiveAgent, activeAgents, type AgentSummary, type Lane } from "./agents.ts";
import type { Item } from "./board.ts";
import { diffBoard, type Snapshot } from "./boardfeed.ts";
import { feedRow } from "./boardfeedview.ts";
import { AGENT_FEED_PREVIEW, HEARTBEAT_ISSUE, TRACKER_REPO } from "./config.ts";
import { workerStatus } from "./opsview.ts";
import { age, pill, time } from "./view.ts";

/** The strip's class, which main.ts replaces it by. */
export const STRIP_CLASS = "agents-strip";

const LANE_LABEL: Record<Lane, string> = { harness: "harness", upstream: "upstream", unknown: "no org" };
const SOURCE_TITLE: Record<ActiveAgent["source"], string> = {
  heartbeat: "listed by the coordinator's heartbeat",
  board: "In Progress on the board, claimed by its Lead or Run; not in the heartbeat",
  both: "listed by the heartbeat and In Progress on the board",
};

/** Whether he opened the changes line: kept across the strip's re-renders, not across reloads. */
let feedOpen = false;

function agentRow(a: ActiveAgent, now: number): HTMLElement {
  const sinceTitle = a.source === "board" ? `its board item last changed ${time(a.since)}` : `started ${time(a.since)}`;
  return h(
    "li",
    { class: `as-agent${a.stale ? " stale" : ""}`, title: SOURCE_TITLE[a.source] },
    workerStatus(a.status),
    h(
      "span",
      { class: "as-who" },
      a.priority ? pill(a.priority) : null,
      a.priority ? " " : null,
      h("strong", {}, a.name),
      " ",
      a.itemUrl ? link(a.itemUrl, a.itemRef ?? a.itemUrl) : null,
      a.title ? h("span", { class: "as-title" }, ` ${a.title}`) : null,
    ),
    a.runUrl ? link(a.runUrl, "run ↗") : null,
    h("span", { class: "age", title: a.since ? sinceTitle : "" }, a.since ? age(a.since, now) : ""),
  );
}

/** The heading line's heartbeat part: its age, said plainly when stale or missing. */
function heartbeatText(s: AgentSummary, now: number, why: string): { text: string; cls: string; title: string } {
  if (s.heartbeat === undefined) return { text: "heartbeat unread", cls: "warn", title: `The coordinator's heartbeat couldn't be read; its local workers are missing.${why}` };
  if (s.heartbeat === null) return { text: "no heartbeat", cls: "warn", title: `Nothing published to ${TRACKER_REPO}#${HEARTBEAT_ISSUE}: local workers can't be seen.` };
  const ago = age(s.heartbeat.updatedAt, now);
  const text = `heartbeat ${ago === "now" ? "just now" : `${ago} old`}`;
  if (s.heartbeat.stopped) {
    return { text: `coordinator stopped · ${text}`, cls: "warn", title: `The coordinator said it stopped at ${time(s.heartbeat.updatedAt)}, so its workers are unconfirmed.` };
  }
  return s.heartbeat.stale
    ? { text, cls: "warn", title: `The coordinator last published at ${time(s.heartbeat.updatedAt)}: it may have stopped, so its workers are unconfirmed.` }
    : { text, cls: "", title: `The coordinator is ${s.heartbeat.loopState}; published at ${time(s.heartbeat.updatedAt)}.` };
}

function changesLine(board: readonly Item[], seen: Snapshot | undefined, now: number, fromCache: boolean): HTMLElement | null {
  if (!seen || fromCache) return null;
  const all = diffBoard(seen, board);
  if (!all.length) return h("p", { class: "as-feed note" }, `No board changes since you last looked (${time(new Date(seen.at).toISOString())}).`);
  const shown = all.slice(0, AGENT_FEED_PREVIEW);
  const details = h(
    "details",
    { class: "as-feed" },
    h("summary", {}, `${all.length} board change${all.length === 1 ? "" : "s"} since you last looked`),
    h("ul", { class: "feed-list" }, ...shown.map((c) => feedRow(c, now))),
    h("p", { class: "fine" }, all.length > shown.length ? `${all.length - shown.length} more, and Mark all seen, ` : "Mark all seen ", h("a", { href: "#ops" }, "on Ops")),
  );
  details.open = feedOpen;
  details.addEventListener("toggle", () => {
    feedOpen = details.open;
  });
  return details;
}

/**
 * The strip: the count against the target, split by lane, then a row
 * per agent, then the board changes line. `seen` is the changes feed's
 * snapshot (boardfeed.ts).
 */
export function agentsStrip(data: Active | undefined, seen: Snapshot | undefined, now: number): HTMLElement {
  const sec = h("section", { class: STRIP_CLASS, "aria-label": "Active agents" });
  const opsLink = h("a", { class: "as-ops", href: "#ops", title: "Devspaces, local agents, usage and every board change" }, "Ops →");
  if (!data?.board && data?.local === undefined) {
    sec.append(h("div", { class: "as-head" }, h("h2", {}, "Active agents"), h("span", { class: "note", title: data?.warnings.join("\n") ?? "" }, data ? "couldn't read the board or the heartbeat" : "reading…"), opsLink));
    return sec;
  }
  const s = activeAgents(data.board ?? [], data.local, now);
  const why = data.warnings.length ? `\n${data.warnings.join("\n")}` : "";
  const hb = heartbeatText(s, now, why);
  const lanes = (["harness", "upstream", "unknown"] as const).filter((l) => s.lanes[l] > 0 || l !== "unknown").map((l) => `${LANE_LABEL[l]} ${s.lanes[l]}`);
  sec.append(
    h(
      "div",
      { class: "as-head" },
      h("h2", {}, "Active agents"),
      h("span", { class: `as-count${s.running < s.target ? " under" : ""}`, title: `${s.running} working, aiming for about ${s.target}` }, `${s.running}/${s.target}`),
      h("span", { class: "as-lanes" }, lanes.join(" · ")),
      s.unconfirmed ? h("span", { class: "as-unconfirmed warn", title: "listed only by a stale heartbeat" }, `+${s.unconfirmed} unconfirmed`) : null,
      h("span", { class: `as-hb ${hb.cls}`, title: hb.title }, hb.text),
      data.board ? null : h("span", { class: "warn", title: `The board couldn't be read, so only the heartbeat's workers show.${why}` }, "board unread"),
      opsLink,
    ),
  );
  if (s.agents.length) sec.append(h("ul", { class: "as-list" }, ...s.agents.map((a) => agentRow(a, now))));
  else sec.append(h("p", { class: "note" }, "No agent is working right now."));
  if (data.board) {
    const feed = changesLine(data.board, seen, now, data.fromCache === true);
    if (feed) sec.append(feed);
  }
  return sec;
}
