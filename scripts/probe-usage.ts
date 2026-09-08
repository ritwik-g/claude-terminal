/**
 * Manual check for the usage probe: refresh the cache the way the server does
 * and print what came back. Run it when Claude Code changes how `/usage`
 * works — a silent failure here shows up in the app as a number that quietly
 * stops moving.
 */
import { readUsage, refreshUsage } from '../server/usage.js';

function show(label: string, snap: Awaited<ReturnType<typeof refreshUsage>>): void {
  if (!snap) {
    console.log(`${label}: no cached usage`);
    return;
  }
  const age = Math.round((Date.now() - snap.fetchedAt) / 1000);
  console.log(`${label}: fetched ${age}s ago${snap.stale ? ' (STALE)' : ''}`);
  for (const [name, w] of [['5-hour', snap.fiveHour], ['weekly', snap.weekly]] as const) {
    if (!w) continue;
    const resets = w.resetsAt ? new Date(w.resetsAt).toLocaleString() : 'unknown';
    console.log(`  ${name}: ${w.percent}% used, resets ${resets}`);
  }
}

const t0 = Date.now();
show('before', readUsage());
console.log('probing…');
const after = await refreshUsage();
show(`after (${Math.round((Date.now() - t0) / 1000)}s)`, after);
