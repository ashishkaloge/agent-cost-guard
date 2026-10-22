/**
 * Summary of the local decision log for `agent-cost-guard report`.
 *
 * Log lines are read back as untrusted data: every string is re-redacted, and
 * human output strips control characters so a logged command cannot drive the
 * terminal.
 */

import type { DecisionLogEntry } from '../log/decision-log.js';
import { redact } from '../redaction/redact.js';

const RECENT_LIMIT = 10;

export interface DecisionReport {
  /** ISO start of the reported period, or undefined for the whole log. */
  since?: string;
  total: number;
  byDecision: Record<string, number>;
  byProvider: Record<string, number>;
  byReasonCode: Record<string, number>;
  byHost: Record<string, number>;
  /** Newest first. */
  recent: DecisionLogEntry[];
}

export interface ReportContext {
  logPath: string;
  logEnabled: boolean;
  logExists: boolean;
  skippedLines: number;
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Counts sorted by count, then key, so output is deterministic. */
function countBy(entries: DecisionLogEntry[], key: (entry: DecisionLogEntry) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const value = key(entry);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]));
  return Object.fromEntries(sorted);
}

function cleanEntry(entry: DecisionLogEntry): DecisionLogEntry {
  return {
    ...entry,
    host: redact(entry.host),
    reasonCode: redact(entry.reasonCode),
    provider: redact(entry.provider),
    resource: redact(entry.resource),
    rules: entry.rules.map(redact),
    command: redact(entry.command),
  };
}

/** Summarize log entries at or after `since`. */
export function summarizeDecisions(entries: DecisionLogEntry[], since?: Date): DecisionReport {
  const start = since?.getTime();
  const selected = entries
    .filter((entry) => start === undefined || Date.parse(entry.time) >= start)
    .map(cleanEntry);
  const recent = [...selected]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, RECENT_LIMIT);
  const report: DecisionReport = {
    total: selected.length,
    byDecision: countBy(selected, (entry) => entry.decision),
    byProvider: countBy(selected, (entry) => entry.provider),
    byReasonCode: countBy(selected, (entry) => entry.reasonCode),
    byHost: countBy(selected, (entry) => entry.host),
    recent,
  };
  if (since) report.since = since.toISOString();
  return report;
}

/** Pretty JSON for `report --json`. */
export function formatReportJson(report: DecisionReport, context: ReportContext): string {
  return JSON.stringify(
    {
      log: { path: context.logPath, enabled: context.logEnabled, skippedLines: context.skippedLines },
      ...report,
    },
    null,
    2,
  );
}

function terminalSafe(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
}

function utcMinute(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function countLines(counts: Record<string, number>): string[] {
  const keys = Object.keys(counts).map(terminalSafe);
  const width = Math.max(0, ...keys.map((key) => key.length));
  return Object.entries(counts).map(
    ([key, count]) => `  ${terminalSafe(key).padEnd(width)}  ${count}`,
  );
}

/** Human-readable terminal output for `report`. */
export function formatReportHuman(report: DecisionReport, context: ReportContext): string {
  const lines = ['Agent Cost Guard report', `Log: ${terminalSafe(context.logPath)}`];
  if (!context.logEnabled) lines.push('Logging: off (AGENT_COST_GUARD_LOG); no new decisions are recorded');
  lines.push(report.since ? `Period: since ${utcMinute(report.since)}` : 'Period: all recorded decisions');
  if (context.skippedLines > 0) {
    lines.push(`Skipped ${context.skippedLines} unreadable log line(s)`);
  }
  lines.push('');

  if (report.total === 0) {
    lines.push(
      context.logExists
        ? 'No approval-required or block decisions in this period.'
        : 'No decisions recorded yet.',
    );
    return lines.join('\n');
  }

  lines.push(`Decisions: ${report.total}`, ...countLines(report.byDecision), '');
  lines.push('By provider:', ...countLines(report.byProvider), '');
  lines.push('By reason code:', ...countLines(report.byReasonCode), '');
  lines.push('By host:', ...countLines(report.byHost), '');
  lines.push(`Most recent (${report.recent.length}):`);
  const hostWidth = Math.max(0, ...report.recent.map((entry) => terminalSafe(entry.host).length));
  const decisionWidth = Math.max(0, ...report.recent.map((entry) => entry.decision.length));
  for (const entry of report.recent) {
    const host = terminalSafe(entry.host).padEnd(hostWidth);
    const decision = entry.decision.padEnd(decisionWidth);
    lines.push(
      `  ${utcMinute(entry.time)}  ${host}  ${decision}  ${terminalSafe(entry.reasonCode)}`,
      `    ${terminalSafe(entry.command)}`,
    );
  }
  return lines.join('\n');
}
