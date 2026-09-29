import React from 'react';
import type { ToolCallRecord } from '../types';
import { Badge, type Tone } from '../ui';

const VIEW: Record<NonNullable<ToolCallRecord['backgroundState']>, { label: string; tone: Tone }> = {
  running: { label: 'Background', tone: 'info' },
  completed: { label: 'Background done', tone: 'ok' },
  failed: { label: 'Background failed', tone: 'danger' },
  stopped: { label: 'Background stopped', tone: 'neutral' },
};

/** Where a call's background work stands; renders nothing for foreground calls. */
export const BackgroundBadge: React.FC<{ call: ToolCallRecord }> = ({ call }) => {
  if (!call.background) return null;
  const view = VIEW[call.backgroundState ?? 'running'];
  return (
    <Badge tone={view.tone} title={call.backgroundSummary}>
      {view.label}
    </Badge>
  );
};
