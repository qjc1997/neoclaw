/**
 * ClaudeCodeAgent — Claude Code CLI agent using JSONL streaming protocol.
 *
 * Each conversation gets a dedicated long-running claude CLI subprocess.
 * Messages are sent as JSONL on stdin and responses are streamed back on stdout.
 *
 * Supports custom tool registration.
 */

import type { FileSink, Subprocess } from 'bun';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { formatBackendError, isAuthErrorText } from '../utils/backend-errors.js';
import { createDebouncedFlush } from '../utils/debounced-flush.js';
import { logger } from '../utils/logger.js';
import { Mutex } from '../utils/mutex.js';
import type {
  Agent,
  AgentStreamEvent,
  AskQuestion,
  Attachment,
  RunRequest,
  RunResponse,
  UnsolicitedHandler,
} from './types.js';

const log = logger('claude-code');

/**
 * System prompt hint appended to every Claude Code session.
 * Explains that AskUserQuestion denials are transparently handled by the gateway.
 */
const ASK_USER_HINT = `\
## AskUserQuestion Gateway Integration

When the AskUserQuestion tool is denied, the gateway has already captured your questions and presented them to the user via an interactive form. Do not mention errors or denials — simply tell the user you have questions and wait for their response.
Always set multiSelect to false (only single-select is supported).`;

// ── JSONL protocol types ──────────────────────────────────────

// Messages sent to Claude CLI on stdin
type TextBlock = { type: 'text'; text: string };
type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
};
type UserInput = {
  type: 'user';
  uuid: string;
  session_id: string;
  parent_tool_use_id: null;
  message: { role: 'user'; content: string | Array<TextBlock | ImageBlock> };
};

/** Detect image MIME type from buffer magic bytes; defaults to image/jpeg. */
function detectImageMime(buf: Buffer): string {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    )
      return 'image/webp';
  }
  return 'image/jpeg';
}

/** Build the content payload for a user turn, embedding image attachments when present. */
function buildUserContent(
  text: string,
  attachments?: Attachment[]
): string | Array<TextBlock | ImageBlock> {
  const images = attachments?.filter((a) => a.mediaType === 'image') ?? [];
  if (images.length === 0) return text;

  const blocks: Array<TextBlock | ImageBlock> = [{ type: 'text', text }];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: detectImageMime(img.buffer),
        data: img.buffer.toString('base64'),
      },
    });
  }
  return blocks;
}

// Messages received from Claude CLI on stdout
type InitEvent = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
};
type AssistantContentBlock =
  | { type: 'thinking'; thinking: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };
type TurnUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};
type AssistantEvent = {
  type: 'assistant';
  // `usage` is this turn's usage alone — unlike the result event's cumulative
  // totals, it is a true snapshot of context occupancy for that turn.
  message: { content: AssistantContentBlock[]; usage?: TurnUsage; model?: string };
};

/**
 * Context occupancy for a single assistant turn: everything the model had to
 * read to produce it (fresh input + newly cached prefix + cache hits).
 */
function turnContextTokens(usage: TurnUsage | undefined): number | null {
  if (!usage) return null;
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}
/**
 * Model that actually served the turn, plus its context window. Prefers the
 * model observed on the stream (assistant `message.model`, else init event);
 * `modelUsage` is cumulative across resumes and may list several models (old
 * model before a /model switch, haiku for subagents), so it's only matched
 * against the observed model, never trusted by key order.
 */
function resolveTurnModel(
  observed: string | null,
  r: ResultEvent | null
): { model: string | null; contextWindow: number | null } {
  const usage = r?.modelUsage ?? {};
  const base = (m: string) => m.replace(/\[.*\]$/, '');
  const key = observed
    ? Object.keys(usage).find((k) => k === observed || base(k) === base(observed))
    : Object.keys(usage).at(-1);
  return {
    model: observed ?? key ?? r?.model ?? null,
    contextWindow: (key ? usage[key]?.contextWindow : undefined) ?? null,
  };
}
type PermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
};
type ResultEvent = {
  type: 'result';
  result: string;
  session_id: string;
  // Claude CLI emits `total_cost_usd` in stream-json result events. The
  // older `cost_usd` field is accepted as a fallback for forward/backward
  // compatibility across CLI versions.
  total_cost_usd?: number | null;
  cost_usd?: number | null;
  // Current CLI does NOT emit a top-level `model` field on the result event
  // (only on the init event). Kept optional here for older CLI versions that
  // may have had it. Don't derive the model from `modelUsage` key order: on
  // --resume the CLI restores the session's cumulative usage, so after a
  // /model switch the FIRST key is still the old model (see resolveTurnModel).
  model?: string;
  is_error: boolean;
  duration_ms: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; contextWindow?: number }
  >;
  permission_denials?: PermissionDenial[];
  // `kind` is "task-notification" when the CLI started the turn itself because
  // a background task finished. Not used for routing: a user message can be
  // folded into such a turn, making this result its reply (see exchange()).
  origin?: { kind?: string } | null;
};

/** Extract AskUserQuestion tool inputs from permission_denials. Returns null if none. */
function extractAskQuestions(resultEvt: ResultEvent): AskQuestion[] | null {
  const denials = resultEvt.permission_denials?.filter((d) => d.tool_name === 'AskUserQuestion');
  if (!denials || denials.length === 0) return null;

  const questions: AskQuestion[] = [];
  for (const denial of denials) {
    const input = denial.tool_input as { questions?: AskQuestion[] };
    for (const q of input.questions ?? []) {
      questions.push(q);
    }
  }
  return questions.length > 0 ? questions : null;
}

/** Format AskQuestion list as plain markdown text (fallback for non-streaming run()). */
function formatQuestionsAsText(questions: AskQuestion[]): string {
  const lines: string[] = [];
  for (const q of questions) {
    lines.push(`**${q.question}**`);
    q.options.forEach((opt, i) => {
      lines.push(`${i + 1}. **${opt.label}**${opt.description ? `: ${opt.description}` : ''}`);
    });
    lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Per-message progress emitted by the CLI, keyed by the `uuid` we put on the
 * stdin message: queued → started → completed. This is the only signal that
 * reliably ties a turn's output to the message that caused it — a message
 * written while the CLI is busy gets folded into the running turn and never
 * gets a result of its own.
 */
type LifecycleEvent = {
  type: 'command_lifecycle';
  command_uuid: string;
  state: string;
};
/** Echo of a stdin message (needs --replay-user-messages), sent when the CLI begins processing it. */
type UserEchoEvent = { type: 'user'; uuid?: string; isReplay?: boolean };
type BackgroundTasksEvent = { type: 'system'; subtype: 'background_tasks_changed'; tasks?: unknown[] };

type CueEvent = InitEvent | AssistantEvent | ResultEvent | LifecycleEvent | UserEchoEvent | BackgroundTasksEvent;

/** Output of a turn the CLI started on its own (background task finished) while no message of ours owned it. */
export type UnsolicitedOutput = { text: string; result: ResultEvent | null; sessionId: string | null; model: string | null };

const QUEUE_TIMEOUT = Symbol('timeout');

/** Single-consumer async queue fed by the stdout pump. */
class EventQueue<T> {
  private _items: T[] = [];
  private _waiter: ((v: T | null | typeof QUEUE_TIMEOUT) => void) | null = null;
  private _closed = false;

  push(v: T): void {
    if (this._closed) return;
    const w = this._waiter;
    if (w) {
      this._waiter = null;
      w(v);
    } else {
      this._items.push(v);
    }
  }

  close(): void {
    this._closed = true;
    const w = this._waiter;
    this._waiter = null;
    w?.(null);
  }

  next(timeoutMs?: number): Promise<T | null | typeof QUEUE_TIMEOUT> {
    if (this._items.length > 0) return Promise.resolve(this._items.shift()!);
    if (this._closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (v: T | null | typeof QUEUE_TIMEOUT) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      this._waiter = settle;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this._waiter === settle) {
            this._waiter = null;
            resolve(QUEUE_TIMEOUT);
          }
        }, timeoutMs);
      }
    });
  }
}

/**
 * After one of {our command completed, the turn's result} arrives, how long to
 * wait for the other. Both normally land within milliseconds of each other.
 */
const TURN_END_GRACE_MS = 5000;

function parseCliEvent(line: string): CueEvent | null {
  try {
    return JSON.parse(line) as CueEvent;
  } catch {
    return null;
  }
}

// ── ClaudeProcess: manages one long-running claude subprocess ──

class ClaudeProcess {
  private _proc: Subprocess | null = null;
  private _sessionId: string | null = null;
  private _mutex = new Mutex();
  private _reader: ReadableStreamDefaultReader<string> | null = null;
  private _buffer = '';
  /** Cached terminate() promise so concurrent calls share one teardown. */
  private _terminatePromise: Promise<void> | null = null;
  /** Set by the stdout pump when it hits EOF (process exited or terminated). */
  private _eof = false;
  /** Receives every stdout event while an exchange() is in flight; null when idle. */
  private _sink: EventQueue<CueEvent> | null = null;
  /** Text of a CLI-initiated turn (background task finished) not owned by any exchange. */
  private _idleText: string[] = [];
  private _idleTurnActive = false;
  private _backgroundTaskCount = 0;
  /** Model reported by the CLI (init event, refined by each assistant message). */
  private _model: string | null = null;
  /** Last time the CLI wrote anything — keeps the idle reaper off a process doing background work. */
  lastActivity = Date.now();

  constructor(
    private readonly opts: {
      model?: string | null;
      allowedTools?: string[];
      systemPrompt?: string | null;
      cwd?: string | null;
      resumeSessionId?: string | null;
      extraEnv?: Record<string, string>;
      onUnsolicited?: (out: UnsolicitedOutput) => void;
    }
  ) {}

  get isRunning(): boolean {
    return this._proc !== null && !this._proc.killed && !this._eof;
  }

  /** True while the CLI has background tasks or is running a turn nobody asked for. */
  get hasBackgroundWork(): boolean {
    return this._backgroundTaskCount > 0 || this._idleTurnActive;
  }

  get idleTurnActive(): boolean {
    return this._idleTurnActive;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get model(): string | null {
    return this._model;
  }

  private _buildArgs(): string[] {
    const args = [
      'claude',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--replay-user-messages',
    ];
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);
    if (this.opts.model) {
      // Auto-enable 1M context for supported models unless user explicitly specified a bracket suffix
      let model = this.opts.model;
      if (!model.includes('[')) {
        const base = model.replace(/-\d{8}$/, ''); // strip date suffix
        if (['opus', 'sonnet', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'].includes(base)) {
          model = `${model}[1m]`;
        }
      }
      args.push('--model', model);
    }
    if (this.opts.allowedTools && this.opts.allowedTools.length > 0) {
      args.push('--allowedTools', this.opts.allowedTools.join(','));
    } else {
      args.push('--dangerously-skip-permissions');
    }
    args.push('--disallowedTools', 'CronCreate,CronDelete,CronList');
    const systemPrompt = this.opts.systemPrompt
      ? `${this.opts.systemPrompt}\n\n${ASK_USER_HINT}`
      : ASK_USER_HINT;
    args.push('--append-system-prompt', systemPrompt);
    return args;
  }

  async start(): Promise<void> {
    if (this.isRunning) throw new Error('Process already running');

    // Strip Claude Code env vars to prevent nested invocations from inheriting them
    const env = { ...process.env, ...this.opts.extraEnv };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    // Also strip NEOCLAW_DAEMON. We inherit it from launchd, and leaking it
    // means a `bun start` an agent runs in its workspace believes it is
    // already the background child, skips self-daemonizing, and performs the
    // takeover in the foreground as our descendant — so disposing this agent
    // during shutdown kills the very daemon meant to replace us.
    delete env['NEOCLAW_DAEMON'];

    this._proc = Bun.spawn(this._buildArgs(), {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: this.opts.cwd ?? undefined,
      env,
    });

    const decoder = new TextDecoderStream();
    (this._proc.stdout as ReadableStream<Uint8Array>)
      .pipeTo(decoder.writable as WritableStream<Uint8Array>)
      .catch(() => {});
    this._reader = decoder.readable.getReader() as ReadableStreamDefaultReader<string>;
    this._buffer = '';
    void this._pump();
  }

  /**
   * Sole reader of stdout for the life of the process. The CLI writes output
   * even when no exchange is waiting (it starts a turn by itself when a
   * background task finishes), so stdout must be drained continuously rather
   * than only inside exchange().
   */
  private async _pump(): Promise<void> {
    while (true) {
      const line = await this._readLine();
      if (line === null) break;
      const evt = parseCliEvent(line);
      if (!evt) continue;
      this.lastActivity = Date.now();

      if (evt.type === 'system') {
        const sys = evt as InitEvent | BackgroundTasksEvent;
        if (sys.subtype === 'init') {
          this._sessionId = (sys as InitEvent).session_id;
          this._model = (sys as InitEvent).model || this._model;
          continue;
        }
        if (sys.subtype === 'background_tasks_changed') {
          this._backgroundTaskCount = (sys as BackgroundTasksEvent).tasks?.length ?? 0;
        }
      }
      if (evt.type === 'assistant' && (evt as AssistantEvent).message?.model) {
        this._model = (evt as AssistantEvent).message.model!;
      }
      if (evt.type === 'result' && (evt as ResultEvent).session_id) {
        this._sessionId = (evt as ResultEvent).session_id;
      }

      if (this._sink) this._sink.push(evt);
      else this._handleIdleEvent(evt);
    }
    this._eof = true;
    this._sink?.close();
    this._idleTurnActive = false;
  }

  /** Accumulate a turn the CLI ran on its own; publish it when it ends. */
  private _handleIdleEvent(evt: CueEvent): void {
    if (evt.type === 'assistant') {
      this._idleTurnActive = true;
      for (const block of (evt as AssistantEvent).message.content) {
        if (block.type === 'text') this._idleText.push(block.text);
      }
    } else if (evt.type === 'result') {
      this._flushIdle(evt as ResultEvent);
    }
  }

  private _flushIdle(result: ResultEvent | null): void {
    const text = (result?.result || this._idleText.join('')).trim();
    this._idleText = [];
    this._idleTurnActive = false;
    if (!text) return;
    log.info(`Unsolicited turn output (${text.length} chars)${result ? '' : ' [partial, superseded by a user message]'}`);
    this.opts.onUnsolicited?.({ text, result, sessionId: this._sessionId, model: this._model });
  }

  /**
   * Send a user message and yield the CLI events that belong to it, ending
   * once the CLI reports that message's turn finished.
   *
   * Ownership is decided by the message's uuid, never by counting results:
   * - events before the CLI starts our message belong to whatever turn was
   *   already running (typically one triggered by a background task) and are
   *   routed to the idle handler;
   * - from `started` (or the replayed echo of our message) on, events are ours;
   * - we finish when our command is `completed` and the turn's result is in.
   * A stray result therefore can't end this exchange early or be inherited by
   * the next one — the failure mode that made replies lag one message behind.
   */
  async *exchange(text: string, attachments?: Attachment[]): AsyncGenerator<CueEvent> {
    await this._mutex.acquire();
    const queue = new EventQueue<CueEvent>();
    this._sink = queue;
    try {
      if (!this.isRunning) throw new Error('Process is not running');

      const uuid = crypto.randomUUID();
      const content = buildUserContent(text, attachments);
      const input: UserInput = {
        type: 'user',
        uuid,
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content },
      };
      await this._writeln(JSON.stringify(input));

      let started = false;
      let completed = false;
      let resultSeen = false;
      const markStarted = () => {
        if (started) return;
        started = true;
        // Whatever the CLI produced on its own before picking up our message
        // is a separate answer; publish it now rather than splice it into ours.
        if (this._idleTurnActive || this._idleText.length > 0) this._flushIdle(null);
      };

      while (true) {
        const evt = await queue.next(completed || resultSeen ? TURN_END_GRACE_MS : undefined);
        if (evt === null) break;
        if (evt === QUEUE_TIMEOUT) {
          log.warn(`exchange: turn end incomplete after ${TURN_END_GRACE_MS}ms (completed=${completed}, result=${resultSeen}); finishing`);
          break;
        }

        if (evt.type === 'command_lifecycle') {
          const lc = evt as LifecycleEvent;
          if (lc.command_uuid !== uuid) continue;
          if (lc.state === 'started') markStarted();
          if (lc.state === 'completed') {
            markStarted();
            completed = true;
            if (resultSeen) return;
          }
          continue;
        }

        if (evt.type === 'user' && (evt as UserEchoEvent).isReplay) {
          if ((evt as UserEchoEvent).uuid === uuid) markStarted();
          continue;
        }

        if (!started) {
          this._handleIdleEvent(evt);
          continue;
        }

        yield evt;
        if (evt.type === 'result') {
          resultSeen = true;
          if (completed) return;
        }
      }
    } finally {
      this._sink = null;
      this._mutex.release();
    }
  }

  async terminate(): Promise<void> {
    // Share one teardown across concurrent callers — two /stop commands racing
    // used to both reach stdin.end() on the same (already closed) FileSink.
    if (this._terminatePromise) return this._terminatePromise;
    this._terminatePromise = this._doTerminate();
    return this._terminatePromise;
  }

  private async _doTerminate(): Promise<void> {
    if (!this._proc) return;

    if (this._reader) {
      this._reader.cancel().catch(() => {});
      this._reader = null;
    }
    this._sink?.close();

    if (this.isRunning) {
      try {
        (this._proc.stdin as FileSink).end();
        const done = this._proc.exited;
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
        await Promise.race([done, timeout]);
      } catch {
        // ignore
      }
      if (!this._proc.killed) {
        this._proc.kill();
        try {
          await this._proc.exited;
        } catch {
          // process may have already exited
        }
      }
    }
    this._proc = null;
  }

  // ── I/O helpers ───────────────────────────────────────────

  private async _writeln(data: string): Promise<void> {
    const stdin = this._proc?.stdin as FileSink | undefined;
    if (!stdin) throw new Error('Process stdin not available');
    stdin.write(data + '\n');
    await stdin.flush();
  }

  private async _readLine(): Promise<string | null> {
    if (!this._reader) return null;
    try {
      while (true) {
        const nl = this._buffer.indexOf('\n');
        if (nl !== -1) {
          const line = this._buffer.slice(0, nl).trim();
          this._buffer = this._buffer.slice(nl + 1);
          if (line) return line;
          continue;
        }
        const { value, done } = await this._reader.read();
        if (done) return null;
        this._buffer += value;
      }
    } catch {
      return null;
    }
  }
}

// ── ClaudeCodeAgent ───────────────────────────────────────────

const IDLE_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 min
const SESSIONS_PATH = join(homedir(), '.neoclaw', 'cache', 'sessions.json');
const MODEL_OVERRIDES_PATH = join(homedir(), '.neoclaw', 'cache', 'model-overrides.json');

export class ClaudeCodeAgent implements Agent {
  readonly kind = 'claude_code';

  private _pool = new Map<string, ClaudeProcess>();
  private _lastUsed = new Map<string, number>();
  /**
   * Conversations currently streaming a response. Guards against the idle
   * reaper killing a long-running subprocess (any run > IDLE_TIMEOUT_MS would
   * otherwise be terminated mid-stream — see `_reapIdleProcesses`).
   */
  private _active = new Set<string>();
  /** Persists session IDs so processes can be resumed after idle reap or daemon restart. */
  private _sessionIds = new Map<string, string>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _unsolicitedHandler: UnsolicitedHandler | null = null;
  private _flushSessions = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: Record<string, string> = Object.fromEntries(this._sessionIds);
      writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn(`Failed to flush sessions: ${err}`);
    }
  }, 2000);

  /** Per-conversation model overrides (from config or /model command). */
  private _modelOverrides = new Map<string, string>();
  private _flushModelOverrides = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: Record<string, string> = Object.fromEntries(this._modelOverrides);
      writeFileSync(MODEL_OVERRIDES_PATH, JSON.stringify(data, null, 2));
    } catch (err) {
      log.warn(`Failed to flush model overrides: ${err}`);
    }
  }, 2000);

  constructor(
    private readonly opts: {
      model?: string | null;
      allowedTools?: string[];
      systemPrompt?: string | null;
      cwd?: string | null;
      mcpServers?: Record<string, McpServerConfig>;
      skillsDir?: string | null;
      modelOverrides?: Record<string, string>;
      backendUrl?: string | null;
      backendKey?: string | null;
    } = {}
  ) {
    this._loadSessions();
    this._loadModelOverrides();
    if (opts.modelOverrides) {
      for (const [key, model] of Object.entries(opts.modelOverrides)) {
        this._modelOverrides.set(key, model);
      }
    }
  }

  /**
   * Set or clear the model override for a conversation.
   * Takes effect on the next subprocess spawn (after idle reap or /clear).
   * If the conversation has a running process, it is terminated so the new model takes effect immediately.
   */
  async setModel(conversationId: string, model: string | null): Promise<void> {
    if (model) {
      this._modelOverrides.set(conversationId, model);
    } else {
      this._modelOverrides.delete(conversationId);
    }
    this._flushModelOverrides();
    // Terminate existing process so next request spawns with the new model
    const proc = this._pool.get(conversationId);
    if (proc) {
      await proc.terminate();
      this._pool.delete(conversationId);
      this._lastUsed.delete(conversationId);
    }
    log.info(`Model override for "${conversationId}": ${model ?? '(default)'}`);
  }

  /** Get the effective model for a conversation. */
  getModel(conversationId: string): string | null {
    return this._modelOverrides.get(conversationId) ?? this.opts.model ?? null;
  }

  setUnsolicitedHandler(handler: UnsolicitedHandler | null): void {
    this._unsolicitedHandler = handler;
  }

  private _publishUnsolicited(
    conversationId: string,
    chatId: string,
    gatewayKind: string,
    out: UnsolicitedOutput
  ): void {
    if (out.sessionId) {
      this._sessionIds.set(conversationId, out.sessionId);
      this._flushSessions();
    }
    this._lastUsed.set(conversationId, Date.now());
    if (!this._unsolicitedHandler) {
      log.warn(`Unsolicited output for "${conversationId}" dropped: no handler`);
      return;
    }
    const r = out.result;
    const { model, contextWindow } = resolveTurnModel(out.model, r);
    this._unsolicitedHandler({
      conversationId,
      chatId,
      gatewayKind,
      response: {
        text: r?.is_error ? formatBackendError(out.text, '') : out.text,
        thinking: null,
        sessionId: out.sessionId,
        costUsd: r?.total_cost_usd ?? r?.cost_usd ?? null,
        inputTokens: turnContextTokens(r?.usage),
        outputTokens: r?.usage?.output_tokens ?? null,
        elapsedMs: r?.duration_ms ?? null,
        isError: r?.is_error === true,
        model,
        contextWindow,
      },
    });
  }

  // ── Agent interface ───────────────────────────────────────

  async run(request: RunRequest): Promise<RunResponse> {
    log.info(`Run request: ${JSON.stringify(request)}`);
    let response: RunResponse | null = null;
    let askQuestions: AskQuestion[] | null = null;
    for await (const event of this.stream(request)) {
      if (event.type === 'ask_questions') askQuestions = event.questions;
      if (event.type === 'done') response = event.response;
    }
    if (!response) throw new Error('Stream ended without done event');
    if (askQuestions) {
      response = {
        ...response,
        text: `${formatQuestionsAsText(askQuestions)}\n\n${response.text}`,
      };
    }
    return response;
  }

  async *stream(request: RunRequest): AsyncGenerator<AgentStreamEvent> {
    const t0 = Date.now();
    const textParts: string[] = [];
    const thinkingParts: string[] = [];
    let resultEvt: ResultEvent | null = null;
    // Context occupancy is a snapshot, not a sum: keep only the LAST assistant
    // turn's usage. The result event's totals accumulate one cache-read per
    // internal turn, which is why they used to report ">100% of the window".
    let lastTurnContextTokens: number | null = null;

    const proc = await this._getOrCreate(request);

    // Mark active so the idle reaper won't kill this subprocess mid-stream
    // even if the response takes longer than IDLE_TIMEOUT_MS.
    this._active.add(request.conversationId);
    try {
      for await (const evt of proc.exchange(request.text, request.attachments)) {
        // Defensive: keep lastUsed fresh on every CLI event so that if _active
        // tracking is ever bypassed, the reaper still sees recent activity.
        this._lastUsed.set(request.conversationId, Date.now());
        if (evt.type === 'assistant') {
          // CLI outputs full assistant message events (not incremental deltas)
          const msg = (evt as AssistantEvent).message;
          const turnTokens = turnContextTokens(msg.usage);
          if (turnTokens !== null) lastTurnContextTokens = turnTokens;
          const blocks = msg.content;
          for (const block of blocks) {
            if (block.type === 'thinking') {
              thinkingParts.push(block.thinking);
              yield { type: 'thinking_delta', text: block.thinking };
            } else if (block.type === 'tool_use') {
              yield { type: 'tool_use', name: block.name, input: block.input };
            } else if (block.type === 'text') {
              textParts.push(block.text);
              yield { type: 'text_delta', text: block.text };
            }
          }
        } else if (evt.type === 'result') {
          resultEvt = evt as ResultEvent;
        }
      }
    } finally {
      this._active.delete(request.conversationId);
      this._lastUsed.set(request.conversationId, Date.now());
    }

    if (resultEvt?.session_id) {
      this._sessionIds.set(request.conversationId, resultEvt.session_id);
      this._flushSessions();
    }

    // A failed turn arrives as an ordinary result event carrying `is_error`,
    // with the CLI's message in `result`. Reading only `result` (as this did)
    // relays backend failures to the user as if the assistant had written
    // them — see utils/backend-errors.ts.
    const isError = resultEvt?.is_error === true;
    const partialText = textParts.join('');
    const baseText = resultEvt?.result || partialText;

    // An auth failure poisons the subprocess for the rest of its life: it
    // holds the credentials it read at spawn, so every later turn fails
    // instantly (~135ms, zero tokens) without re-reading the refreshed token.
    // Drop it so the next turn respawns and resumes on fresh credentials.
    if (isError && isAuthErrorText(baseText)) {
      log.error(`Auth failure for conversation "${request.conversationId}" — discarding subprocess so the next turn re-reads credentials`);
      await this._discardProcess(request.conversationId);
    }

    const askQuestions = resultEvt ? extractAskQuestions(resultEvt) : null;
    // Yield ask_questions BEFORE done so the streaming card is still open when the gateway appends the form
    if (askQuestions && askQuestions.length > 0) {
      yield {
        type: 'ask_questions',
        questions: askQuestions,
        conversationId: request.conversationId,
      };
    }
    const text = isError ? formatBackendError(baseText, partialText) : baseText;
    const thinking = thinkingParts.length > 0 ? thinkingParts.join('') : null;

    log.info(`Run done: ${JSON.stringify({ text, thinking, resultEvt })}`);

    // Total BILLED input tokens across every internal turn (includes cache
    // hits). This is a cost figure — see RunResponse.inputTokens for why it
    // must not be compared against the context window.
    const usage = resultEvt?.usage;
    const totalInputTokens = turnContextTokens(usage);

    const { model, contextWindow } = resolveTurnModel(proc.model, resultEvt);

    yield {
      type: 'done',
      response: {
        text,
        thinking,
        sessionId: resultEvt?.session_id ?? null,
        costUsd: resultEvt?.total_cost_usd ?? resultEvt?.cost_usd ?? null,
        inputTokens: totalInputTokens,
        outputTokens: usage?.output_tokens ?? null,
        elapsedMs: Date.now() - t0,
        contextTokens: lastTurnContextTokens,
        isError,
        model,
        contextWindow,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = Bun.spawnSync(['claude', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Terminate and unpool a conversation's subprocess WITHOUT clearing its
   * session ID, so the next turn respawns with `--resume <sessionId>` and
   * keeps the conversation's context. Used to shed a process whose in-memory
   * state has gone bad (e.g. credentials it can no longer refresh).
   */
  private async _discardProcess(conversationId: string): Promise<void> {
    const proc = this._pool.get(conversationId);
    if (!proc) return;
    this._pool.delete(conversationId);
    this._lastUsed.delete(conversationId);
    await proc.terminate().catch((e) => log.warn(`Discard terminate failed: ${e}`));
  }

  async clearConversation(conversationId: string): Promise<void> {
    const proc = this._pool.get(conversationId);
    if (proc) {
      await proc.terminate();
      this._pool.delete(conversationId);
      this._lastUsed.delete(conversationId);
    }
    this._sessionIds.delete(conversationId);
    this._flushSessions();
    log.info(`Conversation cleared: "${conversationId}"`);
  }

  async cancel(conversationId: string): Promise<boolean> {
    // Only an in-flight response (ours, or a turn the CLI started for a
    // finished background task) is a valid cancel target. An idle pooled
    // subprocess waiting for the next message isn't "running" in the sense
    // /stop intends — killing it would misleadingly say "Stopped" when nothing
    // was happening, and force a cold start on the next message.
    const proc = this._pool.get(conversationId);
    if (!proc) return false;
    if (!this._active.has(conversationId) && !proc.idleTurnActive) return false;
    await proc.terminate();
    // terminate() can take seconds; meanwhile the dispatcher may already have
    // drained a queued message into a NEW process for this conversation. Only
    // evict the process we killed — dropping the new one would orphan it (no
    // reaping, and the next message would spawn a second CLI on the same session).
    if (this._pool.get(conversationId) === proc) {
      this._pool.delete(conversationId);
      this._lastUsed.delete(conversationId);
    }
    // _active cleanup is handled by stream()'s finally: terminate() closes the
    // subprocess stdout → _readLine returns null → exchange() loop exits →
    // stream()'s try/finally deletes from _active.
    // Preserve _sessionIds so the next message resumes the same Claude session.
    log.info(`Cancelled conversation: "${conversationId}"`);
    return true;
  }

  async dispose(): Promise<void> {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    await Promise.all([...this._pool.values()].map((p) => p.terminate()));
    this._pool.clear();
    this._lastUsed.clear();
    this._active.clear();
    // Clear _sessionIds in memory but do NOT flush — the persisted file is kept
    // intact so the next daemon process can resume sessions after a restart.
    this._sessionIds.clear();
    log.info('Claude Code agent disposed');
  }

  // ── Session persistence ───────────────────────────────────

  private _loadSessions(): void {
    try {
      if (!existsSync(SESSIONS_PATH)) return;
      const data = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8')) as Record<string, string>;
      for (const [id, sid] of Object.entries(data)) {
        this._sessionIds.set(id, sid);
      }
      log.info(`Loaded ${this._sessionIds.size} session(s) from ${SESSIONS_PATH}`);
    } catch {
      // Non-critical — start with empty session map
    }
  }

  private _loadModelOverrides(): void {
    try {
      if (!existsSync(MODEL_OVERRIDES_PATH)) return;
      const data = JSON.parse(readFileSync(MODEL_OVERRIDES_PATH, 'utf-8')) as Record<string, string>;
      for (const [id, model] of Object.entries(data)) {
        this._modelOverrides.set(id, model);
      }
      log.info(`Loaded ${this._modelOverrides.size} model override(s) from ${MODEL_OVERRIDES_PATH}`);
    } catch {
      // Non-critical — start with empty overrides
    }
  }

  // ── Internals ─────────────────────────────────────────────

  private _conversationCwd(conversationId: string, authorId?: string): string | null {
    if (!this.opts.cwd) return null;
    // Sanitize conversationId for use as a directory name (replace ':' with '_')
    const dirName = conversationId.replace(/:/g, '_');
    const cwd = join(this.opts.cwd, dirName);
    mkdirSync(cwd, { recursive: true });
    this._prepareWorkspace(cwd, authorId);
    return cwd;
  }

  /**
   * Prepare a workspace directory with agent-specific config files:
   * - .mcp.json for MCP server definitions (hot-reloaded from config file)
   * - .claude/skills/<name> symlinks for skill directories (with stale cleanup)
   */
  private _prepareWorkspace(cwd: string, authorId?: string): void {
    this._syncMcpServers(cwd, authorId);
    this._syncSkills(cwd);
  }

  /** Re-read mcpServers from config file on each process start so changes take effect without daemon restart. */
  private _syncMcpServers(cwd: string, authorId?: string): void {
    let mcpServers: Record<string, McpServerConfig> | undefined;
    let feishuConfig: { appId: string; appSecret: string; domain?: string; owners?: string[] } | undefined;
    let claudeUsageConfig: { sessionKey?: string; orgId?: string } | undefined;
    try {
      const freshConfig = loadConfig();
      mcpServers = freshConfig.mcpServers;
      feishuConfig = freshConfig.feishu;
      claudeUsageConfig = freshConfig.claudeUsage;
    } catch {
      mcpServers = this.opts.mcpServers;
    }

    // Inject built-in memory MCP servers: global + workspace-scoped
    //
    // Workspace memory points to Claude Code's native auto-memory directory for
    // this conversation's cwd. Claude Code derives this path by replacing every
    // non-alphanumeric character in the cwd with '-', so NeoClaw can compute the
    // same path deterministically — no extra config required.
    const memoryDir = join(homedir(), '.neoclaw', 'memory');
    const claudeProjectsDir = join(homedir(), '.claude', 'projects');
    const sanitizedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const workspaceMemoryDir = join(claudeProjectsDir, sanitizedCwd, 'memory');
    const memoryMcpScript = join(import.meta.dir, '..', 'memory', 'mcp-server.ts');
    const allServers: Record<string, McpServerConfig> = {
      ...mcpServers,
      'neoclaw-memory': {
        type: 'stdio',
        command: 'bun',
        args: ['run', memoryMcpScript],
        env: { NEOCLAW_MEMORY_DIR: memoryDir, NEOCLAW_MEMORY_SCOPE: 'global' },
      },
      'neoclaw-workspace-memory': {
        type: 'stdio',
        command: 'bun',
        args: ['run', memoryMcpScript],
        env: { NEOCLAW_MEMORY_DIR: workspaceMemoryDir, NEOCLAW_MEMORY_SCOPE: 'workspace' },
      },
    };

    // Inject built-in Feishu history MCP server (only if Feishu credentials are configured)
    if (feishuConfig?.appId && feishuConfig?.appSecret) {
      const feishuMcpScript = join(import.meta.dir, '..', 'gateway', 'feishu', 'mcp-server.ts');
      // Fallback to first owner open_id when no per-message authorId is available
      const resolvedAuthorId = authorId || feishuConfig.owners?.[0] || '';
      log.info(`[syncMcpServers] authorId="${authorId}" resolvedAuthorId="${resolvedAuthorId}"`);
      allServers['neoclaw-feishu'] = {
        type: 'stdio',
        command: 'bun',
        args: ['run', feishuMcpScript],
        env: {
          FEISHU_APP_ID: feishuConfig.appId,
          FEISHU_APP_SECRET: feishuConfig.appSecret,
          FEISHU_DOMAIN: feishuConfig.domain ?? 'feishu',
          ...(resolvedAuthorId ? { NEOCLAW_AUTHOR_ID: resolvedAuthorId } : {}),
          ...(claudeUsageConfig?.sessionKey ? {
            CLAUDE_USAGE_SESSION_KEY: claudeUsageConfig.sessionKey,
            CLAUDE_USAGE_ORG_ID: claudeUsageConfig.orgId ?? '',
          } : {}),
        },
      };
    }

    const mcpPath = join(cwd, '.mcp.json');
    const mcpConfig = { mcpServers: allServers };
    writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2));
    log.info(`Wrote .mcp.json to ${cwd}`);
  }

  /** Sync skill symlinks: create new, update changed, remove stale. */
  private _syncSkills(cwd: string): void {
    const skillsDir = this.opts.skillsDir;
    if (!skillsDir || !existsSync(skillsDir)) return;

    const destSkillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(destSkillsDir, { recursive: true });

    // Collect valid skill names from source directory
    let srcEntries: string[];
    try {
      srcEntries = readdirSync(skillsDir);
    } catch {
      return;
    }

    const validSkills = new Set<string>();
    for (const name of srcEntries) {
      const srcSkill = join(skillsDir, name);
      try {
        if (!lstatSync(srcSkill).isDirectory()) continue;
        if (!existsSync(join(srcSkill, 'SKILL.md'))) continue;
      } catch {
        continue;
      }
      validSkills.add(name);

      const destLink = join(destSkillsDir, name);
      // Create or update the symlink
      try {
        if (lstatSync(destLink).isSymbolicLink()) {
          if (readlinkSync(destLink) === srcSkill) continue; // already correct
          unlinkSync(destLink); // target changed, re-create
        } else {
          continue; // real dir/file exists, don't overwrite
        }
      } catch {
        // destLink doesn't exist — will create below
      }

      try {
        symlinkSync(srcSkill, destLink);
        log.info(`Linked skill "${name}" → ${destLink}`);
      } catch (err) {
        log.warn(`Failed to symlink skill "${name}": ${err}`);
      }
    }

    // Remove stale symlinks that no longer correspond to a valid skill
    let destEntries: string[];
    try {
      destEntries = readdirSync(destSkillsDir);
    } catch {
      return;
    }
    for (const name of destEntries) {
      if (validSkills.has(name)) continue;
      const destLink = join(destSkillsDir, name);
      try {
        if (!lstatSync(destLink).isSymbolicLink()) continue; // don't touch real dirs/files
        unlinkSync(destLink);
        log.info(`Removed stale skill symlink "${name}" from ${destSkillsDir}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private async _getOrCreate(request: RunRequest): Promise<ClaudeProcess> {
    const { conversationId, chatId, gatewayKind } = request;
    const existing = this._pool.get(conversationId);
    if (existing?.isRunning) {
      this._lastUsed.set(conversationId, Date.now());
      return existing;
    }

    const resumeSessionId = this._sessionIds.get(conversationId);
    const effectiveModel = this._modelOverrides.get(conversationId) ?? this.opts.model;
    const proc = new ClaudeProcess({
      model: effectiveModel,
      allowedTools: this.opts.allowedTools,
      systemPrompt: this.opts.systemPrompt ?? null,
      cwd: this._conversationCwd(conversationId, request.authorId),
      resumeSessionId,
      onUnsolicited: (out) => this._publishUnsolicited(conversationId, chatId, gatewayKind, out),
      // Inject routing context so CLI tools (e.g. neoclaw-cron) know the current chat
      extraEnv: {
        NEOCLAW_CHAT_ID: chatId,
        NEOCLAW_GATEWAY_KIND: gatewayKind,
        ...(request.authorId ? { NEOCLAW_AUTHOR_ID: request.authorId } : {}),
        // Custom LLM backend (e.g. local Ollama). When set, redirects the claude CLI
        // to a different API endpoint instead of api.anthropic.com.
        ...(this.opts.backendUrl ? {
          ANTHROPIC_BASE_URL: this.opts.backendUrl,
          ANTHROPIC_API_KEY: this.opts.backendKey ?? 'local',
        } : {}),
      },
    });
    await proc.start();
    this._pool.set(conversationId, proc);
    this._lastUsed.set(conversationId, Date.now());
    this._scheduleCleanup();
    log.info(
      `Started process for conversation "${conversationId}" (pool size: ${this._pool.size})` +
        (resumeSessionId ? ` [resuming session ${resumeSessionId.slice(0, 8)}...]` : '')
    );
    return proc;
  }

  /** Reaping would drop the result of a still-running background task. */
  private _busyInBackground(id: string, cutoff: number): boolean {
    const proc = this._pool.get(id);
    return !!proc && (proc.hasBackgroundWork || proc.lastActivity >= cutoff);
  }

  private _scheduleCleanup(): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._reapIdleProcesses(), CLEANUP_INTERVAL_MS);
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
  }

  private async _reapIdleProcesses(): Promise<void> {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    const stale = [...this._lastUsed.entries()]
      // Skip conversations with an in-flight stream — reaping them would kill
      // the subprocess mid-response, producing a truncated reply with no
      // result event and losing the updated session_id.
      .filter(([id, ts]) => ts < cutoff && !this._active.has(id) && !this._busyInBackground(id, cutoff))
      .map(([id]) => id);

    for (const id of stale) {
      // Re-check before terminate: the filter above was a synchronous snapshot,
      // but the await in this loop yields the event loop. A new message for
      // this id (hitting an idle-pooled proc) can arrive between snapshot and
      // here, running _getOrCreate + _active.add before we get the chance to
      // kill it. Without this re-check a freshly-started stream would be
      // silently terminated — exactly the bug _active was introduced to fix.
      // Also re-check _lastUsed: _getOrCreate bumps it for existing procs, so
      // a fresh timestamp means the conversation is live even if we haven't
      // yet observed _active.add (tiny microtask window between the two).
      if (this._active.has(id) || this._busyInBackground(id, cutoff)) continue;
      const lastUsed = this._lastUsed.get(id);
      if (lastUsed !== undefined && lastUsed >= cutoff) continue;
      log.info(`Reaping idle process for conversation "${id}"`);
      await this._pool.get(id)?.terminate();
      this._pool.delete(id);
      this._lastUsed.delete(id);
    }

    if (this._pool.size === 0 && this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}
