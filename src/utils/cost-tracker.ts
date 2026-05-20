/**
 * Per-turn cost tracker.
 *
 * Appends one JSONL record per agent turn to ~/.neoclaw/logs/cost.jsonl.
 * The cost value comes from `total_cost_usd` in claude CLI's stream-json
 * result event (Anthropic's own computation at standard API rates).
 *
 * Why this exists: from 2026-06-15 Anthropic separates programmatic usage
 * onto a metered credit pool. Anthropic's UI shows only percentage of
 * subscription used, not USD. Logging here gives us auditable, queryable
 * data that survives policy/UI changes.
 *
 * Query the log with `bun scripts/cost-summary.ts`.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logger } from './logger.js';

const log = logger('cost-tracker');

export const COST_LOG_PATH = join(homedir(), '.neoclaw', 'logs', 'cost.jsonl');

export interface CostRecord {
  conversationId: string;
  gatewayKind: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  elapsedMs: number | null;
}

/**
 * Append one cost record (one turn) to the cost log.
 *
 * Skips silently if costUsd is null (claude CLI didn't report cost — most
 * likely an error or cancellation path). Never throws: cost tracking must
 * not interrupt a live conversation.
 */
export function recordCost(rec: CostRecord): void {
  if (rec.costUsd === null) return;
  try {
    const dir = dirname(COST_LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const row = { ts: new Date().toISOString(), ...rec };
    appendFileSync(COST_LOG_PATH, JSON.stringify(row) + '\n');
  } catch (err) {
    log.warn(`Failed to record cost: ${err}`);
  }
}
