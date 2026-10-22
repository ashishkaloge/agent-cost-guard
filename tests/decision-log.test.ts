import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { main } from '../src/cli.js';
import {
  decisionLogLocation,
  displayLogPath,
  readDecisionLog,
  type DecisionLogEntry,
} from '../src/log/decision-log.js';

interface Captured {
  code: number;
  out: string;
  err: string;
}

function run(args: string[], stdin?: string): Captured {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = main(args, stdin);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

const bash = (command: string): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command } });

let dir: string;
let logFile: string;

function logLines(): DecisionLogEntry[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DecisionLogEntry);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-cost-guard-log-'));
  logFile = join(dir, 'state', 'decisions.jsonl');
  delete process.env.AGENT_COST_GUARD_LOG;
  process.env.AGENT_COST_GUARD_LOG_FILE = logFile;
});

afterEach(() => {
  process.env.AGENT_COST_GUARD_LOG = 'off';
  delete process.env.AGENT_COST_GUARD_LOG_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe('decision log', () => {
  it('records approval-required and block decisions from inspect, but not allow', () => {
    expect(run(['inspect', '--', 'aws', 'ec2', 'describe-instances']).code).toBe(0);
    expect(existsSync(logFile)).toBe(false);

    expect(run(['inspect', '--', 'aws', 'ec2', 'run-instances', '--instance-type', 't3.small']).code).toBe(2);
    expect(run(['inspect', '--', 'AGENT_COST_GUARD_DISABLED=1 true']).code).toBe(3);

    const [approval, block] = logLines();
    expect(approval).toMatchObject({
      version: '1',
      host: 'cli',
      decision: 'approval-required',
      reasonCode: 'aws.ec2.run-instances',
      provider: 'AWS',
      resource: 'EC2 instance(s)',
      rules: ['aws.ec2.run-instances'],
      command: 'aws ec2 run-instances --instance-type t3.small',
    });
    expect(Number.isNaN(Date.parse(approval?.time ?? ''))).toBe(false);
    expect(block).toMatchObject({
      host: 'cli',
      decision: 'block',
      reasonCode: 'guard.bypass',
      provider: 'agent-cost-guard',
      resource: 'guard-bypass',
    });
    expect(logLines()).toHaveLength(2);
  });

  it('records inspect-json decisions under the request source', () => {
    const request = {
      source: 'ci',
      mode: 'non-interactive',
      action: { kind: 'tool', name: 'create_database', arguments: { name: 'fake' } },
    };
    expect(run(['inspect-json'], JSON.stringify(request)).code).toBe(2);
    expect(logLines()[0]).toMatchObject({ host: 'ci', command: 'create_database' });
  });

  it('records every host hook while stdout stays the same valid host JSON', () => {
    const cases: Array<{ args: string[]; input: string; host: string }> = [
      { args: ['hook', 'claude-code'], input: bash('terraform apply'), host: 'claude-code' },
      { args: ['hook', 'codex'], input: bash('terraform apply'), host: 'codex' },
      { args: ['hook', 'cursor'], input: bash('terraform apply'), host: 'cursor' },
      {
        args: ['hook', 'copilot', '--mode', 'cloud'],
        input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'terraform apply' } }),
        host: 'github-copilot',
      },
    ];
    for (const testCase of cases) {
      process.env.AGENT_COST_GUARD_LOG = 'off';
      const unlogged = run(testCase.args, testCase.input);
      delete process.env.AGENT_COST_GUARD_LOG;
      const logged = run(testCase.args, testCase.input);

      expect(logged, testCase.host).toEqual(unlogged);
      expect(logged.err).toBe('');
      expect(() => JSON.parse(logged.out) as unknown, testCase.host).not.toThrow();
      expect(logLines().at(-1), testCase.host).toMatchObject({
        host: testCase.host,
        reasonCode: 'terraform.apply',
        command: 'terraform apply',
      });
    }
    expect(logLines()).toHaveLength(cases.length);
  });

  it('describes file edits by tool and matched evidence instead of file content', () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: {
        file_path: 'infra/main.tf',
        content: 'resource "aws_db_instance" "fake_db" {\n  password = "fake-password-value"\n}',
      },
    });
    run(['hook', 'claude-code'], input);
    const [entry] = logLines();
    expect(entry?.command).toBe('Write: resource "aws_db_instance" "fake_db"');
    expect(readFileSync(logFile, 'utf8')).not.toContain('fake-password-value');
  });

  it('does not log hook input that never reached inspection', () => {
    run(['hook', 'claude-code'], 'not json');
    run(['hook', 'claude-code'], bash('aws ec2 describe-instances'));
    expect(existsSync(logFile)).toBe(false);
  });

  it('does not log the synthetic commands doctor checks', () => {
    expect(run(['doctor']).code).toBe(0);
    expect(existsSync(logFile)).toBe(false);
  });

  it('creates the log readable by the current user only', () => {
    run(['inspect', '--', 'terraform', 'apply']);
    if (process.platform !== 'win32') {
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
    }
  });
});

describe('decision log redaction', () => {
  it('redacts credentials before the command reaches disk', () => {
    run([
      'inspect',
      '--',
      'aws',
      'rds',
      'create-db-instance',
      '--master-user-password',
      'fake multiword password',
      '--db-instance-identifier',
      'fake-db',
    ]);
    run(
      ['hook', 'codex'],
      bash('curl -H "Authorization: Bearer fake-bearer-value-123" https://fake.example && terraform apply'),
    );
    run(['hook', 'cursor'], bash('GITHUB_TOKEN=ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234 wrangler deploy'));

    const raw = readFileSync(logFile, 'utf8');
    expect(raw).not.toContain('fake multiword password');
    expect(raw).not.toContain('fake-bearer-value-123');
    expect(raw).not.toContain('ghp_FAKEFAKEFAKEFAKEFAKEFAKE1234');
    expect(raw).toContain('[REDACTED]');
    expect(logLines()).toHaveLength(3);
  });

  it('bounds the logged command length', () => {
    run(['inspect', '--', `terraform apply ${'x'.repeat(5000)}`]);
    expect(logLines()[0]?.command.length).toBeLessThanOrEqual(500);
  });
});

describe('decision log off switch', () => {
  it.each(['off', 'OFF', '0', 'false', 'no'])('AGENT_COST_GUARD_LOG=%s records nothing', (value) => {
    process.env.AGENT_COST_GUARD_LOG = value;
    expect(run(['inspect', '--', 'terraform', 'apply']).code).toBe(2);
    expect(run(['hook', 'claude-code'], bash('terraform apply')).code).toBe(0);
    expect(existsSync(logFile)).toBe(false);
  });

  it('turning the log off in a proposed command is not a guard bypass', () => {
    const r = run(['inspect', '--json', '--', 'AGENT_COST_GUARD_LOG=off terraform apply']);
    expect(r.code).toBe(2);
    expect((JSON.parse(r.out) as { reasonCode: string }).reasonCode).toBe('terraform.apply');
  });
});

describe('decision log write failure', () => {
  it('never changes, breaks, or adds output to a decision', () => {
    // A regular file where the log directory should be makes every write fail.
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, '');
    process.env.AGENT_COST_GUARD_LOG_FILE = join(blocker, 'decisions.jsonl');

    const cases: Array<{ args: string[]; input?: string }> = [
      { args: ['inspect', '--', 'terraform', 'apply'] },
      { args: ['inspect', '--', 'AGENT_COST_GUARD_DISABLED=1 true'] },
      { args: ['hook', 'claude-code'], input: bash('terraform apply') },
      { args: ['hook', 'codex'], input: bash('terraform apply') },
      { args: ['hook', 'cursor'], input: bash('terraform apply') },
      {
        args: ['hook', 'copilot'],
        input: JSON.stringify({ toolName: 'bash', toolArgs: { command: 'terraform apply' } }),
      },
    ];
    for (const testCase of cases) {
      const failing = run(testCase.args, testCase.input);
      process.env.AGENT_COST_GUARD_LOG = 'off';
      const baseline = run(testCase.args, testCase.input);
      delete process.env.AGENT_COST_GUARD_LOG;
      expect(failing, testCase.args.join(' ')).toEqual(baseline);
      expect(failing.err).toBe('');
    }
    expect(statSync(blocker).size).toBe(0);
  });

  it('ignores an observer that throws inside an adapter', () => {
    const baseline = runClaudeCodeHook(bash('terraform apply'), { strict: true });
    const observed = runClaudeCodeHook(bash('terraform apply'), {
      strict: true,
      onDecision: () => {
        throw new Error('observer failure');
      },
    });
    expect(observed).toEqual(baseline);
    expect(observed.stdout).toContain('"permissionDecision":"ask"');
  });
});

describe('decision log location', () => {
  it('uses the XDG state directory, then the home state directory', () => {
    expect(decisionLogLocation({ XDG_STATE_HOME: '/fake/state' }).path).toBe(
      resolve('/fake/state', 'agent-cost-guard', 'decisions.jsonl'),
    );
    if (process.platform !== 'win32') {
      expect(decisionLogLocation({}).path).toBe(
        join(homedir(), '.local', 'state', 'agent-cost-guard', 'decisions.jsonl'),
      );
      // A relative XDG_STATE_HOME is invalid by the XDG specification.
      expect(decisionLogLocation({ XDG_STATE_HOME: 'relative' }).path).toBe(
        join(homedir(), '.local', 'state', 'agent-cost-guard', 'decisions.jsonl'),
      );
    }
  });

  it('lets AGENT_COST_GUARD_LOG_FILE choose the file and keeps logging on by default', () => {
    expect(decisionLogLocation({ AGENT_COST_GUARD_LOG_FILE: 'logs/acg.jsonl' })).toEqual({
      enabled: true,
      path: resolve('logs/acg.jsonl'),
    });
    expect(decisionLogLocation({ AGENT_COST_GUARD_LOG: 'off' }).enabled).toBe(false);
    expect(decisionLogLocation({ AGENT_COST_GUARD_LOG: 'on' }).enabled).toBe(true);
  });

  it('abbreviates the home directory in displayed paths', () => {
    expect(displayLogPath(join(homedir(), '.local', 'state', 'x.jsonl'))).toBe(
      join('~', '.local', 'state', 'x.jsonl'),
    );
    expect(displayLogPath('/fake/state/x.jsonl')).toBe('/fake/state/x.jsonl');
  });
});

describe('cli report', () => {
  const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

  function entry(overrides: Partial<DecisionLogEntry>): string {
    return JSON.stringify({
      version: '1',
      time: hoursAgo(1),
      host: 'claude-code',
      decision: 'approval-required',
      reasonCode: 'terraform.apply',
      provider: 'Terraform-managed provider',
      resource: 'planned infrastructure changes',
      rules: ['terraform.apply'],
      command: 'terraform apply',
      ...overrides,
    });
  }

  function writeLog(lines: string[]): void {
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, `${lines.join('\n')}\n`);
  }

  it('reports a missing log without failing', () => {
    const r = run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Agent Cost Guard report');
    expect(r.out).toContain('No decisions recorded yet.');
  });

  it('counts by decision, provider, reason code, and host, newest first', () => {
    writeLog([
      entry({ time: hoursAgo(48), command: 'terraform apply old' }),
      entry({
        time: hoursAgo(2),
        host: 'codex',
        decision: 'block',
        reasonCode: 'guard.bypass',
        provider: 'agent-cost-guard',
        resource: 'guard-bypass',
        rules: ['generic.cost-guard-bypass'],
        command: 'AGENT_COST_GUARD_DISABLED=1 true',
      }),
      entry({
        time: hoursAgo(1),
        reasonCode: 'aws.ec2.run-instances',
        provider: 'AWS',
        resource: 'EC2 instance(s)',
        rules: ['aws.ec2.run-instances'],
        command: 'aws ec2 run-instances --instance-type t3.small',
      }),
      entry({ time: hoursAgo(24 * 30), command: 'terraform apply ancient' }),
    ]);

    const all = run(['report']);
    expect(all.code).toBe(0);
    expect(all.out).toContain('Period: all recorded decisions');
    expect(all.out).toContain('Decisions: 4');
    expect(all.out).toMatch(/approval-required +3/);
    expect(all.out).toMatch(/block +1/);
    expect(all.out).toMatch(/Terraform-managed provider +2/);
    expect(all.out).toMatch(/guard\.bypass +1/);
    expect(all.out).toMatch(/claude-code +3/);

    const week = run(['report', '--since', '7d']);
    expect(week.out).toContain('Period: since ');
    expect(week.out).toContain('Decisions: 3');
    expect(week.out).not.toContain('ancient');
    const recent = week.out.slice(week.out.indexOf('Most recent (3):'));
    expect(recent.indexOf('aws ec2 run-instances')).toBeLessThan(recent.indexOf('AGENT_COST_GUARD_DISABLED'));
    expect(recent.indexOf('AGENT_COST_GUARD_DISABLED')).toBeLessThan(recent.indexOf('terraform apply old'));

    expect(run(['report', '--since=3h']).out).toContain('Decisions: 2');
  });

  it('emits parseable JSON with --json', () => {
    writeLog([entry({}), entry({ host: 'cursor' })]);
    const r = run(['report', '--json', '--since', '1w']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as {
      log: { enabled: boolean; skippedLines: number };
      since: string;
      total: number;
      byDecision: Record<string, number>;
      byProvider: Record<string, number>;
      byReasonCode: Record<string, number>;
      byHost: Record<string, number>;
      recent: DecisionLogEntry[];
    };
    expect(parsed.log).toMatchObject({ enabled: true, skippedLines: 0 });
    expect(Number.isNaN(Date.parse(parsed.since))).toBe(false);
    expect(parsed.total).toBe(2);
    expect(parsed.byDecision).toEqual({ 'approval-required': 2 });
    expect(parsed.byProvider).toEqual({ 'Terraform-managed provider': 2 });
    expect(parsed.byReasonCode).toEqual({ 'terraform.apply': 2 });
    expect(parsed.byHost).toEqual({ 'claude-code': 1, cursor: 1 });
    expect(parsed.recent).toHaveLength(2);
  });

  it('accepts an ISO date for --since', () => {
    writeLog([entry({ time: '2020-01-01T00:00:00.000Z' }), entry({})]);
    expect(run(['report', '--since', '2021-01-01']).out).toContain('Decisions: 1');
  });

  it('shows at most ten recent entries', () => {
    writeLog(Array.from({ length: 12 }, (_, i) => entry({ time: hoursAgo(i + 1) })));
    const r = run(['report']);
    expect(r.out).toContain('Decisions: 12');
    expect(r.out).toContain('Most recent (10):');
  });

  it('skips unreadable lines and treats logged text as untrusted', () => {
    writeLog([
      'not json',
      JSON.stringify({ version: '1', decision: 'allow' }),
      entry({ command: 'terraform apply \u001b[31mred\u001b[0m --token=fake-token-value' }),
    ]);
    const r = run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Skipped 2 unreadable log line(s)');
    expect(r.out).toContain('Decisions: 1');
    expect(r.out).not.toContain('\u001b');
    expect(r.out).not.toContain('fake-token-value');
    expect(readDecisionLog(logFile).skipped).toBe(2);
  });

  it('says when logging is off', () => {
    process.env.AGENT_COST_GUARD_LOG = 'off';
    const r = run(['report']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Logging: off');
    expect(existsSync(logFile)).toBe(false);
  });

  it('rejects invalid arguments with usage exit 64', () => {
    for (const args of [
      ['report', '--since'],
      ['report', '--since', 'yesterday'],
      ['report', '--since', '7y'],
      ['report', '--since', '2026-13-45'],
      ['report', '--since', '7d', '--since', '1d'],
      ['report', '--all'],
    ]) {
      expect(run(args).code, args.join(' ')).toBe(64);
    }
  });

  it('fails cleanly when the log cannot be read', () => {
    process.env.AGENT_COST_GUARD_LOG_FILE = dir; // a directory, not a file
    const r = run(['report']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('could not read the decision log');
  });
});
