/**
 * NeoClaw Daemon — manages the process lifecycle.
 *
 * Responsibilities:
 * - PID file management (prevents duplicate instances)
 * - Signal handling (SIGTERM / SIGINT for graceful shutdown)
 * - Workspaces directory initialization
 * - Component assembly (Dispatcher + Agent + Gateway)
 * - Restart coordination (spawns new process, saves notification context)
 * - Startup notification (informs user after a /restart-triggered restart)
 *
 * Self-daemonizes on first launch (forks to background, redirects I/O to log file).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { NeoClawConfig } from './config.js';
import { NEOCLAW_HOME } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { ClaudeCodeAgent } from './agents/claude-code.js';
import { FeishuGateway } from './gateway/feishu/gateway.js';
import { CronScheduler } from './cron/scheduler.js';
import { setLogLevel, initFileLogs, logger } from './utils/logger.js';

const log = logger('daemon');

/** Build the system prompt section that describes the neoclaw-cron CLI to Claude. */
function buildCronCliSystemPrompt(): string {
  const binPath = join(NEOCLAW_HOME, 'bin', 'neoclaw-cron');
  return `\
## Cron Job Management

You can use \`${binPath}\` CLI tool to create and manage scheduled tasks.
When a cron job triggers, it will automatically send a message to you in the current session for you to execute.

### Create One-time Task:
${binPath} create --message "task description" --run-at "2024-03-01T09:00:00+08:00" [--label "task name"]

### Create Recurring Task:
${binPath} create --message "task description" --cron-expr "0 9 * * 1-5" [--label "task name"]
Cron expression format: minute hour day month weekday
Common examples:
  "0 9 * * 1-5"   — 09:00 on weekdays
  "0 */4 * * *"   — every 4 hours
  "30 8 * * *"    — 08:30 daily

### List Tasks:
${binPath} list                    # show only enabled tasks
${binPath} list --include-disabled # show all tasks (including disabled)

### Delete Task:
${binPath} delete --job-id <jobId>

### Update Task:
${binPath} update --job-id <jobId> [--label "new name"] [--message "new prompt"] [--enabled true|false]
${' '.repeat(binPath.length + 8)}[--run-at "new time"] [--cron-expr "new expression"]

All commands output JSON. The value of --message is the prompt that will be sent to you when the task triggers.`;
}

// Path where the restart notification is persisted between process generations
const RESTART_NOTIFY_PATH = join(NEOCLAW_HOME, 'cache', 'restart-notify.json');

export class NeoClawDaemon {
  private _abort = new AbortController();

  constructor(private readonly config: NeoClawConfig) {}

  // ── Main entry point ──────────────────────────────────────

  async run(): Promise<void> {
    // Self-daemonize: if this is the first launch (not the background child),
    // fork to background with I/O redirected to the log file, then exit.
    if (!process.env['NEOCLAW_DAEMON']) {
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: { ...process.env, NEOCLAW_DAEMON: '1' },
      });
      child.unref();
      console.log('[neoclaw] Daemon started in background. Logs:', join(NEOCLAW_HOME, 'logs'));
      process.exit(0);
    }

    // Enable daily-rotating file logging before anything else so that even
    // takeover / PID messages land in the right file.
    initFileLogs(join(NEOCLAW_HOME, 'logs'));
    setLogLevel(this.config.logLevel ?? 'info');
    this._takeover();
    this._writePid();
    this._registerSignals();
    this._ensureDirs();

    const dispatcher = this._buildDispatcher();
    const scheduler = new CronScheduler(dispatcher);

    log.info('='.repeat(60));
    log.info(`NeoClaw daemon starting — pid=${process.pid} agent=${this.config.agent.type}`);

    // Wait a few seconds for gateways to initialize before sending restart notification
    setTimeout(() => this._sendStartupNotification(dispatcher), 5000);

    try {
      scheduler.start();
      await Promise.race([
        dispatcher.start(),
        // Resolve when abort is signaled
        new Promise<never>((_, reject) => {
          this._abort.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        }),
      ]);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) throw err;
    } finally {
      scheduler.stop();
      await dispatcher.stop();
      log.info('NeoClaw daemon stopped.');
    }
  }

  // ── PID management ────────────────────────────────────────

  private _pidPath(): string {
    return join(NEOCLAW_HOME, 'cache', 'neoclaw.pid');
  }

  private _writePid(): void {
    const dir = dirname(this._pidPath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this._pidPath(), String(process.pid));
    log.info(`PID written: ${this._pidPath()} (pid=${process.pid})`);
  }

  private _removePid(): void {
    try {
      if (existsSync(this._pidPath())) unlinkSync(this._pidPath());
    } catch {
      /* ignore */
    }
  }

  /**
   * If an existing daemon is running, send SIGTERM and wait for it to exit
   * before this process claims the PID file.
   */
  private _takeover(): void {
    const pidPath = this._pidPath();
    if (!existsSync(pidPath)) return;

    let oldPid: number;
    try {
      oldPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      log.info(`Existing PID file found: ${pidPath} (pid=${oldPid})`);
    } catch {
      log.warn(`Failed to parse PID file: ${pidPath}`);
      this._removePid();
      return;
    }
    if (isNaN(oldPid)) {
      log.warn(`Invalid PID value in file: ${pidPath}`);
      this._removePid();
      return;
    }

    // Check if the old process is still running
    try {
      process.kill(oldPid, 0);
      log.info(`Old daemon (pid=${oldPid}) is still running.`);
    } catch {
      // Stale PID file
      log.warn(`Stale PID file found: ${pidPath} (pid=${oldPid})`);
      this._removePid();
      return;
    }

    // Gracefully terminate the old daemon
    try {
      log.info(`Existing daemon found (pid=${oldPid}), sending SIGTERM…`);
      process.kill(oldPid, 'SIGTERM');
    } catch {
      /* already gone */
      log.warn(`Failed to send SIGTERM to old daemon (pid=${oldPid})`);
    }

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(oldPid, 0);
        log.info(`Old daemon (pid=${oldPid}) is still running.`);
      } catch {
        log.info(`Old daemon (pid=${oldPid}) exited.`);
        this._removePid();
        return;
      }
      Bun.sleepSync(200);
    }

    try {
      log.info(`Sending SIGKILL to old daemon (pid=${oldPid})`);
      process.kill(oldPid, 'SIGKILL');
    } catch {
      /* ignore */
      log.warn(`Failed to send SIGKILL to old daemon (pid=${oldPid})`);
    }
    Bun.sleepSync(500);
    this._removePid();
  }

  // ── Signal handling ───────────────────────────────────────

  private _registerSignals(): void {
    const shutdown = (sig: string) => {
      log.info(`Received ${sig}, shutting down…`);
      this._abort.abort();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ── Directory setup ───────────────────────────────────────

  private _ensureDirs(): void {
    const dirs = [
      NEOCLAW_HOME,
      join(NEOCLAW_HOME, 'logs'),
      join(NEOCLAW_HOME, 'cache'),
      join(NEOCLAW_HOME, 'cron'),
      this.config.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    log.info(`Workspaces base: ${this.config.workspacesDir}`);
  }

  // ── Component assembly ────────────────────────────────────

  private _buildDispatcher(): Dispatcher {
    const dispatcher = new Dispatcher();

    // Build and register the agent
    const agentType = this.config.agent.type;
    if (agentType !== 'claude_code') {
      throw new Error(
        `Unknown agent type: "${agentType}". Currently only "claude_code" is supported.`
      );
    }

    // Merge base system prompt with cron CLI instructions before constructing the agent.
    const cronPrompt = buildCronCliSystemPrompt();
    const systemPrompt =
      [this.config.agent.systemPrompt, cronPrompt].filter(Boolean).join('\n\n') || undefined;

    const agent = new ClaudeCodeAgent({
      model: this.config.agent.model,
      allowedTools: this.config.agent.allowedTools,
      systemPrompt,
      cwd: this.config.workspacesDir,
    });
    dispatcher.addAgent(agent);
    dispatcher.setDefaultAgent('claude_code');
    dispatcher.setWorkspacesDir(this.config.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'));

    // Register Feishu gateway if credentials are present
    if (this.config.feishu.appId && this.config.feishu.appSecret) {
      const feishu = new FeishuGateway(this.config.feishu);
      dispatcher.addGateway(feishu);
    } else {
      log.warn('Feishu credentials not configured — gateway not started');
    }

    // Wire up restart handler
    dispatcher.onRestart((info) => this._triggerRestart(info));

    return dispatcher;
  }

  // ── Restart ───────────────────────────────────────────────

  private _triggerRestart(info: { chatId: string; gatewayKind: string }): void {
    log.info('Restart requested — forking new process…');

    // Persist notification context so the new process can inform the user
    this._saveRestartNotify(info);

    // Strip Claude Code env vars that would interfere with the child's agent
    const env = { ...process.env };
    delete env['CLAUDECODE'];

    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      env,
    });
    child.unref();

    // Gracefully shut down the current process
    this._abort.abort();
  }

  private _saveRestartNotify(info: { chatId: string; gatewayKind: string }): void {
    const dir = dirname(RESTART_NOTIFY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(RESTART_NOTIFY_PATH, JSON.stringify(info));
  }

  private async _sendStartupNotification(dispatcher: Dispatcher): Promise<void> {
    if (!existsSync(RESTART_NOTIFY_PATH)) return;

    let info: { chatId: string; gatewayKind: string };
    try {
      info = JSON.parse(readFileSync(RESTART_NOTIFY_PATH, 'utf-8'));
      unlinkSync(RESTART_NOTIFY_PATH);
      log.info(`Restart notify: gateway=${info.gatewayKind} chatId=${info.chatId}`);
    } catch (err) {
      log.warn(`Failed to read restart notification: ${err}`);
      if (existsSync(RESTART_NOTIFY_PATH)) unlinkSync(RESTART_NOTIFY_PATH);
      return;
    }

    const response = { text: 'NeoClaw restarted successfully!' };
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await dispatcher.sendTo(info.gatewayKind, info.chatId, response);
        log.info(`Startup notification delivered to ${info.gatewayKind}:${info.chatId}`);
        return;
      } catch (err) {
        log.warn(`Startup notification attempt ${attempt}/${maxAttempts} failed: ${err}`);
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000));
      }
    }
    log.error('Startup notification failed after all attempts.');
  }
}
