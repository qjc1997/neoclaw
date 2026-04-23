/**
 * Dispatcher — routes inbound messages to the active Agent.
 *
 * Responsibilities:
 * - Register Gateways and Agents
 * - Start/stop all gateways
 * - Serialize per-conversation message handling (prevent race conditions)
 * - Manage conversation sessions (stable session IDs for multi-turn context)
 * - Handle built-in slash commands (/clear, /status, /restart, /stop, /help)
 */

import { appendFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent, AgentStreamEvent, RunRequest, RunResponse } from './agents/types.js';
import type {
  Gateway,
  InboundMessage,
  MessageHandler,
  ReplyFn,
  StreamHandler,
} from './gateway/types.js';
import type { CodeReviewConfig } from './config.js';
import { readReviewTarget, REVIEW_TARGET_FILE, runCodeReview, validateExternalTarget } from './hooks/code-review.js';
import type { MemoryManager } from './memory/manager.js';
import { SpeechProcessor } from './speech/index.js';
import type { SpeechConfig } from './speech/index.js';
import { buildContextWarning } from './utils/context.js';
import { logger } from './utils/logger.js';
import { Mutex } from './utils/mutex.js';

const log = logger('dispatcher');

// ── Dispatcher ────────────────────────────────────────────────

/** Callback invoked when the /restart command is received. */
export type RestartCallback = (info: { chatId: string; gatewayKind: string }) => void;

export class Dispatcher {
  private _agents = new Map<string, Agent>();
  private _defaultAgentKind = 'claude_code';
  private _gateways: Gateway[] = [];
  /** Per-conversation serial queues to prevent concurrent handling. */
  private _queues = new Map<string, Mutex>();
  /**
   * Per-conversation serial queues for code reviews. Separate from `_queues`
   * because auto-reviews run fire-and-forget outside the main handler lock;
   * without this, concurrent reviews on the same workspace race on git index.
   */
  private _reviewQueues = new Map<string, Mutex>();
  private _workspacesDir: string | null = null;
  private _memoryManager: MemoryManager | null = null;
  private _onRestart: RestartCallback | null = null;
  private _speechProcessor: SpeechProcessor | null = null;
  private _codeReviewConfig: CodeReviewConfig | null = null;

  // ── Registration ──────────────────────────────────────────

  addAgent(agent: Agent): void {
    this._agents.set(agent.kind, agent);
    log.info(`Agent registered: "${agent.kind}"`);
  }

  addGateway(gateway: Gateway): void {
    this._gateways.push(gateway);
    log.info(`Gateway registered: "${gateway.kind}"`);
  }

  setDefaultAgent(kind: string): void {
    this._defaultAgentKind = kind;
    log.info(`Default agent set: "${kind}"`);
  }

  setWorkspacesDir(dir: string): void {
    this._workspacesDir = dir;
    log.info(`Workspaces base set: "${dir}"`);
  }

  /** Inject memory manager for session summarization on /clear and /new. */
  setMemoryManager(mgr: MemoryManager): void {
    this._memoryManager = mgr;
    log.info('Memory manager set');
  }

  /** Register a callback for when the /restart command is received. */
  onRestart(cb: RestartCallback): void {
    this._onRestart = cb;
    log.info('Restart callback set');
  }

  /** Configure speech processing for audio attachments. */
  setSpeechConfig(config: SpeechConfig): void {
    this._speechProcessor = new SpeechProcessor(config);
    log.info(`Speech processor configured: backend=${config.backend}`);
  }

  /**
   * Configure code review. Makes `/review` available and — if `enabled` —
   * auto-triggers a review after each non-command response.
   */
  setCodeReviewConfig(config: CodeReviewConfig): void {
    this._codeReviewConfig = config;
    log.info(
      `Code review configured: enabled=${config.enabled} model=${config.model ?? 'haiku'}`
    );
  }

  // ── Handler (passed to gateways) ──────────────────────────

  readonly handle: MessageHandler = async (
    msg: InboundMessage,
    reply: ReplyFn,
    streamHandler?: StreamHandler
  ): Promise<void> => {
    const key = this._conversationKey(msg);
    log.info(`Handling message for conversation key: ${key}`);

    // Fast-path: /stop must bypass the per-conversation mutex, otherwise it
    // would queue up behind the very stream it's trying to abort.
    const earlyCmd = this._tryParseCommand(msg.text);
    if (earlyCmd?.name === 'stop') {
      const agent = this._getAgent();
      const aborted = agent.cancel ? await agent.cancel(key) : false;
      const replyText = aborted
        ? '⛔️ Stopped the current response. Next message will continue the conversation if possible.'
        : 'Nothing to stop — no active response.';
      await reply({ text: replyText });
      this._appendHistory(key, 'user', msg.text);
      this._appendHistory(key, 'neoclaw', replyText);
      return;
    }

    const queue = this._getQueue(key);
    await queue.acquire();

    try {
      let responseText = '';

      // Slash commands are always non-streaming
      const command = this._tryParseCommand(msg.text);
      if (command) {
        log.info(`Executing command: ${command.name}${command.args ? ' ' + command.args : ''}`);
        const response = await this._execCommand(command, msg, key);
        responseText = response.text;
        await reply(response);
      } else {
        // Process audio attachments through speech backend if configured
        let processedText = msg.text;
        if (this._speechProcessor && msg.attachments?.some((a) => a.mediaType === 'audio')) {
          const audioAttachments = msg.attachments.filter((a) => a.mediaType === 'audio');
          const results = await Promise.allSettled(
            audioAttachments.map((a) => this._speechProcessor!.process(a.buffer))
          );
          for (const result of results) {
            if (result.status === 'fulfilled') {
              processedText += `\n\n${SpeechProcessor.formatResult(result.value)}`;
              log.info(`Audio processed: "${result.value.transcript.slice(0, 80)}..."`);
            } else {
              const err = result.reason;
              log.error(`Speech processing failed: ${err}`);
              processedText += `\n\n[Speech processing error: ${err instanceof Error ? err.message : String(err)}]`;
            }
          }
        }

        const agent = this._getAgent();
        const request: RunRequest = {
          text: processedText,
          conversationId: key,
          chatId: msg.chatId,
          gatewayKind: msg.gatewayKind,
          attachments: msg.attachments,
        };

        if (streamHandler && agent.stream) {
          // Streaming path: gateway renders content progressively
          const agentStream = agent.stream(request);
          async function* tracked(): AsyncGenerator<AgentStreamEvent> {
            for await (let event of agentStream) {
              if (event.type === 'done') {
                const warning = buildContextWarning(event.response.inputTokens, event.response.contextWindow, event.response.model);
                if (warning) {
                  event = {
                    ...event,
                    response: { ...event.response, text: event.response.text + warning },
                  };
                  log.warn(`Context usage ${event.response.inputTokens} tokens exceeds threshold for "${key}"`);
                }
                responseText = event.response.text;
              }
              yield event;
            }
          }
          await streamHandler(tracked());
        } else {
          // Non-streaming fallback
          const response = await agent.run(request);
          const warning = buildContextWarning(response.inputTokens, response.contextWindow, response.model);
          if (warning) {
            response.text += warning;
            log.warn(`Context usage ${response.inputTokens} tokens exceeds threshold for "${key}"`);
          }
          responseText = response.text;
          await reply(response);
        }
      }

      log.info(`Response text: "${responseText}"`);
      this._appendHistory(key, 'user', msg.text);
      this._appendHistory(key, 'neoclaw', responseText);

      // Auto-trigger code review for non-command messages (fire-and-forget)
      if (!command && this._codeReviewConfig?.enabled) {
        this._triggerReview(key, msg.chatId, msg.gatewayKind).catch((err) =>
          log.warn(`Auto code review failed: ${err}`)
        );
      }
    } finally {
      queue.release();
    }
  };

  /** Run code review on the workspace and send result to the originating chat. */
  private async _triggerReview(
    conversationKey: string,
    chatId: string,
    gatewayKind: string
  ): Promise<void> {
    const cfg = this._codeReviewConfig;
    if (!cfg) return;
    const workspaceDir = this._workspaceDirFor(conversationKey);
    if (!workspaceDir) {
      log.warn('Cannot run code review: no workspace dir configured');
      return;
    }
    const result = await this._runReviewSerial(conversationKey, workspaceDir, cfg);
    if (!result) return; // no changes
    const header = this._reviewHeader(result.filesChanged.length, result.targetDir, workspaceDir);
    await this.sendTo(gatewayKind, chatId, { text: header + result.reviewText });
  }

  /** Format the header of a review message, noting the target when external. */
  private _reviewHeader(fileCount: number, targetDir: string, workspaceDir: string): string {
    const plural = fileCount === 1 ? '' : 's';
    const targetNote = targetDir === workspaceDir ? '' : ` · target: \`${targetDir}\``;
    return `**📝 Code Review** (${fileCount} file${plural} changed${targetNote})\n\n`;
  }

  /**
   * Handle `/review target …` subcommands: show, set, or clear the external
   * review target pointer stored at `<workspace>/.review-target`.
   */
  private _handleReviewTarget(workspaceDir: string, arg: string): RunResponse {
    if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
    const targetFile = join(workspaceDir, REVIEW_TARGET_FILE);

    if (!arg) {
      const current = readReviewTarget(workspaceDir);
      if (!current) {
        return {
          text:
            '**Review target**: (default — reviews this workspace itself)\n\n' +
            'Usage:\n' +
            '- `/review target <absolute_path>` — point review at an external git repo\n' +
            '- `/review target clear` — restore default',
        };
      }
      return { text: `**Review target**: \`${current}\`` };
    }

    if (arg === 'clear') {
      if (existsSync(targetFile)) unlinkSync(targetFile);
      return { text: 'Review target cleared. Reviews will now scan this workspace itself.' };
    }

    try {
      validateExternalTarget(arg);
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) };
    }
    writeFileSync(
      targetFile,
      `# neoclaw review target — absolute path to a git repo\n${arg}\n`,
      'utf-8'
    );
    return {
      text: `Review target set to \`${arg}\`. Next \`/review\` (or auto-review) will scan uncommitted changes there via \`git diff HEAD\`.`,
    };
  }

  /**
   * Run `runCodeReview` under a per-conversation mutex so concurrent reviews
   * on the same workspace don't race on the git index.
   */
  private async _runReviewSerial(
    conversationKey: string,
    workspaceDir: string,
    cfg: CodeReviewConfig
  ): Promise<Awaited<ReturnType<typeof runCodeReview>>> {
    let mutex = this._reviewQueues.get(conversationKey);
    if (!mutex) {
      mutex = new Mutex();
      this._reviewQueues.set(conversationKey, mutex);
    }
    await mutex.acquire();
    try {
      return await runCodeReview({
        workspaceDir,
        model: cfg.model ?? 'haiku',
        timeoutSecs: cfg.timeoutSecs ?? 180,
      });
    } finally {
      mutex.release();
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._agents.size === 0) throw new Error('No agents registered');
    if (this._gateways.length === 0) throw new Error('No gateways registered');

    await Promise.all(this._gateways.map((gw) => gw.start(this.handle)));
  }

  async stop(): Promise<void> {
    for (const gw of this._gateways) {
      await gw.stop().catch((e) => log.warn(`Gateway "${gw.kind}" stop error: ${e}`));
    }
    for (const agent of this._agents.values()) {
      await agent.dispose().catch((e) => log.warn(`Agent "${agent.kind}" dispose error: ${e}`));
    }
  }

  /**
   * Hot-reload: dispose old agents and swap internals without touching gateways.
   * Gateways keep the same `handle` reference and automatically use the new agent.
   */
  async reload(opts: {
    agent: Agent;
    defaultAgentKind?: string;
    workspacesDir?: string;
    memoryManager?: MemoryManager;
    speechConfig?: SpeechConfig;
    codeReviewConfig?: CodeReviewConfig;
  }): Promise<void> {
    for (const agent of this._agents.values()) {
      await agent.dispose().catch((e) => log.warn(`Agent dispose during reload: ${e}`));
    }
    this._agents.clear();
    this.addAgent(opts.agent);
    if (opts.defaultAgentKind) this._defaultAgentKind = opts.defaultAgentKind;
    if (opts.workspacesDir) this._workspacesDir = opts.workspacesDir;
    if (opts.memoryManager) this._memoryManager = opts.memoryManager;
    if (opts.speechConfig) this.setSpeechConfig(opts.speechConfig);
    this._codeReviewConfig = opts.codeReviewConfig ?? null;
    log.info('Dispatcher reloaded');
  }

  /** Proactively send a message to a gateway (e.g. restart notifications). */
  async sendTo(gatewayKind: string, chatId: string, response: RunResponse): Promise<void> {
    const gateway = this._gateways.find((g) => g.kind === gatewayKind);
    if (!gateway) {
      log.warn(`sendTo: gateway "${gatewayKind}" not found`);
      return;
    }
    await gateway.send(chatId, response);
    log.info(
      `Message sent to gateway "${gatewayKind}" proactively, chatId="${chatId}" response="${response.text}"`
    );
  }

  // ── Internals ──────────────────────────────────────────────

  private _conversationKey(msg: InboundMessage): string {
    // Thread messages get an isolated session to avoid polluting the main chat context
    if (msg.threadRootId) return `${msg.chatId}_thread_${msg.threadRootId}`;
    return msg.chatId;
  }

  /** Resolve the filesystem workspace directory for a conversation key. */
  private _workspaceDirFor(conversationKey: string): string | null {
    if (!this._workspacesDir) return null;
    const sanitized = conversationKey.replace(/:/g, '_');
    return join(this._workspacesDir, sanitized);
  }

  private _getQueue(key: string): Mutex {
    let q = this._queues.get(key);
    if (!q) {
      q = new Mutex();
      this._queues.set(key, q);
    }
    return q;
  }

  private _getAgent(): Agent {
    const agent = this._agents.get(this._defaultAgentKind);
    if (!agent) {
      const available = [...this._agents.keys()].join(', ');
      throw new Error(`Agent "${this._defaultAgentKind}" not registered. Available: ${available}`);
    }
    return agent;
  }

  // ── Built-in slash commands ──────────────────────────────

  private static readonly COMMANDS = new Set(['clear', 'new', 'status', 'restart', 'help', 'model', 'compress', 'review', 'stop']);

  private _tryParseCommand(text: string): { name: string; args: string } | null {
    let trimmed = text.trim();
    // Strip sender prefix (e.g. "ou_xxx: /model opus" → "/model opus") added by gateways in group chats
    const prefixMatch = trimmed.match(/^[a-zA-Z0-9_]+:\s*/);
    if (prefixMatch && !trimmed.startsWith('/')) {
      trimmed = trimmed.slice(prefixMatch[0].length);
    }
    if (!trimmed.startsWith('/')) return null;
    // Strip trailing @mention text (e.g. "/model @_user_1" → "/model")
    trimmed = trimmed.replace(/@_user_\d+/g, '').trim();
    const end = trimmed.indexOf(' ');
    const name = (end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)).toLowerCase();
    const args = end === -1 ? '' : trimmed.slice(end + 1).trim();
    return Dispatcher.COMMANDS.has(name) ? { name, args } : null;
  }

  private async _execCommand(
    { name, args }: { name: string; args: string },
    msg: InboundMessage,
    key: string
  ): Promise<RunResponse> {
    const isThread = key !== msg.chatId;

    switch (name) {
      case 'clear':
      case 'new': {
        // Generate session summary before clearing (best-effort, non-blocking on failure)
        if (this._memoryManager && this._workspacesDir) {
          await this._memoryManager
            .summarizeSession(key, this._workspacesDir)
            .catch((err) => log.warn(`Failed to summarize session: ${err}`));
        }
        const agent = this._getAgent();
        await agent.clearConversation(key);
        return { text: 'Context cleared, ready for a new conversation.' };
      }

      case 'restart': {
        if (this._onRestart) {
          // Delay slightly so reply() is called before the restart fires
          setTimeout(
            () => this._onRestart!({ chatId: msg.chatId, gatewayKind: msg.gatewayKind }),
            5_000
          );
        }
        return { text: 'Restarting NeoClaw, please wait...' };
      }

      case 'status': {
        const agent = this._getAgent();
        const agents = [...this._agents.keys()].join(', ');
        const gateways = this._gateways.map((g) => g.kind).join(', ');
        const model = agent.getModel ? (agent.getModel(key) ?? 'default') : 'unknown';
        const lines = [
          '**NeoClaw Status**',
          `- Context: ${isThread ? 'Thread (isolated)' : 'Main chat'}`,
          `- Model: ${model}`,
          `- Agents: ${agents}`,
          `- Gateways: ${gateways}`,
        ];
        return { text: lines.join('\n') };
      }

      case 'model': {
        const agent = this._getAgent();
        if (!agent.setModel || !agent.getModel) {
          return { text: 'Model override is not supported by the current agent.' };
        }
        if (!args) {
          const current = agent.getModel(key) ?? 'default';
          return {
            text: [
              `Current model: **${current}**`,
              '',
              'Aliases:',
              '- `sonnet` — latest Claude Sonnet (fast, balanced)',
              '- `opus` — latest Claude Opus 4.7 (most capable)',
              '- `haiku` — latest Claude Haiku (fastest, lightweight)',
              '',
              'You can also pass a full model ID, e.g. `claude-opus-4-7` or `claude-sonnet-4-6`.',
              '',
              'Usage: `/model <name|id>` to change, `/model reset` to use default.',
            ].join('\n'),
          };
        }
        if (args === 'reset' || args === 'default') {
          await agent.setModel(key, null);
          return { text: 'Model reset to default. Takes effect on next message.' };
        }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(args)) {
          return {
            text: `Invalid model **${args}**. Use an alias (\`sonnet\`, \`opus\`, \`haiku\`) or a full model ID like \`claude-opus-4-7\`.`,
          };
        }
        await agent.setModel(key, args);
        return { text: `Model set to **${args}** for this conversation. Takes effect on next message.` };
      }

      case 'compress': {
        // 1. Summarize current session into episodic memory
        let summaryNote = '';
        if (this._memoryManager && this._workspacesDir) {
          try {
            await this._memoryManager.summarizeSession(key, this._workspacesDir);
            summaryNote = 'Session summary saved. ';
          } catch (err) {
            log.warn(`Failed to summarize session during compress: ${err}`);
            summaryNote = 'Summary failed, but context will still be cleared. ';
          }
        }
        // 2. Clear conversation (terminate subprocess, drop session ID)
        const compressAgent = this._getAgent();
        await compressAgent.clearConversation(key);
        return { text: `${summaryNote}Context compressed and cleared, ready for a new conversation.` };
      }

      case 'review': {
        if (!this._codeReviewConfig) {
          return { text: 'Code review is not configured. Set `codeReview` in config.json to enable.' };
        }
        const workspaceDir = this._workspaceDirFor(key);
        if (!workspaceDir) {
          return { text: 'Code review unavailable: no workspace directory configured.' };
        }
        // `/review target …` — manage the external review target pointer
        if (args.startsWith('target')) {
          return this._handleReviewTarget(workspaceDir, args.slice('target'.length).trim());
        }
        try {
          const result = await this._runReviewSerial(key, workspaceDir, this._codeReviewConfig);
          if (!result) {
            return { text: 'No code changes since last review.' };
          }
          const header = this._reviewHeader(result.filesChanged.length, result.targetDir, workspaceDir);
          return { text: header + result.reviewText };
        } catch (err) {
          log.error(`/review failed: ${err}`);
          return { text: `Code review failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case 'help': {
        const lines = [
          '**Available Commands**',
          '- `/clear` or `/new` — Start a fresh conversation',
          '- `/compress` — Summarize and compress the current session',
          '- `/stop` — Abort the current streaming response (preserves session; next message resumes)',
          '- `/model [name]` — Show or change the model for this conversation',
          '- `/review` — Review code changes (workspace by default, or the target set via `/review target <path>`)',
          '- `/review target` — Show / set / clear the review target directory',
          '- `/status` — Show current session and system info',
          '- `/restart` — Restart the NeoClaw daemon',
          '- `/help` — Show this help message',
        ];
        return { text: lines.join('\n') };
      }

      default:
        return { text: `Unknown command: /${name}` };
    }
  }

  // ── Conversation history ──────────────────────────────────

  private _appendHistory(conversationKey: string, role: 'user' | 'neoclaw', text: string): void {
    if (!this._workspacesDir) return;
    const sanitized = conversationKey.replace(/:/g, '_');
    const historyDir = join(this._workspacesDir, sanitized, '.neoclaw', '.history');
    try {
      if (!existsSync(historyDir)) mkdirSync(historyDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      appendFileSync(join(historyDir, `${date}.txt`), `[${role}] ${text}\n\n`, 'utf-8');
    } catch (err) {
      log.warn(`Failed to write conversation history: ${err}`);
    }
  }
}
