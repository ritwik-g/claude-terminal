import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { GitInfo } from './types.js';

const exec = promisify(execFile);
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; info: GitInfo }>();

export async function getGitInfo(cwd: string): Promise<GitInfo | null> {
  if (!cwd || !fs.existsSync(cwd)) return null;

  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  const info: GitInfo = {
    branch: '',
    uncommittedFiles: 0,
    unpushedCommits: 0,
    isClean: true,
    repoRoot: cwd,
  };

  try {
    const { stdout } = await exec(
      'git',
      [
        '-c', 'core.fsmonitor=',
        '-c', 'core.hooksPath=/dev/null',
        '--no-optional-locks',
        'status', '--porcelain=v2', '--branch',
      ],
      { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }
    );

    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        const branchName = line.slice('# branch.head '.length).trim();
        info.branch = branchName === '(detached)' ? 'detached' : branchName;
      } else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+)\s+-(\d+)/);
        if (m) {
          info.unpushedCommits = Number(m[1]);
        }
      } else if (line && !line.startsWith('#')) {
        info.uncommittedFiles++;
      }
    }

    info.isClean = info.uncommittedFiles === 0 && info.unpushedCommits === 0;

    // Discover repository root
    try {
      const { stdout: rootOut } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd, timeout: 2000 });
      info.repoRoot = rootOut.trim();
    } catch {
      info.repoRoot = cwd;
    }
  } catch {
    // Not a git repository
    cache.set(cwd, { at: Date.now(), info });
    return null;
  }

  cache.set(cwd, { at: Date.now(), info });
  return info;
}
