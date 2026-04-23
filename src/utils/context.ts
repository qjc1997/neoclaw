/**
 * Context window utilities — model-specific limits and usage helpers.
 */

/**
 * Fallback model context window limits (in tokens) when backend doesn't report contextWindow.
 * Opus/Sonnet 4.6+ default to 1M (auto-enabled via [1m] suffix in CLI args).
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-0': 200_000,
  'claude-haiku-4-5': 200_000,
};

const DEFAULT_CONTEXT_LIMIT = 200_000;

/** Ratio of context usage at which a warning is triggered. */
export const WARNING_RATIO = 0.7;

/**
 * Resolve the context window limit.
 * Prefers the value reported by the backend; falls back to static model mapping.
 */
export function resolveContextLimit(
  contextWindow: number | null | undefined,
  model: string | null | undefined
): number {
  if (contextWindow != null && contextWindow > 0) return contextWindow;
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  if (model in MODEL_CONTEXT_LIMITS) return MODEL_CONTEXT_LIMITS[model]!;
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(key)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Calculate context usage percentage (0–100).
 */
export function contextUsagePercent(
  inputTokens: number | null | undefined,
  contextWindow: number | null | undefined,
  model: string | null | undefined
): number | null {
  if (inputTokens == null) return null;
  const limit = resolveContextLimit(contextWindow, model);
  return Math.round((inputTokens / limit) * 100);
}

/**
 * Build a context warning message if usage exceeds the warning threshold.
 * Returns null if no warning is needed.
 */
export function buildContextWarning(
  inputTokens: number | null | undefined,
  contextWindow: number | null | undefined,
  model: string | null | undefined
): string | null {
  if (inputTokens == null) return null;
  const limit = resolveContextLimit(contextWindow, model);
  if (inputTokens < limit * WARNING_RATIO) return null;
  const pct = Math.round((inputTokens / limit) * 100);
  return `\n\n---\n⚠️ **上下文使用量已达 ${pct}%（${inputTokens.toLocaleString()}/${limit.toLocaleString()} tokens），建议尽快使用 \`/compress\` 压缩会话。**`;
}
