import { execFile } from 'node:child_process';

/**
 * The operating system's own folder picker, opened by the server.
 *
 * The server always runs on the same machine as the window showing it (it only
 * listens on loopback), so it can raise the native dialog itself. That serves
 * the desktop app and a plain browser tab alike, where a renderer-side picker
 * could do neither: the app has no preload to carry an IPC call, and a browser
 * file input never reveals an absolute path.
 */
export type PickResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unsupported' };

interface Picker {
  cmd: string;
  args: (start: string | null) => string[];
  /** Exit codes that mean the user dismissed the dialog, not that it failed. */
  cancelCodes: number[];
}

function pickerFor(platform: NodeJS.Platform): Picker[] {
  if (platform === 'darwin') {
    return [{
      cmd: 'osascript',
      // `activate` first, or the dialog opens behind the app window that asked
      // for it. The start folder is passed as an argument rather than spliced
      // into the script, so no path can inject AppleScript.
      args: (start) => [
        '-e', 'on run argv',
        '-e', 'activate',
        '-e', 'if (count of argv) > 0 then',
        '-e', 'return POSIX path of (choose folder with prompt "Start a new session in" default location (POSIX file (item 1 of argv)))',
        '-e', 'end if',
        '-e', 'return POSIX path of (choose folder with prompt "Start a new session in")',
        '-e', 'end run',
        ...(start ? [start] : []),
      ],
      // osascript reports "User canceled" (-128) with exit status 1.
      cancelCodes: [1],
    }];
  }
  if (platform === 'linux') {
    return [
      {
        cmd: 'zenity',
        args: (start) => [
          '--file-selection', '--directory', '--title=Start a new session in',
          ...(start ? [`--filename=${start.endsWith('/') ? start : `${start}/`}`] : []),
        ],
        cancelCodes: [1],
      },
      {
        cmd: 'kdialog',
        args: (start) => ['--getexistingdirectory', start ?? '.', '--title', 'Start a new session in'],
        cancelCodes: [1],
      },
    ];
  }
  return [];
}

function run(p: Picker, start: string | null): Promise<PickResult | null> {
  return new Promise((resolve) => {
    // No timeout: the dialog stays up for as long as the person takes to choose.
    execFile(p.cmd, p.args(start), { encoding: 'utf8' }, (err, stdout) => {
      if (!err) {
        // macOS returns a trailing slash on folders; keep paths in the same
        // shape as every other cwd in the app.
        const out = stdout.trim().replace(/(.)\/$/, '$1');
        resolve(out ? { status: 'picked', path: out } : { status: 'cancelled' });
        return;
      }
      const e = err as NodeJS.ErrnoException & { code?: string | number };
      // Not installed: let the caller try the next picker.
      if (e.code === 'ENOENT') return resolve(null);
      if (typeof e.code === 'number' && p.cancelCodes.includes(e.code)) {
        return resolve({ status: 'cancelled' });
      }
      console.error(`[claude-terminal] ${p.cmd} folder picker failed:`, err);
      resolve(null);
    });
  });
}

let open = false;

export async function pickFolder(start: string | null): Promise<PickResult> {
  // One dialog at a time; a second click while one is up would stack another.
  if (open) return { status: 'cancelled' };
  open = true;
  try {
    for (const p of pickerFor(process.platform)) {
      const result = await run(p, start);
      if (result) return result;
    }
    return { status: 'unsupported' };
  } finally {
    open = false;
  }
}
