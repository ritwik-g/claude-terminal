/**
 * The rename to CodePit: the one-time move of the data folder from ~/.acp-terminal
 * to ~/.codepit, and the old names (ACP_* variables, x-acp-token) still being accepted.
 * Runs on temp folders only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appEnv } from '../server/env.js';
import { migrateLegacyAppDir } from '../server/paths.js';
import { headerToken } from '../server/security.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepit-migration-test-'));
const warn = console.warn;
const log = console.log;

function setup(name: string): { legacy: string; target: string } {
  const base = path.join(root, name);
  fs.mkdirSync(base);
  return { legacy: path.join(base, '.acp-terminal'), target: path.join(base, '.codepit') };
}

function quietly<T>(fn: () => T): T {
  console.warn = () => {};
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

try {
  test('moves the old folder, leaves a link and rewrites saved paths', () => {
    const { legacy, target } = setup('move');
    fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'uploads', 's1'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'token'), 'abc');
    fs.writeFileSync(path.join(legacy, 'uploads', 's1', 'a.png'), 'png');
    const saved = { attachments: [{ path: path.join(legacy, 'uploads', 's1', 'a.png') }], cwd: '/work/.acp-terminal-notes' };
    fs.writeFileSync(path.join(legacy, 'sessions', 's1.json'), JSON.stringify(saved));
    fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ lan: false }));

    assert.equal(quietly(() => migrateLegacyAppDir(legacy, target)), target);
    assert.equal(fs.readFileSync(path.join(target, 'token'), 'utf8'), 'abc');
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(legacy), fs.realpathSync(target));
    const session = JSON.parse(fs.readFileSync(path.join(target, 'sessions', 's1.json'), 'utf8'));
    assert.equal(session.attachments[0].path, path.join(target, 'uploads', 's1', 'a.png'));
    assert.equal(session.cwd, '/work/.acp-terminal-notes', 'only the folder prefix is rewritten');
    assert.equal(fs.readFileSync(session.attachments[0].path, 'utf8'), 'png');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')), { lan: false });
    assert.equal(fs.readdirSync(path.join(target, 'sessions')).some((f) => f.endsWith('.migrating')), false);
  });

  test('a second start finds the link and uses the new folder', () => {
    const { legacy, target } = setup('again');
    fs.mkdirSync(legacy);
    quietly(() => migrateLegacyAppDir(legacy, target));
    assert.equal(migrateLegacyAppDir(legacy, target), target);
    assert.equal(fs.lstatSync(legacy).isSymbolicLink(), true);
  });

  test('never merges: when both folders exist the new one is used and the old left alone', () => {
    const { legacy, target } = setup('both');
    fs.mkdirSync(legacy);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(legacy, 'token'), 'old');
    assert.equal(migrateLegacyAppDir(legacy, target), target);
    assert.equal(fs.lstatSync(legacy).isDirectory(), true);
    assert.equal(fs.existsSync(path.join(target, 'token')), false);
  });

  test('a fresh install has nothing to move', () => {
    const { legacy, target } = setup('fresh');
    assert.equal(migrateLegacyAppDir(legacy, target), target);
    assert.equal(fs.existsSync(legacy), false);
  });

  test('when the move fails the old folder stays in use', () => {
    const { legacy, target } = setup('fails');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'token'), 'abc');
    // The new folder's parent does not exist, so the rename cannot succeed
    const unreachable = path.join(root, 'fails', 'missing', '.codepit');
    assert.equal(quietly(() => migrateLegacyAppDir(legacy, unreachable)), legacy);
    assert.equal(fs.readFileSync(path.join(legacy, 'token'), 'utf8'), 'abc');
    assert.equal(fs.existsSync(target), false);
  });

  test('CODEPIT_ variables win, the older ACP_ names still work', () => {
    assert.equal(appEnv('APP_DIR', { CODEPIT_APP_DIR: '/new', ACP_APP_DIR: '/old' }), '/new');
    assert.equal(appEnv('APP_DIR', { ACP_APP_DIR: '/old' }), '/old');
    assert.equal(appEnv('APP_DIR', {}), undefined);
  });

  test('the token header is read under its new name and its old one', () => {
    assert.equal(headerToken({ 'x-codepit-token': 'n' }), 'n');
    assert.equal(headerToken({ 'x-acp-token': 'o' }), 'o');
    assert.equal(headerToken({ 'x-codepit-token': 'n', 'x-acp-token': 'o' }), 'n');
    assert.equal(headerToken({ 'x-codepit-token': ['a', 'b'] as any }), undefined);
    assert.equal(headerToken({}), undefined);
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} migration checks passed`);
