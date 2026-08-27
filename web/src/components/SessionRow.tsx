import React from 'react';
import type { Session } from '../../../server/types';
import { STATE_COLOR, STATE_LABEL, SHAPE_GLYPH, SHAPE_HINT, relTime, shortId, shortPath } from '../util';

interface Props {
  s: Session;
  selected: boolean;
  atCursor: boolean;
  now: number;
  onClick: () => void;
}

export const SessionRow = React.memo(function SessionRow({ s, selected, atCursor, now, onClick }: Props) {
  const dotColor = STATE_COLOR[s.state];
  // The primary line under the title is the single most useful fact we have:
  // what you last asked, else the running recap, else where it lives.
  const sub = s.lastPrompt || s.recap || shortPath(s.cwd);
  // reasons[0] restates the group header for the three states that map 1:1 to
  // a bucket, so it wastes the line. But 'crashed' shares the *Needs you*
  // bucket with 'needs_you' — there it is the ONLY thing telling them apart —
  // and 'quiet' has no state reason at all, so reasons[0] is already real
  // detail. Blindly slicing from 1 blanked 95 of 135 rows.
  const restatesHeader =
    s.state === 'needs_you' || s.state === 'working' || s.state === 'parked';
  const detail = (restatesHeader ? s.reasons.slice(1, 3) : s.reasons.slice(0, 2)).join(' · ');

  return (
    <div
      className={
        `row${selected ? ' sel' : ''}${atCursor ? ' cursor' : ''}` +
        (s.user.priority ? ` pri-${s.user.priority}` : '')
      }
      onClick={onClick}
      role="option"
      aria-selected={selected}
      id={s.id}
      data-session-row={s.id}
      title={s.reasons.length ? s.reasons.join(' · ') : undefined}
    >
      <span
        className={`row-dot${s.state === 'working' ? ' pulse' : ''}`}
        style={{ background: dotColor }}
        aria-hidden
      />
      <span className="sr-only">{STATE_LABEL[s.state]}</span>
      <div className="row-main">
        <div className="row-title">
          {s.shape !== 'task' && (
            <span className={`shape ${s.shape}`} title={SHAPE_HINT[s.shape]}>
              {SHAPE_GLYPH[s.shape]}
            </span>
          )}
          {s.title}
        </div>
        <div className="row-sub">
          {/* Every id is the same width in a mono font, so this reads as a
              column you can scan down rather than as prose. */}
          <span className="row-id" title={s.id}>{shortId(s.id)}</span>
          {' · '}
          {detail && <span className="row-reason">{detail}</span>}
          {detail && sub ? ' · ' : ''}
          {sub}
        </div>
      </div>
      <div className="row-meta">
        <span className="row-age">{relTime(s.lastActivity, now)}</span>
        <div className="chips">
          {s.user.pinned && <span className="chip pin">pin</span>}
          {s.user.priority && <span className={`chip pri ${s.user.priority}`}>{s.user.priority.toUpperCase()}</span>}
          {s.attached && <span className="chip live">term</span>}
          {/* Derived, so it costs no tag slot and cannot be removed by hand —
              it says what the session IS, not what someone filed it under. */}
          {s.review && (
            <span className="chip review" title={`Opened with /${s.review.command}`}>review</span>
          )}
          {/* The PR being reviewed stands in when the session raised none of
              its own, which is the usual case when reviewing someone else. */}
          {(s.pr ?? s.review?.pr) && (
            <span className="chip pr">#{(s.pr ?? s.review!.pr)!.number}</span>
          )}
          {s.user.tags.slice(0, 1).map((t) => (
            <span className="chip tag" key={t}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
});
