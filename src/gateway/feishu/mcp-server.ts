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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Config from environment ──────────────────────────────────

const appId = process.env['FEISHU_APP_ID'] ?? '';
const appSecret = process.env['FEISHU_APP_SECRET'] ?? '';
const domain = process.env['FEISHU_DOMAIN'] ?? 'feishu';
const currentChatId = process.env['NEOCLAW_CHAT_ID'] ?? '';
const claudeUsageSessionKey = process.env['CLAUDE_USAGE_SESSION_KEY'] ?? '';
const claudeUsageOrgId = process.env['CLAUDE_USAGE_ORG_ID'] ?? 'b0d11fd8-e6ac-4329-a8d2-13f5d9887446';

/**
 * Resolve the @mention target for the current message.
 *
 * Priority:
 * 1. `.neoclaw/current_author` file in the workspace — written by the
 *    dispatcher on every inbound message, so it always reflects the
 *    real-time sender.
 * 2. NEOCLAW_AUTHOR_ID env var — set once at process spawn (may be stale).
 * 3. feishu.owners[0] from config — fallback for cron / proactive messages.
 */
function resolveAuthorId(): string {
  // Try the per-workspace live file first
  const workspacesDir = process.env['NEOCLAW_WORKSPACES_DIR'] ?? join(homedir(), '.neoclaw', 'workspaces');
  const chatId = currentChatId; // e.g. oc_abc123
  if (chatId) {
    const sanitized = chatId.replace(/:/g, '_');
    const authorFile = join(workspacesDir, sanitized, '.neoclaw', 'current_author');
    try {
      if (existsSync(authorFile)) {
        const id = readFileSync(authorFile, 'utf-8').trim();
        if (id) return id;
      }
    } catch { /* ignore */ }
  }
  // Env var fallback
  if (process.env['NEOCLAW_AUTHOR_ID']) return process.env['NEOCLAW_AUTHOR_ID'];
  // Config owners fallback
  try {
    const configPath = process.env['NEOCLAW_CONFIG'] ?? join(homedir(), '.neoclaw', 'config.json');
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as { feishu?: { owners?: string[] } };
      return cfg.feishu?.owners?.[0] ?? '';
    }
  } catch { /* ignore */ }
  return '';
}

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

// ── File download ─────────────────────────────────────────────

/**
 * Find the message_id of a message in the current chat that contains the given
 * file_key, then download the file content and return it as a string.
 *
 * Feishu requires the message_id to download a resource — you can't download
 * by file_key alone. This function does the lookup automatically.
 */
async function readFileFromChat(opts: {
  fileKey: string;
  chatId: string;
  maxLookback?: number; // max messages to scan, default 50
}): Promise<{ content: string; fileName?: string } | { error: string }> {
  if (!appId || !appSecret) return { error: 'Feishu credentials not configured' };

  try {
    const token = await getTenantAccessToken();
    const maxLookback = opts.maxLookback ?? 50;

    // Step 1: scan recent messages to find the one containing this file_key
    const listRes = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?container_id_type=chat&container_id=${opts.chatId}&page_size=${maxLookback}&sort_type=ByCreateTimeDesc`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const listJson = await listRes.json() as {
      code: number;
      data?: { items?: Array<{ message_id: string; body: { content: string }; msg_type: string }> };
    };
    if (listJson.code !== 0) return { error: `Messages list failed: ${listJson.code}` };

    let messageId: string | null = null;
    let fileName: string | undefined;
    for (const item of listJson.data?.items ?? []) {
      try {
        const body = JSON.parse(item.body.content) as Record<string, unknown>;
        if (body['file_key'] === opts.fileKey) {
          messageId = item.message_id;
          fileName = body['file_name'] as string | undefined;
          break;
        }
      } catch { /* not JSON or no file_key */ }
    }
    if (!messageId) return { error: `File key "${opts.fileKey}" not found in the last ${maxLookback} messages` };

    // Step 2: download the resource
    const dlRes = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${opts.fileKey}?type=file`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!dlRes.ok) return { error: `Download failed: HTTP ${dlRes.status}` };

    const contentType = dlRes.headers.get('content-type') ?? '';
    const isText = contentType.includes('text') ||
      fileName?.match(/\.(sh|py|js|ts|txt|md|json|yaml|yml|toml|conf|cfg|env|csv|xml|html)$/i);

    if (isText) {
      return { content: await dlRes.text(), fileName };
    }
    // Binary: return base64
    const buf = await dlRes.arrayBuffer();
    return { content: Buffer.from(buf).toString('base64'), fileName };
  } catch (err) {
    return { error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Contact directory ─────────────────────────────────────────

async function listOrgUsers(opts: {
  pageSize?: number;
  pageToken?: string;
}): Promise<{ users: Array<{ open_id: string; name: string; email?: string }>; hasMore: boolean; nextToken?: string } | { error: string }> {
  if (!appId || !appSecret) return { error: 'Feishu credentials not configured' };
  try {
    const token = await getTenantAccessToken();
    const params = new URLSearchParams({
      user_id_type: 'open_id',
      page_size: String(Math.min(opts.pageSize ?? 50, 50)),
      fields: 'open_id,name,email',
    });
    if (opts.pageToken) params.set('page_token', opts.pageToken);

    const res = await fetch(
      `https://open.feishu.cn/open-apis/contact/v3/users?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const json = await res.json() as {
      code: number;
      msg?: string;
      data?: {
        has_more: boolean;
        page_token?: string;
        items?: Array<{ open_id?: string; name?: string; email?: string }>;
      };
    };
    if (json.code !== 0) return { error: `API error ${json.code}: ${json.msg ?? ''}` };

    const users = (json.data?.items ?? []).map(u => ({
      open_id: u.open_id ?? '',
      name: u.name ?? '',
      email: u.email,
    })).filter(u => u.open_id);

    return { users, hasMore: json.data?.has_more ?? false, nextToken: json.data?.page_token };
  } catch (err) {
    return { error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
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

// ── Send text message ────────────────────────────────────────

async function sendTextMessage(opts: {
  receiveId: string;
  text: string;
  mentionUserId?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!appId || !appSecret) {
    return { success: false, error: 'Feishu credentials not configured' };
  }
  try {
    const token = await getTenantAccessToken();
    const idType = receiveIdType(opts.receiveId);

    // @mention: use explicitly provided ID first, fall back to env-injected author ID
    const isGroupChat = idType === 'chat_id';
    // Resolve dynamically so it always reflects the latest message sender
    const mentionId = opts.mentionUserId || (isGroupChat ? resolveAuthorId() : '');
    const textWithMention = mentionId
      ? `<at user_id="${mentionId}"></at> ${opts.text}`
      : opts.text;

    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${idType}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receive_id: opts.receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text: textWithMention }),
        }),
      }
    );
    const json = await res.json() as { code: number; msg?: string; data?: { message_id?: string } };
    return {
      success: json.code === 0,
      messageId: json.data?.message_id,
      error: json.code !== 0 ? `${json.code}: ${json.msg ?? ''}` : undefined,
    };
  } catch (err) {
    return { success: false, error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
  }
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

// ── User (OAuth) access token ────────────────────────────────
// The tenant token only sees chats the bot belongs to. A user_access_token
// (obtained via scripts/feishu-oauth.mjs) lets us act as the owner and read
// records in THEIR view. Token + refresh token are stored by that script in
// ~/.neoclaw/feishu_user_token.json; this helper loads it and auto-refreshes.

const USER_TOKEN_PATH = join(homedir(), '.neoclaw', 'feishu_user_token.json');
const openApiHost = domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

interface UserTokenRecord {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at: number;
  scope?: string;
  saved_at?: number;
}

async function getUserAccessToken(): Promise<string> {
  if (!existsSync(USER_TOKEN_PATH)) {
    throw new Error(
      'No Feishu user token found. Authorize once with: `bun run scripts/feishu-oauth.mjs` (see its header for prerequisites).'
    );
  }
  const rec = JSON.parse(readFileSync(USER_TOKEN_PATH, 'utf-8')) as UserTokenRecord;
  const now = Math.floor(Date.now() / 1000);
  if (rec.expires_at > now) return rec.access_token;
  if (rec.refresh_expires_at <= now) {
    throw new Error('Feishu user token expired and refresh token is also expired — re-run scripts/feishu-oauth.mjs.');
  }
  // Refresh
  const res = await fetch(`${openApiHost}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: rec.refresh_token,
    }),
  });
  const tok = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  if (!tok.access_token) {
    throw new Error('Feishu user token refresh failed: ' + JSON.stringify(tok));
  }
  const updated: UserTokenRecord = {
    ...rec,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token ?? rec.refresh_token,
    expires_at: now + (tok.expires_in ?? 7200) - 60,
    refresh_expires_at: tok.refresh_token_expires_in
      ? now + tok.refresh_token_expires_in - 60
      : rec.refresh_expires_at,
    saved_at: now,
  };
  writeFileSync(USER_TOKEN_PATH, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
  return tok.access_token;
}

/** List all chats the USER (not the bot) belongs to. */
async function listMyChats(): Promise<string> {
  const token = await getUserAccessToken();
  const chats: string[] = [];
  let pageToken = '';
  do {
    const url = `${openApiHost}/open-apis/im/v1/chats?page_size=100${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data?: { items?: Array<{ chat_id?: string; name?: string; description?: string }>; page_token?: string; has_more?: boolean };
    };
    if (json.code !== 0) return `Error listing chats: ${json.code} ${json.msg ?? ''}`;
    for (const it of json.data?.items ?? []) {
      chats.push(`${it.chat_id}\t${it.name || '(no name)'}${it.description ? ' — ' + it.description : ''}`);
    }
    pageToken = json.data?.has_more ? (json.data?.page_token ?? '') : '';
  } while (pageToken);
  return chats.length ? `${chats.length} chats you're in:\n${chats.join('\n')}` : 'You are in no chats (or scope missing).';
}

/** Read messages from a chat AS THE USER (includes messages not involving the bot). */
async function readChatAsUser(
  chatId: string,
  opts: { count?: number; startTime?: string; endTime?: string }
): Promise<string> {
  const token = await getUserAccessToken();
  const limit = Math.max(1, Math.min(500, opts.count ?? 100));
  const out: string[] = [];
  let pageToken = '';
  while (out.length < limit) {
    const params = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      page_size: String(Math.min(50, limit - out.length)),
    });
    if (opts.startTime) params.set('start_time', opts.startTime);
    if (opts.endTime) params.set('end_time', opts.endTime);
    if (pageToken) params.set('page_token', pageToken);
    const res = await fetch(`${openApiHost}/open-apis/im/v1/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as {
      code: number;
      msg?: string;
      data?: {
        items?: Array<{ create_time?: string; msg_type?: string; sender?: { id?: string }; body?: { content?: string } }>;
        page_token?: string;
        has_more?: boolean;
      };
    };
    if (json.code !== 0) return `Error reading chat: ${json.code} ${json.msg ?? ''}`;
    for (const m of json.data?.items ?? []) {
      const sender = m.sender?.id ?? 'unknown';
      const ts = m.create_time ? new Date(parseInt(m.create_time)).toISOString() : '';
      const text = extractText(m.body?.content ?? '', m.msg_type ?? 'text');
      out.push(`[${ts}] ${sender}: ${text}`);
    }
    pageToken = json.data?.has_more ? (json.data?.page_token ?? '') : '';
    if (!pageToken) break;
  }
  // API returns newest-first; reverse to chronological for readability
  return out.length ? out.reverse().join('\n') : 'No messages in range.';
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

/**
 * Create a new Feishu docx document, optionally with plain-text content
 * (each line becomes a paragraph block). Optionally place it in a Drive folder.
 * Returns the new document_id and a share URL. Requires the Feishu app to have
 * docx create/write permission (scope docx:document).
 */
async function createDocument(opts: {
  title: string;
  content?: string;
  folderToken?: string;
}): Promise<{ documentId: string; url: string; contentWarning?: string } | { error: string }> {
  if (!appId || !appSecret) {
    return { error: 'Feishu credentials not configured' };
  }
  try {
    const accessToken = await getTenantAccessToken();

    // 1. Create the (empty) document
    const body: Record<string, string> = { title: opts.title };
    if (opts.folderToken) body['folder_token'] = opts.folderToken;
    const createRes = await fetch('https://open.feishu.cn/open-apis/docx/v1/documents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const createJson = (await createRes.json()) as {
      code: number;
      msg?: string;
      data?: { document?: { document_id?: string } };
    };
    if (createJson.code !== 0 || !createJson.data?.document?.document_id) {
      return { error: `Create docx failed ${createJson.code}: ${createJson.msg ?? ''}` };
    }
    const documentId = createJson.data.document.document_id;
    const url = `https://feishu.cn/docx/${documentId}`;

    // 2. Optionally insert plain-text content as paragraph blocks (one per line)
    let contentWarning: string | undefined;
    if (opts.content && opts.content.trim()) {
      const children = opts.content.split('\n').map((line) => ({
        block_type: 2, // 2 = Text (paragraph)
        text: { elements: [{ text_run: { content: line } }] },
      }));
      const blockRes = await fetch(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: 0, children }),
        }
      );
      const blockJson = (await blockRes.json()) as { code: number; msg?: string };
      if (blockJson.code !== 0) {
        contentWarning = `Document created but content insert failed ${blockJson.code}: ${blockJson.msg ?? ''}`;
      }
    }
    return { documentId, url, contentWarning };
  } catch (err) {
    return { error: `Exception: ${err instanceof Error ? err.message : String(err)}` };
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
      name: 'feishu_create_document',
      description:
        "Create a new Feishu (Lark) cloud document (docx). Provide a title and optional plain-text content — each line of content becomes a paragraph. Optionally provide a folder_token to place the doc inside a specific Drive folder (otherwise it lands in the app's space root). Returns the new document's share URL. Requires the Feishu app to have docx create/write permission (scope docx:document).",
      inputSchema: {
        type: 'object' as const,
        required: ['title'],
        properties: {
          title: {
            type: 'string',
            description: 'Title of the new document.',
          },
          content: {
            type: 'string',
            description:
              'Optional initial plain-text content. Each newline becomes a separate paragraph block.',
          },
          folder_token: {
            type: 'string',
            description:
              'Optional Drive folder token to create the document inside a specific folder.',
          },
        },
      },
    },
    {
      name: 'feishu_list_my_chats',
      description:
        "List all chats the OWNER (you) belong to, acting as the user via their OAuth token — NOT limited to chats the bot is in. Use this to discover chat_ids for feishu_read_chat_as_me when searching/analyzing the owner's own conversations. Requires a user token (run scripts/feishu-oauth.mjs once).",
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'feishu_read_chat_as_me',
      description:
        "Read a chat's message history AS THE OWNER (user token), so it includes human-to-human messages the bot was never part of. Returns chronological 'timestamp sender_open_id: text' lines. Use with a keyword/time range to gather records for analysis or summary. Requires a user token (run scripts/feishu-oauth.mjs once).",
      inputSchema: {
        type: 'object' as const,
        required: ['chat_id'],
        properties: {
          chat_id: { type: 'string', description: 'Target chat ID (starts with "oc_"). Get it from feishu_list_my_chats.' },
          count: { type: 'number', description: 'Max messages to fetch (1–500, default 100).' },
          start_time: { type: 'string', description: 'Optional lower bound, Unix seconds (string).' },
          end_time: { type: 'string', description: 'Optional upper bound, Unix seconds (string).' },
        },
      },
    },
    {
      name: 'feishu_send_message',
      description:
        'Send a text message to a Feishu chat or user. When sending to a group chat (receive_id starts with "oc_"), always pass mention_user_id so the recipient gets @mentioned. In group chats, each user message starts with their open_id as a prefix (e.g. "ou_xxx: message") — extract that open_id and pass it as mention_user_id.',
      inputSchema: {
        type: 'object' as const,
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: 'The text content to send.',
          },
          receive_id: {
            type: 'string',
            description:
              'Feishu chat ID ("oc_...") or user open_id ("ou_..."). If omitted, sends to the current chat.',
          },
          mention_user_id: {
            type: 'string',
            description:
              'open_id of the user to @mention (starts with "ou_"). Required when sending to a group chat — extract it from the "ou_xxx:" prefix of the current user\'s message. Ignored for private chats.',
          },
        },
      },
    },
    {
      name: 'claude_usage',
      description:
        'Fetch Claude subscription usage percentage from claude.ai. Returns utilization for the 5-hour and 7-day windows, plus per-model breakdowns. Uses CLAUDE_USAGE_SESSION_KEY from config by default; pass session_key to override.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_key: {
            type: 'string',
            description: 'Override the sessionKey cookie from claude.ai (sk-ant-sid02-...). If omitted, uses the value from config.',
          },
          org_id: {
            type: 'string',
            description: 'Organization ID. Defaults to the bot owner\'s org.',
          },
        },
      },
    },
    {
      name: 'feishu_list_users',
      description:
        'List users in the Feishu organization directory. Returns open_id, name, and email for each user. Requires contact:contact.base:readonly permission. Use open_id with feishu_send_message to send private messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          page_size: {
            type: 'number',
            description: 'Number of users to fetch per page (max 50, default 50).',
          },
          page_token: {
            type: 'string',
            description: 'Pagination token from a previous call to get the next page.',
          },
        },
      },
    },
    {
      name: 'feishu_read_file',
      description:
        'Read the content of a file sent in the current Feishu chat. Pass the file_key from the message (e.g. "file_v3_xxx..."). Automatically locates the message and downloads the file — text files are returned as-is, binaries as base64.',
      inputSchema: {
        type: 'object' as const,
        required: ['file_key'],
        properties: {
          file_key: {
            type: 'string',
            description: 'The file_key from the Feishu file message (starts with "file_v3_").',
          },
          chat_id: {
            type: 'string',
            description: 'Chat ID to search in. Defaults to the current chat.',
          },
        },
      },
    },
    {
      name: 'feishu_monitor_job',
      description:
        'Start a background monitor for a long-running job (script/process). Spawns a lightweight watcher that reads a log file and sends Feishu progress messages automatically — no Claude tokens consumed after launch. Use after starting a background process with Bash.',
      inputSchema: {
        type: 'object' as const,
        required: ['log_file'],
        properties: {
          log_file: {
            type: 'string',
            description: 'Absolute path to the log file written by the background process.',
          },
          job_label: {
            type: 'string',
            description: 'Human-readable name for the job shown in progress messages (e.g. "F4 ablation run").',
          },
          done_pattern: {
            type: 'string',
            description: 'Regex pattern in the log that signals completion (default: "DONE|FINISHED|ERROR|Traceback|exit code").',
          },
          progress_pattern: {
            type: 'string',
            description: 'Regex pattern to extract progress info from the log (e.g. "\\\\d+/\\\\d+ trial"). When matched and changed, sends an intermediate update.',
          },
          interval_sec: {
            type: 'number',
            description: 'How often to check the log file in seconds (default: 120).',
          },
          max_hours: {
            type: 'number',
            description: 'Safety timeout in hours — monitor stops and notifies if job exceeds this (default: 12).',
          },
          receive_id: {
            type: 'string',
            description: 'Feishu chat ID ("oc_...") or user open_id ("ou_...") to send reports to. Defaults to the current chat.',
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

  if (name === 'claude_usage') {
    const sessionKey = (args?.['session_key'] as string) || claudeUsageSessionKey;
    if (!sessionKey) return { content: [{ type: 'text', text: 'Error: session_key not provided and CLAUDE_USAGE_SESSION_KEY not configured.' }] };
    const orgId = (args?.['org_id'] as string) || claudeUsageOrgId;

    try {
      const scriptPath = join(import.meta.dir, '..', '..', '..', 'scripts', 'claude-usage.mjs');
      const proc = Bun.spawn(
        [process.execPath, scriptPath, sessionKey, orgId],
        { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } }
      );
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) return { content: [{ type: 'text', text: `Error fetching usage (exit ${exitCode})` }] };

      const d = JSON.parse(stdout) as Record<string, unknown>;
      const fiveHour = d['five_hour'] as { utilization: number; resets_at: string } | null;
      const sevenDay = d['seven_day'] as { utilization: number; resets_at: string } | null;
      const sonnet = d['seven_day_sonnet'] as { utilization: number } | null;

      const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Europe/Berlin', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const lines = ['**Claude 订阅用量**\n'];
      if (fiveHour) lines.push(`5小时窗口：**${fiveHour.utilization}%** (重置 ${fmt(fiveHour.resets_at)})`);
      if (sevenDay) lines.push(`7天窗口：**${sevenDay.utilization}%** (重置 ${fmt(sevenDay.resets_at)})`);
      if (sonnet) lines.push(`7天 Sonnet：${sonnet.utilization}%`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  if (name === 'feishu_list_users') {
    const result = await listOrgUsers({
      pageSize: args?.['page_size'] as number | undefined,
      pageToken: args?.['page_token'] as string | undefined,
    });
    if ('error' in result) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    const lines = result.users.map(u => `${u.name || '(unnamed)'} | open_id: ${u.open_id}${u.email ? ` | ${u.email}` : ''}`);
    const footer = result.hasMore ? `\n\n(More users available — pass page_token: "${result.nextToken}" to get next page)` : '';
    return { content: [{ type: 'text', text: `${result.users.length} users:\n\n${lines.join('\n')}${footer}` }] };
  }

  if (name === 'feishu_read_file') {
    const fileKey = args?.['file_key'] as string;
    if (!fileKey) return { content: [{ type: 'text', text: 'Error: file_key is required.' }] };
    const chatId = (args?.['chat_id'] as string) || currentChatId;
    if (!chatId) return { content: [{ type: 'text', text: 'Error: No chat_id and NEOCLAW_CHAT_ID not set.' }] };

    const result = await readFileFromChat({ fileKey, chatId });
    if ('error' in result) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    const header = result.fileName ? `# ${result.fileName}\n\n` : '';
    return { content: [{ type: 'text', text: header + result.content }] };
  }

  if (name === 'feishu_monitor_job') {
    const logFile = args?.['log_file'] as string;
    if (!logFile) {
      return { content: [{ type: 'text', text: 'Error: log_file is required.' }] };
    }
    const receiveId = (args?.['receive_id'] as string) || currentChatId;
    if (!receiveId) {
      return { content: [{ type: 'text', text: 'Error: No receive_id provided and NEOCLAW_CHAT_ID is not set.' }] };
    }
    if (!appId || !appSecret) {
      return { content: [{ type: 'text', text: 'Error: Feishu credentials not configured.' }] };
    }

    const monitorScript = new URL('monitor-job.ts', import.meta.url).pathname;
    const spawnArgs = [
      'run', monitorScript,
      '--log-file', logFile,
      '--chat-id', receiveId,
      '--app-id', appId,
      '--app-secret', appSecret,
      '--domain', domain,
    ];
    if (args?.['job_label'])      spawnArgs.push('--job-label',       String(args['job_label']));
    if (args?.['done_pattern'])   spawnArgs.push('--done-pattern',    String(args['done_pattern']));
    if (args?.['progress_pattern']) spawnArgs.push('--progress-pattern', String(args['progress_pattern']));
    if (args?.['interval_sec'])   spawnArgs.push('--interval',        String(args['interval_sec']));
    if (args?.['max_hours'])      spawnArgs.push('--max-hours',       String(args['max_hours']));

    try {
      const proc = Bun.spawn(['bun', ...spawnArgs], {
        stdout: 'ignore',
        stderr: 'ignore',
        // detach so it outlives this MCP server process
        env: { ...process.env },
      });
      const label = (args?.['job_label'] as string) || logFile;
      return {
        content: [{
          type: 'text',
          text: `Monitor started (PID ${proc.pid}) for "${label}". Progress reports will be sent to ${receiveId}. Log: ${logFile}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to start monitor: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  if (name === 'feishu_send_message') {
    const text = args?.['text'] as string;
    if (!text) {
      return { content: [{ type: 'text', text: 'Error: text is required.' }] };
    }
    const receiveId = (args?.['receive_id'] as string) || currentChatId;
    if (!receiveId) {
      return { content: [{ type: 'text', text: 'Error: No receive_id provided and NEOCLAW_CHAT_ID is not set.' }] };
    }
    const mentionUserId = args?.['mention_user_id'] as string | undefined;
    const result = await sendTextMessage({ receiveId, text, mentionUserId });
    if (!result.success) {
      return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    }
    return { content: [{ type: 'text', text: `Message sent successfully. Message ID: ${result.messageId ?? 'unknown'}` }] };
  }

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

  if (name === 'feishu_create_document') {
    const title = args?.['title'] as string;
    if (!title) {
      return { content: [{ type: 'text', text: 'Error: title is required.' }] };
    }
    const result = await createDocument({
      title,
      content: args?.['content'] as string | undefined,
      folderToken: args?.['folder_token'] as string | undefined,
    });
    if ('error' in result) {
      return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    }
    const warn = result.contentWarning ? `\n⚠️ ${result.contentWarning}` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Document created: ${result.url}\ndocument_id: ${result.documentId}${warn}`,
        },
      ],
    };
  }

  if (name === 'feishu_list_my_chats') {
    try {
      return { content: [{ type: 'text', text: await listMyChats() }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  if (name === 'feishu_read_chat_as_me') {
    const chatId = args?.['chat_id'] as string;
    if (!chatId) {
      return { content: [{ type: 'text', text: 'Error: chat_id is required.' }] };
    }
    try {
      const text = await readChatAsUser(chatId, {
        count: args?.['count'] as number | undefined,
        startTime: args?.['start_time'] as string | undefined,
        endTime: args?.['end_time'] as string | undefined,
      });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
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
