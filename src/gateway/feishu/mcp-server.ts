/**
 * Feishu History MCP Server — stdio-based MCP server exposing Feishu chat history tools.
 *
 * Spawned by Claude Code as a child process via .mcp.json configuration.
 * Each Claude Code subprocess gets its own instance.
 *
 * Environment variables:
 * - FEISHU_APP_ID: Feishu app ID
 * - FEISHU_APP_SECRET: Feishu app secret
 * - FEISHU_DOMAIN: Feishu domain (default: "feishu")
 * - NEOCLAW_CHAT_ID: Current chat ID (injected by agent)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as Lark from '@larksuiteoapi/node-sdk';

// ── Config from environment ──────────────────────────────────

const appId = process.env['FEISHU_APP_ID'] ?? '';
const appSecret = process.env['FEISHU_APP_SECRET'] ?? '';
const domain = process.env['FEISHU_DOMAIN'] ?? 'feishu';
const currentChatId = process.env['NEOCLAW_CHAT_ID'] ?? '';

function larkDomain(d: string): Lark.Domain | string {
  if (d === 'lark') return Lark.Domain.Lark;
  if (!d || d === 'feishu') return Lark.Domain.Feishu;
  return d.replace(/\/+$/, '');
}

let _client: Lark.Client | null = null;
function getClient(): Lark.Client {
  if (_client) return _client;
  _client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: larkDomain(domain),
  });
  return _client;
}

// ── Content extraction (mirrored from receiver.ts) ───────────

function extractText(content: string, msgType: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (msgType === 'text') return (parsed['text'] as string) || '';
    if (msgType === 'post') return extractRichText(content);
    return content;
  } catch {
    return content;
  }
}

function extractRichText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      title?: string;
      content?: Array<
        Array<{
          tag: string;
          text?: string;
          href?: string;
          user_id?: string;
          user_name?: string;
        }>
      >;
    };
    const title = parsed.title ?? '';
    const blocks = parsed.content ?? [];
    let text = title ? `# ${title}\n\n` : '';
    for (const para of blocks) {
      for (const el of para) {
        if (el.tag === 'text') text += el.text ?? '';
        else if (el.tag === 'a') text += `[${el.text ?? el.href ?? ''}](${el.href ?? ''})`;
        else if (el.tag === 'at') text += el.user_name ? `@${el.user_name}` : (el.user_id ?? '');
      }
      text += '\n';
    }
    return text.trim();
  } catch {
    return '[rich text]';
  }
}

// ── Feishu API helpers ───────────────────────────────────────

type MessageItem = {
  message_id: string;
  msg_type: string;
  create_time: string;
  sender: { id: string; id_type: string; sender_type: string; tenant_key?: string };
  body: { content: string };
};

type ListMessagesResponse = {
  code: number;
  msg?: string;
  data?: {
    has_more: boolean;
    page_token?: string;
    items?: MessageItem[];
  };
};

async function fetchHistory(opts: {
  chatId: string;
  count: number;
  startTime?: string;
  endTime?: string;
}): Promise<{ messages: string[]; hasMore: boolean; error?: string }> {
  if (!appId || !appSecret) {
    return { messages: [], hasMore: false, error: 'Feishu credentials not configured' };
  }

  const client = getClient();
  const allItems: MessageItem[] = [];
  let pageToken: string | undefined;

  // Paginate up to the requested count
  while (allItems.length < opts.count) {
    const pageSize = Math.min(opts.count - allItems.length, 50);
    const params: Record<string, string> = {
      container_id_type: 'chat',
      container_id: opts.chatId,
      page_size: String(pageSize),
      sort_type: 'ByCreateTimeDesc',
    };
    if (opts.startTime) params['start_time'] = opts.startTime;
    if (opts.endTime) params['end_time'] = opts.endTime;
    if (pageToken) params['page_token'] = pageToken;

    try {
      const res = (await (
        client as unknown as {
          request: (opts: {
            method: string;
            url: string;
            data: object;
            params: Record<string, string>;
          }) => Promise<Record<string, unknown>>;
        }
      ).request({
        method: 'GET',
        url: '/open-apis/im/v1/messages',
        data: {},
        params,
      })) as unknown as ListMessagesResponse;

      if (res.code !== 0) {
        return { messages: [], hasMore: false, error: `API error ${res.code}: ${res.msg ?? ''}` };
      }

      const items = res.data?.items ?? [];
      allItems.push(...items);

      if (!res.data?.has_more || !res.data?.page_token) break;
      pageToken = res.data.page_token;
    } catch (err) {
      return {
        messages: [],
        hasMore: false,
        error: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Reverse to chronological order (API returns newest first)
  allItems.reverse();

  const formatted = allItems.map((item) => {
    const ts = new Date(parseInt(item.create_time) * 1000).toISOString();
    const senderId = item.sender.id;
    const text = extractText(item.body.content, item.msg_type);
    const typeLabel = item.msg_type !== 'text' ? ` [${item.msg_type}]` : '';
    return `[${ts}] ${senderId}${typeLabel}: ${text}`;
  });

  return { messages: formatted, hasMore: allItems.length >= opts.count };
}

// ── MCP Server ───────────────────────────────────────────────

const server = new Server(
  { name: 'neoclaw-feishu', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'feishu_get_history',
      description:
        'Fetch recent chat history messages from a Feishu group or direct chat. Returns messages in chronological order with timestamp, sender ID, and text content. Useful for catching up on conversation context.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description:
              'Feishu chat ID (starts with "oc_"). If omitted, uses the current chat.',
          },
          count: {
            type: 'number',
            description: 'Number of messages to fetch (1-50, default: 20).',
          },
          start_time: {
            type: 'string',
            description:
              'Start time as Unix timestamp in seconds (e.g. "1700000000"). Only messages after this time are returned.',
          },
          end_time: {
            type: 'string',
            description:
              'End time as Unix timestamp in seconds. Only messages before this time are returned.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== 'feishu_get_history') {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }

  const chatId = (args?.['chat_id'] as string) || currentChatId;
  if (!chatId) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: No chat_id provided and NEOCLAW_CHAT_ID is not set.',
        },
      ],
    };
  }

  const rawCount = (args?.['count'] as number) ?? 20;
  const count = Math.max(1, Math.min(50, rawCount));
  const startTime = (args?.['start_time'] as string) || undefined;
  const endTime = (args?.['end_time'] as string) || undefined;

  const result = await fetchHistory({ chatId, count, startTime, endTime });

  if (result.error) {
    return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
  }

  if (result.messages.length === 0) {
    return { content: [{ type: 'text', text: 'No messages found in the specified range.' }] };
  }

  const header = `Fetched ${result.messages.length} message(s) from chat ${chatId}:`;
  const body = result.messages.join('\n');
  const footer = result.hasMore ? '\n\n(More messages available — increase count or adjust time range)' : '';

  return { content: [{ type: 'text', text: `${header}\n\n${body}${footer}` }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Feishu MCP server failed to start:', err);
  process.exit(1);
});
