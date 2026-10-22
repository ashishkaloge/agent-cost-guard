/**
 * Normalize an action into inspectable units.
 *
 * Routing reads untrusted argument shapes only. It never executes a tool or
 * expands shell text. Recognized actions that cannot be fully inspected return
 * an explicit issue so strict callers can fail closed.
 */

import { parseShell, parseShellArgv, type ParsedCommand } from './tokenize.js';
import type {
  Action,
  FileChangeAction,
  InspectionIssue,
  ToolAction,
} from './types.js';

export type Unit =
  | { kind: 'shell'; cmd: ParsedCommand }
  | { kind: 'tool'; action: ToolAction }
  | { kind: 'file-change'; action: FileChangeAction };

export interface NormalizationResult {
  units: Unit[];
  complete: boolean;
  issues: InspectionIssue[];
}

/** Tool names whose arguments carry a shell command to inspect. */
const SHELL_TOOLS = new Set([
  'bash',
  'sh',
  'shell',
  'run',
  'run_command',
  'run_shell_command',
  'runcommand',
  'runterminalcommand',
  'execute',
  'exec',
  'command',
  'terminal',
  'powershell',
  'pwsh',
]);

/** Tool names that write or edit files (possibly Terraform). */
const FILE_TOOLS = new Set([
  'write',
  'create',
  'create_file',
  'createfile',
  'edit',
  'multiedit',
  'str_replace',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'apply_patch',
  'applypatch',
  'fs_write',
  'update_file',
]);

/** Argument keys that carry the command of a shell tool call. */
const SHELL_COMMAND_KEYS = ['command', 'cmd', 'script', 'input', 'commandLine'];

const TERRAFORM_SUFFIXES = ['.tf', '.tf.json', '.tofu'];

function issue(code: string, message: string): InspectionIssue {
  return { code, message };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isTerraformPath(path: string): boolean {
  const lower = path.toLowerCase();
  return TERRAFORM_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function addedText(record: Record<string, unknown>): string | undefined {
  return firstString(record, [
    'content',
    'text',
    'new_string',
    'new_str',
    'file_text',
    'contents',
  ]);
}

function fileUnit(path: string, text: string): Unit {
  return {
    kind: 'file-change',
    action: { kind: 'file-change', path, addedText: text },
  };
}

function terraformJsonIssue(path: string, text: string): InspectionIssue | undefined {
  if (!path.toLowerCase().endsWith('.tf.json') || text.trim().length === 0) return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch {
    return issue(
      'file-change.terraform-json-incomplete',
      'The added Terraform JSON text was not a complete JSON document.',
    );
  }
}

interface PatchResult {
  recognized: boolean;
  changes: Array<{ path: string; addedText: string }>;
}

function cleanDiffPath(path: string): string {
  const trimmed = path.trim().replace(/^"|"$/g, '');
  return /^(?:a|b)\//.test(trimmed) ? trimmed.slice(2) : trimmed;
}

/** Extract only literal added lines from apply_patch or unified-diff text. */
function parsePatch(patch: string): PatchResult {
  const additions = new Map<string, string[]>();
  let currentPath: string | null = null;
  let deleting = false;
  let recognized = false;

  const select = (path: string, isDelete = false): void => {
    currentPath = cleanDiffPath(path);
    deleting = isDelete || currentPath === '/dev/null';
    recognized = true;
    if (!deleting && currentPath.length > 0 && !additions.has(currentPath)) {
      additions.set(currentPath, []);
    }
  };

  for (const line of patch.split(/\r?\n/)) {
    const agentHeader = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (agentHeader) {
      select(agentHeader[2] as string, agentHeader[1] === 'Delete');
      continue;
    }

    if (line.startsWith('diff --git ')) {
      recognized = true;
      currentPath = null;
      deleting = false;
      continue;
    }

    const unifiedHeader = /^\+\+\+\s+([^\t]+)(?:\t.*)?$/.exec(line);
    if (unifiedHeader) {
      select(unifiedHeader[1] as string);
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (currentPath && !deleting && line.startsWith('+')) {
      additions.get(currentPath)?.push(line.slice(1));
    }
  }

  return {
    recognized,
    changes: [...additions].map(([path, lines]) => ({ path, addedText: lines.join('\n') })),
  };
}

function normalizePatch(args: Record<string, unknown>): NormalizationResult {
  const patch = firstString(args, ['patch', 'patch_text', 'diff', 'input', 'command']);
  if (patch === undefined) {
    return {
      units: [],
      complete: false,
      issues: [issue('tool.patch-missing', 'The apply_patch tool did not contain patch text.')],
    };
  }

  const parsed = parsePatch(patch);
  if (!parsed.recognized) {
    return {
      units: [],
      complete: false,
      issues: [issue('tool.patch-uninspectable', 'The apply_patch text did not identify changed files.')],
    };
  }

  const relevant = parsed.changes.filter((change) => isTerraformPath(change.path));
  const issues = relevant
    .map((change) => terraformJsonIssue(change.path, change.addedText))
    .filter((entry): entry is InspectionIssue => entry !== undefined);
  return {
    units: relevant.map((change) => fileUnit(change.path, change.addedText)),
    complete: issues.length === 0,
    issues,
  };
}

function normalizeFileTool(name: string, args: Record<string, unknown>): NormalizationResult {
  if (name === 'apply_patch' || name === 'applypatch') return normalizePatch(args);

  const topPath = firstString(args, ['file_path', 'path', 'filename', 'filePath', 'file']);
  const edits = args.edits;
  const changes: Array<{ path: string; text: string }> = [];
  const issues: InspectionIssue[] = [];

  if (Array.isArray(edits)) {
    for (const rawEdit of edits) {
      if (rawEdit === null || typeof rawEdit !== 'object' || Array.isArray(rawEdit)) {
        issues.push(issue('tool.edit-uninspectable', 'A file edit did not use an inspectable object shape.'));
        continue;
      }
      const edit = rawEdit as Record<string, unknown>;
      const path = firstString(edit, ['file_path', 'path', 'filename', 'filePath', 'file']) ?? topPath;
      if (path === undefined) {
        issues.push(issue('tool.file-path-missing', 'A file edit did not identify its target path.'));
        continue;
      }
      if (!isTerraformPath(path)) continue;
      const text = addedText(edit);
      if (text === undefined) {
        issues.push(issue('tool.added-text-missing', 'A Terraform edit did not identify added text.'));
        continue;
      }
      changes.push({ path, text });
    }
  } else {
    if (topPath === undefined) {
      return {
        units: [],
        complete: false,
        issues: [issue('tool.file-path-missing', 'The file tool did not identify its target path.')],
      };
    }
    if (!isTerraformPath(topPath)) return { units: [], complete: true, issues: [] };
    const text = addedText(args);
    if (text === undefined) {
      return {
        units: [],
        complete: false,
        issues: [issue('tool.added-text-missing', 'The Terraform file tool did not identify added text.')],
      };
    }
    changes.push({ path: topPath, text });
  }

  for (const change of changes) {
    const jsonIssue = terraformJsonIssue(change.path, change.text);
    if (jsonIssue) issues.push(jsonIssue);
  }

  return {
    units: changes.map((change) => fileUnit(change.path, change.text)),
    complete: issues.length === 0,
    issues,
  };
}

function routeTool(action: ToolAction): NormalizationResult {
  const name = action.name.toLowerCase();
  const args = action.arguments;

  if (SHELL_TOOLS.has(name)) {
    const command = firstString(args, SHELL_COMMAND_KEYS);
    if (command === undefined) {
      return {
        units: [],
        complete: false,
        issues: [issue('tool.shell-command-missing', 'The shell tool did not contain a string command.')],
      };
    }
    const parsed = parseShell(command);
    return {
      units: parsed.commands.map((cmd) => ({ kind: 'shell', cmd })),
      complete: parsed.complete,
      issues: parsed.issues.map((code) =>
        issue(code, 'The shell command contained an incomplete or unsupported lexical form.'),
      ),
    };
  }

  if (FILE_TOOLS.has(name)) return normalizeFileTool(name, args);

  return { units: [{ kind: 'tool', action }], complete: true, issues: [] };
}

function normalizeFileChange(action: FileChangeAction): NormalizationResult {
  if (isTerraformPath(action.path) && action.addedText === undefined) {
    return {
      units: [{ kind: 'file-change', action }],
      complete: false,
      issues: [
        issue(
          'file-change.additions-unknown',
          'The Terraform change did not distinguish added text from full changed text.',
        ),
      ],
    };
  }
  if (action.addedText !== undefined) {
    const jsonIssue = terraformJsonIssue(action.path, action.addedText);
    if (jsonIssue) {
      return {
        units: [{ kind: 'file-change', action }],
        complete: false,
        issues: [jsonIssue],
      };
    }
  }
  return { units: [{ kind: 'file-change', action }], complete: true, issues: [] };
}

/** The raw command text of a shell tool call, or undefined for any other tool. */
export function toolShellCommand(action: ToolAction): string | undefined {
  if (!SHELL_TOOLS.has(action.name.toLowerCase())) return undefined;
  return firstString(action.arguments, SHELL_COMMAND_KEYS);
}

/** Normalize any action and retain whether inspection was complete. */
export function normalize(action: Action): NormalizationResult {
  switch (action.kind) {
    case 'shell': {
      if (action.argv) {
        const parsed = parseShellArgv(action.argv);
        return {
          units: parsed.commands.map((cmd) => ({ kind: 'shell', cmd })),
          complete: parsed.complete,
          issues: parsed.issues.map((code) =>
            issue(code, 'The shell command contained an incomplete or unsupported lexical form.'),
          ),
        };
      }
      const parsed = parseShell(action.command);
      return {
        units: parsed.commands.map((cmd) => ({ kind: 'shell', cmd })),
        complete: parsed.complete,
        issues: parsed.issues.map((code) =>
          issue(code, 'The shell command contained an incomplete or unsupported lexical form.'),
        ),
      };
    }
    case 'file-change':
      return normalizeFileChange(action);
    case 'tool':
      return routeTool(action);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
