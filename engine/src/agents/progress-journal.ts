/**
 * Subagent → main agent communication.
 *
 * The main agent follows a subagent through *semantic* events, not raw output tails:
 * - milestones: what the subagent itself states with subagent_report (draft/final);
 * - tool activity: cumulative per-tool call/failure tallies, plus the latest failure;
 * - status changes.
 * Every main-agent read returns only what changed since its previous read (a cursor), so repeated
 * checks never re-inject the same content. Ordinary tool calls are tallied, never pushed; milestones,
 * failures and status changes are what wakes or informs the main agent.
 */
export interface ProgressMilestone { seq: number; at: string; status: "draft" | "completed" | "incomplete"; report: string }
export interface ToolTally { calls: number; failed: number }
export interface ProgressJournal {
  /** Bumped by semantic events only: milestones and tool failures. */
  seq: number;
  milestones: ProgressMilestone[];
  tools: Record<string, ToolTally>;
  lastFailure?: { seq: number; at: string; tool: string; purpose?: string };
}
/** The main agent's last read position for one task. */
export interface ParentCursor { runGeneration: number; seq: number; tools: Record<string, ToolTally>; status?: string }

export interface ProgressDelta {
  status: string;
  statusChanged: boolean;
  milestones: ProgressMilestone[];
  tools: Array<{ name: string; calls: number; failed: number }>;
  failure?: ProgressJournal["lastFailure"];
  currentAction?: string;
  totalToolCalls: number;
  /** Something the main agent should know about (new milestone, failure or status change). */
  semantic: boolean;
  changed: boolean;
}

interface JournalHost { progress: { journal?: ProgressJournal; currentAction?: string; totalToolUseCount: number } }
interface CursorHost extends JournalHost { status: string; runGeneration: number; parentCursor?: ParentCursor }

/** Milestones are authored, rare and small; keep a generous entry history (never a character cut). */
const MAX_MILESTONES = 50;
const REPORT_TOOL = "subagent_report";

function journalOf(host: JournalHost): ProgressJournal {
  return host.progress.journal ??= { seq: 0, milestones: [], tools: {} };
}

export function recordToolOutcome(host: JournalHost, tool: string, ok: boolean, purpose?: unknown): void {
  if (tool === REPORT_TOOL) return; // reports are milestones, not activity
  const journal = journalOf(host);
  const tally = journal.tools[tool] ??= { calls: 0, failed: 0 };
  tally.calls += 1;
  if (!ok) {
    tally.failed += 1;
    journal.seq += 1;
    journal.lastFailure = { seq: journal.seq, at: new Date().toISOString(), tool, ...(typeof purpose === "string" && purpose.trim() ? { purpose: purpose.trim() } : {}) };
  }
}

export function recordMilestone(host: JournalHost, report: string, status: ProgressMilestone["status"]): void {
  const text = report.trim();
  if (!text) return;
  const journal = journalOf(host);
  journal.seq += 1;
  journal.milestones = [...journal.milestones, { seq: journal.seq, at: new Date().toISOString(), status, report: text }].slice(-MAX_MILESTONES);
}

/** Read milestones from a subagent's own tool results (durable message boundary). */
export function recordMilestonesFromMessage(host: JournalHost, message: { role: string; blocks: ReadonlyArray<{ type: string; name?: string; ok?: boolean; output?: unknown }> }): void {
  if (message.role !== "tool_result") return;
  for (const block of message.blocks) {
    if (block.type !== "tool_result" || block.name !== REPORT_TOOL || !block.ok || !block.output || typeof block.output !== "object") continue;
    const output = block.output as { report?: unknown; status?: unknown };
    if (typeof output.report !== "string") continue;
    const status = output.status === "completed" || output.status === "incomplete" ? output.status : "draft";
    recordMilestone(host, output.report, status);
  }
}

function cursorFor(host: CursorHost): ParentCursor {
  const cursor = host.parentCursor;
  // A new run generation starts its own journal; an older cursor must not hide it.
  return cursor && cursor.runGeneration === host.runGeneration ? cursor : { runGeneration: host.runGeneration, seq: 0, tools: {} };
}

export function progressDelta(host: CursorHost): ProgressDelta {
  const journal = host.progress.journal ?? { seq: 0, milestones: [], tools: {} };
  const cursor = cursorFor(host);
  const milestones = journal.milestones.filter(milestone => milestone.seq > cursor.seq);
  const tools = Object.entries(journal.tools)
    .map(([name, tally]) => ({ name, calls: tally.calls - (cursor.tools[name]?.calls ?? 0), failed: tally.failed - (cursor.tools[name]?.failed ?? 0) }))
    .filter(tally => tally.calls > 0)
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
  const failure = journal.lastFailure && journal.lastFailure.seq > cursor.seq ? journal.lastFailure : undefined;
  const statusChanged = cursor.status !== undefined && cursor.status !== host.status;
  const semantic = milestones.length > 0 || !!failure || statusChanged;
  return { status: host.status, statusChanged, milestones, tools, failure, currentAction: host.progress.currentAction,
    totalToolCalls: host.progress.totalToolUseCount, semantic, changed: semantic || tools.length > 0 };
}

/** Mark everything currently known as seen by the main agent. */
export function advanceParentCursor(host: CursorHost): void {
  const journal = host.progress.journal ?? { seq: 0, milestones: [], tools: {} };
  host.parentCursor = { runGeneration: host.runGeneration, seq: journal.seq, status: host.status,
    tools: Object.fromEntries(Object.entries(journal.tools).map(([name, tally]) => [name, { ...tally }])) };
}

/** Compact, line-oriented text for the main agent's context. */
export function formatProgressDelta(delta: ProgressDelta): string {
  if (!delta.changed) return `No change since your last check (status: ${delta.status}${delta.currentAction ? `; current: ${delta.currentAction}` : ""}).`;
  const lines = [`status: ${delta.status}${delta.statusChanged ? " (changed)" : ""}`];
  for (const milestone of delta.milestones) lines.push(`report (${milestone.status}): ${milestone.report}`);
  if (delta.tools.length) {
    lines.push(`tools since last check: ${delta.tools.map(tool => `${tool.name}×${tool.calls}${tool.failed ? ` (${tool.failed} failed)` : ""}`).join(", ")} — ${delta.totalToolCalls} total`);
  }
  if (delta.failure) lines.push(`latest failure: ${delta.failure.tool}${delta.failure.purpose ? ` — ${delta.failure.purpose}` : ""}`);
  if (delta.currentAction && delta.status === "running") lines.push(`current: ${delta.currentAction}`);
  return lines.join("\n");
}
