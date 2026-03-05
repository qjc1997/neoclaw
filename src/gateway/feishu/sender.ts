/**
 * Feishu message sending utilities.
 *
 * Two card formats are used:
 *
 * 1. Non-streaming (JSON 2.0, direct send):
 *      schema: "2.0"
 *      config: { wide_screen_mode: true }
 *      body.elements: [ collapsible_panel?, hr?, markdown, hr?, markdown(stats)? ]
 *    Sent directly as msg_type "interactive" with content = card JSON string.
 *
 * 2. Streaming (JSON 2.0, requires cardkit API):
 *      schema: "2.0"
 *      config: { streaming_mode: true, ... }
 *      body.elements: [ collapsible_panel (thinking), hr, markdown (main) ]
 *    Created via cardkit.v1.card.create → card_id reference sent in message.
 *    Content updated progressively via cardkit.v1.cardElement.content.
 *    Streaming closed via cardkit.v1.card.settings({ streaming_mode: false }).
 */

import type * as Lark from '@larksuiteoapi/node-sdk';
import type { AskQuestion } from '../../agents/types.js';
import type { SendResult } from './client.js';
import { idType } from './client.js';
import { logger } from '../../utils/logger.js';

const log = logger('sender');

// ── Card JSON 2.0 element types ───────────────────────────────

type MarkdownEl = { tag: 'markdown'; content: string };
type HrEl = { tag: 'hr' };
type CollapsiblePanel = {
  tag: 'collapsible_panel';
  expanded: boolean;
  header: { title: { tag: 'plain_text'; content: string } };
  elements: CardElement[];
};
type CardElement = MarkdownEl | HrEl | CollapsiblePanel;

// ── Card builder ──────────────────────────────────────────────

/** Build a Feishu Card JSON 2.0 object for an agent response. */
export function buildCard(opts: {
  text: string;
  thinking?: string | null;
  stats?: string | null;
}): Record<string, unknown> {
  const elements: CardElement[] = [];

  if (opts.thinking) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: { title: { tag: 'plain_text', content: '💭 Thinking' } },
      elements: [{ tag: 'markdown', content: opts.thinking }],
    });
    elements.push({ tag: 'hr' });
  }

  elements.push({ tag: 'markdown', content: opts.text });

  if (opts.stats) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `*${opts.stats}*` });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  };
}

// ── Send helpers ──────────────────────────────────────────────

/** Send an interactive card to a chat or as a reply. */
export async function sendCard(
  client: Lark.Client,
  target: string,
  card: Record<string, unknown>,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  const content = JSON.stringify(card);
  const receiveId = target.trim();
  log.info(`Sending card to ${target}: ${content.slice(0, 200)}…`);

  let res: Record<string, unknown>;
  if (opts?.replyToMessageId) {
    res = await (
      client as unknown as {
        im: {
          message: {
            reply: (opts: {
              path: { message_id: string };
              data: { msg_type: string; content: string };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.message.reply({
      path: { message_id: opts.replyToMessageId },
      data: { msg_type: 'interactive', content },
    });
  } else {
    res = await (
      client as unknown as {
        im: {
          message: {
            create: (opts: {
              params: { receive_id_type: string };
              data: { receive_id: string; msg_type: string; content: string };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.message.create({
      params: { receive_id_type: idType(receiveId) },
      data: { receive_id: receiveId, msg_type: 'interactive', content },
    });
  }

  if (res['code'] !== 0) {
    throw new Error(`Feishu send failed (code ${res['code']}): ${res['msg'] ?? ''}`);
  }
  const messageId =
    ((res['data'] as Record<string, unknown>)?.['message_id'] as string) ?? 'unknown';
  return { messageId, chatId: receiveId };
}

// ── Streaming card (JSON 2.0, requires cardkit API) ───────────

/** Element IDs used in streaming cards — must be globally unique within the card. */
export const STREAM_EL = {
  thinkingPanel: 'thinking_panel',
  thinkingMd: 'thinking_md',
  thinkingHr: 'thinking_hr',
  mainMd: 'main_md',
  statsHr: 'stats_hr',
  statsNote: 'stats_note',
} as const;

/**
 * Build the initial Feishu Card JSON 2.0 object for a streaming response.
 * The thinking panel is NOT included here — it is inserted dynamically via
 * insertThinkingPanel() only when thinking content actually arrives.
 */
export function buildStreamingCard(): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 5 },
        print_strategy: 'delay',
      },
    },
    body: {
      elements: [{ tag: 'markdown', element_id: STREAM_EL.mainMd, content: '' }],
    },
  };
}

/**
 * Insert the thinking collapsible panel + divider BEFORE the main content element.
 * Call this once when the first thinking_delta arrives.
 */
export async function insertThinkingPanel(
  client: Lark.Client,
  cardId: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.create({
    path: { card_id: cardId },
    data: {
      type: 'insert_before',
      target_element_id: STREAM_EL.mainMd,
      elements: JSON.stringify([
        {
          tag: 'collapsible_panel',
          element_id: STREAM_EL.thinkingPanel,
          expanded: true,
          header: { title: { tag: 'plain_text', content: '💭 Thinking' } },
          elements: [{ tag: 'markdown', element_id: STREAM_EL.thinkingMd, content: '' }],
        },
        { tag: 'hr', element_id: STREAM_EL.thinkingHr },
      ]),
      sequence,
    },
  });
  if (res.code !== 0) {
    throw new Error(`insertThinkingPanel failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Create a card entity and return its card_id. */
export async function createCardEntity(
  client: Lark.Client,
  card: Record<string, unknown>
): Promise<string> {
  const res = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  });
  if (res.code !== 0) {
    throw new Error(`Failed to create card entity (code ${res.code}): ${res.msg ?? ''}`);
  }
  const cardId = res.data?.card_id;
  if (!cardId) throw new Error('Card entity created but no card_id returned');
  return cardId;
}

/** Send a card entity (by card_id reference) as a message or reply. */
export async function sendCardByRef(
  client: Lark.Client,
  target: string,
  cardId: string,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  const receiveId = target.trim();
  const content = JSON.stringify({ type: 'card', data: { card_id: cardId } });
  log.info(`Sending card ref ${cardId} to ${target}`);

  let res: Record<string, unknown>;
  if (opts?.replyToMessageId) {
    res = await (
      client as unknown as {
        im: {
          message: {
            reply: (opts: {
              path: { message_id: string };
              data: { msg_type: string; content: string };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.message.reply({
      path: { message_id: opts.replyToMessageId },
      data: { msg_type: 'interactive', content },
    });
  } else {
    res = await (
      client as unknown as {
        im: {
          message: {
            create: (opts: {
              params: { receive_id_type: string };
              data: { receive_id: string; msg_type: string; content: string };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.message.create({
      params: { receive_id_type: idType(receiveId) },
      data: { receive_id: receiveId, msg_type: 'interactive', content },
    });
  }

  if (res['code'] !== 0) {
    throw new Error(`Feishu send failed (code ${res['code']}): ${res['msg'] ?? ''}`);
  }
  const messageId =
    ((res['data'] as Record<string, unknown>)?.['message_id'] as string) ?? 'unknown';
  return { messageId, chatId: receiveId };
}

/**
 * Stream-update a markdown/plain_text element content (typewriter effect).
 * Pass the FULL accumulated text on each call — the platform computes the delta.
 */
export async function updateCardText(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.content({
    path: { card_id: cardId, element_id: elementId },
    data: { content, sequence },
  });
  if (res.code !== 0) {
    throw new Error(`updateCardText failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Partially update a card element's properties (e.g. collapse a panel). */
export async function patchCardElement(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  partial: Record<string, unknown>,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.patch({
    path: { card_id: cardId, element_id: elementId },
    data: { partial_element: JSON.stringify(partial), sequence },
  });
  if (res.code !== 0) {
    throw new Error(`patchCardElement failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Delete a card element by ID. */
export async function deleteCardElement(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.cardElement.delete({
    path: { card_id: cardId, element_id: elementId },
    data: { sequence },
  });
  if (res.code !== 0) {
    throw new Error(`deleteCardElement failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Append one or more elements after a target element (or at the end of the card). */
export async function appendCardElements(
  client: Lark.Client,
  cardId: string,
  elements: Record<string, unknown>[],
  sequence: number,
  afterElementId?: string
): Promise<void> {
  const payload: Parameters<typeof client.cardkit.v1.cardElement.create>[0] = {
    path: { card_id: cardId },
    data: {
      type: afterElementId ? 'insert_after' : 'append',
      target_element_id: afterElementId,
      elements: JSON.stringify(elements),
      sequence,
    },
  };
  const res = await client.cardkit.v1.cardElement.create(payload);
  if (res.code !== 0) {
    throw new Error(`appendCardElements failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

/** Close streaming mode for a card (re-enables forwarding and interactions). */
export async function closeCardStreaming(
  client: Lark.Client,
  cardId: string,
  sequence: number
): Promise<void> {
  const res = await client.cardkit.v1.card.settings({
    path: { card_id: cardId },
    data: {
      settings: JSON.stringify({ config: { streaming_mode: false } }),
      sequence,
    },
  });
  if (res.code !== 0) {
    throw new Error(`closeCardStreaming failed (code ${res.code}): ${res.msg ?? ''}`);
  }
}

// ── Non-streaming send helpers ────────────────────────────────

/** Convenience wrapper: send a plain markdown text as a simple interactive card. */
export async function sendMarkdown(
  client: Lark.Client,
  target: string,
  text: string,
  opts?: { replyToMessageId?: string }
): Promise<SendResult> {
  return sendCard(client, target, buildCard({ text }), opts);
}

// ── Reaction helpers ──────────────────────────────────────────

/** Add an emoji reaction to a message. Returns the reaction ID, or null on failure. */
export async function addReaction(
  client: Lark.Client,
  messageId: string,
  emoji: string
): Promise<string | null> {
  try {
    const res = await (
      client as unknown as {
        im: {
          messageReaction: {
            create: (opts: {
              path: { message_id: string };
              data: { reaction_type: { emoji_type: string } };
            }) => Promise<Record<string, unknown>>;
          };
        };
      }
    ).im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emoji } },
    });
    return ((res['data'] as Record<string, unknown>)?.['reaction_id'] as string) ?? null;
  } catch {
    return null;
  }
}

// ── AskUserQuestion interactive form ─────────────────────────

/**
 * Build the card elements for an AskUserQuestion form.
 * Returns an array to be appended to an existing streaming card via appendCardElements().
 *
 * Layout: hr → form(label + select_static per question + submit button)
 *
 * The submit button encodes routing context in its callback value so the
 * card.action.trigger handler knows which chat/thread to reply to.
 */
export function buildQuestionFormElements(opts: {
  questions: AskQuestion[];
  chatId: string;
  threadRootId?: string;
}): Record<string, unknown>[] {
  const { questions, chatId, threadRootId } = opts;

  const formInner: Record<string, unknown>[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    formInner.push({ tag: 'markdown', content: `**${i + 1}. ${q.question}**` });
    formInner.push({
      tag: 'select_static',
      name: `q${i}`,
      required: true,
      width: 'fill',
      placeholder: { tag: 'plain_text', content: '请选择...' },
      options: q.options.map((opt) => ({
        text: {
          tag: 'plain_text',
          content: opt.description ? `${opt.label}: ${opt.description}` : opt.label,
        },
        // value = label text so the callback directly carries the human-readable answer
        value: opt.label,
      })),
    });
  }

  formInner.push({
    tag: 'button',
    name: 'neoclaw_submit',
    type: 'primary_filled',
    width: 'default',
    text: { tag: 'plain_text', content: '提交' },
    form_action_type: 'submit',
    behaviors: [
      {
        type: 'callback',
        value: {
          _neoclaw_action: 'questions_submit',
          _neoclaw_chat_id: chatId,
          _neoclaw_thread_id: threadRootId ?? '',
        },
      },
    ],
  });

  return [
    { tag: 'hr' },
    { tag: 'form', name: 'neoclaw_questions', vertical_spacing: '12px', elements: formInner },
  ];
}

/** Remove an emoji reaction from a message. Silently ignores errors. */
export async function removeReaction(
  client: Lark.Client,
  messageId: string,
  reactionId: string
): Promise<void> {
  try {
    await (
      client as unknown as {
        im: {
          messageReaction: {
            delete: (opts: { path: { message_id: string; reaction_id: string } }) => Promise<void>;
          };
        };
      }
    ).im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  } catch {
    // Non-critical
  }
}
