/**
 * Orphaned workspace-process reaper.
 *
 * Agents routinely start long-lived background processes from a workspace
 * (`vite`, `next dev`, watchers…). Those are children of the Claude Code
 * subprocess, so when the pool reaps that subprocess after its idle timeout
 * the background process is re-parented to init (PPID 1) and survives forever
 * — nothing in the tree remembers it exists. Observed in the wild: two vite
 * servers orphaned for 6+ days, each re-forking a dozen `tsc` type-check
 * workers, together enough to push an 8 GB host into permanent swap thrash.
 *
 * A process is a candidate when ALL of the following hold:
 *   1. PPID is 1 — nothing is supervising it any more.
 *   2. Its CWD is inside the neoclaw workspaces root.
 *   3. It has been orphaned longer than a grace period.
 *   4. Its command does not match PROTECTED_PATTERNS.
 *
 * (4) exists because (2) turned out NOT to be a safe kill signal on its own.
 * A workspace CWD only records where a process was launched from, not what it
 * belongs to: an agent that ran `colima start` in a workspace leaves the
 * machine's entire Docker VM (limactl usernet/hostagent + its ssh mux)
 * orphaned under that path. Reaping those on a "stale dev server" rule would
 * tear down Docker for the whole host. The same applies to SSH port-forward
 * tunnels and mDNS browsers.
 *
 * Because no local signal reliably separates "abandoned dev server" from
 * "host-wide service launched from the wrong directory", the default mode is
 * REPORT — candidates are logged, nothing is killed. Killing is opt-in via
 * `orphanReaper.mode: "kill"`.
 */

import { readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from './logger.js';

const log = logger('orphans');

export interface OrphanProc {
  pid: number;
  /** Seconds since the process started. */
  ageSecs: number;
  cwd: string;
  command: string;
}

/**
 * Host-wide services that are never reaped even when orphaned under a
 * workspace — they outlive any single conversation by design, and killing
 * them breaks things far outside neoclaw (Docker, tunnels, VMs).
 */
export const PROTECTED_PATTERNS: RegExp[] = [
  /\b(limactl|colima|lima-guestagent)\b/,
  /\b(dockerd|containerd|docker-proxy|podman)\b/,
  /\bqemu-system-/,
  /\bssh\b/, // port-forward tunnels and ssh mux masters
  /\bdns-sd\b/,
  /\b(sshd|gpg-agent|ssh-agent)\b/,
];

export function isProtected(command: string): boolean {
  return PROTECTED_PATTERNS.some((re) => re.test(command));
}

/** Parse `ps` etime ([[dd-]hh:]mm:ss) into seconds. */
export function parseEtime(etime: string): number {
  const trimmed = etime.trim();
  const [dayPart, clockPart] = trimmed.includes('-')
    ? (trimmed.split('-') as [string, string])
    : ['0', trimmed];
  const days = Number(dayPart) || 0;
  // clockPart is [hh:]mm:ss — fold left so each field carries the next up.
  let secs = 0;
  for (const p of clockPart.split(':')) secs = secs * 60 + (Number(p) || 0);
  return days * 86400 + secs;
}

/** Resolve a process's CWD. Returns null if it cannot be determined. */
async function procCwd(pid: number): Promise<string | null> {
  // Linux exposes this for free; only fall back to lsof (a fork + scan) on
  // platforms that need it.
  if (process.platform === 'linux') {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const proc = Bun.spawn(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim();
    }
  } catch {
    // lsof missing or refused — treat as undeterminable
  }
  return null;
}

/**
 * Find processes orphaned under `workspacesRoot` for at least `minAgeSecs`.
 */
export async function findOrphans(
  workspacesRoot: string,
  minAgeSecs: number
): Promise<OrphanProc[]> {
  const root = resolve(workspacesRoot);

  let psOut: string;
  try {
    const proc = Bun.spawn(['ps', '-eo', 'pid=,ppid=,etime=,command='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    psOut = await new Response(proc.stdout).text();
    await proc.exited;
  } catch (err) {
    log.warn(`Could not list processes: ${err}`);
    return [];
  }

  // Narrow to PPID-1 processes FIRST so the expensive per-pid CWD lookup runs
  // on a handful of candidates rather than every process on the box.
  const candidates: Array<{ pid: number; ageSecs: number; command: string }> = [];
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, ppidStr, etime, command] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (Number(ppidStr) !== 1) continue;
    const pid = Number(pidStr);
    if (pid === process.pid) continue;
    const ageSecs = parseEtime(etime);
    if (ageSecs < minAgeSecs) continue;
    if (isProtected(command)) continue;
    candidates.push({ pid, ageSecs, command });
  }

  const orphans: OrphanProc[] = [];
  for (const c of candidates) {
    const cwd = await procCwd(c.pid);
    if (!cwd) continue;
    const resolved = resolve(cwd);
    if (resolved !== root && !resolved.startsWith(root + '/')) continue;
    orphans.push({ pid: c.pid, ageSecs: c.ageSecs, cwd: resolved, command: c.command });
  }
  return orphans;
}

/** Collect a process and all of its descendants, deepest-last. */
async function withDescendants(pid: number): Promise<number[]> {
  let psOut: string;
  try {
    const proc = Bun.spawn(['ps', '-eo', 'pid=,ppid='], { stdout: 'pipe', stderr: 'ignore' });
    psOut = await new Response(proc.stdout).text();
    await proc.exited;
  } catch {
    return [pid];
  }
  const children = new Map<number, number[]>();
  for (const line of psOut.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (!m) continue;
    const child = Number(m[1]);
    const parent = Number(m[2]);
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    out.push(p);
    for (const c of children.get(p) ?? []) if (!out.includes(c)) walk(c);
  };
  walk(pid);
  return out;
}

/**
 * Terminate orphaned processes and their descendants (SIGTERM, then SIGKILL
 * for anything still alive). Returns the number of process trees reaped.
 */
export async function killOrphans(orphans: OrphanProc[]): Promise<number> {
  let reaped = 0;
  for (const o of orphans) {
    const tree = await withDescendants(o.pid);
    log.warn(
      `Reaping orphan tree pid=${o.pid} (${tree.length} procs, orphaned ${Math.round(o.ageSecs / 3600)}h) ` +
        `cwd=${o.cwd} cmd=${o.command.slice(0, 120)}`
    );
    // Kill children before parents so a supervisor cannot respawn them.
    for (const pid of tree.slice().reverse()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    reaped++;
  }
  if (reaped === 0) return 0;

  await Bun.sleep(3000);
  for (const o of orphans) {
    for (const pid of await withDescendants(o.pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone — the expected path
      }
    }
  }
  return reaped;
}

export type ReaperMode = 'report' | 'kill';

/**
 * One sweep. In 'report' mode (the default) candidates are only logged — see
 * the module header for why killing is not safe to enable unattended.
 * Returns the candidates found.
 */
export async function sweepOrphans(
  workspacesRoot: string,
  minAgeSecs: number,
  mode: ReaperMode = 'report'
): Promise<OrphanProc[]> {
  const orphans = await findOrphans(workspacesRoot, minAgeSecs);
  if (orphans.length === 0) return orphans;

  if (mode === 'kill') {
    await killOrphans(orphans);
    return orphans;
  }

  log.warn(
    `${orphans.length} orphaned workspace process(es) found — NOT killed ` +
      `(orphanReaper.mode is "report"; set it to "kill" to reap automatically):`
  );
  for (const o of orphans) {
    log.warn(
      `  pid=${o.pid} orphaned=${(o.ageSecs / 3600).toFixed(1)}h cwd=${o.cwd} ` +
        `cmd=${o.command.slice(0, 120)}`
    );
  }
  return orphans;
}

/**
 * Start periodic orphan sweeping. Returns a stop function.
 */
export function startOrphanSweeper(opts: {
  workspacesRoot: string;
  minAgeSecs: number;
  intervalMs: number;
  mode: ReaperMode;
}): () => void {
  const run = () => {
    sweepOrphans(opts.workspacesRoot, opts.minAgeSecs, opts.mode)
      .then((found) => {
        if (found.length > 0 && opts.mode === 'kill') {
          log.info(`Orphan sweep reaped ${found.length} process tree(s)`);
        }
      })
      .catch((err) => log.warn(`Orphan sweep failed: ${err}`));
  };
  run();
  const timer = setInterval(run, opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
