/**
 * Shared adapter helpers. Adapters translate a host hook protocol to and from
 * the core decision. They never turn core `allow` into host approval: an allow
 * produces either empty output or a valid neutral response so the host's own
 * permission flow stays in control.
 */

import { inspect, type InspectOptions } from '../core/classify.js';
import type { Decision, InspectionRequest, Source, ToolAction } from '../core/types.js';

export interface HookResult {
  stdout: string;
  exitCode: number;
}

export interface AdapterOptions {
  /** Strict mode blocks on malformed/unsupported input instead of deferring. */
  strict?: boolean;
  /** Injectable rule set for tests. */
  inspectOptions?: InspectOptions;
  /**
   * Observer for the core decision, used by the CLI's local decision log.
   * Anything it throws is ignored, so it can never change the host response.
   */
  onDecision?: (request: InspectionRequest, decision: Decision) => void;
}

/** Build a structured tool action from an untrusted name/arguments pair. */
export function toToolAction(name: unknown, args: unknown): ToolAction | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  let candidate = args;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const arg = candidate as Record<string, unknown>;
  return { kind: 'tool', name, arguments: arg };
}

/** Parse untrusted stdin JSON into an object, or null when unusable. */
export function parseHookInput(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Run inspection for an adapter given a resolved tool action. */
export function inspectTool(
  source: Source,
  mode: InspectionRequest['mode'],
  action: ToolAction,
  options: AdapterOptions,
): Decision {
  const request: InspectionRequest = { source, mode, action };
  const inspectOptions: InspectOptions = { ...options.inspectOptions };
  if (options.strict !== undefined) inspectOptions.strict = options.strict;
  const decision = inspect(request, inspectOptions);
  try {
    options.onDecision?.(request, decision);
  } catch {
    // Observers are best effort; the decision stands.
  }
  return decision;
}
