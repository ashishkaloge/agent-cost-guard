#!/usr/bin/env node
/**
 * CLI smoke test. Drives the built executable and an npm-installed package as
 * real subprocesses. Run after `npm run build`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Every subprocess logs to a temporary decision log, never the real one.
const LOG_DIR = mkdtempSync(join(tmpdir(), 'agent-cost-guard-smoke-log-'));
const LOG_FILE = join(LOG_DIR, 'decisions.jsonl');
const ENV = { ...process.env, AGENT_COST_GUARD_LOG: 'on', AGENT_COST_GUARD_LOG_FILE: LOG_FILE };

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures += 1;
  }
}

function cli(args, input, env = ENV) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    input: input ?? '',
    encoding: 'utf8',
    env,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function logEntries() {
  if (!existsSync(LOG_FILE)) return [];
  return readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean).map(parseJson);
}

console.log('inspect:');
let r = cli(['inspect', '--', 'aws', 'ec2', 'describe-instances']);
check(
  'describe-instances allows (exit 0)',
  r.code === 0 && r.stdout.includes('Decision: ALLOW'),
);

r = cli(['inspect', '--', 'aws', 'ec2', 'run-instances', '--instance-type', 't3.small']);
check('run-instances asks approval (exit 2)', r.code === 2 && r.stdout.includes('Cost confirmation required:'));

r = cli(['inspect', '--json', '--', 'terraform', 'apply']);
check('terraform apply json (exit 2)', r.code === 2 && JSON.parse(r.stdout).reasonCode === 'terraform.apply');

r = cli(['inspect', '--json', '--', 'npx', '--yes', 'wrangler', 'deploy']);
check('package runner cannot hide a deploy', r.code === 2 && parseJson(r.stdout)?.reasonCode === 'cloudflare.wrangler.deploy');

r = cli(['inspect', '--json', '--strict', '--', 'aws ec2 describe-instances "']);
check('strict incomplete shell input blocks', r.code === 3 && parseJson(r.stdout)?.reasonCode === 'inspection.incomplete');

r = cli(
  ['inspect-json', '--strict'],
  JSON.stringify({
    source: 'generic',
    mode: 'non-interactive',
    action: {
      kind: 'file-change',
      path: 'infra/main.tf.json',
      addedText: JSON.stringify({ resource: { aws_instance: { fake_app: {} } } }),
    },
  }),
);
check('generic JSON inspects Terraform JSON', r.code === 2 && parseJson(r.stdout)?.reasonCode === 'terraform.resource-added');

r = cli([
  'inspect',
  '--json',
  '--',
  'aws',
  'rds',
  'create-db-instance',
  '--master-user-password',
  'fake multiword password',
  '--db-instance-identifier',
  'fake-db',
]);
check('decision output redacts a multiword secret', r.code === 2 && !r.stdout.includes('fake multiword password'));

r = cli(['inspect', '--', 'AGENT_COST_GUARD_DISABLED=1']);
check(
  'guard bypass blocks (exit 3)',
  r.code === 3 && r.stdout.includes('Decision: BLOCKED'),
);

r = cli(['inspect']);
check('missing -- is usage error (exit 64)', r.code === 64);

console.log('hook claude-code:');
r = cli(['hook', 'claude-code'], 'not json');
check('malformed input denies by default', r.code === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny');

r = cli(['hook', 'claude-code', '--no-strict'], 'not json');
check('explicit --no-strict defers malformed input', r.code === 0 && r.stdout.trim() === '');

r = cli(['hook', 'claude-code'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aws ec2 describe-instances' } }));
check('allow -> empty output, exit 0', r.code === 0 && r.stdout.trim() === '');

r = cli(['hook', 'claude-code'], JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aws ec2 run-instances' } }));
check('approval -> ask', r.code === 0 && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'ask');
check('never auto-approves', !r.stdout.includes('"permissionDecision":"allow"'));

console.log('hook codex:');
r = cli(['hook', 'codex'], 'not json');
check(
  'malformed input denies by default',
  r.code === 0 && parseJson(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
);

r = cli(
  ['hook', 'codex'],
  JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aws ec2 describe-instances' } }),
);
check('allow -> empty output, exit 0', r.code === 0 && r.stdout.trim() === '');

r = cli(
  ['hook', 'codex'],
  JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'aws ec2 run-instances' } }),
);
check(
  'approval -> deny with message',
  r.code === 0 &&
    parseJson(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny' &&
    r.stdout.includes('Cost confirmation required:'),
);
check('never emits unsupported ask or allow', !r.stdout.includes('"permissionDecision":"ask"') && !r.stdout.includes('"permissionDecision":"allow"'));

r = cli(
  ['hook', 'codex'],
  JSON.stringify({
    tool_name: 'apply_patch',
    tool_input: {
      command: '*** Begin Patch\n*** Update File: infra/main.tf\n@@\n+resource "aws_instance" "fake_web" {}\n*** End Patch',
    },
  }),
);
check(
  'native apply_patch command is inspected',
  r.code === 0 && parseJson(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
);

console.log('hook cursor:');
r = cli(
  ['hook', 'cursor'],
  JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'aws s3 ls' } }),
);
check('allow -> neutral JSON, exit 0', r.code === 0 && r.stdout.trim() === '{}');

r = cli(
  ['hook', 'cursor'],
  JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'terraform apply' } }),
);
check(
  'approval -> deny with message',
  r.code === 0 && parseJson(r.stdout)?.permission === 'deny' && r.stdout.includes('Cost confirmation required:'),
);
check('never emits unsupported ask or allow', !r.stdout.includes('"permission":"ask"') && !r.stdout.includes('"permission":"allow"'));

r = cli(
  ['hook', 'cursor'],
  JSON.stringify({
    tool_name: 'ApplyPatch',
    tool_input: {
      patch: '*** Begin Patch\n*** Update File: infra/main.tf\n@@\n+resource "aws_instance" "fake_web" {}\n*** End Patch',
    },
  }),
);
check('native ApplyPatch is inspected', r.code === 0 && parseJson(r.stdout)?.permission === 'deny');

console.log('hook copilot:');
r = cli(['hook', 'copilot', '--mode', 'cloud'], JSON.stringify({ toolName: 'bash', toolArgs: { command: 'terraform apply' } }));
check('cloud approval -> deny with message', r.code === 0 && JSON.parse(r.stdout).permissionDecision === 'deny' && r.stdout.includes('Cost confirmation required:'));

r = cli(
  ['hook', 'copilot', '--mode', 'interactive'],
  JSON.stringify({ toolName: 'powershell', toolArgs: JSON.stringify({ command: 'terraform apply' }) }),
);
check('native JSON-string toolArgs asks', r.code === 0 && parseJson(r.stdout)?.permissionDecision === 'ask');

r = cli(
  ['hook', 'copilot', '--mode', 'vscode'],
  JSON.stringify({
    tool_name: 'runTerminalCommand',
    tool_input: { command: 'AGENT_COST_GUARD_DISABLED=1 true' },
  }),
);
check(
  'VS Code bypass -> nested deny with reason',
  r.code === 0 &&
    parseJson(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny' &&
    r.stdout.includes('bypass'),
);

console.log('decision log:');
const hosts = new Set(logEntries().map((entry) => entry?.host));
check(
  'hooks and inspect recorded their decisions',
  ['cli', 'generic', 'claude-code', 'codex', 'cursor', 'github-copilot'].every((host) => hosts.has(host)),
);
check(
  'log never records allow decisions',
  logEntries().every((entry) => entry?.decision === 'approval-required' || entry?.decision === 'block'),
);
check('log redacts a multiword secret', !readFileSync(LOG_FILE, 'utf8').includes('fake multiword password'));

const before = logEntries().length;
r = cli(
  ['hook', 'claude-code'],
  JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'terraform apply' } }),
  { ...ENV, AGENT_COST_GUARD_LOG: 'off' },
);
check(
  'AGENT_COST_GUARD_LOG=off keeps the decision and records nothing',
  parseJson(r.stdout)?.hookSpecificOutput?.permissionDecision === 'ask' && logEntries().length === before,
);

r = cli(
  ['hook', 'codex'],
  JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'terraform apply' } }),
  { ...ENV, AGENT_COST_GUARD_LOG_FILE: join(CLI, 'decisions.jsonl') },
);
check(
  'unwritable log keeps valid hook output',
  r.code === 0 && r.stderr === '' && parseJson(r.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
);

r = cli(['report', '--json', '--since', '1d']);
check('report --json counts logged decisions', r.code === 0 && parseJson(r.stdout)?.total === before);

r = cli(['report']);
check('report prints a human summary', r.code === 0 && r.stdout.includes('By reason code:'));

console.log('rules:');
r = cli(['rules', 'list']);
check('rules list shows a known rule', r.code === 0 && r.stdout.includes('aws.ec2.run-instances'));

r = cli(['--version']);
check('--version prints a version', r.code === 0 && /\d+\.\d+\.\d+/.test(r.stdout));

r = cli(['doctor']);
check(
  'doctor reports local core and adapters working',
  r.code === 0 &&
    r.stdout.includes('Core inspection: checking... working') &&
    r.stdout.includes('Claude Code adapter: checking... working') &&
    r.stdout.includes('GitHub Copilot CLI adapter: checking... working') &&
    r.stdout.includes('GitHub Copilot for VS Code adapter: checking... working') &&
    r.stdout.includes('Host hook installation: not checked'),
);

console.log('installed package:');
const tempRoot = mkdtempSync(join(tmpdir(), 'agent-cost-guard-smoke-'));
try {
  const pack = spawnSync(
    NPM,
    [
      'pack',
      '--json',
      '--ignore-scripts',
      '--cache',
      join(tempRoot, 'npm-cache'),
      '--pack-destination',
      tempRoot,
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  check('npm pack succeeds', pack.status === 0);

  let tarball;
  if (pack.status === 0) {
    try {
      const result = JSON.parse(pack.stdout);
      tarball = join(tempRoot, result[0].filename);
      check(
        'package includes the executable entry',
        result[0].files.some((file) => file.path === 'dist/bin.js'),
      );
      check(
        'package includes offline integration examples',
        result[0].files.some((file) => file.path.startsWith('examples/')),
      );
      check(
        'package includes all first-class hook examples',
        [
          'examples/claude-code/settings.json',
          'examples/codex/hooks.json',
          'examples/cursor/hooks.json',
          'examples/github-copilot/copilot-cli.json',
          'examples/github-copilot/copilot-cloud.json',
          'examples/github-copilot/copilot-vscode.json',
        ].every((path) => result[0].files.some((file) => file.path === path)),
      );
    } catch {
      check('npm pack returns valid JSON', false);
    }
  }

  if (tarball) {
    const prefix = join(tempRoot, 'prefix');
    const install = spawnSync(
      NPM,
      [
        'install',
        '--global',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        join(tempRoot, 'npm-cache'),
        '--prefix',
        prefix,
        tarball,
      ],
      { encoding: 'utf8' },
    );
    check('tarball installs without network dependencies', install.status === 0);

    if (install.status === 0) {
      const bin = process.platform === 'win32'
        ? join(prefix, 'agent-cost-guard.cmd')
        : join(prefix, 'bin', 'agent-cost-guard');
      const installedVersion = spawnSync(bin, ['--version'], { encoding: 'utf8', env: ENV });
      check(
        'installed agent-cost-guard executable runs',
        installedVersion.status === 0 && /^\d+\.\d+\.\d+\s*$/.test(installedVersion.stdout),
      );

      const installedDoctor = spawnSync(bin, ['doctor'], { encoding: 'utf8', env: ENV });
      check(
        'installed executable reports local adapter status',
        installedDoctor.status === 0 &&
          installedDoctor.stdout.includes('Local verification: passed') &&
          installedDoctor.stdout.includes('Host hook installation: not checked'),
      );

      const installedInspect = spawnSync(
        bin,
        ['inspect', '--json', '--', 'terraform', 'apply', 'fake.plan'],
        { encoding: 'utf8', env: ENV },
      );
      check(
        'installed executable performs a real inspection',
        installedInspect.status === 2 &&
          parseJson(installedInspect.stdout)?.reasonCode === 'terraform.apply',
      );

      const installedCodex = spawnSync(
        bin,
        ['hook', 'codex'],
        {
          input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'aws ec2 run-instances' },
          }),
          encoding: 'utf8',
          env: ENV,
        },
      );
      check(
        'installed executable handles Codex hook input',
        installedCodex.status === 0 &&
          parseJson(installedCodex.stdout)?.hookSpecificOutput?.permissionDecision === 'deny',
      );

      const installedCursor = spawnSync(
        bin,
        ['hook', 'cursor'],
        {
          input: JSON.stringify({
            tool_name: 'Shell',
            tool_input: { command: 'terraform apply' },
          }),
          encoding: 'utf8',
          env: ENV,
        },
      );
      check(
        'installed executable handles Cursor hook input',
        installedCursor.status === 0 && parseJson(installedCursor.stdout)?.permission === 'deny',
      );
    }
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(LOG_DIR, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log('\nAll smoke checks passed.');
