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
type AssistantEvent = {
  type: 'assistant';
  message: { content: AssistantContentBlock[] };
};
type PermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
};
type ResultEvent = {
  type: 'result';
  result: string;
  session_id: string;
  cost_usd: number | null;
  model: string;
  is_error: boolean;
  duration_ms: number | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  permission_denials?: PermissionDenial[];
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

type CueEvent = InitEvent | AssistantEvent | ResultEvent;

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

  constructor(
    private readonly opts: {
      model?: string | null;
      allowedTools?: string[];
      systemPrompt?: string | null;
      cwd?: string | null;
      resumeSessionId?: string | null;
      extraEnv?: Record<string, string>;
    }
  ) {}

  get isRunning(): boolean {
    return this._proc !== null && !this._proc.killed;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  private _buildArgs(): string[] {
    const args = [
      'claude',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);
    if (this.opts.model) args.push('--model', this.opts.model);
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
  }

  /**
   * Send a user message (with optional image attachments) and yield parsed CLI
   * events until the result arrives.
   */
  async *exchange(text: string, attachments?: Attachment[]): AsyncGenerator<CueEvent> {
    await this._mutex.acquire();
    try {
      if (!this.isRunning) throw new Error('Process is not running');

      const content = buildUserContent(text, attachments);
      await this._writeln(
        JSON.stringify({ type: 'user', message: { role: 'user', content } } as UserInput)
      );

      while (true) {
        const line = await this._readLine();
        if (line === null) break;

        const evt = parseCliEvent(line);
        if (!evt) continue;

        // Capture session ID from init event
        if (evt.type === 'system' && (evt as InitEvent).subtype === 'init') {
          this._sessionId = (evt as InitEvent).session_id;
          continue;
        }

        if (evt.type === 'result') {
          const r = evt as ResultEvent;
          if (r.session_id) this._sessionId = r.session_id;
          yield evt;
          return;
        }

        yield evt;
      }
    } finally {
      this._mutex.release();
    }
  }

  async terminate(): Promise<void> {
    if (!this._proc) return;

    if (this._reader) {
      this._reader.cancel().catch(() => {});
      this._reader = null;
    }

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
  /** Persists session IDs so processes can be resumed after idle reap or daemon restart. */
  private _sessionIds = new Map<string, string>();
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;
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

    const proc = await this._getOrCreate(request);

    for await (const evt of proc.exchange(request.text, request.attachments)) {
      if (evt.type === 'assistant') {
        // CLI outputs full assistant message events (not incremental deltas)
        const blocks = (evt as AssistantEvent).message.content;
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

    if (resultEvt?.session_id) {
      this._sessionIds.set(request.conversationId, resultEvt.session_id);
      this._flushSessions();
    }

    const baseText = resultEvt?.result || textParts.join('');
    const askQuestions = resultEvt ? extractAskQuestions(resultEvt) : null;
    // Yield ask_questions BEFORE done so the streaming card is still open when the gateway appends the form
    if (askQuestions && askQuestions.length > 0) {
      yield {
        type: 'ask_questions',
        questions: askQuestions,
        conversationId: request.conversationId,
      };
    }
    const text = baseText;
    const thinking = thinkingParts.length > 0 ? thinkingParts.join('') : null;

    log.info(`Run done: ${JSON.stringify({ text, thinking, resultEvt })}`);

    yield {
      type: 'done',
      response: {
        text,
        thinking,
        sessionId: resultEvt?.session_id ?? null,
        costUsd: resultEvt?.cost_usd ?? null,
        inputTokens: resultEvt?.usage?.input_tokens ?? null,
        outputTokens: resultEvt?.usage?.output_tokens ?? null,
        elapsedMs: Date.now() - t0,
        model: resultEvt?.model ?? null,
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

  async dispose(): Promise<void> {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    await Promise.all([...this._pool.values()].map((p) => p.terminate()));
    this._pool.clear();
    this._lastUsed.clear();
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

  private _conversationCwd(conversationId: string): string | null {
    if (!this.opts.cwd) return null;
    // Sanitize conversationId for use as a directory name (replace ':' with '_')
    const dirName = conversationId.replace(/:/g, '_');
    const cwd = join(this.opts.cwd, dirName);
    mkdirSync(cwd, { recursive: true });
    this._prepareWorkspace(cwd);
    return cwd;
  }

  /**
   * Prepare a workspace directory with agent-specific config files:
   * - .mcp.json for MCP server definitions (hot-reloaded from config file)
   * - .claude/skills/<name> symlinks for skill directories (with stale cleanup)
   */
  private _prepareWorkspace(cwd: string): void {
    this._syncMcpServers(cwd);
    this._syncSkills(cwd);
  }

  /** Re-read mcpServers from config file on each process start so changes take effect without daemon restart. */
  private _syncMcpServers(cwd: string): void {
    let mcpServers: Record<string, McpServerConfig> | undefined;
    try {
      const freshConfig = loadConfig();
      mcpServers = freshConfig.mcpServers;
    } catch {
      mcpServers = this.opts.mcpServers;
    }

    // Inject built-in memory MCP server
    const memoryDir = join(homedir(), '.neoclaw', 'memory');
    const mcpServerScript = join(import.meta.dir, '..', 'memory', 'mcp-server.ts');
    const allServers: Record<string, McpServerConfig> = {
      ...mcpServers,
      'neoclaw-memory': {
        type: 'stdio',
        command: 'bun',
        args: ['run', mcpServerScript],
        env: { NEOCLAW_MEMORY_DIR: memoryDir },
      },
    };

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
      cwd: this._conversationCwd(conversationId),
      resumeSessionId,
      // Inject routing context so CLI tools (e.g. neoclaw-cron) know the current chat
      extraEnv: { NEOCLAW_CHAT_ID: chatId, NEOCLAW_GATEWAY_KIND: gatewayKind },
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

  private _scheduleCleanup(): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._reapIdleProcesses(), CLEANUP_INTERVAL_MS);
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref();
  }

  private async _reapIdleProcesses(): Promise<void> {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    const stale = [...this._lastUsed.entries()].filter(([, ts]) => ts < cutoff).map(([id]) => id);

    for (const id of stale) {
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
