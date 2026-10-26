/**
 * Recognising Claude Code CLI failures that arrive on the happy path.
 *
 * The CLI does not always signal failure out of band. A failed turn comes back
 * as an ordinary `result` event with `is_error` set, and a failed one-shot
 * `claude -p` prints its message to **stdout** before exiting non-zero. Callers
 * that read only the text therefore relay CLI errors to end users as if the
 * assistant had written them — this is how "Failed to authenticate: OAuth
 * session expired and could not be refreshed" was posted into Feishu chats,
 * both as a reply card and as an English-coach suggestion.
 */

/** Backend failures that leave a pooled subprocess permanently unusable. */
const AUTH_ERROR_RE =
  /OAuth session expired|Failed to authenticate|Invalid API key|authentication[_ ]error|Please run `?\/login/i;

/**
 * Text shapes the CLI emits instead of model output. Deliberately narrow —
 * a false positive silently swallows a genuine reply, which is worse than
 * letting an unrecognised error through to the existing error path.
 */
const BACKEND_ERROR_RE = new RegExp(
  [
    AUTH_ERROR_RE.source,
    'Credit balance is too low',
    'rate limit exceeded',
    'Usage limit reached',
    '^Execution error(:|$)',
    '^API Error:',
  ].join('|'),
  'i'
);

/** True when `text` is an authentication failure rather than model output. */
export function isAuthErrorText(text: string): boolean {
  return AUTH_ERROR_RE.test(text);
}

/** True when `text` is a CLI error message rather than model output. */
export function isBackendErrorText(text: string): boolean {
  return BACKEND_ERROR_RE.test(text);
}

/**
 * Render a failed turn so it cannot be mistaken for an assistant reply.
 * Any real output produced before the failure is preserved above the notice.
 */
export function formatBackendError(errorText: string, partialText = ''): string {
  const detail = errorText.trim() || 'The agent backend reported a failure with no detail.';
  // The CLI normally emits the failure as an assistant text block AS WELL as
  // in the result event, so `partialText` usually just repeats it. Strip those
  // copies out and keep only genuine output produced before the failure —
  // otherwise the notice renders the same message twice.
  const partial = partialText.trim().split(detail).join('').trim();
  const hint = isAuthErrorText(detail)
    ? '\n\nRe-authenticate the Claude Code CLI on this host (`claude` → `/login`), then retry.'
    : '';
  const quoted = detail.replace(/\n/g, '\n> ');
  return (
    (partial ? `${partial}\n\n---\n\n` : '') +
    `⚠️ **Agent error** — the backend failed; this is not a reply.\n\n> ${quoted}${hint}`
  );
}
