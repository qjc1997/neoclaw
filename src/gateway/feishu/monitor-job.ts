/**
 * monitor-job.ts — Lightweight background process for tracking long-running tasks.
 *
 * Spawned by feishu_monitor_job MCP tool. Runs independently of Claude Code,
 * consuming zero LLM tokens. Reads a log file and sends Feishu messages directly.
 *
 * Usage (internal, spawned by mcp-server.ts):
 *   bun run monitor-job.ts \
 *     --log-file /tmp/bench.log \
 *     --chat-id oc_xxx \
 *     --app-id cli_xxx \
 *     --app-secret xxx \
 *     [--done-pattern "All done|exit"] \
 *     [--progress-pattern "\\d+/\\d+"] \
 *     [--interval 120] \
 *     [--max-hours 12] \
 *     [--domain feishu] \
 *     [--job-label "benchmark run"]
 */

import { existsSync, readFileSync, statSync } from 'node:fs';

// ── Parse CLI args ───────────────────────────────────────────

function arg(name: string, def?: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  if (def !== undefined) return def;
  throw new Error(`Missing required argument: --${name}`);
}

const logFile = arg('log-file');
const chatId = arg('chat-id');
const appId = arg('app-id');
const appSecret = arg('app-secret');
const donePattern = new RegExp(arg('done-pattern', 'DONE|FINISHED|ERROR|Traceback|exit code'), 'i');
const progressPattern = arg('progress-pattern', '');
const intervalSec = parseInt(arg('interval', '120'), 10);
const maxHours = parseFloat(arg('max-hours', '12'));
const domain = arg('domain', 'feishu');
const jobLabel = arg('job-label', logFile);

const baseUrl = domain === 'lark'
  ? 'https://open.larksuite.com'
  : 'https://open.feishu.cn';

const startedAt = Date.now();
const maxMs = maxHours * 3600 * 1000;

// ── Feishu API helpers ───────────────────────────────────────

async function getToken(): Promise<string> {
  const res = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json() as { code: number; tenant_access_token?: string };
  if (json.code !== 0 || !json.tenant_access_token) throw new Error('Token fetch failed');
  return json.tenant_access_token;
}

function receiveIdType(id: string): string {
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('ou_')) return 'open_id';
  return 'user_id';
}

async function sendMessage(text: string): Promise<void> {
  try {
    const token = await getToken();
    await fetch(
      `${baseUrl}/open-apis/im/v1/messages?receive_id_type=${receiveIdType(chatId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      }
    );
  } catch (err) {
    console.error(`[monitor-job] sendMessage failed: ${err}`);
  }
}

// ── Log reading ──────────────────────────────────────────────

function readTail(file: string, bytes = 4000): string {
  if (!existsSync(file)) return '';
  try {
    const size = statSync(file).size;
    if (size === 0) return '';
    const buf = Buffer.alloc(Math.min(bytes, size));
    const fd = require('node:fs').openSync(file, 'r');
    require('node:fs').readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    require('node:fs').closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return readFileSync(file, 'utf-8').slice(-bytes);
  }
}

// ── Main loop ────────────────────────────────────────────────

let lastProgressMsg = '';
let checkCount = 0;

async function check(): Promise<boolean> {
  checkCount++;
  const tail = readTail(logFile);
  if (!tail) return false;

  const elapsed = Math.round((Date.now() - startedAt) / 1000 / 60);

  // Check for completion
  if (donePattern.test(tail)) {
    const lastLines = tail.split('\n').filter(Boolean).slice(-8).join('\n');
    await sendMessage(
      `✅ **[${jobLabel}] 任务结束** (运行 ${elapsed} 分钟)\n\n` +
      `\`\`\`\n${lastLines}\n\`\`\``
    );
    return true; // signal done
  }

  // Progress update (only if pattern provided and content changed)
  if (progressPattern) {
    const re = new RegExp(progressPattern);
    const matches = tail.match(re);
    if (matches) {
      const msg = matches[0];
      if (msg !== lastProgressMsg) {
        lastProgressMsg = msg;
        await sendMessage(`⏳ **[${jobLabel}]** ${msg}  _(+${elapsed}min)_`);
      }
    }
  }

  return false;
}

async function main() {
  await sendMessage(`🚀 **[${jobLabel}] 开始监控** — 每 ${intervalSec}s 检查一次，最长 ${maxHours}h`);

  while (true) {
    const done = await check();
    if (done) break;

    if (Date.now() - startedAt > maxMs) {
      await sendMessage(`⏰ **[${jobLabel}] 监控超时** (${maxHours}h)，请手动检查 \`${logFile}\``);
      break;
    }

    await new Promise(r => setTimeout(r, intervalSec * 1000));
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[monitor-job] fatal:', err);
  process.exit(1);
});
