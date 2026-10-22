# Architecture

`agent-cost-guard` is intentionally one small Node.js and TypeScript package.
It has no server, database, account, telemetry, LLM, or runtime dependency.

## Why this shape fits

The tool sits between a coding agent and a proposed action. Its job is narrow:
inspect untrusted data, apply deterministic cost rules, and return a decision
before the host decides whether the action may run.

Keeping that path local and direct makes the important properties easy to
audit:

- inspected commands are never executed, sourced, evaluated, or expanded;
- rules produce the same result for the same input;
- possible credentials are redacted before output;
- an `allow` result never overrides the host's permission system; and
- no inspection needs a network connection or account.

## Data flow

```text
CLI, TypeScript caller, or host hook
  -> validate the external payload
  -> normalize shell, tool, or file-change input
  -> tokenize supported shell syntax without executing it
  -> match deterministic JSON rules
  -> order block and approval matches
  -> redact evidence
  -> emit the CLI or host-protocol decision
  -> append approval-required and block decisions to the local log
```

## Repository map

```text
src/
  adapters/       Host payload parsing and decision mapping
  core/           Types, normalization, tokenization, matching, and rules
  format/         Human and machine-readable decision and report output
  log/            Local decision log
  redaction/      Output redaction
  bin.ts          Executable entry point
  cli.ts          Importable CLI argument handling
  index.ts        Public TypeScript API
rules/            Versioned provider and generic cost rules
fixtures/         Fake, deterministic contract cases
tests/            Unit, contract, adapter, and package tests
examples/         Ready-to-copy host configuration
scripts/          Local smoke and package validation
```

## Boundaries

### Adapters

Adapters understand host-specific JSON. They must reject malformed supported
actions in strict mode and must never turn a core `allow` into automatic host
approval.

The adapter layer stays deliberately small. Claude Code and interactive GitHub
Copilot can map a cost match to the host's `ask` decision. Codex and Cursor do
not currently provide a reliable interactive prompt decision, so their adapters
map both `approval-required` and `block` to `deny` with the complete redacted
approval details. On a no-match, Cursor returns neutral `{}` and the other
adapters emit no permission override.

Agents without a first-class adapter use the same core through `inspect-json`
with `source: "generic"`. Enforcement still requires a before-tool hook or a
wrapper that can stop the proposed action; the core cannot intercept tools by
itself.

### Core

The core owns deterministic inspection. It reports whether parsing was
complete so an adapter can distinguish a genuine no-match from input it could
not safely inspect.

### Rules

Rules stay under `rules/` with stable IDs. A rule describes a cost policy, not
general command security. Every rule needs positive, negative, near-match, and
redaction coverage.

### Output

Output contains redacted structural evidence only. A compound action must list
every distinct cost approval it requires.

CLI and hook stdin is capped at 1 MiB. Oversized generic JSON is rejected, and
strict host hooks convert oversized input into the host's native deny response.

### Decision log

The CLI, not the core or the adapters, owns the decision log. Adapters expose
an optional `onDecision` observer whose errors are ignored; the CLI collects
decisions through it and appends them only after the host or terminal output
has been written. `doctor` and library callers record nothing.

Each line holds the time, host, decision, reason code, rule-defined provider
and resource, matched rule IDs, and the redacted command. For tools that are
not shell commands, it holds the tool name or path plus the matched evidence,
not the file body. Every write failure is swallowed. `report` reads the log
back as untrusted data, re-redacts it, and strips terminal control characters.

## Deliberate non-goals

- calculating a full cloud bill;
- querying live cloud accounts or prices;
- replacing IAM, budgets, sandboxes, or native agent permissions;
- parsing every possible shell program;
- becoming a broad command-security scanner; or
- adding a web application or remote policy service.
