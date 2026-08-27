import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import type { Artifact } from './types.js';

/**
 * Artifacts published by a session, read from its `frame-link` records.
 *
 * These deliberately do NOT go through scan.ts. That scanner samples the first
 * 256KB and last 1MB of each transcript, which is sound for titles, last-prompt
 * and pr-link because Claude Code re-emits those throughout the file — the tail
 * always holds the current value. A `frame-link` is written ONCE, at the moment
 * you publish, and then never again. Measured across this corpus, 51 of the 71
 * artifacts in transcripts larger than that window fall between the two sampled
 * ranges: folding them into scan.ts would have shown roughly a quarter of them
 * while looking perfectly healthy.
 *
 * So they are read on demand, whole-file, for the one session you are looking
 * at. That is a few tens of milliseconds even for the largest transcript here,
 * against every-session-every-poll for the sampled alternative.
 */

const MAX_ARTIFACTS = 60;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  artifacts: Artifact[];
}

/**
 * Keyed by transcript path. Bounded because a long-lived app browsing a large
 * corpus would otherwise retain an entry per session ever selected.
 */
const cache = new Map<string, CacheEntry>();
const MAX_CACHED_FILES = 200;

export async function readArtifacts(file: string): Promise<Artifact[]> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    return [];
  }

  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.artifacts;

  const artifacts = await parse(file);

  if (cache.size >= MAX_CACHED_FILES) {
    // Oldest insertion first; Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, artifacts });
  return artifacts;
}

async function parse(file: string): Promise<Artifact[]> {
  // Republishing an artifact writes a new frame-link with the SAME frameUrl —
  // that is what an update IS, since the URL is the artifact's identity. The
  // title can change with it ("The Node That Poisoned The Fleet" became "Port
  // Exhaustion On A Fresh Node" at the same URL), so the last record seen wins
  // the title while the first fixes when it was created.
  const byUrl = new Map<string, Artifact>();

  let stream: fs.ReadStream | undefined;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      // Cheap reject before JSON.parse: on a 30MB transcript this is the
      // difference between parsing ~100k records and parsing ~20.
      if (!line.includes('"frame-link"')) continue;

      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.type !== 'frame-link') continue;

      // Some frame-link records carry only an `artifactCount` — a running
      // tally, not a publish. They have no URL to link to and no title to
      // show, so they are not artifacts as far as this view is concerned.
      const url = typeof rec.frameUrl === 'string' ? rec.frameUrl : '';
      if (!url) continue;

      const at = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
      const prev = byUrl.get(url);
      byUrl.set(url, {
        url,
        title: typeof rec.title === 'string' && rec.title ? rec.title : untitled(url),
        path: typeof rec.path === 'string' ? rec.path : '',
        createdAt: prev?.createdAt ?? (Number.isNaN(at) ? 0 : at),
        updatedAt: Number.isNaN(at) ? (prev?.updatedAt ?? 0) : at,
        revisions: (prev?.revisions ?? 0) + 1,
      });
    }
  } catch {
    // A transcript we cannot read yields no artifacts, which is what the UI
    // would show anyway; there is nothing here worth failing the request over.
    return [];
  } finally {
    stream?.destroy();
  }

  // Most recently touched first — the thing you just published is the thing
  // you are most likely to want to open.
  return [...byUrl.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ARTIFACTS);
}

/** A publish with no title still deserves to be openable. */
function untitled(url: string): string {
  const id = url.split('/').filter(Boolean).pop() ?? '';
  return id ? `Artifact ${id.slice(0, 8)}` : 'Artifact';
}
