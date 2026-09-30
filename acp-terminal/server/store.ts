import fs from 'node:fs';
import path from 'node:path';
import { getSessionsDir, FILE_MODE, ensurePrivateDir, initStorage } from './paths.js';
import type { AcpSession, UserAnnotations } from './types.js';
import { rankSession } from './rank.js';

function applyRank(session: AcpSession): void {
  const { score, reasons, factors, summary, state } = rankSession(session);
  session.score = score;
  session.reasons = reasons;
  session.rankFactors = factors;
  session.rankSummary = summary;
  session.state = state;
}

class SessionStore {
  private sessions = new Map<string, AcpSession>();
  private initialized = false;

  init(): void {
    if (this.initialized) return;
    initStorage();

    const sessionsDir = getSessionsDir();
    // Load persisted sessions from sessionsDir
    try {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const filePath = path.join(sessionsDir, file);
          const raw = fs.readFileSync(filePath, 'utf8');
          const session = JSON.parse(raw) as AcpSession;
          if (session && session.id) {
            applyRank(session);
            this.sessions.set(session.id, session);
          }
        } catch (err) {
          console.warn(`[codepit] Failed to parse session ${file}:`, err);
        }
      }
    } catch {
      // Directory empty or not created yet
    }

    this.initialized = true;
  }

  clear(): void {
    this.sessions.clear();
    this.initialized = false;
  }

  getAll(): AcpSession[] {
    this.init();
    return Array.from(this.sessions.values());
  }

  get(id: string): AcpSession | null {
    this.init();
    return this.sessions.get(id) ?? null;
  }

  /**
   * Re-rank and persist a session. `touch: false` keeps updatedAt for bookkeeping writes
   * (background git refresh, snooze expiry) so they do not count as user/agent activity
   * in the recency ranking.
   */
  save(session: AcpSession, opts: { touch?: boolean } = {}): void {
    this.init();
    // Touch first so "Active just now" reflects this write
    if (opts.touch !== false) {
      session.updatedAt = Date.now();
    }
    applyRank(session);

    this.sessions.set(session.id, session);
    this.persist(session);
  }

  delete(id: string): boolean {
    this.init();
    const removed = this.sessions.delete(id);
    if (removed) {
      try {
        const filePath = path.join(getSessionsDir(), `${id}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // ignore delete failure
      }
    }
    return removed;
  }

  updateAnnotations(id: string, updates: Partial<UserAnnotations>): AcpSession | null {
    const session = this.get(id);
    if (!session) return null;

    session.user = {
      ...session.user,
      ...updates,
    };

    this.save(session);
    return session;
  }

  private persist(session: AcpSession): void {
    try {
      const sessionsDir = getSessionsDir();
      ensurePrivateDir(sessionsDir);
      const filePath = path.join(sessionsDir, `${session.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session), {
        mode: FILE_MODE,
        encoding: 'utf8',
      });
    } catch (err) {
      console.error(`[codepit] Failed to persist session ${session.id}:`, err);
    }
  }
}

export const store = new SessionStore();
