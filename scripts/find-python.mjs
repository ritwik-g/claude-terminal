/**
 * Print a Python that node-gyp can actually use.
 *
 * node-gyp (the version electron-builder vendors) imports `distutils`, which
 * was REMOVED from the stdlib in Python 3.12. On a machine whose default
 * python3 is 3.12+, every native rebuild fails with a bare
 * "ModuleNotFoundError: No module named 'distutils'" that says nothing about
 * the real cause. Probe for an interpreter that still has it.
 */
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
  process.env.PYTHON,
  process.env.npm_config_python,
  '/usr/bin/python3',          // macOS ships 3.9 — real stdlib distutils
  'python3.11',
  'python3.10',
  'python3.9',
  'python3',
].filter(Boolean);

for (const py of CANDIDATES) {
  try {
    execFileSync(py, ['-c', 'import distutils'], { stdio: 'ignore', timeout: 5000 });
    process.stdout.write(py);
    process.exit(0);
  } catch {
    // not present, or no distutils — try the next
  }
}

console.error(
  'No Python with distutils found. node-gyp needs it to build node-pty.\n' +
  '  macOS: /usr/bin/python3 normally works.\n' +
  '  Otherwise: pip install setuptools  (into a venv), then PYTHON=/path/to/python npm run dist',
);
process.exit(1);
