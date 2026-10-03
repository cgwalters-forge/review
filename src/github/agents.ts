// The active agents strip atop the queue: who is working on what now,
// against the target of agents the bot aims to keep busy. Two sources,
// merged: the board's In Progress items that a topic session (Lead) or
// a devspace agent run (Run) claimed, and the coordinator's heartbeat
// (heartbeat.ts), which lists the workers on its own machine. Neither
// is complete alone: the heartbeat can't see topic sessions and goes
// stale when the coordinator stops, and the board says nothing of a
// worker's progress. Pure, so tests can check the merge.

import { type Item, parseIssueUrl, PRIORITY_ORDER, repoOf } from "./board.ts";
import { AGENT_TARGET, IN_PROGRESS, TRACKER_REPO } from "./config.ts";
import { isOwnOrg, itemOrg } from "./filter.ts";
import { type Heartbeat, isStale } from "./heartbeat.ts";
import type { UsageData } from "./usage.ts";

/** What the strip shows: the whole board and the heartbeat, as last read. */
export interface Active {
  /** Every unarchived board item; undefined when its read failed or isn't cached. */
  board?: Item[];
  /** The heartbeat: undefined when its read failed or isn't cached, null when none is published. */
  local?: Heartbeat | null;
  /** The plan's usage, for the usage section; undefined when its read failed or isn't cached. */
  usage?: UsageData;
  warnings: string[];
  at: number;
  /** Read from the cache only, before GitHub answered. */
  fromCache?: boolean;
}

/** Whom the work is for: the bot's own harness, upstream, or unknown (a tracker issue without an Org). */
export type Lane = "harness" | "upstream" | "unknown";

/** Where an agent was seen. */
export type AgentSource = "heartbeat" | "board" | "both";

export interface ActiveAgent {
  /** The worker's name, else the item's Lead, else "agent run". */
  name: string;
  itemUrl?: string;
  /** OWNER/REPO#N, when the item is an issue or PR. */
  itemRef?: string;
  title?: string;
  priority?: string;
  /** The worker's last reported status; for one only the board knows, "run" or "claimed". */
  status: string;
  /** When it started: the worker's start, else when its board item last changed. */
  since?: string;
  source: AgentSource;
  lane: Lane;
  lead?: string;
  runUrl?: string;
  devspace?: string;
  /** Only a stale heartbeat says it is running, so it may have ended. */
  stale: boolean;
}

export interface HeartbeatState {
  updatedAt: string;
  loopState: string;
  /** Too old to trust (see isStale). */
  stale: boolean;
  /** The coordinator said it stopped: its workers may have ended with it. */
  stopped: boolean;
}

export interface AgentSummary {
  /** Running ones first (by priority, then longest running), then the unconfirmed. */
  agents: ActiveAgent[];
  /** Agents counted as working: all but those only a stale heartbeat lists. */
  running: number;
  target: number;
  /** The running ones by lane. */
  lanes: Record<Lane, number>;
  /** Agents only a stale heartbeat lists. */
  unconfirmed: number;
  /** The heartbeat's freshness: undefined when it couldn't be read, null when none is published. */
  heartbeat?: HeartbeatState | null;
}

/** A board item claimed by an agent: In Progress, with a Lead or a Run. */
export function isClaimed(item: Item): boolean {
  return item.status === IN_PROGRESS && (item.lead !== undefined || item.run !== undefined);
}

export function laneOf(org: string | undefined): Lane {
  if (org === undefined) return "unknown";
  return isOwnOrg(org) ? "harness" : "upstream";
}

/** The lane of an issue or PR URL no board item describes: its owner's, a tracker issue's unknown. */
function urlLane(url: string): Lane {
  const ref = parseIssueUrl(url);
  if (!ref || repoOf(ref) === TRACKER_REPO.toLowerCase()) return "unknown";
  return laneOf(ref.owner.toLowerCase());
}

const norm = (url: string) => url.toLowerCase();

function refText(url: string | undefined): string | undefined {
  const ref = url ? parseIssueUrl(url) : undefined;
  return ref ? `${ref.owner}/${ref.repo}#${ref.number}` : undefined;
}

/**
 * The board item a worker's item URL names: the item that is that issue
 * or PR, else one whose Branch holds it; a claimed one first, since that
 * is the one the worker is likely working for.
 */
function itemFor(url: string, board: readonly Item[]): Item | undefined {
  const u = norm(url);
  const candidates = [...board.filter((i) => i.url && norm(i.url) === u), ...board.filter((i) => i.branch.some((b) => norm(b) === u))];
  return candidates.find(isClaimed) ?? candidates[0];
}

function rank(p: string | undefined): number {
  const i = PRIORITY_ORDER.indexOf(p ?? "");
  return i < 0 ? PRIORITY_ORDER.length : i;
}

function byPriorityThenAge(a: ActiveAgent, b: ActiveAgent): number {
  return rank(a.priority) - rank(b.priority) || (a.since ?? "￿").localeCompare(b.since ?? "￿") || a.name.localeCompare(b.name);
}

/**
 * Merge the heartbeat's workers with the board's claimed items. A worker
 * whose item is a claimed board item (by its URL, or a PR in its Branch)
 * is one agent seen in both; a claimed item no worker names is an agent
 * of its own (a topic session, or a devspace run). `board` is the whole
 * board, so a worker on an item that isn't claimed still gets its title,
 * priority and lane. `hb` is undefined when the heartbeat couldn't be
 * read, null when none is published.
 */
export function activeAgents(board: readonly Item[], hb: Heartbeat | null | undefined, now: number, target: number = AGENT_TARGET): AgentSummary {
  const stopped = hb?.loopState === "stopped";
  // A stopped coordinator isn't stale to the ops view, but nothing
  // vouches for the workers it last listed any more either.
  const hbStale = hb ? isStale(hb, now) || stopped : false;
  const used = new Set<string>();
  const agents: ActiveAgent[] = [];
  for (const w of hb?.workers ?? []) {
    const item = itemFor(w.itemUrl, board);
    const claimed = item !== undefined && isClaimed(item);
    if (claimed) used.add(item.nodeId);
    const a: ActiveAgent = {
      name: w.name,
      itemUrl: w.itemUrl,
      itemRef: w.itemRef,
      status: w.status,
      since: w.startedAt,
      source: claimed ? "both" : "heartbeat",
      lane: item ? laneOf(itemOrg(item)) : urlLane(w.itemUrl),
      // The board still claiming it vouches for it; a stale heartbeat alone doesn't.
      stale: hbStale && !claimed,
    };
    if (item) {
      a.title = item.title;
      if (item.priority) a.priority = item.priority;
      if (claimed && item.lead) a.lead = item.lead;
      if (claimed && item.run) a.runUrl = item.run;
    }
    if (w.devspace) a.devspace = w.devspace;
    agents.push(a);
  }
  for (const item of board) {
    if (!isClaimed(item) || used.has(item.nodeId)) continue;
    const a: ActiveAgent = {
      name: item.lead ?? "agent run",
      title: item.title,
      status: item.run ? "run" : "claimed",
      source: "board",
      lane: laneOf(itemOrg(item)),
      stale: false,
    };
    if (item.url) a.itemUrl = item.url;
    const ref = refText(item.url);
    if (ref) a.itemRef = ref;
    if (item.priority) a.priority = item.priority;
    const since = item.movedAt ?? item.updatedAt;
    if (since) a.since = since;
    if (item.lead) a.lead = item.lead;
    if (item.run) a.runUrl = item.run;
    agents.push(a);
  }
  const live = agents.filter((a) => !a.stale).sort(byPriorityThenAge);
  const unconfirmed = agents.filter((a) => a.stale).sort(byPriorityThenAge);
  const lanes: Record<Lane, number> = { harness: 0, upstream: 0, unknown: 0 };
  for (const a of live) lanes[a.lane]++;
  const summary: AgentSummary = { agents: [...live, ...unconfirmed], running: live.length, target, lanes, unconfirmed: unconfirmed.length };
  if (hb === null) summary.heartbeat = null;
  else if (hb) summary.heartbeat = { updatedAt: hb.updatedAt, loopState: hb.loopState, stale: isStale(hb, now), stopped };
  return summary;
}
