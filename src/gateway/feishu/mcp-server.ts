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

// ── ID helpers ───────────────────────────────────────────────

function receiveIdType(id: string): 'chat_id' | 'open_id' | 'user_id' {
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.startsWith('ou_')) return 'open_id';
  return 'user_id';
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

// ── File upload & send ────────────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

async function getTenantAccessToken(): Promise<string> {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json() as { code: number; tenant_access_token?: string; msg?: string };
  if (json.code !== 0 || !json.tenant_access_token) {
    throw new Error(`Failed to get access token: ${json.code} ${json.msg ?? ''}`);
  }
  return json.tenant_access_token;
}

async function uploadAndSendFile(opts: {
  chatId: string;
  filePath: string;
  fileName?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { basename, extname } = await import('node:path');

  if (!existsSync(opts.filePath)) {
    return { success: false, error: `File not found: ${opts.filePath}` };
  }

  const fileName = opts.fileName || basename(opts.filePath);
  const ext = extname(fileName).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

  try {
    const token = await getTenantAccessToken();
    const fileBuffer = readFileSync(opts.filePath);
    const blob = new Blob([fileBuffer]);

    let resourceKey: string;
    let msgType: string;
    let contentKey: string;

    if (isImage) {
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', blob, fileName);

      const uploadRes = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const uploadJson = await uploadRes.json() as { code: number; msg?: string; data?: { image_key?: string } };
      if (uploadJson.code !== 0 || !uploadJson.data?.image_key) {
        return { success: false, error: `Image upload failed: ${uploadJson.code} ${uploadJson.msg ?? ''}` };
      }
      resourceKey = uploadJson.data.image_key;
      msgType = 'image';
      contentKey = 'image_key';
    } else {
      const fileTypeMap: Record<string, string> = { '.mp4': 'mp4', '.pdf': 'pdf', '.opus': 'opus' };
      const fileType = fileTypeMap[ext] ?? 'stream';

      const form = new FormData();
      form.append('file_type', fileType);
      form.append('file_name', fileName);
      form.append('file', blob, fileName);

      const uploadRes = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const uploadJson = await uploadRes.json() as { code: number; msg?: string; data?: { file_key?: string } };
      if (uploadJson.code !== 0 || !uploadJson.data?.file_key) {
        return { success: false, error: `File upload failed: ${uploadJson.code} ${uploadJson.msg ?? ''}` };
      }
      resourceKey = uploadJson.data.file_key;
      msgType = 'file';
      contentKey = 'file_key';
    }

    // Send message
    const sendRes = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType(opts.chatId)}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receive_id: opts.chatId,
          msg_type: msgType,
          content: JSON.stringify({ [contentKey]: resourceKey }),
        }),
      }
    );
    const sendJson = await sendRes.json() as { code: number; msg?: string; data?: { message_id?: string } };
    return {
      success: sendJson.code === 0,
      messageId: sendJson.data?.message_id,
      error: sendJson.code !== 0 ? `${sendJson.code}: ${sendJson.msg ?? ''}` : undefined,
    };
  } catch (err) {
    return { success: false, error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Document reading ─────────────────────────────────────────

/**
 * Parse a Feishu URL to extract the token and type.
 * Supported URL formats:
 * - https://xxx.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWxYz
 * - https://xxx.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz
 * - https://xxx.feishu.cn/docs/AbCdEfGhIjKlMnOpQrStUvWxYz
 * - Plain token string
 */
function parseDocInput(input: string): { token: string; type: 'wiki' | 'docx' | 'doc' | 'unknown' } {
  const trimmed = input.trim();

  // Try to parse as URL
  const wikiMatch = trimmed.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) return { token: wikiMatch[1], type: 'wiki' };

  const docxMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docxMatch) return { token: docxMatch[1], type: 'docx' };

  const docMatch = trimmed.match(/\/docs\/([A-Za-z0-9]+)/);
  if (docMatch) return { token: docMatch[1], type: 'doc' };

  // Plain token
  return { token: trimmed, type: 'unknown' };
}

/**
 * Resolve a wiki node token to its underlying document token and type.
 */
async function resolveWikiNode(token: string, accessToken: string): Promise<{ objToken: string; objType: string } | { error: string }> {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json() as {
    code: number;
    msg?: string;
    data?: { node?: { obj_token?: string; obj_type?: string; title?: string } };
  };
  if (json.code !== 0) {
    return { error: `Wiki API error ${json.code}: ${json.msg ?? ''}` };
  }
  const node = json.data?.node;
  if (!node?.obj_token || !node?.obj_type) {
    return { error: 'Wiki node not found or missing obj_token/obj_type' };
  }
  return { objToken: node.obj_token, objType: node.obj_type };
}

/**
 * Read a docx document's raw text content.
 */
async function readDocxContent(docToken: string, accessToken: string): Promise<{ content: string } | { error: string }> {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(docToken)}/raw_content`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const json = await res.json() as {
    code: number;
    msg?: string;
    data?: { content?: string };
  };
  if (json.code !== 0) {
    return { error: `Docx API error ${json.code}: ${json.msg ?? ''}` };
  }
  return { content: json.data?.content ?? '' };
}

/**
 * Read a document: resolve wiki if needed, then fetch content.
 */
async function readDocument(input: string): Promise<{ content: string; error?: string }> {
  if (!appId || !appSecret) {
    return { content: '', error: 'Feishu credentials not configured' };
  }

  try {
    const accessToken = await getTenantAccessToken();
    const parsed = parseDocInput(input);
    let docToken = parsed.token;

    // If it's a wiki URL/token, resolve to the underlying document
    if (parsed.type === 'wiki' || parsed.type === 'unknown') {
      const resolved = await resolveWikiNode(parsed.token, accessToken);
      if ('error' in resolved) {
        // If type was 'unknown', try reading as docx directly
        if (parsed.type === 'unknown') {
          const result = await readDocxContent(parsed.token, accessToken);
          if ('error' in result) return { content: '', error: `Could not resolve as wiki or docx: ${resolved.error} / ${result.error}` };
          return { content: result.content };
        }
        return { content: '', error: resolved.error };
      }
      docToken = resolved.objToken;
      // Currently only docx is supported for content reading
      if (resolved.objType !== 'docx' && resolved.objType !== 'doc') {
        return { content: '', error: `Unsupported document type: ${resolved.objType}. Only docx/doc types are supported.` };
      }
    }

    const result = await readDocxContent(docToken, accessToken);
    if ('error' in result) return { content: '', error: result.error };
    return { content: result.content };
  } catch (err) {
    return { content: '', error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── MCP Server ───────────────────────────────────────────────

const server = new Server(
  { name: 'neoclaw-feishu', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'feishu_send_file',
      description:
        'Upload a local file and send it to a Feishu chat. Supports images (jpg, jpeg, png, gif, webp) and general files (pdf, mp4, opus, and others). The file is uploaded to Feishu and delivered as a native file/image message.',
      inputSchema: {
        type: 'object' as const,
        required: ['file_path'],
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute path to the local file to upload and send.',
          },
          file_name: {
            type: 'string',
            description:
              'Optional display name for the file. Defaults to the filename from file_path.',
          },
          chat_id: {
            type: 'string',
            description:
              'Feishu chat ID (starts with "oc_"). If omitted, sends to the current chat.',
          },
        },
      },
    },
    {
      name: 'feishu_read_document',
      description:
        'Read the content of a Feishu document or wiki page. Accepts a full Feishu URL (e.g. https://xxx.feishu.cn/wiki/xxx or https://xxx.feishu.cn/docx/xxx) or a plain document/wiki token. For wiki pages, automatically resolves to the underlying document. Returns the document text content.',
      inputSchema: {
        type: 'object' as const,
        required: ['url_or_token'],
        properties: {
          url_or_token: {
            type: 'string',
            description:
              'Feishu document URL or token. Supported formats: wiki URL, docx URL, doc URL, or plain token string.',
          },
        },
      },
    },
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

  if (name === 'feishu_send_file') {
    const filePath = args?.['file_path'] as string;
    if (!filePath) {
      return { content: [{ type: 'text', text: 'Error: file_path is required.' }] };
    }
    const chatId = (args?.['chat_id'] as string) || currentChatId;
    if (!chatId) {
      return { content: [{ type: 'text', text: 'Error: No chat_id provided and NEOCLAW_CHAT_ID is not set.' }] };
    }
    const fileName = args?.['file_name'] as string | undefined;
    const result = await uploadAndSendFile({ chatId, filePath, fileName });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    }
    return { content: [{ type: 'text', text: `File sent successfully. Message ID: ${result.messageId ?? 'unknown'}` }] };
  }

  if (name === 'feishu_read_document') {
    const urlOrToken = args?.['url_or_token'] as string;
    if (!urlOrToken) {
      return { content: [{ type: 'text', text: 'Error: url_or_token is required.' }] };
    }
    const result = await readDocument(urlOrToken);
    if (result.error) {
      return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    }
    if (!result.content) {
      return { content: [{ type: 'text', text: 'Document is empty or has no readable content.' }] };
    }
    return { content: [{ type: 'text', text: result.content }] };
  }

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
