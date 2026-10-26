/**
 * AgyAgent — Google Gemini "agy" CLI agent (Claude-Code-style coding agent).
 *
 * Unlike Claude Code, agy has NO bidirectional `--input-format stream-json`
 * stdin channel. Each turn is a fresh one-shot `agy -p` invocation whose output
 * is parsed from stream-json on stdout. Conversation continuity is achieved by
 * resuming a stored `conversation_id` via `--conversation <id>` on later turns.
 *
 * This mirrors ClaudeCodeAgent's public Agent interface so it is a drop-in
 * backend, but the process model (one-shot per turn vs. one long-running
 * subprocess) is different, so it does not share ClaudeCodeAgent's pool logic.
 *
 * agy stream-json protocol (observed, agy v1.1.8):
 *   {"event":"init","conversation_id":"...","init":{"model":"...","cwd":"...",...}}
 *   {"event":"step_update","step_update":{"step_index":N,"state":"ACTIVE|DONE",
 *       "step_type":"agent_response|user_input|checkpoint|unknown",
 *       "text_delta":"...","duration_seconds":...,"usage":{...}}}
 *   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS",
 *       "response":"...","duration_seconds":...,"num_turns":N,"usage":{...}}}
 */

import type { Subprocess } from 'bun';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { createDebouncedFlush } from '../utils/debounced-flush.js';
import { logger } from '../utils/logger.js';
import type { Agent, AgentStreamEvent, Attachment, RunRequest, RunResponse } from './types.js';

const log = logger('agy');

const AGY_BIN = 'agy';
const CONVERSATIONS_PATH = join(homedir(), '.neoclaw', 'cache', 'agy-conversations.json');
const MODEL_OVERRIDES_PATH = join(homedir(), '.neoclaw', 'cache', 'agy-model-overrides.json');

// ── agy stream-json event types (subset we consume) ──────────────

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgyInitEvent {
  event: 'init';
  conversation_id?: string;
  init?: { model?: string; cwd?: string };
}

interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update?: {
    conversation_id?: string;
    step_index?: number;
    state?: 'ACTIVE' | 'DONE' | string;
    step_type?: string;
    text_delta?: string;
    usage?: AgyUsage;
  };
}

interface AgyResultEvent {
  event: 'result';
  result?: {
    conversation_id?: string;
    status?: string;
    response?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AgyUsage;
  };
}

type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | { event: string };

function parseAgyEvent(line: string): AgyEvent | null {
  try {
    return JSON.parse(line) as AgyEvent;
  } catch {
    return null;
  }
}

/** Map a file name / media type to a reasonable extension for a written attachment. */
function attachmentExt(att: Attachment): string {
  if (att.fileName && extname(att.fileName)) return '';
  switch (att.mediaType) {
    case 'image':
      return '.png';
    case 'audio':
      return '.ogg';
    case 'video':
      return '.mp4';
    default:
      return '.bin';
  }
}

// ── AgyAgent ─────────────────────────────────────────────────────

export class AgyAgent implements Agent {
  readonly kind = 'agy';

  /** neoclaw conversationId → agy conversation_id (for --conversation resume). */
  private _conversationIds = new Map<string, string>();
  /** In-flight one-shot subprocesses, keyed by neoclaw conversationId (for cancel). */
  private _procs = new Map<string, Subprocess>();
  /** Conversations currently streaming a response. */
  private _active = new Set<string>();
  /** Per-conversation model overrides (from config or /model command). */
  private _modelOverrides = new Map<string, string>();

  private _flushConversations = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(CONVERSATIONS_PATH, JSON.stringify(Object.fromEntries(this._conversationIds), null, 2));
    } catch (err) {
      log.warn(`Failed to flush conversations: ${err}`);
    }
  }, 2000);

  private _flushModelOverrides = createDebouncedFlush(() => {
    try {
      const dir = join(homedir(), '.neoclaw', 'cache');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(MODEL_OVERRIDES_PATH, JSON.stringify(Object.fromEntries(this._modelOverrides), null, 2));
    } catch (err) {
      log.warn(`Failed to flush model overrides: ${err}`);
    }
  }, 2000);

  constructor(
    private readonly opts: {
      model?: string | null;
      systemPrompt?: string | null;
      cwd?: string | null;
      modelOverrides?: Record<string, string>;
    } = {}
  ) {
    this._loadConversations();
    this._loadModelOverrides();
    if (opts.modelOverrides) {
      for (const [key, model] of Object.entries(opts.modelOverrides)) {
        this._modelOverrides.set(key, model);
      }
    }
  }

  // ── Agent interface ────────────────────────────────────────────

  async run(request: RunRequest): Promise<RunResponse> {
    log.info(`Run request: ${JSON.stringify({ ...request, attachments: request.attachments?.length ?? 0 })}`);
    let response: RunResponse | null = null;
    for await (const event of this.stream(request)) {
      if (event.type === 'done') response = event.response;
    }
    if (!response) throw new Error('Stream ended without done event');
    return response;
  }

  async *stream(request: RunRequest): AsyncGenerator<AgentStreamEvent> {
    const t0 = Date.now();
    const { conversationId } = request;
    const cwd = this._conversationCwd(conversationId);
    const resumeId = this._conversationIds.get(conversationId);
    const model = this._modelOverrides.get(conversationId) ?? this.opts.model ?? null;

    // Build the prompt. On the FIRST turn (no stored conversation_id) inject the
    // system prompt as a preamble — agy has no --append-system-prompt flag, and
    // the preamble carries forward in the persisted conversation context.
    let prompt = request.text;
    const attachmentNote = this._writeAttachments(cwd, request.attachments);
    if (attachmentNote) prompt = `${prompt}\n\n${attachmentNote}`;
    if (!resumeId && this.opts.systemPrompt) {
      prompt = `${this.opts.systemPrompt}\n\n---\n\n${prompt}`;
    }

    const args = [
      AGY_BIN,
      '--print',
      prompt,
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
    ];
    if (model) args.push('--model', model);
    if (resumeId) args.push('--conversation', resumeId);

    // Strip Claude Code env vars so a nested claude invocation (if any) doesn't
    // inherit them; pass routing context through for parity with ClaudeCodeAgent.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    // See ClaudeCodeAgent: leaking NEOCLAW_DAEMON makes an agent-launched
    // `bun start` skip self-daemonizing and die with our process tree.
    delete env['NEOCLAW_DAEMON'];
    env['NEOCLAW_CHAT_ID'] = request.chatId;
    env['NEOCLAW_GATEWAY_KIND'] = request.gatewayKind;
    if (request.authorId) env['NEOCLAW_AUTHOR_ID'] = request.authorId;

    const proc = Bun.spawn(args, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: cwd ?? undefined,
      env,
    });
    this._procs.set(conversationId, proc);
    this._active.add(conversationId);

    const textParts: string[] = [];
    let newConversationId: string | null = null;
    let resultEvt: AgyResultEvent['result'] | null = null;
    let model_ = model;

    try {
      const decoder = new TextDecoderStream();
      (proc.stdout as ReadableStream<Uint8Array>)
        .pipeTo(decoder.writable as WritableStream<Uint8Array>)
        .catch(() => {});
      const reader = decoder.readable.getReader() as ReadableStreamDefaultReader<string>;
      let buffer = '';

      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          continue;
        }
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        const evt = parseAgyEvent(line);
        if (!evt) continue;

        if (evt.event === 'init') {
          const e = evt as AgyInitEvent;
          if (e.conversation_id) newConversationId = e.conversation_id;
          if (e.init?.model) model_ = e.init.model;
        } else if (evt.event === 'step_update') {
          const su = (evt as AgyStepUpdateEvent).step_update;
          if (!su) continue;
          if (su.conversation_id) newConversationId = su.conversation_id;
          const delta = su.text_delta;
          if (delta) {
            const isThinking = (su.step_type ?? '').toLowerCase().includes('thinking');
            if (isThinking) {
              yield { type: 'thinking_delta', text: delta };
            } else if (su.step_type === 'agent_response') {
              textParts.push(delta);
              yield { type: 'text_delta', text: delta };
            }
          }
        } else if (evt.event === 'result') {
          resultEvt = (evt as AgyResultEvent).result ?? null;
          if (resultEvt?.conversation_id) newConversationId = resultEvt.conversation_id;
        }
      }

      await proc.exited;
      if (proc.exitCode && proc.exitCode !== 0 && !resultEvt) {
        const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => '');
        throw new Error(`agy exited with code ${proc.exitCode}: ${stderr.slice(0, 500)}`);
      }
    } finally {
      this._procs.delete(conversationId);
      this._active.delete(conversationId);
    }

    // Persist the agy conversation_id so the next turn resumes this context.
    if (newConversationId) {
      this._conversationIds.set(conversationId, newConversationId);
      this._flushConversations();
    }

    // result.response is the authoritative final text; fall back to streamed deltas.
    const text = resultEvt?.response?.trim() || textParts.join('').trim();
    const usage = resultEvt?.usage;
    const inputTokens =
      usage !== undefined ? (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0) : null;

    log.info(`Run done: ${JSON.stringify({ textLen: text.length, conversationId: newConversationId, usage })}`);

    yield {
      type: 'done',
      response: {
        text,
        thinking: null,
        sessionId: newConversationId,
        // agy stream-json does not report a monetary cost, only token usage.
        costUsd: null,
        inputTokens,
        outputTokens: usage?.output_tokens ?? null,
        elapsedMs: Date.now() - t0,
        model: model_,
        contextWindow: null,
        // agy reports one usage block per turn (not summed over internal
        // turns the way the Claude CLI result event is), so the billed input
        // count doubles as the context snapshot here.
        contextTokens: inputTokens,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = Bun.spawnSync([AGY_BIN, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    await this._killProc(conversationId);
    this._conversationIds.delete(conversationId);
    this._flushConversations();
    log.info(`Conversation cleared: "${conversationId}"`);
  }

  async cancel(conversationId: string): Promise<boolean> {
    // Only an in-flight streaming turn is a valid cancel target.
    if (!this._active.has(conversationId)) return false;
    const killed = await this._killProc(conversationId);
    // Preserve the stored conversation_id so the next message resumes context.
    if (killed) log.info(`Cancelled conversation: "${conversationId}"`);
    return killed;
  }

  async setModel(conversationId: string, model: string | null): Promise<void> {
    if (model) {
      this._modelOverrides.set(conversationId, model);
    } else {
      this._modelOverrides.delete(conversationId);
    }
    this._flushModelOverrides();
    log.info(`Model override for "${conversationId}": ${model ?? '(default)'}`);
  }

  getModel(conversationId: string): string | null {
    return this._modelOverrides.get(conversationId) ?? this.opts.model ?? null;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this._procs.keys()].map((id) => this._killProc(id)));
    this._procs.clear();
    this._active.clear();
    // Keep _conversationIds persisted on disk so the next daemon resumes contexts.
    this._conversationIds.clear();
    log.info('Agy agent disposed');
  }

  // ── Internals ──────────────────────────────────────────────────

  private async _killProc(conversationId: string): Promise<boolean> {
    const proc = this._procs.get(conversationId);
    if (!proc) return false;
    try {
      proc.kill();
      await proc.exited;
    } catch {
      // already exited
    }
    this._procs.delete(conversationId);
    return true;
  }

  private _conversationCwd(conversationId: string): string | null {
    if (!this.opts.cwd) return null;
    const dirName = conversationId.replace(/:/g, '_');
    const cwd = join(this.opts.cwd, dirName);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  /**
   * Persist image/file attachments into the workspace so agy can read them via
   * its file tools, and return a note listing them (or '' if none).
   */
  private _writeAttachments(cwd: string | null, attachments?: Attachment[]): string {
    if (!cwd || !attachments || attachments.length === 0) return '';
    const names: string[] = [];
    attachments.forEach((att, i) => {
      const base = att.fileName || `attachment-${i}${attachmentExt(att)}`;
      const dest = join(cwd, base);
      try {
        writeFileSync(dest, att.buffer);
        names.push(base);
      } catch (err) {
        log.warn(`Failed to write attachment "${base}": ${err}`);
      }
    });
    if (names.length === 0) return '';
    return `The user attached the following file(s) in the current directory: ${names.join(', ')}`;
  }

  private _loadConversations(): void {
    try {
      if (!existsSync(CONVERSATIONS_PATH)) return;
      const data = JSON.parse(readFileSync(CONVERSATIONS_PATH, 'utf-8')) as Record<string, string>;
      for (const [id, cid] of Object.entries(data)) this._conversationIds.set(id, cid);
      log.info(`Loaded ${this._conversationIds.size} conversation(s) from ${CONVERSATIONS_PATH}`);
    } catch {
      // Non-critical — start empty
    }
  }

  private _loadModelOverrides(): void {
    try {
      if (!existsSync(MODEL_OVERRIDES_PATH)) return;
      const data = JSON.parse(readFileSync(MODEL_OVERRIDES_PATH, 'utf-8')) as Record<string, string>;
      for (const [id, model] of Object.entries(data)) this._modelOverrides.set(id, model);
      log.info(`Loaded ${this._modelOverrides.size} model override(s) from ${MODEL_OVERRIDES_PATH}`);
    } catch {
      // Non-critical — start empty
    }
  }
}
