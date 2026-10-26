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

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
import { isBackendErrorText } from './utils/backend-errors.js';
import { buildContextWarning } from './utils/context.js';
import { recordCost } from './utils/cost-tracker.js';
import { createDebouncedFlush } from './utils/debounced-flush.js';
import { logger } from './utils/logger.js';
import { Mutex } from './utils/mutex.js';

const log = logger('dispatcher');

/**
 * Tools that mutate files. Used to detect whether a streaming turn actually
 * touched code — purely conversational/read-only turns are skipped by the
 * auto code-review trigger to avoid noise.
 */
const FILE_MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Extract the filesystem path from a file-mutating tool's input, if any. */
function extractMutatedFile(name: string, input: unknown): string | null {
  if (!FILE_MUTATING_TOOLS.has(name)) return null;
  if (typeof input !== 'object' || input === null) return null;
  const i = input as Record<string, unknown>;
  // Edit / Write / MultiEdit use file_path; NotebookEdit uses notebook_path
  const path = i['file_path'] ?? i['notebook_path'];
  return typeof path === 'string' ? path : null;
}

// ── English coach helper ──────────────────────────────────────

/**
 * Strip bot @mention suffixes (e.g. "@_user_1") and sender prefixes
 * (e.g. "ou_xxx: ") from a message before sending to the English coach.
 */
function _stripMentions(text: string): string {
  return text
    .replace(/@_user_\d+/g, '')   // strip @_user_1 style mentions
    .replace(/^[a-zA-Z0-9_]+:\s*/, '') // strip "ou_xxx: " sender prefix
    .trim();
}

const _isCjk = (c: string): boolean => {
  const cp = c.codePointAt(0) ?? 0;
  return (cp >= 0x4e00 && cp <= 0x9fff)   // CJK Unified Ideographs
      || (cp >= 0x3400 && cp <= 0x4dbf)   // CJK Extension A
      || (cp >= 0x20000 && cp <= 0x2a6df); // CJK Extension B
};

/**
 * Drop tokens that are language-neutral — URLs, file paths, identifiers like
 * `notion-daily-log-rules` or `{date, notion_url}` — so they don't swamp the
 * language ratio. A Chinese instruction full of paths is still Chinese.
 */
function _proseOnly(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[~.]?\/[^\s，。、；：）)]+/g, ' ')        // paths
    .replace(/\{[^}]*\}|`[^`]*`/g, ' ')               // {…} and `code`
    .replace(/\b[\w]+[-_.][\w.-]*\b/g, ' ');           // kebab/snake/dotted ids
}

/**
 * Returns true if the message looks like natural English prose worth coaching:
 * - At least 20 non-whitespace characters
 * - At least 8 alphabetic characters (filters out code/file paths/URLs/numbers)
 * - >80% of non-whitespace chars are ASCII (rules out Chinese/Japanese/Korean)
 * - Does not look like a file path or shell command (no leading / or ~/)
 * - Contains at least 3 words
 */
function _looksLikeEnglish(text: string): boolean {
  const clean = _stripMentions(text);
  if (clean.startsWith('/') || clean.startsWith('~/') || clean.startsWith('http')) return false;
  const words = clean.trim().split(/\s+/);
  if (words.length < 3) return false;
  const stripped = clean.replace(/\s+/g, '');
  if (stripped.length < 20) return false;
  const alphaCount = (clean.match(/[a-zA-Z]/g) ?? []).length;
  if (alphaCount < 8) return false;
  // Any real Chinese means it isn't English prose (paths/ids can push the
  // ASCII ratio of a Chinese instruction past 90%).
  if ([...stripped].filter(_isCjk).length >= 2) return false;
  const asciiCount = [...stripped].filter((c) => c.charCodeAt(0) < 128).length;
  return asciiCount / stripped.length > 0.8;
}

/**
 * Returns true if the message is predominantly Chinese (CJK characters):
 * - At least 6 CJK characters
 * - >40% of non-whitespace chars are CJK
 * - Does not look like a command or URL
 */
function _looksLikeChinese(text: string): boolean {
  const clean = _stripMentions(text);
  if (clean.startsWith('/') || clean.startsWith('http')) return false;
  const stripped = _proseOnly(clean).replace(/\s+/g, '');
  if (stripped.length < 6) return false;
  const cjkCount = [...stripped].filter(_isCjk).length;
  // Weigh by words, not chars: one CJK char ≈ one word ≈ ~4 Latin letters,
  // so English terms mixed into a Chinese sentence don't outvote it.
  const latinWords = (stripped.match(/[a-zA-Z]/g) ?? []).length / 4;
  return cjkCount >= 6 && cjkCount / (cjkCount + latinWords) > 0.4;
}

// ── Dispatcher ────────────────────────────────────────────────

/** Callback invoked when the /restart command is received. */
export type RestartCallback = (info: { chatId: string; gatewayKind: string }) => void;

type PendingMessage = {
  msg: InboundMessage;
  reply: ReplyFn;
  streamHandler?: StreamHandler;
};

export class Dispatcher {

  private _agentOverrides = new Map<string, string>();
  private _flushAgentOverrides = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this._agentOverrides);
      writeFileSync(join(dir, 'agent-overrides.json'), JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn(`Failed to flush agent overrides: ${err}`);
    }
  }, 2000);

  /**
   * chatIds where the English coach is explicitly disabled.
   * Feature is ON by default; this set tracks opt-outs.
   * Persisted to ~/.neoclaw/cache/english-coach-disabled.json.
   */
  private _englishCoachDisabled = new Set<string>();
  private _flushEnglishCoach = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'english-coach-disabled.json'),
        JSON.stringify([...this._englishCoachDisabled], null, 2)
      );
    } catch (err) {
      log.warn(`Failed to flush english coach state: ${err}`);
    }
  }, 2000);

  constructor() {
    try {
      const path = join(homedir(), '.neoclaw', 'cache', 'agent-overrides.json');
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        for (const [k, v] of Object.entries(data)) {
          this._agentOverrides.set(k, v as string);
        }
      }
    } catch {}
    try {
      const path = join(homedir(), '.neoclaw', 'cache', 'english-coach-disabled.json');
      if (existsSync(path)) {
        const list = JSON.parse(readFileSync(path, 'utf-8')) as string[];
        for (const id of list) this._englishCoachDisabled.add(id);
      }
    } catch {}
    try {
      const path = join(homedir(), '.neoclaw', 'cache', 'cleared-chats.json');
      if (existsSync(path)) {
        const list = JSON.parse(readFileSync(path, 'utf-8')) as string[];
        for (const id of list) this._clearedChats.add(id);
      }
    } catch {}
  }
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
  /**
   * Messages that arrived while a turn was already in-flight for that
   * conversation. Drained (in arrival order) by the in-flight turn before it
   * releases the queue mutex, so each gets its own response without any gap
   * where an unrelated message could slip in between.
   */
  private _pendingMessages = new Map<string, PendingMessage[]>();
  private _workspacesDir: string | null = null;
  private _memoryManager: MemoryManager | null = null;
  private _onRestart: RestartCallback | null = null;
  private _speechProcessor: SpeechProcessor | null = null;
  private _codeReviewConfig: CodeReviewConfig | null = null;
  /**
   * Feishu group chatIds that were just /clear-ed and are waiting for their
   * first message to trigger an auto-rename based on the Q&A content.
   * Persisted to ~/.neoclaw/cache/cleared-chats.json — the first message after
   * a /clear can arrive days later, across daemon restarts.
   */
  private _clearedChats = new Set<string>();
  private _flushClearedChats = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'cleared-chats.json'), JSON.stringify([...this._clearedChats], null, 2));
    } catch (err) {
      log.warn(`Failed to flush cleared chats: ${err}`);
    }
  }, 2000);

  // ── Registration ──────────────────────────────────────────

  addAgent(agent: Agent): void {
    this._agents.set(agent.kind, agent);
    agent.setUnsolicitedHandler?.(({ conversationId, chatId, gatewayKind, response }) => {
      this._appendHistory(conversationId, 'neoclaw', response.text);
      this.sendTo(gatewayKind, chatId, response).catch((err) =>
        log.warn(`Failed to deliver unsolicited output for "${conversationId}": ${err}`)
      );
    });
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
      const agent = this._getAgent(key);
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

    // Non-blocking check: if a turn is already in-flight for this conversation,
    // push to the pending queue and return immediately. The in-flight turn will
    // drain pending messages (in order) before releasing the mutex, ensuring
    // each gets its own response without any gap between them.
    if (!queue.tryAcquire()) {
      const pending = this._pendingMessages.get(key) ?? [];
      pending.push({ msg, reply, streamHandler });
      this._pendingMessages.set(key, pending);
      log.info(`Message queued (${pending.length} pending) for "${key}"`);
      return;
    }

    try {
      await this._processTurn(msg, reply, streamHandler, key);

      // Drain any messages that piled up while this turn was in-flight.
      // Process them sequentially here, still holding the mutex, so no
      // unrelated message can interleave between them. Each gets its own
      // response sent via its own reply/streamHandler.
      let next: PendingMessage | undefined;
      while ((next = this._shiftPending(key))) {
        log.info(`Draining pending message for "${key}"`);
        await this._processTurn(next.msg, next.reply, next.streamHandler, key);
      }
    } finally {
      queue.release();
    }
  };

  /**
   * Process a single message turn (no mutex — caller must hold the queue).
   * Extracted so that `handle()` can call it for both the initial message
   * and any pending messages drained after the initial turn completes.
   */
  private async _processTurn(
    msg: InboundMessage,
    reply: ReplyFn,
    streamHandler: StreamHandler | undefined,
    key: string
  ): Promise<void> {
      let responseText = '';

      // Files written by Edit/Write/MultiEdit/NotebookEdit during this turn —
      // populated only on the streaming path (non-streaming has no tool_use signal).
      // Used to skip auto code-review for purely conversational turns.
      const mutatedFiles = new Set<string>();
      // Whether the agent invoked Bash during this turn. Bash can mutate files
      // (sed -i, mv, rm, > redirect, git mv, patch …) without leaving a Edit/Write
      // trace — when set, we still trigger review and let `git diff` decide if
      // anything actually changed. Pure read-only Bash (ls, cat, git status …)
      // costs us a no-op review pass; that's cheaper than missing real changes.
      let bashUsed = false;

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

        const agent = this._getAgent(key);
        const request: RunRequest = {
          text: processedText,
          conversationId: key,
          chatId: msg.chatId,
          gatewayKind: msg.gatewayKind,
          attachments: msg.attachments,
          authorId: msg.authorId,
        };

        if (streamHandler && agent.stream) {
          // Streaming path: gateway renders content progressively
          const agentStream = agent.stream(request);
          async function* tracked(): AsyncGenerator<AgentStreamEvent> {
            for await (let event of agentStream) {
              if (event.type === 'tool_use') {
                if (event.name === 'Bash') bashUsed = true;
                const mutated = extractMutatedFile(event.name, event.input);
                if (mutated) mutatedFiles.add(mutated);
              }
              if (event.type === 'done') {
                const warning = buildContextWarning(event.response.contextTokens, event.response.contextWindow, event.response.model);
                if (warning) {
                  event = {
                    ...event,
                    response: { ...event.response, text: event.response.text + warning },
                  };
                  log.warn(`Context usage ${event.response.contextTokens} tokens exceeds threshold for "${key}"`);
                }
                if (event.response.isError) {
                  log.error(`Agent reported a failed turn for "${key}": ${event.response.text.slice(0, 300)}`);
                }
                responseText = event.response.text;
                recordCost({
                  conversationId: key,
                  gatewayKind: msg.gatewayKind,
                  model: event.response.model ?? null,
                  inputTokens: event.response.inputTokens ?? null,
                  outputTokens: event.response.outputTokens ?? null,
                  costUsd: event.response.costUsd ?? null,
                  elapsedMs: event.response.elapsedMs ?? null,
                });
              }
              yield event;
            }
          }
          await streamHandler(tracked());
        } else {
          // Non-streaming fallback
          const response = await agent.run(request);
          const warning = buildContextWarning(response.contextTokens, response.contextWindow, response.model);
          if (warning) {
            response.text += warning;
            log.warn(`Context usage ${response.contextTokens} tokens exceeds threshold for "${key}"`);
          }
          if (response.isError) {
            log.error(`Agent reported a failed turn for "${key}": ${response.text.slice(0, 300)}`);
          }
          responseText = response.text;
          recordCost({
            conversationId: key,
            gatewayKind: msg.gatewayKind,
            model: response.model ?? null,
            inputTokens: response.inputTokens ?? null,
            outputTokens: response.outputTokens ?? null,
            costUsd: response.costUsd ?? null,
            elapsedMs: response.elapsedMs ?? null,
          });
          await reply(response);
        }
      }

      log.info(`Response text: "${responseText}"`);
      this._appendHistory(key, 'user', msg.text);
      this._appendHistory(key, 'neoclaw', responseText);
      this._updateCurrentAuthor(key, msg.authorId);

      // Auto-rename: first non-command message after /clear in a Feishu group chat
      if (
        !command &&
        msg.gatewayKind === 'feishu' &&
        msg.meta?.chatType === 'group' &&
        key === msg.chatId &&
        this._clearedChats.has(msg.chatId)
      ) {
        this._clearedChats.delete(msg.chatId);
        this._flushClearedChats();
        this._autoRenameChatFromExchange(msg.chatId, msg.text, responseText).catch((err) =>
          log.warn(`Auto chat rename failed: ${err}`)
        );
      }

      // English coach: suggest native phrasing for English messages (Feishu only)
      if (
        !command &&
        msg.gatewayKind === 'feishu' &&
        msg.authorId !== 'cron' &&
        !this._englishCoachDisabled.has(msg.chatId) &&
        _looksLikeEnglish(_stripMentions(msg.text))
      ) {
        this._runEnglishCoach(msg).catch((err) =>
          log.warn(`English coach failed: ${err}`)
        );
      }

      // English coach (Chinese branch): suggest how to ask the same question in English
      if (
        !command &&
        msg.gatewayKind === 'feishu' &&
        msg.authorId !== 'cron' &&
        !this._englishCoachDisabled.has(msg.chatId) &&
        _looksLikeChinese(_stripMentions(msg.text))
      ) {
        this._runChineseToEnglishCoach(msg).catch((err) =>
          log.warn(`Chinese→English coach failed: ${err}`)
        );
      }

      // Auto-trigger code review when the agent either edited files via the
      // file tools (Edit/Write/MultiEdit/NotebookEdit) or invoked Bash — Bash
      // can mutate files without leaving an Edit trace. Pure-chat / pure-read
      // turns (Read/Grep/Glob only) are skipped. `runCodeReview` then bails
      // cheaply if `git diff` shows no actual change.
      if (
        !command &&
        this._codeReviewConfig?.enabled &&
        (mutatedFiles.size > 0 || bashUsed)
      ) {
        const fileList = mutatedFiles.size > 0 ? [...mutatedFiles] : undefined;
        log.info(
          `Auto-review triggered for "${key}" — ${fileList ? `${fileList.length} mutated file(s)` : 'Bash-only signal'}`
        );
        this._triggerReview(key, msg.chatId, msg.gatewayKind, fileList).catch((err) =>
          log.warn(`Auto code review failed: ${err}`)
        );
      }
  }

  /** Remove and return the next pending message for a conversation, or undefined. */
  private _shiftPending(key: string): PendingMessage | undefined {
    const queue = this._pendingMessages.get(key);
    if (!queue?.length) return undefined;
    const item = queue.shift();
    if (queue.length === 0) this._pendingMessages.delete(key);
    return item;
  }

  /**
   * Generate a ≤3-word chat name from a Q&A exchange and rename the group.
   * Uses the summary model (haiku by default) via a single-shot `claude -p` call.
   * Runs in the background — never throws to the caller.
   */
  private async _autoRenameChatFromExchange(
    chatId: string,
    question: string,
    answer: string
  ): Promise<void> {
    const gw = this._gateways.find((g) => g.kind === 'feishu');
    if (!gw?.setChatName) return;

    const q = question.slice(0, 400);
    const a = answer.slice(0, 400);
    const prompt =
      'Generate a group chat name of no more than 3 words that captures the main topic of this exchange. ' +
      'Use the same language as the conversation (Chinese or English). ' +
      'Return ONLY the name — no punctuation, no quotes, no explanation.\n\n' +
      `Q: ${q}\nA: ${a}`;

    const result = Bun.spawnSync(['claude', '--model', 'haiku', '-p', prompt], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const name = result.stdout.toString().trim().replace(/^["'「」【】]+|["'「」【】]+$/g, '').trim();
    if (!name) {
      log.warn('Auto-rename: empty title generated, skipping');
      return;
    }

    log.info(`Auto-rename chat ${chatId} → "${name}"`);
    await gw.setChatName(chatId, name);
  }

  /** Run code review on the workspace and send result to the originating chat. */
  private async _triggerReview(
    conversationKey: string,
    chatId: string,
    gatewayKind: string,
    mutatedFiles?: string[]
  ): Promise<void> {
    const cfg = this._codeReviewConfig;
    if (!cfg) return;
    const workspaceDir = this._workspaceDirFor(conversationKey);
    if (!workspaceDir) {
      log.warn('Cannot run code review: no workspace dir configured');
      return;
    }
    const result = await this._runReviewSerial(conversationKey, workspaceDir, cfg, mutatedFiles);
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
    cfg: CodeReviewConfig,
    mutatedFiles?: string[]
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
        mutatedFiles,
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
    agents: Agent[];
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
    for (const agent of opts.agents) {
      this.addAgent(agent);
    }
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

  private _getAgent(key?: string): Agent {
    const kind = (key && this._agentOverrides.get(key)) || this._defaultAgentKind;
    let agent = this._agents.get(kind);
    if (!agent) agent = this._agents.get(this._defaultAgentKind);
    if (!agent) {
      const available = [...this._agents.keys()].join(', ');
      throw new Error(`Agent "${this._defaultAgentKind}" not registered. Available: ${available}`);
    }
    return agent;
  }

  // ── Built-in slash commands ──────────────────────────────

  private static readonly COMMANDS = new Set(['clear', 'new', 'status', 'restart', 'help', 'model', 'compress', 'review', 'stop', 'agent', 'english']);

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
        const agent = this._getAgent(key);
        await agent.clearConversation(key);
        // For Feishu group main chats: reset name to placeholder and mark for auto-rename
        if (msg.gatewayKind === 'feishu' && msg.meta?.chatType === 'group' && key === msg.chatId) {
          const gw = this._gateways.find((g) => g.kind === 'feishu');
          if (gw?.setChatName) {
            this._clearedChats.add(msg.chatId);
            this._flushClearedChats();
            gw.setChatName(msg.chatId, '💬').catch((err) =>
              log.warn(`Failed to reset chat name on clear: ${err}`)
            );
          }
        }
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
        const agent = this._getAgent(key);
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

      
      case 'agent': {
        if (!args) {
          const current = this._agentOverrides.get(key) ?? this._defaultAgentKind;
          const available = [...this._agents.keys()].join(', ');
          return {
            text: `Current agent: **${current}**\nAvailable: ${available}\n\nUsage: \`/agent <name>\` to change, \`/agent reset\` to use default.`
          };
        }
        if (args === 'reset' || args === 'default') {
          this._agentOverrides.delete(key);
          this._flushAgentOverrides();
          return { text: 'Agent reset to default.' };
        }
        if (!this._agents.has(args)) {
          return { text: `Unknown agent **${args}**. Available: ${[...this._agents.keys()].join(', ')}` };
        }
        this._agentOverrides.set(key, args);
        this._flushAgentOverrides();
        return { text: `Agent set to **${args}** for this conversation.` };
      }

      case 'model': {
        const agent = this._getAgent(key);
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
        const compressAgent = this._getAgent(key);
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
          '- `/agent [name]` — Show or change the agent backend for this conversation',
          '- `/model [name]` — Show or change the model for this conversation',
          '- `/review` — Review code changes (workspace by default, or the target set via `/review target <path>`)',
          '- `/review target` — Show / set / clear the review target directory',
          '- `/status` — Show current session and system info',
          '- `/restart` — Restart the NeoClaw daemon',
          '- `/help` — Show this help message',
        ];
        return { text: lines.join('\n') };
      }

      case 'english': {
        const normalized = args.toLowerCase().trim();
        if (normalized === 'off') {
          this._englishCoachDisabled.add(msg.chatId);
          this._flushEnglishCoach();
          return { text: '✏️ English coach **off** for this chat.' };
        }
        if (normalized === 'on') {
          this._englishCoachDisabled.delete(msg.chatId);
          this._flushEnglishCoach();
          return { text: '✏️ English coach **on** for this chat.' };
        }
        // No args → toggle
        const wasDisabled = this._englishCoachDisabled.has(msg.chatId);
        if (wasDisabled) {
          this._englishCoachDisabled.delete(msg.chatId);
          this._flushEnglishCoach();
          return { text: '✏️ English coach **on** for this chat.' };
        } else {
          this._englishCoachDisabled.add(msg.chatId);
          this._flushEnglishCoach();
          return { text: '✏️ English coach **off** for this chat.' };
        }
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

  /**
   * Persist the current message sender's ID to a file so the Feishu MCP server
   * can read it at tool-call time for dynamic @mention.
   */
  /**
   * Run a one-shot `claude -p` coach prompt, returning its output or null if
   * the CLI failed.
   *
   * The CLI writes its own failures (expired OAuth, rate limits, low balance)
   * to STDOUT and exits non-zero. The callers post whatever comes back
   * straight into the chat, so without these two guards a backend outage was
   * @mentioned at users as coaching advice.
   *
   * Uses async Bun.spawn (not spawnSync) so the event loop stays unblocked
   * while haiku runs — incoming messages can be processed concurrently.
   */
  private async _runCoachPrompt(prompt: string): Promise<string | null> {
    const proc = Bun.spawn(['claude', '--model', 'haiku', '-p', prompt], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    const out = stdout.trim();
    if (exitCode !== 0) {
      log.warn(`Coach CLI exited ${exitCode}, suppressed: ${(stderr.trim() || out).slice(0, 200)}`);
      return null;
    }
    // Belt and braces: some CLI failures still exit 0.
    if (isBackendErrorText(out)) {
      log.warn(`Coach CLI returned a backend error, suppressed: ${out.slice(0, 200)}`);
      return null;
    }
    return out || null;
  }

  /**
   * Call haiku to suggest more natural English phrasing for the sender's message.
   * Sends an independent @mention message if haiku finds something to improve.
   * Runs fire-and-forget — never blocks the main response.
   */
  private async _runEnglishCoach(msg: InboundMessage): Promise<void> {
    const cleanText = _stripMentions(msg.text);
    const prompt =
      'You are a concise English writing coach. Review the message below.\n' +
      'If it has grammar errors, unnatural phrasing, or non-native word choices, reply with:\n' +
      '**Suggestion:** <rewritten version>\n' +
      '**Reason:** <one short phrase, ≤10 words>\n' +
      'If the message is already natural, reply with exactly: OK\n\n' +
      `Message: ${cleanText}`;

    const suggestion = await this._runCoachPrompt(prompt);
    // Anything other than the requested format (e.g. "This message is in
    // Chinese…") is the model declining — don't post it.
    if (!suggestion || !suggestion.startsWith('**Suggestion:**')) return;

    const mention = msg.authorId ? `<at id=${msg.authorId}></at> ` : '';
    await this.sendTo(msg.gatewayKind, msg.chatId, {
      text: `✏️ ${mention}\n> ${cleanText}\n\n${suggestion}`,
    });
  }

  /**
   * Chinese → English coach: given a Chinese message, reply with a natural
   * English phrasing of the same question/request.
   */
  private async _runChineseToEnglishCoach(msg: InboundMessage): Promise<void> {
    const cleanText = _stripMentions(msg.text);
    const prompt =
      'You are a concise bilingual writing coach.\n' +
      'The user wrote the message below in Chinese. Provide the most natural English way to express the same question or request.\n' +
      'Reply with exactly:\n' +
      '**🇬🇧 In English:** <natural English version>\n' +
      'Keep it short and conversational. Do not add explanations.\n\n' +
      `Message: ${cleanText}`;

    const suggestion = await this._runCoachPrompt(prompt);
    if (!suggestion) return;

    const mention = msg.authorId ? `<at id=${msg.authorId}></at> ` : '';
    await this.sendTo(msg.gatewayKind, msg.chatId, {
      text: `✏️ ${mention}\n> ${cleanText}\n\n${suggestion}`,
    });
  }

  private _updateCurrentAuthor(conversationKey: string, authorId: string | undefined): void {
    log.info(`[author] conversationKey=${conversationKey} authorId="${authorId ?? '(empty)'}"`);
    if (!this._workspacesDir || !authorId) return;
    const sanitized = conversationKey.replace(/:/g, '_');
    const metaDir = join(this._workspacesDir, sanitized, '.neoclaw');
    try {
      if (!existsSync(metaDir)) mkdirSync(metaDir, { recursive: true });
      writeFileSync(join(metaDir, 'current_author'), authorId, 'utf-8');
    } catch (err) {
      log.warn(`Failed to write current author: ${err}`);
    }
  }
}
