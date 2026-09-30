/**
 * Runs an agent's JavaScript entry point with the CodePit desktop app's own executable
 * in Node mode. A packaged app has no `node` of its own, and there's no telling
 * whether the user's is new enough, so agents run on the Node inside Electron:
 *
 *   ELECTRON_RUN_AS_NODE=1 <app executable> agent-launcher.mjs <entry> [args...]
 *
 * The flag is meant for this process only. Left in the environment it would reach
 * everything the agent starts, and an Electron app run from a tool call (VS Code's
 * `code`, `npm run app`) would come up as bare Node. So it's removed here, and put
 * back only for children that re-launch this same executable to run JS, which is
 * how codex-acp starts its bundled Codex CLI.
 */
import childProcess from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const self = fileURLToPath(import.meta.url);
const entry = process.argv[2];
if (!entry) {
  console.error('usage: agent-launcher <entry> [args...]');
  process.exit(2);
}

delete process.env.ELECTRON_RUN_AS_NODE;

type Env = NodeJS.ProcessEnv;
const nodeModeEnv = (env: Env | undefined): Env => ({ ...(env ?? process.env), ELECTRON_RUN_AS_NODE: '1' });

// spawn(cmd, args?, options?): options move up a slot when args are left out
const split = (rest: any[]): [string[], any] => (Array.isArray(rest[0]) ? [rest[0], rest[1]] : [[], rest[0]]);

const { spawn, execFile, fork } = childProcess;

(childProcess as any).spawn = function (command: string, ...rest: any[]) {
  if (command !== process.execPath) return (spawn as any).call(this, command, ...rest);
  const [args, options] = split(rest);
  // A script goes through this launcher again, so its own children get a clean environment too
  const argv = args[0] && !args[0].startsWith('-') ? [self, ...args] : args;
  return spawn(command, argv, { ...options, env: nodeModeEnv(options?.env) });
};

const nodeModeArgs = (rest: any[]): any[] => {
  const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined;
  const [args, options] = split(rest);
  return [args, { ...options, env: nodeModeEnv(options?.env) }, ...(callback ? [callback] : [])];
};
const execFileAsync = promisify(execFile);
const patchedExecFile: any = function (this: unknown, file: string, ...rest: any[]) {
  return (execFile as any).apply(this, [file, ...(file === process.execPath ? nodeModeArgs(rest) : rest)]);
};
// promisify(execFile) resolves { stdout, stderr } only through this hook; without it callers get a bare string
patchedExecFile[promisify.custom] = (file: string, ...rest: any[]) =>
  (execFileAsync as any)(file, ...(file === process.execPath ? nodeModeArgs(rest) : rest));
(childProcess as any).execFile = patchedExecFile;

// fork() runs its module on process.execPath by default, so it always needs Node mode
(childProcess as any).fork = function (modulePath: string, ...rest: any[]) {
  const [args, options] = split(rest);
  return fork(modulePath, args, { ...options, env: nodeModeEnv(options?.env) });
};

// Named imports of node:child_process (`import { spawn } from ...`) are snapshots until synced
syncBuiltinESMExports();

// The entry sees the argv it would have had if run directly: [execPath, entry, ...args]
process.argv.splice(1, 1);
await import(pathToFileURL(path.resolve(entry)).href);
