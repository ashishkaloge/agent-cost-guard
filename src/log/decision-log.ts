/**
 * Local decision log.
 *
 * Records each approval-required or block decision as one JSON line in the
 * user's state directory, so a person can later see what the guard stopped.
 * The log stays on this machine, holds only redacted command text, and is
 * turned off with `AGENT_COST_GUARD_LOG=off`.
 *
 * Writing is best effort. Callers record only after the decision has been
 * emitted, and every failure is swallowed, so the log can never change or
 * break a decision.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { toolShellCommand } from '../core/normalize.js';
import { loadRules } from '../core/rules.js';
import type { Action, Decision, InspectionRequest } from '../core/types.js';
import { redactEvidence } from '../redaction/redact.js';

/** Set to `off` (or `0`, `false`, `no`) to stop recording decisions. */
export const LOG_ENV = 'AGENT_COST_GUARD_LOG';
/** Optional log file path. Relative paths resolve against the working directory. */
export const LOG_FILE_ENV = 'AGENT_COST_GUARD_LOG_FILE';

const OFF_VALUES = new Set(['off', '0', 'false', 'no']);
const MAX_COMMAND_LENGTH = 500;

export type LogEnv = Readonly<Record<string, string | undefined>>;

export type LoggedDecision = 'approval-required' | 'block';

/** One line of the decision log. Every string is redacted or rule-defined. */
export interface DecisionLogEntry {
  version: '1';
  time: string;
  host: string;
  decision: LoggedDecision;
  reasonCode: string;
  provider: string;
  resource: string;
  rules: string[];
  command: string;
}

export interface LogLocation {
  enabled: boolean;
  path: string;
}

/** Resolve whether the log is on and where it lives. Never touches the disk. */
export function decisionLogLocation(env: LogEnv = process.env): LogLocation {
  const enabled = !OFF_VALUES.has((env[LOG_ENV] ?? '').trim().toLowerCase());
  const file = env[LOG_FILE_ENV]?.trim();
  if (file) return { enabled, path: resolve(file) };

  const xdgState = env.XDG_STATE_HOME;
  let stateDir: string;
  if (xdgState && isAbsolute(xdgState)) {
    stateDir = xdgState;
  } else if (process.platform === 'win32' && env.LOCALAPPDATA) {
    stateDir = env.LOCALAPPDATA;
  } else {
    stateDir = join(homedir(), '.local', 'state');
  }
  return { enabled, path: join(stateDir, 'agent-cost-guard', 'decisions.jsonl') };
}

/** Show a log path with the home directory abbreviated to `~`. */
export function displayLogPath(path: string): string {
  const raw = homedir();
  if (!raw) return path;
  const home = resolve(raw);
  if (path === home || path.startsWith(`${home}${sep}`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function primaryTarget(decision: Decision): { provider: string; resource: string } {
  const approval = decision.approval ?? decision.approvals?.[0];
  if (approval) return { provider: approval.provider, resource: approval.resource };

  const ruleId = decision.matches[0]?.ruleId;
  const rule = ruleId === undefined ? undefined : loadRules().find((r) => r.id === ruleId);
  if (rule?.approval) return { provider: rule.approval.provider, resource: rule.approval.resource };
  if (rule) return { provider: rule.provider, resource: rule.category };
  return { provider: 'agent-cost-guard', resource: 'uninspectable action' };
}

/** The proposed command, or the tool/path plus matched evidence when there is none. */
function actionText(action: Action, decision: Decision): string {
  if (action.kind === 'shell') return action.command;
  if (action.kind === 'tool') {
    const command = toolShellCommand(action);
    if (command !== undefined) return command;
  }
  const subject = action.kind === 'tool' ? action.name : action.path;
  const evidence = decision.matches
    .map((match) => match.redactedEvidence)
    .filter((text): text is string => text !== undefined && text !== subject);
  return evidence.length > 0 ? `${subject}: ${evidence.join('; ')}` : subject;
}

/** Build the log line for a decision, or undefined for `allow`. */
export function decisionLogEntry(
  request: InspectionRequest,
  decision: Decision,
  now: Date = new Date(),
): DecisionLogEntry | undefined {
  if (decision.decision === 'allow') return undefined;
  const { provider, resource } = primaryTarget(decision);
  return {
    version: '1',
    time: now.toISOString(),
    host: request.source,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    provider,
    resource,
    rules: decision.matches.map((match) => match.ruleId),
    command: redactEvidence(actionText(request.action, decision), MAX_COMMAND_LENGTH),
  };
}

/**
 * Append an approval-required or block decision to the local log.
 *
 * Call only after the decision has been written to the host or terminal.
 * Never throws and never writes to stdout or stderr.
 */
export function recordDecision(
  request: InspectionRequest,
  decision: Decision,
  env: LogEnv = process.env,
  now: Date = new Date(),
): void {
  try {
    if (decision.decision === 'allow') return;
    const location = decisionLogLocation(env);
    if (!location.enabled) return;
    const entry = decisionLogEntry(request, decision, now);
    if (!entry) return;
    mkdirSync(dirname(location.path), { recursive: true, mode: 0o700 });
    appendFileSync(location.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // The log is optional evidence; it must never affect a decision.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEntry(line: string): DecisionLogEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== '1') return undefined;
  const { time, host, decision, reasonCode, provider, resource, rules, command } = value;
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time))) return undefined;
  if (decision !== 'approval-required' && decision !== 'block') return undefined;
  if (
    typeof host !== 'string' ||
    typeof reasonCode !== 'string' ||
    typeof provider !== 'string' ||
    typeof resource !== 'string' ||
    typeof command !== 'string' ||
    !Array.isArray(rules) ||
    !rules.every((rule) => typeof rule === 'string')
  ) {
    return undefined;
  }
  return {
    version: '1',
    time,
    host,
    decision,
    reasonCode,
    provider,
    resource,
    rules: rules as string[],
    command,
  };
}

export interface DecisionLogContents {
  /** False when no log file exists yet. */
  exists: boolean;
  entries: DecisionLogEntry[];
  /** Lines that were not valid log entries. */
  skipped: number;
}

/** Read the log. A missing file is an empty log; other read errors throw. */
export function readDecisionLog(path: string): DecisionLogContents {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return { exists: false, entries: [], skipped: 0 };
    }
    throw error;
  }
  const entries: DecisionLogEntry[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
    else skipped += 1;
  }
  return { exists: true, entries, skipped };
}
