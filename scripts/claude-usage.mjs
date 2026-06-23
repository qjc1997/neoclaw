/**
 * Fetch Claude subscription usage from claude.ai using Playwright.
 * Usage: node claude-usage.mjs <session_key> [org_id]
 *
 * Requires playwright to be installed in /tmp/pw_check/node_modules or globally.
 * The session_key is the sessionKey cookie value from claude.ai.
 */
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const sessionKey = process.argv[2];
const orgId = process.argv[3] || 'b0d11fd8-e6ac-4329-a8d2-13f5d9887446';

if (!sessionKey) {
  console.error('Usage: node claude-usage.mjs <session_key> [org_id]');
  process.exit(1);
}

// Find playwright: prefer /tmp/pw_check local install
let playwrightPath = '/tmp/pw_check/node_modules/playwright';
if (!existsSync(playwrightPath)) {
  // Try to install it
  execSync('cd /tmp/pw_check && npm install playwright --silent 2>/dev/null', { stdio: 'ignore' });
}

const require = createRequire(import.meta.url);
const { chromium } = require(playwrightPath);

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
});

await ctx.addCookies([{
  name: 'sessionKey', value: sessionKey, domain: 'claude.ai', path: '/', secure: true, httpOnly: true,
}]);

const page = await ctx.newPage();
await page.goto('https://claude.ai/', { timeout: 20000, waitUntil: 'domcontentloaded' }).catch(() => {});

const result = await page.evaluate(async ({ url }) => {
  const r = await fetch(url, { credentials: 'include' });
  return { status: r.status, body: await r.text() };
}, { url: `https://claude.ai/api/organizations/${orgId}/usage` });

await browser.close();

if (result.status === 200) {
  process.stdout.write(result.body);
} else {
  process.stderr.write(`HTTP ${result.status}: ${result.body.slice(0, 200)}\n`);
  process.exit(1);
}
