import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, FILE_MODE, getLogDir } from './paths.js';

/**
 * An append-only record of what happened to each queued message (queued, sent, sent now,
 * added to the running turn, put back, edited, removed), so a message that seems to have
 * gone missing can be traced. One JSON object per line in <app dir>/logs/queue.jsonl; the
 * file is rotated to queue.1.jsonl past 5 MB.
 */

const MAX_BYTES = 5 * 1024 * 1024;

export type QueueEvent = 'queued' | 'sent' | 'sent-now' | 'steered' | 'requeued' | 'edited' | 'removed';

export function logQueueEvent(sessionId: string, event: QueueEvent, item: { id: string; text?: string }, detail?: string): void {
  try {
    const dir = getLogDir();
    ensurePrivateDir(dir);
    const file = path.join(dir, 'queue.jsonl');
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, 'queue.1.jsonl'));
    } catch {
      // no log yet
    }
    const line = {
      at: new Date().toISOString(),
      sessionId,
      event,
      queueId: item.id,
      text: (item.text ?? '').slice(0, 500),
      ...(detail ? { detail } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: FILE_MODE });
  } catch (err: any) {
    console.warn(`[queue-log] Could not record ${event}: ${err.message}`);
  }
}
