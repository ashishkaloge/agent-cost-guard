# Integrations

The package exposes the `agent-cost-guard` executable. Install it in the same
project that owns the hook configuration so the hook does not depend on a
global installation or a network download at runtime.

```bash
npm install --save-dev @ashishkaloge/agent-cost-guard@0.1.0
```

For development, install a local checkout instead:

```bash
npm install --save-dev /absolute/path/to/agent-cost-guard
```

The examples below invoke the project-local dependency. Keep strict mode
enabled for enforcement. A malformed supported action is then denied instead
of silently falling through.

## Host behavior

| Host | No cost match | Cost approval required | Policy block or strict error |
| --- | --- | --- | --- |
| Claude Code | No permission override | `ask` | `deny` |
| Codex | No permission override | `deny` with full approval details | `deny` |
| Cursor | Neutral `{}` | `deny` with full approval details | `deny` |
| GitHub Copilot CLI | No permission override | `ask` | `deny` |
| GitHub Copilot for VS Code | No permission override | `ask` | `deny` |
| GitHub Copilot cloud agent | No permission override | `deny` with full approval details | `deny` |

Core `allow` means only that no cost rule matched. It never grants automatic
host permission.

## Claude Code

Copy `examples/claude-code/settings.json` to `.claude/settings.json`, or merge
its `hooks` object into existing project settings.

The hook runs for every tool so structured provider and MCP tool names can also
be inspected. A no-match emits no permission decision, leaving Claude Code's
normal permissions in control. A cost match asks the user, and a policy block
denies the tool call.

Test the adapter without running the inspected command:

```bash
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"terraform apply"}}' \
  | ./node_modules/.bin/agent-cost-guard hook claude-code --strict
```

Expected result: host JSON containing `permissionDecision: "ask"`.

The Code tab in the Claude desktop app uses Claude Code's project settings and
hooks, so the same `.claude/settings.json` integration applies there. Regular
Claude Chat is a different surface and does not load this project hook.

## Codex

Copy `examples/codex/hooks.json` to `.codex/hooks.json`. Review and trust the
project hook through Codex's `/hooks` view before relying on it.

Codex currently parses `ask` but does not support it as an interactive
PreToolUse outcome. The adapter therefore denies both cost matches and policy
blocks. A cost denial contains the full redacted approval details so the user
can review the provider, resource, billing model, and price uncertainty. Codex
will continue to deny the same proposed action because this guard stores no
approval state and the host cannot ask interactively. After explicit approval,
the person must run the reviewed command outside the hooked Codex tool path or
use a separate user-controlled execution flow.

Test the adapter without running the inspected command:

```bash
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"terraform apply"}}' \
  | ./node_modules/.bin/agent-cost-guard hook codex --strict
```

Expected result: Codex PreToolUse JSON containing
`permissionDecision: "deny"`.

Codex hooks cover supported local function and command paths. Hosted tools are
not included, and specialized tool paths can opt out of hook processing. This
integration therefore cannot claim universal interception. See the official
[Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).

## Cursor

Copy `examples/cursor/hooks.json` to `.cursor/hooks.json` in a trusted
workspace. The example sets `failClosed: true`, which makes hook errors block
instead of falling through.

Cursor does not currently enforce `ask` for `preToolUse`. The adapter returns
neutral `{}` when no cost rule matches and `permission: "deny"` for cost
matches, policy blocks, malformed supported input, and internal errors. Cost
denials include the complete redacted approval details.

Test the adapter without running the inspected command:

```bash
printf '%s' '{"tool_name":"Shell","tool_input":{"command":"terraform apply","cwd":"/project"}}' \
  | ./node_modules/.bin/agent-cost-guard hook cursor --strict
```

Expected result: Cursor JSON containing `permission: "deny"`.

Cursor also has a current, staff-confirmed
[fast-exit hook race](https://forum.cursor.com/t/race-condition-silently-disables-hooks-that-exit-quickly/165818/7)
in which hook stdout, including a deny result, can be missed. `failClosed: true`
protects hook failures but does not eliminate that host-side race. Do not treat
Cursor integration as an absolute billing boundary until Cursor fixes it. The
packaged executable follows Cursor's current workaround by keeping the hook
process alive for 60 milliseconds after writing its response; this reduces but
does not eliminate the race. Cursor cloud agents also skip project hooks during
their initial read-only exploration; cost-bearing tool calls remain within the
later hooked phase. See the official
[Cursor hooks documentation](https://cursor.com/docs/hooks).

## GitHub Copilot CLI

Copy `examples/github-copilot/copilot-cli.json` to a JSON file under
`.github/hooks/` in the consuming repository.

The configuration invokes the local package for both Unix and PowerShell hook
runners. Interactive cost matches return `ask`.

Install only the Copilot example for the host being used. Copilot CLI and VS
Code both scan `.github/hooks/*.json`; keeping both examples active would run
the guard twice with different output formats.

Test the adapter with Copilot's JSON-string `toolArgs` form:

```bash
printf '%s' '{"toolName":"bash","toolArgs":"{\"command\":\"terraform apply\"}"}' \
  | ./node_modules/.bin/agent-cost-guard hook copilot --mode interactive --strict
```

## GitHub Copilot for VS Code

VS Code agent hooks are currently a Preview feature. Copy
`examples/github-copilot/copilot-vscode.json` to a JSON file under
`.github/hooks/` and use it instead of the Copilot CLI example.

VS Code sends terminal actions as `runTerminalCommand` and requires decisions
inside `hookSpecificOutput`. The `vscode` adapter mode handles both details.
Cost matches ask the user; policy blocks deny the proposed tool call.

Test that adapter without running the inspected command:

```bash
printf '%s' '{"tool_name":"runTerminalCommand","tool_input":{"command":"terraform apply"}}' \
  | ./node_modules/.bin/agent-cost-guard hook copilot --mode vscode --strict
```

Expected result: VS Code hook JSON containing nested
`permissionDecision: "ask"`. In VS Code, hook execution details are also
available in the `GitHub Copilot Chat Hooks` output channel.

## GitHub Copilot cloud agent

Use `examples/github-copilot/copilot-cloud.json`. Commit both the hook file and
the package dependency to the consuming repository. Its
[Copilot setup workflow](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment)
at `.github/workflows/copilot-setup-steps.yml` must install dependencies before
agent tool use. The relevant job can stay small:

```yaml
jobs:
  copilot-setup-steps:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 20
          cache: npm
      - run: npm ci
```

The cloud agent has no person who can answer a prompt, so
`approval-required` is emitted as `deny` with the full cost-confirmation
message. GitHub documents command-hook errors as fail-closed for `preToolUse`,
but hook timeouts as fail-open. Keep the packaged 10-second timeout and this
local dependency path so normal inspection completes well inside that limit.

Do not use `npx --yes` in a policy hook. That would introduce a runtime network
dependency and could run a package version that was not reviewed with the
repository.

## Generic CLI and CI

Inspect a proposed shell command:

```bash
./node_modules/.bin/agent-cost-guard inspect --json -- terraform apply saved.plan
```

Exit codes are stable:

- `0`: no cost rule matched;
- `2`: explicit cost approval is required;
- `3`: blocked by policy; and
- `64`: invalid CLI usage.

For structured tools and file changes, pass the documented inspection request
JSON through the generic JSON command described by `agent-cost-guard --help`.
The command reads data only; it never invokes the proposed tool.

Other agents, including Antigravity and future tools, can use this contract by
setting `source: "generic"` if they expose a before-tool hook or run through a
wrapper that can enforce the exit code. Map exit `0` to "no cost match" without
auto-approving the host action. Map exit `2` to an interactive prompt when the
host reliably supports one, otherwise deny it with the returned approval
details. Map exits `3` and `64` to deny. Without a pre-execution interception
point, compatibility is informational rather than enforceable.

## Safe verification

First verify the local package and every protocol adapter:

```bash
./node_modules/.bin/agent-cost-guard doctor
```

Then verify that each host actually loaded its project hook. Ask the agent to
run this harmless command exactly:

```bash
AGENT_COST_GUARD_DISABLED=1 true
```

Expected result: the host denies it and shows a reason that says a cost-guard
bypass was blocked. If the host runs it, the hook is not active. The command
has no cloud or filesystem side effect, even when the hook is missing.

The guard's local decision log confirms the same thing from its side:

```bash
./node_modules/.bin/agent-cost-guard report --since 10m
```

A `guard.bypass` block under that host's name shows that the hook ran. Hooks
on a remote runner, such as the GitHub Copilot cloud agent, write the log on
that runner instead. Set `AGENT_COST_GUARD_LOG=off` in the agent's environment
to stop logging; decisions do not change.

Do not run a real resource-creation command merely to test an integration. The
adapter examples pass proposed cloud commands as strings to the guard and do
not execute them.
