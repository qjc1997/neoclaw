/**
 * neoclaw-cron — CLI for managing NeoClaw cron jobs.
 *
 * Reads NEOCLAW_CHAT_ID and NEOCLAW_GATEWAY_KIND from environment variables,
 * which the daemon injects into the Claude Code subprocess at spawn time.
 *
 * Usage:
 *   neoclaw-cron create --message <msg> (--run-at <iso> | --cron-expr <expr>) [--label <label>]
 *   neoclaw-cron list [--include-disabled]
 *   neoclaw-cron delete --job-id <id>
 *   neoclaw-cron update --job-id <id> [--label <label>] [--message <msg>]
 *                                  [--run-at <iso>] [--cron-expr <expr>] [--enabled <true|false>]
 *
 * All commands output a single JSON object.
 */

import { randomUUID } from 'node:crypto';
import { saveJob, loadJob, deleteJob, listJobs } from '../cron/store.js';
import type { CronJob } from '../cron/types.js';

// ── Helpers ───────────────────────────────────────────────────

function out(obj: unknown): never {
  console.log(JSON.stringify(obj));
  process.exit(0);
}

function fail(msg: string): never {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

/** Minimal flag parser: --key value or --flag (boolean). */
function parseFlags(args: string[]): Record<string, string | true> {
  const result: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      result[key] = next;
      i++;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function str(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v.trim() : undefined;
}

// ── Context from env ──────────────────────────────────────────

const chatId = process.env['NEOCLAW_CHAT_ID'] ?? '';
const gatewayKind = process.env['NEOCLAW_GATEWAY_KIND'] ?? '';

// ── Dispatch ──────────────────────────────────────────────────

const [, , subcommand, ...rest] = process.argv;

if (!subcommand) {
  fail('Usage: neoclaw-cron <create|list|delete|update> [options]');
}

switch (subcommand) {
  // ── create ───────────────────────────────────────────────

  case 'create': {
    if (!chatId || !gatewayKind)
      fail('NEOCLAW_CHAT_ID and NEOCLAW_GATEWAY_KIND env vars are not set');

    const flags = parseFlags(rest);
    const message = str(flags, 'message');
    const label = str(flags, 'label');
    const runAt = str(flags, 'run-at');
    const cronExpr = str(flags, 'cron-expr');

    if (!message) fail('--message is required');
    if (!runAt && !cronExpr) fail('one of --run-at or --cron-expr is required');
    if (runAt && cronExpr) fail('--run-at and --cron-expr are mutually exclusive');

    if (runAt) {
      const d = new Date(runAt);
      if (isNaN(d.getTime())) fail(`invalid datetime: "${runAt}"`);
    }

    const job: CronJob = {
      id: randomUUID(),
      label,
      message,
      chatId,
      gatewayKind,
      conversationId: chatId,
      runAt,
      cronExpr,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    saveJob(job);
    out({ ok: true, jobId: job.id, label: job.label, runAt, cronExpr });
  }

  // ── list ─────────────────────────────────────────────────

  case 'list': {
    const flags = parseFlags(rest);
    const includeDisabled = flags['include-disabled'] === true;
    let jobs = listJobs();
    if (chatId) jobs = jobs.filter((j) => j.chatId === chatId);
    if (!includeDisabled) jobs = jobs.filter((j) => j.enabled);
    out({
      ok: true,
      count: jobs.length,
      jobs: jobs.map((j) => ({
        jobId: j.id,
        label: j.label,
        message: j.message,
        runAt: j.runAt,
        cronExpr: j.cronExpr,
        enabled: j.enabled,
        createdAt: j.createdAt,
        lastRunAt: j.lastRunAt,
      })),
    });
  }

  // ── delete ───────────────────────────────────────────────

  case 'delete': {
    const flags = parseFlags(rest);
    const jobId = str(flags, 'job-id');
    if (!jobId) fail('--job-id is required');

    const job = loadJob(jobId);
    if (!job) fail(`job "${jobId}" not found`);
    if (chatId && job.chatId !== chatId) fail('permission denied: job belongs to a different chat');

    deleteJob(jobId);
    out({ ok: true, jobId });
  }

  // ── update ───────────────────────────────────────────────

  case 'update': {
    const flags = parseFlags(rest);
    const jobId = str(flags, 'job-id');
    if (!jobId) fail('--job-id is required');

    const job = loadJob(jobId);
    if (!job) fail(`job "${jobId}" not found`);
    if (chatId && job.chatId !== chatId) fail('permission denied: job belongs to a different chat');

    const label = str(flags, 'label');
    const message = str(flags, 'message');
    const runAt = str(flags, 'run-at');
    const cronExpr = str(flags, 'cron-expr');
    const enabledStr = str(flags, 'enabled');

    if (label !== undefined) job.label = label;
    if (message !== undefined) job.message = message;
    if (enabledStr !== undefined) job.enabled = enabledStr === 'true';
    if (runAt !== undefined) {
      const d = new Date(runAt);
      if (isNaN(d.getTime())) fail(`invalid datetime: "${runAt}"`);
      job.runAt = runAt;
      job.cronExpr = undefined; // switch to one-time
    }
    if (cronExpr !== undefined) {
      job.cronExpr = cronExpr;
      job.runAt = undefined; // switch to recurring
    }

    saveJob(job);
    out({ ok: true, jobId, label: job.label, enabled: job.enabled });
  }

  default:
    fail(`Unknown subcommand: "${subcommand}". Use: create, list, delete, update`);
}
