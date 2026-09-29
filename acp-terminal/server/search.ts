import { store } from './store.js';
import type { AcpSession } from './types.js';

export function searchSessions(query: string): AcpSession[] {
  const q = query.trim().toLowerCase();
  if (!q) return store.getAll();

  const terms = q.split(/\s+/).filter(Boolean);
  const all = store.getAll();

  return all.filter((s) => {
    // Searchable text corpus for this session
    const corpusParts: string[] = [
      s.title,
      s.agentName,
      s.agentId,
      s.cwd,
      s.lastPrompt,
      s.recap,
      s.git?.branch ?? '',
      ...(s.user.tags || []),
      s.user.priority ?? '',
      s.state,
    ];

    // Include message turns and tool calls
    for (const turn of s.turns) {
      if (turn.content) corpusParts.push(turn.content);
      if (turn.thoughts) corpusParts.push(turn.thoughts);
      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          corpusParts.push(tc.title);
          if (tc.output) corpusParts.push(tc.output.slice(0, 1000));
        }
      }
    }

    const corpus = corpusParts.join(' ').toLowerCase();
    return terms.every((term) => corpus.includes(term));
  });
}
