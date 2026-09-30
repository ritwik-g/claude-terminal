import { createContext, useContext } from 'react';

/**
 * Opens the focused view of one or more agent tasks (subagents, background
 * work, workflows) in the session's Agents tab. Provided by SessionDetail so
 * a subagent card anywhere in the transcript can link to it; null elsewhere.
 */
export const AgentTaskNavContext = createContext<((...taskIds: string[]) => void) | null>(null);

export const useOpenAgentTask = () => useContext(AgentTaskNavContext);
