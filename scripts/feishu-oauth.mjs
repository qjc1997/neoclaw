/**
 * feishu-oauth.mjs — one-time interactive OAuth to obtain a Feishu USER access token.
 *
 * Why: the neoclaw bot uses a tenant (app) token, which can only see chats the bot
 * is a member of. To read/search records in YOUR view, calls must be made as YOU —
 * with a user_access_token. This script drives Feishu's OAuth authorization-code flow:
 * it opens a local callback server, you log in in a browser, and it saves the token
 * (with refresh token) to ~/.neoclaw/feishu_user_token.json. The neoclaw-feishu MCP
 * server then reads that file (auto-refreshing) for user-scoped tools.
 *
 * Run:  bun run scripts/feishu-oauth.mjs
 * Env overrides: FEISHU_OAUTH_PORT (default 9988), FEISHU_OAUTH_HOST (default localhost),
 *                NEOCLAW_CONFIG, FEISHU_DOMAIN (feishu|lark).
 *
 * PREREQUISITES (do these in the Feishu app console once):
 *  1. Enable the user-scoped permissions: `im:chat` and `im:message` (or their
 *     :readonly variants). Optionally `contact:user.base:readonly` to resolve names.
 *  2. Add the redirect URL to the app's "Security settings → Redirect URLs":
 *        http://localhost:9988/callback
 *     (must match FEISHU_OAUTH_HOST/PORT below exactly).
 *  3. Open the printed authorize URL in a browser ON THIS MACHINE (so the localhost
 *     callback reaches this script).
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const configPath = process.env['NEOCLAW_CONFIG'] ?? join(homedir(), '.neoclaw', 'config.json');
const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
const APP_ID = cfg.feishu?.appId;
const APP_SECRET = cfg.feishu?.appSecret;
const DOMAIN = process.env['FEISHU_DOMAIN'] ?? cfg.feishu?.domain ?? 'feishu';
if (!APP_ID || !APP_SECRET) {
  console.error('Missing feishu.appId / feishu.appSecret in', configPath);
  process.exit(1);
}

const HOST = process.env['FEISHU_OAUTH_HOST'] ?? 'localhost';
const PORT = parseInt(process.env['FEISHU_OAUTH_PORT'] ?? '9988', 10);
const REDIRECT = `http://${HOST}:${PORT}/callback`;
const TOKEN_PATH = join(homedir(), '.neoclaw', 'feishu_user_token.json');

// Feishu (China) vs Lark (intl) hosts
const ACCOUNTS = DOMAIN === 'lark' ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn';
const OPEN = DOMAIN === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';

// Scopes needed to enumerate the user's chats and read their messages.
const SCOPE = 'im:chat im:message im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user contact:user.base:readonly sheets:spreadsheet:readonly drive:drive:readonly';
const STATE = 'neoclaw-oauth';

const authorizeUrl =
  `${ACCOUNTS}/open-apis/authen/v1/authorize?` +
  `client_id=${encodeURIComponent(APP_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&state=${encodeURIComponent(STATE)}`;

async function exchangeCode(code) {
  const res = await fetch(`${OPEN}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      code,
      redirect_uri: REDIRECT,
    }),
  });
  return res.json();
}

function saveToken(tok) {
  const now = Math.floor(Date.now() / 1000);
  const record = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    // expires_at / refresh_expires_at are absolute epoch seconds for easy checks
    expires_at: now + (tok.expires_in ?? 7200) - 60,
    refresh_expires_at: now + (tok.refresh_token_expires_in ?? 2592000) - 60,
    scope: tok.scope ?? SCOPE,
    domain: DOMAIN,
    saved_at: now,
  };
  writeFileSync(TOKEN_PATH, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return record;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404); res.end('not found'); return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400); res.end('missing code'); return;
  }
  const tok = await exchangeCode(code);
  if (!tok.access_token) {
    res.writeHead(500);
    res.end('Token exchange failed: ' + JSON.stringify(tok));
    console.error('\n❌ Token exchange failed:', JSON.stringify(tok, null, 2));
    server.close();
    process.exit(1);
  }
  const rec = saveToken(tok);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>✅ NeoClaw: Feishu user token saved. You can close this tab.</h2>');
  console.log('\n✅ Saved user token to', TOKEN_PATH);
  console.log('   access_token expires_at :', new Date(rec.expires_at * 1000).toISOString());
  console.log('   refresh_token expires_at:', new Date(rec.refresh_expires_at * 1000).toISOString());
  console.log('   scope:', rec.scope);
  server.close();
  process.exit(0);
});

server.listen(PORT, HOST, () => {
  console.log('NeoClaw Feishu OAuth');
  console.log('====================');
  if (existsSync(TOKEN_PATH)) console.log('(note: an existing token at', TOKEN_PATH, 'will be overwritten)');
  console.log('\n1) Ensure redirect URL is whitelisted in the app console:');
  console.log('     ', REDIRECT);
  console.log('   and user scopes enabled:', SCOPE);
  console.log('\n2) Open this URL in a browser ON THIS MACHINE and log in:\n');
  console.log('     ' + authorizeUrl + '\n');
  console.log('Waiting for the callback on ' + REDIRECT + ' ...');
});
