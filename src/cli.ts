/**
 * agent-cost-guard command-line interface.
 *
 * Commands:
 *   inspect [--json] [--strict] -- <command>
 *   inspect-json [--strict]
 *   hook claude-code [--strict|--no-strict]
 *   hook codex [--strict|--no-strict]
 *   hook cursor [--strict|--no-strict]
 *   hook copilot [--mode interactive|cloud|vscode] [--strict|--no-strict]
 *   doctor
 *   report [--since <age|date>] [--json]
 *   rules list [--json]
 *   rules explain <rule-id> [--json]
 *
 * Generic inspect exit codes: 0 allow, 2 approval-required, 3 block,
 * 64 invalid usage. Hook subcommands follow their host protocol on stdout and
 * exit 0; they never use the generic exit-code contract.
 *
 * Approval-required and block decisions from inspect, inspect-json, and hooks
 * are appended to the local decision log after their output is written.
 */

import { readFileSync, readSync } from 'node:fs';
import process from 'node:process';
import { clearLine, cursorTo } from 'node:readline';
import { runClaudeCodeHook } from './adapters/claude-code.js';
import { runCodexHook } from './adapters/codex.js';
import { runCursorHook } from './adapters/cursor.js';
import { runCopilotHook, type CopilotMode } from './adapters/github-copilot.js';
import type { AdapterOptions, HookResult } from './adapters/shared.js';
import { inspect } from './core/classify.js';
import { loadRules } from './core/rules.js';
import { parseInspectionRequest, type Decision, type InspectionRequest } from './core/types.js';
import { formatHuman, formatJson } from './format/output.js';
import { formatReportHuman, formatReportJson, summarizeDecisions } from './format/report.js';
import {
  decisionLogLocation,
  displayLogPath,
  readDecisionLog,
  recordDecision,
  type DecisionLogContents,
} from './log/decision-log.js';
import { redact } from './redaction/redact.js';

const EXIT = { allow: 0, error: 1, approval: 2, block: 3, usage: 64 } as const;
const MAX_STDIN_BYTES = 1024 * 1024;

const USAGE = `agent-cost-guard - local cost-policy gate for coding agents

Usage:
  agent-cost-guard inspect [--json] [--strict] -- <command...>
  agent-cost-guard inspect-json [--strict]
  agent-cost-guard hook claude-code [--strict|--no-strict]
  agent-cost-guard hook codex [--strict|--no-strict]
  agent-cost-guard hook cursor [--strict|--no-strict]
  agent-cost-guard hook copilot [--mode interactive|cloud|vscode] [--strict|--no-strict]
  agent-cost-guard doctor
  agent-cost-guard report [--since <age|date>] [--json]
  agent-cost-guard rules list [--json]
  agent-cost-guard rules explain <rule-id> [--json]
  agent-cost-guard --help | --version

Inspect exit codes: 0 allow, 2 approval-required, 3 block, 64 invalid usage.
Hook subcommands emit host-protocol JSON on stdout and exit 0.
Approval-required and block decisions are logged locally; set
AGENT_COST_GUARD_LOG=off to stop logging.`;

function decisionExitCode(decision: Decision): number {
  if (decision.decision === 'approval-required') return EXIT.approval;
  if (decision.decision === 'block') return EXIT.block;
  return EXIT.allow;
}

function getVersion(): string {
  try {
    const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(pkg) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface StdinInput {
  raw: string;
  oversized: boolean;
}

function readStdin(stdin?: string): StdinInput {
  if (stdin !== undefined) {
    return Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES
      ? { raw: '', oversized: true }
      : { raw: stdin, oversized: false };
  }

  try {
    const buffer = Buffer.alloc(MAX_STDIN_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(0, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > MAX_STDIN_BYTES
      ? { raw: '', oversized: true }
      : { raw: buffer.toString('utf8', 0, offset), oversized: false };
  } catch {
    return { raw: '', oversized: false };
  }
}

function usageError(message: string): number {
  process.stderr.write(`${redact(message)}\n\n${USAGE}\n`);
  return EXIT.usage;
}

function diagnostic(message: string): void {
  process.stderr.write(`${redact(message)}\n`);
}

function runInspect(args: string[]): number {
  const sep = args.indexOf('--');
  const flags = sep === -1 ? args : args.slice(0, sep);
  const rest = sep === -1 ? [] : args.slice(sep + 1);
  const json = flags.includes('--json');
  const unknown = flags.find((f) => f !== '--json' && f !== '--strict');
  if (unknown) return usageError(`Unknown inspect flag: ${unknown}`);
  if (sep === -1 || rest.length === 0) {
    return usageError('inspect requires a command after `--`.');
  }

  // A single argument is a full command string (may contain operators, env
  // assignments, or `sh -c` wrappers), so tokenize it. Multiple arguments were
  // already split by the parent shell; keep them as argv to preserve quoting.
  const action =
    rest.length === 1
      ? ({ kind: 'shell', command: rest[0] as string } as const)
      : ({ kind: 'shell', command: rest.join(' '), argv: rest } as const);
  const request: InspectionRequest = { source: 'cli', mode: 'interactive', action };
  const showProgress = !json && process.stdout.isTTY === true && process.stderr.isTTY === true;
  if (showProgress) process.stderr.write('⠋ Checking cost policy...');
  let decision: Decision;
  try {
    decision = inspect(request, { strict: flags.includes('--strict') });
  } finally {
    if (showProgress) {
      clearLine(process.stderr, 0);
      cursorTo(process.stderr, 0);
      process.stderr.write('✓ Cost policy checked.\n');
    }
  }
  process.stdout.write(`${json ? formatJson(decision) : formatHuman(decision)}\n`);
  recordDecision(request, decision);
  return decisionExitCode(decision);
}

function runInspectJson(args: string[], stdin?: string): number {
  const unknown = args.find((flag) => flag !== '--strict');
  if (unknown) return usageError(`Unknown inspect-json flag: ${unknown}`);

  const stdinInput = readStdin(stdin);
  if (stdinInput.oversized) {
    return usageError('inspect-json stdin exceeds the 1 MiB limit.');
  }
  const raw = stdinInput.raw;
  if (raw.trim().length === 0) {
    return usageError('inspect-json requires one JSON request on stdin.');
  }

  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch {
    return usageError('inspect-json received invalid JSON on stdin.');
  }

  const parsed = parseInspectionRequest(input);
  if (!parsed.ok) return usageError(`Invalid inspection request: ${parsed.error}.`);

  const decision = inspect(parsed.request, { strict: args.includes('--strict') });
  process.stdout.write(`${formatJson(decision)}\n`);
  recordDecision(parsed.request, decision);
  return decisionExitCode(decision);
}

type StrictHookRunner = (raw: string, options: AdapterOptions) => HookResult;

/** Hold hook decisions so the log is written only after the host response. */
function hookDecisionLog(): {
  onDecision: NonNullable<AdapterOptions['onDecision']>;
  flush: () => void;
} {
  const observed: Array<{ request: InspectionRequest; decision: Decision }> = [];
  return {
    onDecision: (request, decision) => {
      observed.push({ request, decision });
    },
    flush: () => {
      for (const { request, decision } of observed) recordDecision(request, decision);
    },
  };
}

function runStrictHook(
  host: 'claude-code' | 'codex' | 'cursor',
  label: string,
  flags: string[],
  stdin: string | undefined,
  runner: StrictHookRunner,
): number {
  const unknown = flags.find((flag) => flag !== '--strict' && flag !== '--no-strict');
  if (unknown) return usageError(`Unknown ${label} hook flag: ${unknown}`);
  if (flags.includes('--strict') && flags.includes('--no-strict')) {
    return usageError(`hook ${host} cannot combine --strict and --no-strict.`);
  }
  const strict = !flags.includes('--no-strict');
  const input = readStdin(stdin);
  const log = hookDecisionLog();
  const result = runner(input.oversized ? '' : input.raw, { strict, onDecision: log.onDecision });
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  log.flush();
  return result.exitCode;
}

function runHook(args: string[], stdin?: string): number {
  const host = args[0];
  if (host === 'claude-code') {
    return runStrictHook('claude-code', 'Claude Code', args.slice(1), stdin, runClaudeCodeHook);
  }
  if (host === 'codex') {
    return runStrictHook('codex', 'Codex', args.slice(1), stdin, runCodexHook);
  }
  if (host === 'cursor') {
    return runStrictHook('cursor', 'Cursor', args.slice(1), stdin, runCursorHook);
  }
  if (host === 'copilot' || host === 'github-copilot') {
    const flags = args.slice(1);
    let strict = true;
    let strictFlag: '--strict' | '--no-strict' | undefined;
    let mode: CopilotMode = 'interactive';
    let hasMode = false;
    for (let i = 0; i < flags.length; i += 1) {
      const flag = flags[i] as string;
      if (flag === '--strict' || flag === '--no-strict') {
        if (strictFlag !== undefined && strictFlag !== flag) {
          return usageError('hook copilot cannot combine --strict and --no-strict.');
        }
        strictFlag = flag;
        strict = flag === '--strict';
        continue;
      }
      if (flag === '--mode') {
        if (hasMode) return usageError('hook copilot accepts --mode only once.');
        const value = flags[i + 1];
        if (value !== 'interactive' && value !== 'cloud' && value !== 'vscode') {
          return usageError('hook copilot --mode must be "interactive", "cloud", or "vscode".');
        }
        mode = value;
        hasMode = true;
        i += 1;
        continue;
      }
      if (flag.startsWith('--mode=')) {
        if (hasMode) return usageError('hook copilot accepts --mode only once.');
        const value = flag.slice('--mode='.length);
        if (value !== 'interactive' && value !== 'cloud' && value !== 'vscode') {
          return usageError('hook copilot --mode must be "interactive", "cloud", or "vscode".');
        }
        mode = value;
        hasMode = true;
        continue;
      }
      return usageError(`Unknown Copilot hook flag: ${flag}`);
    }
    const input = readStdin(stdin);
    const log = hookDecisionLog();
    const result = runCopilotHook(input.oversized ? '' : input.raw, {
      strict,
      mode,
      onDecision: log.onDecision,
    });
    if (result.stdout) process.stdout.write(`${result.stdout}\n`);
    log.flush();
    return result.exitCode;
  }
  return usageError(`Unknown hook host: ${host ?? '(none)'}`);
}

interface HookDecisionOutput {
  hookSpecificOutput?: { permissionDecision?: unknown };
  permission?: unknown;
  permissionDecision?: unknown;
}

function hookDecision(result: HookResult): string | undefined {
  if (result.exitCode !== 0 || result.stdout.length === 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as HookDecisionOutput;
    const decision =
      parsed.hookSpecificOutput?.permissionDecision ??
      parsed.permission ??
      parsed.permissionDecision;
    return typeof decision === 'string' ? decision : undefined;
  } catch {
    return undefined;
  }
}

function runDoctor(args: string[]): number {
  if (args.length > 0) return usageError('doctor does not accept arguments.');

  try {
    const request = (command: string): InspectionRequest => ({
      source: 'cli',
      mode: 'interactive',
      action: { kind: 'shell', command },
    });
    const safe = inspect(request('aws ec2 describe-instances'), { strict: true });
    const cost = inspect(request('terraform apply fake.plan'), { strict: true });
    const bypass = inspect(request('AGENT_COST_GUARD_DISABLED=1 true'), { strict: true });

    const claudeInput = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'terraform apply fake.plan' },
    });
    const copilotInput = JSON.stringify({
      toolName: 'bash',
      toolArgs: { command: 'terraform apply fake.plan' },
    });
    const vscodeInput = JSON.stringify({
      tool_name: 'runTerminalCommand',
      tool_input: { command: 'terraform apply fake.plan' },
    });

    const checks = [
      {
        label: 'Core inspection',
        run: () =>
          safe.decision === 'allow' &&
          cost.decision === 'approval-required' &&
          bypass.decision === 'block',
      },
      {
        label: 'Claude Code adapter',
        run: () => hookDecision(runClaudeCodeHook(claudeInput, { strict: true })) === 'ask',
      },
      {
        label: 'Codex adapter',
        run: () => hookDecision(runCodexHook(claudeInput, { strict: true })) === 'deny',
      },
      {
        label: 'Cursor adapter',
        run: () => hookDecision(runCursorHook(claudeInput, { strict: true })) === 'deny',
      },
      {
        label: 'GitHub Copilot CLI adapter',
        run: () =>
          hookDecision(runCopilotHook(copilotInput, { strict: true, mode: 'interactive' })) ===
          'ask',
      },
      {
        label: 'GitHub Copilot for VS Code adapter',
        run: () =>
          hookDecision(runCopilotHook(vscodeInput, { strict: true, mode: 'vscode' })) === 'ask',
      },
    ];
    process.stdout.write('Agent Cost Guard doctor\n\n');
    const results = checks.map((check) => {
      process.stdout.write(`${check.label}: checking... `);
      const ok = check.run();
      process.stdout.write(`${ok ? 'working' : 'FAILED'}\n`);
      return { label: check.label, ok };
    });
    const passed = results.every((check) => check.ok);
    const lines = [
      '',
      `Safe command decision: ${safe.decision}`,
      `Cost command decision: ${cost.decision}`,
      `Guard bypass decision: ${bypass.decision}`,
      '',
      `Local verification: ${passed ? 'passed' : 'FAILED'}`,
      'Host hook installation: not checked',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    return passed ? EXIT.allow : EXIT.error;
  } catch {
    diagnostic('Agent Cost Guard doctor could not complete local verification.');
    return EXIT.error;
  }
}

const SINCE_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse `--since` as an age (`30m`, `24h`, `7d`, `2w`) or an ISO date. */
function parseSince(value: string, now: Date): Date | undefined {
  const age = /^(\d{1,6})([mhdw])$/.exec(value);
  if (age) {
    const unit = SINCE_UNIT_MS[age[2] as string] as number;
    return new Date(now.getTime() - Number(age[1]) * unit);
  }
  if (/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time);
  }
  return undefined;
}

function runReport(args: string[]): number {
  let json = false;
  let sinceValue: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i] as string;
    if (flag === '--json') {
      json = true;
      continue;
    }
    if (flag === '--since' || flag.startsWith('--since=')) {
      if (sinceValue !== undefined) return usageError('report accepts --since only once.');
      if (flag === '--since') {
        sinceValue = args[i + 1] ?? '';
        i += 1;
      } else {
        sinceValue = flag.slice('--since='.length);
      }
      continue;
    }
    return usageError(`Unknown report flag: ${flag}`);
  }

  let since: Date | undefined;
  if (sinceValue !== undefined) {
    since = parseSince(sinceValue, new Date());
    if (!since) {
      return usageError(
        'report --since must be an age such as 24h, 7d, or 2w, or a date such as 2026-01-31.',
      );
    }
  }

  const location = decisionLogLocation();
  const logPath = displayLogPath(location.path);
  let contents: DecisionLogContents;
  try {
    contents = readDecisionLog(location.path);
  } catch {
    diagnostic(`Agent Cost Guard could not read the decision log at ${logPath}.`);
    return EXIT.error;
  }
  const report = summarizeDecisions(contents.entries, since);
  const context = {
    logPath,
    logEnabled: location.enabled,
    logExists: contents.exists,
    skippedLines: contents.skipped,
  };
  process.stdout.write(
    `${json ? formatReportJson(report, context) : formatReportHuman(report, context)}\n`,
  );
  return EXIT.allow;
}

function runRules(args: string[]): number {
  const sub = args[0];

  if (sub === 'list') {
    const flags = args.slice(1);
    const unknown = flags.find((flag) => flag !== '--json');
    if (unknown) return usageError(`Unknown rules list flag: ${unknown}`);
    const json = flags.includes('--json');
    const rules = loadRules();
    if (json) {
      process.stdout.write(
        `${JSON.stringify(
          rules.map((r) => ({
            id: r.id,
            provider: r.provider,
            category: r.category,
            decision: r.decision,
          })),
          null,
          2,
        )}\n`,
      );
      return EXIT.allow;
    }
    for (const rule of rules) {
      process.stdout.write(
        `${rule.id.padEnd(40)} ${rule.decision.padEnd(18)} ${rule.provider} / ${rule.category}\n`,
      );
    }
    return EXIT.allow;
  }

  if (sub === 'explain') {
    const rest = args.slice(1);
    const unknownFlag = rest.find((arg) => arg.startsWith('--') && arg !== '--json');
    if (unknownFlag) return usageError(`Unknown rules explain flag: ${unknownFlag}`);
    const ids = rest.filter((arg) => arg !== '--json');
    if (ids.length > 1) return usageError('rules explain accepts exactly one <rule-id>.');
    const id = ids[0];
    if (!id) return usageError('rules explain requires a <rule-id>.');
    const json = rest.includes('--json');
    const rules = loadRules();
    const rule = rules.find((r) => r.id === id);
    if (!rule) {
      diagnostic(`No rule with id "${id}".`);
      return EXIT.usage;
    }
    if (json) {
      process.stdout.write(`${JSON.stringify(rule, null, 2)}\n`);
      return EXIT.allow;
    }
    const lines = [
      `Rule:      ${rule.id} (v${rule.version})`,
      `Provider:  ${rule.provider}`,
      `Category:  ${rule.category}`,
      `Form:      ${rule.actionForm}`,
      `Decision:  ${rule.decision}`,
      `Reason:    ${rule.reasonCode}`,
      `Summary:   ${rule.summary}`,
    ];
    if (rule.approval) {
      lines.push(
        `Approval:  ${rule.approval.provider} / ${rule.approval.resource} / ${rule.approval.billing}`,
        `Price:     ${rule.approval.price}`,
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return EXIT.allow;
  }

  return usageError(`Unknown rules subcommand: ${sub ?? '(none)'}`);
}

export function main(argv: string[], stdin?: string): number {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? EXIT.usage : EXIT.allow;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${getVersion()}\n`);
    return EXIT.allow;
  }

  switch (command) {
    case 'inspect':
      return runInspect(rest);
    case 'inspect-json':
      return runInspectJson(rest, stdin);
    case 'hook':
      return runHook(rest, stdin);
    case 'doctor':
      return runDoctor(rest);
    case 'report':
      return runReport(rest);
    case 'rules':
      return runRules(rest);
    default:
      return usageError(`Unknown command: ${command}`);
  }
}
