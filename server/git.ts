import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import type { GitInfo } from './types.js';

const exec = promisify(execFile);
const TTL_MS = 30_000;

const cache = new Map<string, { at: number; info: GitInfo }>();

/**
 * Many sessions share a cwd, so results are cached per directory with a short
 * TTL. Git calls are the slowest thing in a refresh; without this a rescan
 * shells out ~130 times.
 */
export async function gitInfo(cwd: string): Promise<GitInfo | null> {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  if (!fs.existsSync(cwd)) {
    const info: GitInfo = {
      branch: '', dirty: 0, ahead: 0, behind: 0, isWorktree: false, exists: false,
    };
    cache.set(cwd, { at: Date.now(), info });
    return info;
  }

  const info: GitInfo = {
    branch: '', dirty: 0, ahead: 0, behind: 0, isWorktree: false, exists: true,
  };

  try {
    // --porcelain=v2 --branch gives branch, upstream divergence and file states
    // in a single call, which keeps this to one process per directory.
    const { stdout } = await exec(
      'git',
      ['status', '--porcelain=v2', '--branch', '--untracked-files=no'],
      { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    );
    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        info.branch = line.slice('# branch.head '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          info.ahead = Number(m[1]);
          info.behind = Number(m[2]);
        }
      } else if (line && !line.startsWith('#')) {
        info.dirty++;
      }
    }

    // A linked worktree has .git as a file pointing at the real gitdir.
    try {
      info.isWorktree = fs.statSync(`${cwd}/.git`).isFile();
    } catch {
      info.isWorktree = false;
    }
  } catch {
    // not a repo, or git unavailable — leave the zeroed info
  }

  cache.set(cwd, { at: Date.now(), info });
  return info;
}

export async function gitInfoForAll(cwds: string[]): Promise<Map<string, GitInfo>> {
  const unique = [...new Set(cwds.filter(Boolean))];
  const out = new Map<string, GitInfo>();
  const results = await Promise.all(unique.map((c) => gitInfo(c).then((i) => [c, i] as const)));
  for (const [c, i] of results) if (i) out.set(c, i);
  return out;
}
