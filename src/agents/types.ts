/**
 * Agent interface and shared types.
 *
 * An Agent is an AI backend that processes messages and returns responses.
 */

// ── Request / Response ────────────────────────────────────────

/** A binary attachment (image, file, etc.) carried through the message pipeline. */
export interface Attachment {
  /** Raw binary content. */
  buffer: Buffer;
  /**
   * Media category inferred from the source platform
   * (e.g. 'image', 'file', 'audio', 'video', 'sticker').
   */
  mediaType: string;
  /** Original file name, if available. */
  fileName?: string;
}

export interface RunRequest {
  /** User message text. */
  text: string;
  /**
   * Stable identifier for the conversation (e.g. chatId or chatId_thread_threadId).
   * Used to route messages to the correct process in the agent pool.
   */
  conversationId: string;
  /** The originating chat room ID (from InboundMessage). */
  chatId: string;
  /** The originating gateway kind (from InboundMessage). */
  gatewayKind: string;
  /** Binary attachments (images, files, etc.) from the originating message. */
  attachments?: Attachment[];
  /** Author's platform user ID (open_id for Feishu). Used for @mention in group chats. */
  authorId?: string;
  /** Opaque metadata passed through from the channel. */
  extra?: Record<string, unknown>;
}

export interface RunResponse {
  text: string;
  thinking?: string | null;
  sessionId?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  elapsedMs?: number | null;
  model?: string | null;
  /** Model context window size reported by the backend (tokens). */
  contextWindow?: number | null;
}

// ── Streaming event types ─────────────────────────────────────

/** A single question item from Claude Code's AskUserQuestion tool. */
export type AskQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

/** Events emitted by Agent.stream() during incremental response generation. */
export type AgentStreamEvent =
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'text_delta'; text: string }
  /** Emitted when Claude Code uses AskUserQuestion and the gateway should render an interactive form. */
  | { type: 'ask_questions'; questions: AskQuestion[]; conversationId: string }
  | { type: 'done'; response: RunResponse };

// ── Agent interface ───────────────────────────────────────────

export interface Agent {
  /**
   * Short identifier for this agent type (e.g. "claude_code").
   * Used for registration and logging.
   */
  readonly kind: string;

  /** Process a message and return a complete response. */
  run(request: RunRequest): Promise<RunResponse>;

  /**
   * Stream a response incrementally, yielding deltas as they arrive.
   * Implementations should yield thinking_delta and text_delta events,
   * followed by a single done event containing the full RunResponse.
   */
  stream?(request: RunRequest): AsyncGenerator<AgentStreamEvent>;

  /** Returns true if the agent binary / service is reachable. */
  healthCheck(): Promise<boolean>;

  /** Clear the conversation context for a given conversationId. */
  clearConversation(conversationId: string): Promise<void>;

  /**
   * Abort the in-flight request for a conversation, preserving the session so
   * the next message can resume. Returns true if something was actually
   * running and got cancelled, false if there was nothing to stop.
   */
  cancel?(conversationId: string): Promise<boolean>;

  /** Set or clear the model override for a conversation. Null resets to default. */
  setModel?(conversationId: string, model: string | null): Promise<void>;

  /** Get the effective model for a conversation. */
  getModel?(conversationId: string): string | null;

  /** Shut down all background processes managed by this agent. */
  dispose(): Promise<void>;
}
