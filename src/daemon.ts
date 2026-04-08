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

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ClaudeCodeAgent } from './agents/claude-code.js';
import type { NeoClawConfig } from './config.js';
import { loadConfig, NEOCLAW_HOME } from './config.js';
import { CronScheduler } from './cron/scheduler.js';
import { Dispatcher } from './dispatcher.js';
import { FeishuGateway } from './gateway/feishu/gateway.js';
import { MemoryManager } from './memory/manager.js';
import { MemoryStore } from './memory/store.js';
import { initFileLogs, logger, setLogLevel } from './utils/logger.js';

const log = logger('daemon');

/** Build the system prompt section that describes the neoclaw-cron CLI to Claude. */
function buildCronCliSystemPrompt(): string {
  const bin = join(NEOCLAW_HOME, 'bin', 'neoclaw-cron');
  return `\
## Cron Job Management

Use \`${bin}\` to manage scheduled tasks. When a job triggers, its --message is sent to you in the current session.

### Commands
\`\`\`bash
# One-time task
${bin} create --message "prompt" --run-at "2024-03-01T09:00:00+08:00" [--label "name"]

# Recurring task (cron format: min hour day month weekday)
${bin} create --message "prompt" --cron-expr "0 9 * * 1-5" [--label "name"]

# List / delete / update
${bin} list [--include-disabled]
${bin} delete --job-id <id>
${bin} update --job-id <id> [--label ".."] [--message ".."] [--enabled true|false] [--run-at ".."] [--cron-expr ".."]
\`\`\`

All commands output JSON.`;
}

// Path where the restart notification is persisted between process generations
const RESTART_NOTIFY_PATH = join(NEOCLAW_HOME, 'cache', 'restart-notify.json');

export class NeoClawDaemon {
  private _abort = new AbortController();
  private _memoryManager: MemoryManager | null = null;
  private _memoryStore: MemoryStore | null = null;
  private _dispatcher: Dispatcher | null = null;

  constructor(private config: NeoClawConfig) {}

  // ── Main entry point ──────────────────────────────────────

  async run(): Promise<void> {
    // Self-daemonize: if this is the first launch (not the background child),
    // fork to background with I/O redirected to the log file, then exit.
    if (!process.env['NEOCLAW_DAEMON']) {
      // Save the real Bun binary path before daemonizing — inside the spawned
      // child, process.execPath may resolve to a temporary bun-node shim that
      // can disappear across restarts.
      const child = spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: { ...process.env, NEOCLAW_DAEMON: '1', NEOCLAW_BUN_PATH: process.execPath },
      });
      child.unref();
      console.log('NeoClaw daemon started in background. Logs:', join(NEOCLAW_HOME, 'logs'));
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

    this._dispatcher = await this._buildDispatcher();
    const scheduler = new CronScheduler(this._dispatcher);

    log.info('='.repeat(60));
    log.info(`NeoClaw daemon starting — pid=${process.pid}`);

    // Wait a few seconds for gateways to initialize before sending restart notification
    setTimeout(() => this._sendStartupNotification(this._dispatcher!), 5000);

    try {
      scheduler.start();
      this._memoryManager?.startPeriodicReindex();
      await Promise.race([
        this._dispatcher.start(),
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
      this._memoryManager?.stopPeriodicReindex();
      scheduler.stop();
      await this._dispatcher.stop();
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
      log.info(`PID file removed: ${this._pidPath()}`);
    } catch {
      /* ignore */
      log.warn(`Failed to remove PID file: ${this._pidPath()}`);
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
      log.info(`Existing daemon found (pid=${oldPid}), sending SIGTERM...`);
      process.kill(oldPid, 'SIGTERM');
    } catch {
      /* already gone */
      log.warn(`Failed to send SIGTERM to old daemon (pid=${oldPid})`);
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        process.kill(oldPid, 0);
        log.info(`Old daemon (pid=${oldPid}) is still running.`);
      } catch {
        log.info(`Old daemon (pid=${oldPid}) exited.`);
        this._removePid();
        return;
      }
      Bun.sleepSync(1000);
    }

    try {
      log.info(`Sending SIGKILL to old daemon (pid=${oldPid})`);
      process.kill(oldPid, 'SIGKILL');
    } catch {
      /* ignore */
      log.warn(`Failed to send SIGKILL to old daemon (pid=${oldPid})`);
    }

    Bun.sleepSync(1000);
    this._removePid();
  }

  // ── Signal handling ───────────────────────────────────────

  private _registerSignals(): void {
    const shutdown = (sig: string) => {
      log.info(`Received ${sig}, shutting down...`);
      this._abort.abort();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  // ── Directory setup ───────────────────────────────────────

  private _ensureDirs(): void {
    const dirs = [
      NEOCLAW_HOME,
      join(NEOCLAW_HOME, 'bin'),
      join(NEOCLAW_HOME, 'cache'),
      join(NEOCLAW_HOME, 'cron'),
      join(NEOCLAW_HOME, 'logs'),
      join(NEOCLAW_HOME, 'memory'),
      join(NEOCLAW_HOME, 'memory', 'episodes'),
      join(NEOCLAW_HOME, 'memory', 'knowledge'),
      this.config.skillsDir ?? join(NEOCLAW_HOME, 'skills'),
      this.config.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    log.info(`Needed directories created: ${dirs.join(', ')}`);
  }

  // ── Component assembly ────────────────────────────────────

  private async _buildDispatcher(): Promise<Dispatcher> {
    const dispatcher = new Dispatcher();

    // Build and register the agent
    const agentType = this.config.agent.type;
    if (agentType !== 'claude_code') {
      log.error(`Unknown agent type: "${agentType}". Currently only "claude_code" is supported.`);
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
      modelOverrides: this.config.agent.modelOverrides,
      allowedTools: this.config.agent.allowedTools,
      systemPrompt,
      cwd: this.config.workspacesDir,
      mcpServers: this.config.mcpServers,
      skillsDir: this.config.skillsDir,
    });

    // Initialize memory system (used for session summarization and periodic reindex)
    const memoryDir = join(NEOCLAW_HOME, 'memory');
    this._memoryStore = new MemoryStore(join(memoryDir, 'index.sqlite'));
    const memoryManager = new MemoryManager(memoryDir, this._memoryStore);
    memoryManager.reindex();
    this._memoryManager = memoryManager;

    dispatcher.addAgent(agent);
    dispatcher.setDefaultAgent('claude_code');
    dispatcher.setWorkspacesDir(this.config.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'));
    dispatcher.setMemoryManager(memoryManager);
    if (this.config.speech) {
      dispatcher.setSpeechConfig(this.config.speech);
    }

    // Register Feishu gateway if credentials are present
    if (this.config.feishu.appId && this.config.feishu.appSecret) {
      const feishu = new FeishuGateway(this.config.feishu);
      dispatcher.addGateway(feishu);
      log.info('Feishu gateway registered');
    } else {
      log.warn('Feishu credentials not configured — Feishu gateway not started');
    }

    // Register Wework gateway if credentials are present
    if (this.config.wework?.botId && this.config.wework?.secret) {
      const { WeworkWsGateway } = await import('./gateway/wework/ws-gateway.js');
      const weworkConfig = {
        botId: this.config.wework.botId,
        secret: this.config.wework.secret,
        websocketUrl: this.config.wework.websocketUrl,
      };
      const wework = new WeworkWsGateway(weworkConfig);
      dispatcher.addGateway(wework);
      log.info('Wework WebSocket gateway registered');
    } else {
      log.warn('Wework WebSocket credentials not configured — Wework gateway not started');
    }

    // Ensure at least one gateway is configured
    // Only error if both gateways are missing credentials
    if (
      (!this.config.feishu.appId || !this.config.feishu.appSecret) &&
      (!this.config.wework?.botId || !this.config.wework?.secret)
    ) {
      log.error('No gateway credentials configured — at least one of Feishu or Wework must be configured');
      throw new Error(
        'No gateway credentials configured — at least one of Feishu or Wework must be configured'
      );
    }

    // Wire up restart handler
    dispatcher.onRestart((info) => this._triggerRestart(info));

    return dispatcher;
  }

  // ── Restart ───────────────────────────────────────────────

  private _triggerRestart(info: { chatId: string; gatewayKind: string }): void {
    this._softRestart(info).catch((err) => {
      log.error(`Soft restart failed: ${err}, falling back to hard restart`);
      this._hardRestart(info);
    });
  }

  /**
   * Soft restart: reload config, agent, and memory while keeping gateway
   * WebSocket connections alive. No new OS process is spawned.
   */
  private async _softRestart(info: { chatId: string; gatewayKind: string }): Promise<void> {
    log.info('Soft restart requested — reloading config and agents...');

    // 1. Fresh config from disk
    const newConfig = loadConfig();

    // 2. Update log level
    setLogLevel(newConfig.logLevel ?? 'info');

    // 3. Build cron system prompt and create new agent
    const cronPrompt = buildCronCliSystemPrompt();
    const systemPrompt =
      [newConfig.agent.systemPrompt, cronPrompt].filter(Boolean).join('\n\n') || undefined;

    const agent = new ClaudeCodeAgent({
      model: newConfig.agent.model,
      modelOverrides: newConfig.agent.modelOverrides,
      allowedTools: newConfig.agent.allowedTools,
      systemPrompt,
      cwd: newConfig.workspacesDir,
      mcpServers: newConfig.mcpServers,
      skillsDir: newConfig.skillsDir,
    });

    // 4. Stop old memory system
    this._memoryManager?.stopPeriodicReindex();
    this._memoryStore?.close();

    // 5. Create new memory system
    const memoryDir = join(NEOCLAW_HOME, 'memory');
    this._memoryStore = new MemoryStore(join(memoryDir, 'index.sqlite'));
    const memoryManager = new MemoryManager(memoryDir, this._memoryStore);
    memoryManager.reindex();
    this._memoryManager = memoryManager;

    // 6. Reload dispatcher (disposes old agents, swaps in new ones)
    await this._dispatcher!.reload({
      agent,
      defaultAgentKind: 'claude_code',
      workspacesDir: newConfig.workspacesDir ?? join(NEOCLAW_HOME, 'workspaces'),
      memoryManager,
      speechConfig: newConfig.speech,
    });

    // 7. Start new periodic reindex
    this._memoryManager.startPeriodicReindex();

    // 8. Update stored config
    this.config = newConfig;

    log.info('Soft restart complete');

    // 9. Notify user
    await this._dispatcher!.sendTo(info.gatewayKind, info.chatId, {
      text: 'NeoClaw soft-restarted successfully! (config & agents reloaded, WebSocket kept alive)',
    });
  }

  private _hardRestart(info: { chatId: string; gatewayKind: string }): void {
    log.info('Hard restart requested — forking new process...');

    // Persist notification context so the new process can inform the user
    this._saveRestartNotify(info);

    // Use the real Bun binary saved during initial daemonization — process.execPath
    // inside the daemon may point to a temporary bun-node compatibility shim.
    const execPath = process.env['NEOCLAW_BUN_PATH'] || process.execPath;
    const args = process.argv.slice(1);

    // Strip Claude Code env vars that would interfere with the child's agent
    const env = { ...process.env };
    delete env['CLAUDECODE'];

    log.info(`Spawning: ${execPath} ${args.join(' ')} (cwd=${process.cwd()})`);

    try {
      const child = spawn(execPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env,
      });
      child.on('error', (err) => log.error(`Restart child process error: ${err}`));
      child.unref();
    } catch (err) {
      log.error(`Failed to spawn restart process: ${err}`);
      return;
    }

    // Gracefully shut down the current process
    this._abort.abort();
  }

  private _saveRestartNotify(info: { chatId: string; gatewayKind: string }): void {
    const dir = dirname(RESTART_NOTIFY_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(RESTART_NOTIFY_PATH, JSON.stringify(info));
    log.info(`Restart notify saved: ${RESTART_NOTIFY_PATH}`);
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
