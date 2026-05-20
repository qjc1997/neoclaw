#!/usr/bin/env bun
/**
 * Summarize ~/.neoclaw/logs/cost.jsonl.
 *
 * Usage:
 *   bun scripts/cost-summary.ts                       # all-time, grouped by gateway
 *   bun scripts/cost-summary.ts --since 2026-06-15    # since a date (filters by UTC)
 *   bun scripts/cost-summary.ts --since 2026-06-15 --until 2026-07-14
 *   bun scripts/cost-summary.ts --gateway feishu      # filter by gateway
 *   bun scripts/cost-summary.ts --by date             # group by date
 *   bun scripts/cost-summary.ts --by conversation     # group by conversationId
 *   bun scripts/cost-summary.ts --by model            # group by model
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COST_LOG = join(homedir(), '.neoclaw', 'logs', 'cost.jsonl');

interface Row {
  ts: string;
  conversationId: string;
  gatewayKind: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number;
  elapsedMs: number | null;
}

type GroupBy = 'gateway' | 'date' | 'conversation' | 'model';

interface Args {
  since: Date | null;
  until: Date | null;
  gateway: string | null;
  groupBy: GroupBy;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = { since: null, until: null, gateway: null, groupBy: 'gateway' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--since' && v) {
      out.since = new Date(v + 'T00:00:00Z');
      i++;
    } else if (a === '--until' && v) {
      out.until = new Date(v + 'T23:59:59Z');
      i++;
    } else if (a === '--gateway' && v) {
      out.gateway = v;
      i++;
    } else if (a === '--by' && v) {
      if (v === 'gateway' || v === 'date' || v === 'conversation' || v === 'model') {
        out.groupBy = v;
      } else {
        console.error(`unknown --by value: ${v}. valid: gateway | date | conversation | model`);
        process.exit(1);
      }
      i++;
    } else if (a === '-h' || a === '--help') {
      console.log(__filename);
      console.log(
        'flags: --since YYYY-MM-DD  --until YYYY-MM-DD  --gateway <name>  --by gateway|date|conversation|model'
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function main(): void {
  const args = parseArgs();

  if (!existsSync(COST_LOG)) {
    console.error(`no cost log at ${COST_LOG}`);
    console.error('(it gets created on the first agent turn after this code is shipped)');
    process.exit(1);
  }

  const lines = readFileSync(COST_LOG, 'utf8').split('\n').filter(Boolean);
  const rows: Row[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as Row;
      if (typeof r.costUsd !== 'number') continue;
      const t = new Date(r.ts);
      if (args.since && t < args.since) continue;
      if (args.until && t > args.until) continue;
      if (args.gateway && r.gatewayKind !== args.gateway) continue;
      rows.push(r);
    } catch {
      // skip malformed
    }
  }

  if (rows.length === 0) {
    console.log('no rows matched.');
    return;
  }

  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalIn = rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const firstTs = rows[0]?.ts ?? '';
  const lastTs = rows[rows.length - 1]?.ts ?? '';

  console.log('=== Cost Summary ===');
  console.log(`Range:        ${firstTs}`);
  console.log(`              ${lastTs}`);
  console.log(`Turns:        ${rows.length}`);
  console.log(`Total cost:   ${fmtUsd(totalCost)}`);
  console.log(`Tokens in:    ${totalIn.toLocaleString()}`);
  console.log(`Tokens out:   ${totalOut.toLocaleString()}`);
  console.log();

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    let k: string;
    if (args.groupBy === 'gateway') k = r.gatewayKind;
    else if (args.groupBy === 'date') k = r.ts.slice(0, 10);
    else if (args.groupBy === 'conversation') k = r.conversationId;
    else k = r.model ?? '(no model)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const sorted = [...groups.entries()].sort((a, b) => {
    const aCost = a[1].reduce((s, r) => s + r.costUsd, 0);
    const bCost = b[1].reduce((s, r) => s + r.costUsd, 0);
    return bCost - aCost;
  });

  console.log(`By ${args.groupBy}:`);
  for (const [k, grp] of sorted) {
    const cost = grp.reduce((s, r) => s + r.costUsd, 0);
    const pct = ((cost / totalCost) * 100).toFixed(1);
    const keyDisplay = k.length > 40 ? k.slice(0, 37) + '...' : k;
    console.log(
      `  ${keyDisplay.padEnd(40)}  ${fmtUsd(cost).padStart(10)}  (${pct.padStart(5)}%, ${String(grp.length).padStart(4)} turns)`
    );
  }
}

main();
