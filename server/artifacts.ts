import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import type { Artifact } from './types.js';

/**
 * Artifacts published by a session.
 *
 * There are two ways one gets into a transcript, and reading only the first
 * lost every artifact of the second kind:
 *
 *   `frame-link`   written when a PAGE is published from a local file. Carries
 *                  the url, the title and the file it came from.
 *   an `Artifact`  written when an artifact is created from an Artifact TYPE
 *   tool call      (a deck, a doc) — `publish` with a `type_url`. Claude Code
 *                  emits NO frame-link for these. The url exists only in the
 *                  tool_result prose, and the title only on the tool_use, so
 *                  the two have to be paired by `tool_use_id`.
 *
 * The second kind is not exotic, it is just newer: its content lives in
 * Claude Docs rather than in a local file, so its `path` comes back empty.
 * Everything else about it is an ordinary artifact.
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

/**
 * A type-create's tool_result opens with this, and nothing else in a
 * transcript does. The url that follows is the artifact's own, NOT the
 * `type_url` the call was made against — that one is the template.
 */
const CREATED_AT = /Created a new Artifact at (https:\/\/\S*?\/artifact\/[A-Za-z0-9_-]+)/;

/**
 * Artifact tool calls still waiting for their result, keyed by tool_use id.
 * Bounded for the same reason the file cache is: a session that publishes all
 * day should not grow this without limit, and an unanswered call — the turn
 * was interrupted — is never resolved and would otherwise sit here forever.
 */
const MAX_PENDING = 200;

async function parse(file: string): Promise<Artifact[]> {
  // Republishing an artifact writes a new frame-link with the SAME frameUrl —
  // that is what an update IS, since the URL is the artifact's identity. The
  // title can change with it ("The Node That Poisoned The Fleet" became "Port
  // Exhaustion On A Fresh Node" at the same URL), so the last record seen wins
  // the title while the first fixes when it was created.
  const byUrl = new Map<string, Artifact>();

  /** tool_use id -> the title that call asked for. */
  const pending = new Map<string, string>();

  const record = (url: string, title: string, path: string, at: number): void => {
    const prev = byUrl.get(url);
    byUrl.set(url, {
      url,
      title: title || untitled(url),
      path,
      createdAt: prev?.createdAt ?? (Number.isNaN(at) ? 0 : at),
      updatedAt: Number.isNaN(at) ? (prev?.updatedAt ?? 0) : at,
      revisions: (prev?.revisions ?? 0) + 1,
    });
  };

  let stream: fs.ReadStream | undefined;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      // Cheap reject before JSON.parse: on a 30MB transcript this is the
      // difference between parsing ~100k records and parsing ~20. Widening it
      // from the one marker to three costs a handful more parses on a session
      // that discusses artifacts without publishing any; those records are
      // thrown out below, on the record itself rather than on the substring.
      if (
        !line.includes('"frame-link"') &&
        !line.includes('"name":"Artifact"') &&
        !line.includes('Created a new Artifact at ')
      ) continue;

      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      const at = rec?.timestamp ? Date.parse(rec.timestamp) : NaN;

      if (rec?.type === 'frame-link') {
        // Some frame-link records carry only an `artifactCount` — a running
        // tally, not a publish. They have no URL to link to and no title to
        // show, so they are not artifacts as far as this view is concerned.
        const url = typeof rec.frameUrl === 'string' ? rec.frameUrl : '';
        if (!url) continue;

        record(
          url,
          typeof rec.title === 'string' ? rec.title : '',
          typeof rec.path === 'string' ? rec.path : '',
          at,
        );
        continue;
      }

      for (const c of contentOf(rec)) {
        if (c?.type === 'tool_use' && c.name === 'Artifact' && typeof c.id === 'string') {
          if (pending.size >= MAX_PENDING) {
            // Oldest insertion first; Map preserves insertion order.
            const oldest = pending.keys().next();
            if (!oldest.done) pending.delete(oldest.value);
          }
          pending.set(c.id, typeof c.input?.title === 'string' ? c.input.title : '');
          continue;
        }

        // A result only counts when it answers a call we saw. The same
        // sentence appears in the Artifact tool's own documentation, which is
        // quoted into plenty of transcripts, and adopting those would put a
        // link to somebody else's artifact on a session that never published.
        if (c?.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        const title = pending.get(c.tool_use_id);
        if (title === undefined) continue;
        pending.delete(c.tool_use_id);
        const m = CREATED_AT.exec(textOf(c.content));
        // A file publish resolves through its frame-link instead; counting it
        // here as well would report every artifact at twice its revisions.
        if (!m) continue;
        // No local file behind it: the content is a Claude Docs document.
        record(m[1], title, '', at);
      }
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

/** The content blocks of a transcript record, whatever shape it arrived in. */
function contentOf(rec: any): any[] {
  const c = rec?.message?.content;
  return Array.isArray(c) ? c : [];
}

/** A tool_result's text, which is either a string or a list of blocks. */
function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
}

/** A publish with no title still deserves to be openable. */
function untitled(url: string): string {
  const id = url.split('/').filter(Boolean).pop() ?? '';
  return id ? `Artifact ${id.slice(0, 8)}` : 'Artifact';
}
