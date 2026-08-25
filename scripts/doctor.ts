/** Diagnostics: prove the scanner and live registry agree with reality. */
import { scanAll, loadCache, saveCache } from '../server/scan.js';
import { readLiveSessions } from '../server/live.js';

const t0 = Date.now();
loadCache();
const sessions = await scanAll();
const cold = Date.now() - t0;
saveCache();

const t1 = Date.now();
await scanAll();
const warm = Date.now() - t1;

const live = readLiveSessions();
console.log(`scanned ${sessions.length} sessions  cold=${cold}ms  warm=${warm}ms`);
console.log(`live registry: ${live.size} running  (${[...live.values()].filter((l) => l.status === 'busy').length} busy)\n`);

const recent = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, 12);
console.log('when        title                              src     lastRole  stop       midtool live  pr    branch');
for (const x of recent) {
  const l = live.get(x.id);
  console.log(
    `${new Date(x.lastActivity).toISOString().slice(5, 16)}  ` +
      `${x.title.slice(0, 33).padEnd(33)} ${x.titleSource.padEnd(7)} ` +
      `${(x.tail.lastRole ?? '-').padEnd(9)} ${(x.tail.lastStopReason ?? '-').padEnd(10)} ` +
      `${(x.tail.endedMidTool ? 'Y' : '.').padEnd(7)} ${(l ? l.status : '-').padEnd(5)} ` +
      `${String(x.pr?.number ?? '-').padEnd(5)} ${x.branch}`,
  );
}

const noTitle = sessions.filter((s) => s.titleSource === 'id').length;
const noCwd = sessions.filter((s) => !s.cwd).length;
console.log(`\nunnamed: ${noTitle}   missing cwd: ${noCwd}   with PR: ${sessions.filter((s) => s.pr).length}`);
