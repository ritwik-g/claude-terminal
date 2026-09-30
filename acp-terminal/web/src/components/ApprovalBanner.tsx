import React, { useState } from 'react';
import type { PendingPermission, PermissionOption } from '../types';
import { Button, Icon } from '../ui';

const isRejectOption = (opt: PermissionOption) => /reject|deny/i.test(`${opt.kind || ''} ${opt.optionId}`);

/**
 * The attention card shown while the agent waits for a permission decision.
 * The agent's own options are mapped to buttons: the first allow-type option
 * is the primary action, other allow options are secondary, reject options
 * are secondary with an x.
 */
export const ApprovalBanner: React.FC<{
  permission: PendingPermission;
  onResolve: (optionId: string) => Promise<void> | void;
  onApproveAndAutoApprove: () => Promise<void> | void;
}> = ({ permission, onResolve, onApproveAndAutoApprove }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const firstAllow = permission.options.find((o) => !isRejectOption(o));
  // Rejects first, other allow options next and the primary allow last, so the
  // row reads "Reject, Allow always, Approve" whatever order the agent sent.
  const ordered = [
    ...permission.options.filter((o) => isRejectOption(o)),
    ...permission.options.filter((o) => !isRejectOption(o) && o !== firstAllow),
    ...(firstAllow ? [firstAllow] : []),
  ];

  const run = async (key: string, fn: () => Promise<void> | void) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="ws-approval" role="alert" aria-label="Approval needed">
      <span className="ws-approval-icon" aria-hidden>
        <Icon name="shield" size={16} />
      </span>
      <div className="ws-approval-body">
        <div className="ws-approval-kicker">{permission.subagent ? `Approval needed · ${permission.subagent} subagent` : 'Approval needed'}</div>
        <div className="ws-approval-title" title={permission.title}>
          {permission.title}
        </div>
      </div>
      <div className="ws-approval-actions">
        <Button
          variant="ghost"
          size="sm"
          icon="zap"
          className="ws-approval-auto"
          disabled={busy !== null}
          loading={busy === 'auto'}
          onClick={() => run('auto', onApproveAndAutoApprove)}
          title="Approve this request and approve all future requests in this session automatically"
        >
          Always approve in this session
        </Button>
        <span className="ws-approval-main">
          {ordered.map((opt) => {
            const reject = isRejectOption(opt);
            const primary = opt === firstAllow;
            return (
              <Button
                key={opt.optionId}
                variant={primary ? 'primary' : 'secondary'}
                size="sm"
                icon={reject ? 'x' : primary ? 'check' : undefined}
                loading={busy === opt.optionId}
                disabled={busy !== null && busy !== opt.optionId}
                onClick={() => run(opt.optionId, () => onResolve(opt.optionId))}
              >
                {opt.name}
              </Button>
            );
          })}
        </span>
      </div>
    </section>
  );
};
