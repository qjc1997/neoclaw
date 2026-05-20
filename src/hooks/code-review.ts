/**
 * Code review hook — spawns a separate `claude -p` subprocess to review
 * the diff accumulated in a workspace since the last review.
 *
 * Two modes:
 * - **Internal baseline** (default): the workspace itself is auto-initialized
 *   as a git repo on first review, and each review commits a snapshot so
 *   subsequent reviews diff from that point.
 * - **External target**: if `<workspace>/.review-target` exists and points to
 *   an absolute path that IS a git repo, review `git diff HEAD` there without
 *   touching the user's git state (no add, no commit).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { logger } from '../utils/logger.js';

const log = logger('code-review');

export interface CodeReviewOptions {
  workspaceDir: string;
  model: string;
  timeoutSecs: number;
  /**
   * Files the agent reported as modified during the latest turn (captured from
   * Edit/Write/MultiEdit/NotebookEdit tool_use events). Passed to the reviewer
   * as a focus hint. May be a subset of the full git diff (e.g. omits Bash-driven
   * mutations) — the reviewer is told to consult `git status` if needed.
   */
  mutatedFiles?: string[];
}

export interface CodeReviewResult {
  reviewText: string;
  filesChanged: string[];
  /** Directory actually reviewed (may be external target, not workspace). */
  targetDir: string;
}

/** Name of the per-workspace file that points to an external review target. */
export const REVIEW_TARGET_FILE = '.review-target';

/**
 * Read `<workspace>/.review-target` and return the external target path,
 * or null if the file is absent / empty / comments-only.
 *
 * Supported format: one absolute path per file; lines starting with `#` are
 * comments; blank lines ignored; the first non-comment non-blank line wins.
 */
export function readReviewTarget(workspaceDir: string): string | null {
  const targetFile = join(workspaceDir, REVIEW_TARGET_FILE);
  if (!existsSync(targetFile)) return null;
  const raw = readFileSync(targetFile, 'utf-8');
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    return line;
  }
  return null;
}

async function runGit(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', dir, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stderrText.trim()}`);
  }
  return stdoutText;
}

async function ensureGitRepo(dir: string): Promise<void> {
  if (existsSync(join(dir, '.git'))) return;

  const gitignorePath = join(dir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '.neoclaw/\n.claude/\n.mcp.json\n', 'utf-8');
  }

  await runGit(dir, ['init', '-q']);
  await runGit(dir, ['config', 'user.email', 'neoclaw@localhost']);
  await runGit(dir, ['config', 'user.name', 'neoclaw']);
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-q', '--allow-empty', '-m', 'neoclaw baseline']);
  log.info(`Initialized git repo for code review at ${dir}`);
}

function buildReviewPrompt(diff: string, mutatedFiles: string[] | undefined): string {
  const focusList =
    mutatedFiles && mutatedFiles.length > 0
      ? mutatedFiles.map((f) => `- ${f}`).join('\n')
      : '(not reported — discover via `git status` / `git diff HEAD --name-only`)';

  return `You are an independent, **read-only** code reviewer for an AI assistant's recent edits.

You are running in the directory containing the changes with Read, Grep, and Glob tools (no Edit/Write/Bash). Use them to:
1. Read CLAUDE.md and/or README.md (if present) for project conventions and architecture
2. Inspect the modules around the changed files: imports, callers, type definitions

The full diff is provided below — you do not need shell access to fetch more context.

Focus your review on:
- Bugs and logic errors
- Security issues (command injection, XSS, SQL injection, secrets in code)
- Architectural inconsistency with existing code (e.g. duplicating an existing helper, breaking a layering convention)
- Unclear naming, dead code, or unnecessary complexity
- Missing edge-case handling at system boundaries

Files the agent reported as modified in this turn:
${focusList}

Report findings concisely in Markdown with \`file:line\` references. Group by severity (Blocker / Concern / Nit). If everything looks good, say "LGTM" and briefly describe what the changes do and how they fit the project. Keep the response under 600 words.

Here is the diff:

\`\`\`diff
${diff}
\`\`\``;
}

async function spawnReviewer(
  prompt: string,
  model: string,
  timeoutSecs: number,
  cwd: string
): Promise<string> {
  const env = { ...process.env };
  delete env['CLAUDECODE'];
  delete env['CLAUDE_CODE_ENTRYPOINT'];

  // Reviewer is strictly read-only. The full diff is already in the prompt;
  // Read/Grep/Glob are sufficient to inspect surrounding code & project conventions.
  // Explicitly NO Edit/Write/Bash — a hallucinated mutation must not be able to
  // touch the user's workspace or external review target. This is the contract
  // the file header promises ("no state mutation"); enforce at tool granularity,
  // not via prompt politeness.
  const proc = Bun.spawn(
    ['claude', '-p', prompt, '--model', model, '--allowedTools', 'Read,Grep,Glob'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      cwd,
    }
  );

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }, timeoutSecs * 1000);

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timedOut) throw new Error(`Reviewer timed out after ${timeoutSecs}s`);
    if (exitCode !== 0) {
      throw new Error(`claude -p failed (${exitCode}): ${stderrText.trim()}`);
    }
    return stdoutText.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a code review on the given workspace. Returns null if no code changed
 * since the last review (or if git/workspace is unavailable).
 */
export async function runCodeReview(
  opts: CodeReviewOptions
): Promise<CodeReviewResult | null> {
  const { workspaceDir, model, timeoutSecs, mutatedFiles } = opts;
  if (!existsSync(workspaceDir)) {
    log.warn(`Workspace does not exist: ${workspaceDir}`);
    return null;
  }

  const externalTarget = readReviewTarget(workspaceDir);
  if (externalTarget) {
    validateExternalTarget(externalTarget);
    return reviewExternalTarget(externalTarget, model, timeoutSecs, mutatedFiles);
  }

  return reviewInternalWorkspace(workspaceDir, model, timeoutSecs, mutatedFiles);
}

/** Review an external git repo using `git diff HEAD` — no state mutation. */
async function reviewExternalTarget(
  targetDir: string,
  model: string,
  timeoutSecs: number,
  mutatedFiles?: string[]
): Promise<CodeReviewResult | null> {
  // mutatedFiles paths come from the AI agent running in NeoClaw's workspace
  // (a different directory). Only keep paths that resolve under targetDir;
  // otherwise the focus list misleads the reviewer. Workspace-relative or
  // workspace-absolute paths get dropped — better to omit hints than to lie.
  const targetPrefix = targetDir.endsWith('/') ? targetDir : targetDir + '/';
  const focusFiles = mutatedFiles?.filter(
    (p) => isAbsolute(p) && (p === targetDir || p.startsWith(targetPrefix))
  );
  const focus = focusFiles && focusFiles.length > 0 ? focusFiles : undefined;
  // Tracked changes (modified + deleted) vs HEAD, including staged.
  const diff = await runGit(targetDir, ['diff', 'HEAD', '--']);
  const trackedChanged = (await runGit(targetDir, ['diff', 'HEAD', '--name-only', '--']))
    .split('\n')
    .filter(Boolean);

  // Untracked files: list names only. We don't inline their contents into the
  // diff to keep the prompt bounded and to avoid scraping large untracked blobs.
  const untracked = (await runGit(targetDir, ['ls-files', '--others', '--exclude-standard']))
    .split('\n')
    .filter(Boolean);

  if (!diff.trim() && untracked.length === 0) {
    log.info(`No uncommitted changes in ${targetDir}, skipping review`);
    return null;
  }

  const changedFiles = [...trackedChanged, ...untracked];
  log.info(
    `Reviewing ${trackedChanged.length} tracked + ${untracked.length} untracked file(s) in ${targetDir} with ${model}`
  );

  let augmentedDiff = diff;
  if (untracked.length > 0) {
    augmentedDiff +=
      '\n\n# Untracked files (not yet added to git, shown as list only):\n' +
      untracked.map((f) => `# - ${f}`).join('\n') +
      '\n';
  }

  const prompt = buildReviewPrompt(augmentedDiff, focus);
  const reviewText = await spawnReviewer(prompt, model, timeoutSecs, targetDir);
  return { reviewText, filesChanged: changedFiles, targetDir };
}

/** Review the workspace itself using the neoclaw-managed baseline+snapshot flow. */
async function reviewInternalWorkspace(
  workspaceDir: string,
  model: string,
  timeoutSecs: number,
  mutatedFiles?: string[]
): Promise<CodeReviewResult | null> {
  await ensureGitRepo(workspaceDir);
  await runGit(workspaceDir, ['add', '-A']);
  const staged = await runGit(workspaceDir, ['diff', '--cached']);
  if (!staged.trim()) {
    log.info(`No code changes in ${workspaceDir}, skipping review`);
    return null;
  }

  const changedFiles = (await runGit(workspaceDir, ['diff', '--cached', '--name-only']))
    .split('\n')
    .filter(Boolean);

  log.info(`Reviewing ${changedFiles.length} changed file(s) in ${workspaceDir} with ${model}`);

  const prompt = buildReviewPrompt(staged, mutatedFiles);

  // On reviewer failure (timeout, non-zero exit, etc.), roll back the staged
  // index so the next review starts from a clean baseline — otherwise the
  // failed changes pile up and pollute subsequent review diffs.
  let reviewText: string;
  try {
    reviewText = await spawnReviewer(prompt, model, timeoutSecs, workspaceDir);
    await runGit(workspaceDir, [
      'commit',
      '-q',
      '-m',
      `neoclaw snapshot ${new Date().toISOString()}`,
    ]);
  } catch (err) {
    await runGit(workspaceDir, ['reset', '-q']).catch((resetErr) =>
      log.warn(`git reset after failed review also failed: ${resetErr}`)
    );
    throw err;
  }

  return { reviewText, filesChanged: changedFiles, targetDir: workspaceDir };
}

/** Throw with a clear message if the target path is unusable. */
export function validateExternalTarget(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`Review target must be an absolute path, got: ${path}`);
  }
  if (!existsSync(path)) {
    throw new Error(`Review target does not exist: ${path}`);
  }
  if (!existsSync(join(path, '.git'))) {
    throw new Error(
      `Review target is not a git repo (no .git/): ${path}. Run 'git init' there first, or clear the target.`
    );
  }
}
