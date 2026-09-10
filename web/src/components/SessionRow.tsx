import React from 'react';
import type { Session } from '../../../server/types';
import { STATE_COLOR, STATE_LABEL, SHAPE_GLYPH, SHAPE_HINT, relTime, shortId, shortPath } from '../util';

/** How many of a review's PRs get their own chip before the rest collapse. */
const PR_CHIPS = 3;

interface Props {
  s: Session;
  selected: boolean;
  atCursor: boolean;
  now: number;
  /** Finished while you were away and not opened since — see App's seenDone. */
  unseenDone: boolean;
  onClick: () => void;
}

export const SessionRow = React.memo(function SessionRow({
  s, selected, atCursor, now, unseenDone, onClick,
}: Props) {
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

  const reviewPrs = s.review?.prs ?? [];
  // The strip is a fixed width and scrolls, so on a busy row some of it is
  // always off-screen. Spelling the whole set out in words gives the hover a
  // job beyond decoration — it is the only place the hidden chips are legible.
  const chipWords = [
    s.user.pinned ? 'pinned' : null,
    s.user.priority ? s.user.priority.toUpperCase() : null,
    s.attached ? 'terminal open' : null,
    s.review ? `review · /${s.review.command}` : null,
    ...(s.pr ? [`PR #${s.pr.number}`] : reviewPrs.map((p) => `${p.repository} #${p.number}`)),
    ...s.user.tags,
  ].filter(Boolean) as string[];

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
      {/* The unseen-completion marker rides on the state dot as a halo rather
          than sitting among the chips. It used to be the first child of a
          right-aligned, clipped strip, which made it the very first thing to
          disappear on exactly the busy rows most worth flagging. This column
          is a fixed 14px and holds one glyph, so it can never be crowded out. */}
      <span
        className={
          `row-dot${s.state === 'working' ? ' pulse' : ''}${unseenDone ? ' unseen' : ''}`
        }
        style={{ background: dotColor }}
        title={unseenDone ? 'Stopped since you last looked — open it to clear' : undefined}
        aria-hidden
      />
      <span className="sr-only">
        {STATE_LABEL[s.state]}
        {unseenDone ? ', stopped since you last looked' : ''}
      </span>
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
        <div className="chips" title={chipWords.length ? chipWords.join(' · ') : undefined}>
          {s.user.pinned && <span className="chip pin">pin</span>}
          {s.user.priority && <span className={`chip pri ${s.user.priority}`}>{s.user.priority.toUpperCase()}</span>}
          {s.attached && <span className="chip live">term</span>}
          {/* Derived, so it costs no tag slot and cannot be removed by hand —
              it says what the session IS, not what someone filed it under. */}
          {s.review && (
            <span className="chip review" title={`Opened with /${s.review.command}`}>review</span>
          )}
          {/* The PRs being reviewed stand in when the session raised none of
              its own, which is the usual case when reviewing someone else. A
              review covering several PRs shows each, so the row says what the
              session is actually about rather than naming only the first. */}
          {s.pr
            ? <span className="chip pr">#{s.pr.number}</span>
            : reviewPrs.slice(0, PR_CHIPS).map((p) => (
                <span key={p.url} className="chip pr" title={`${p.repository} #${p.number}`}>
                  #{p.number}
                </span>
              ))}
          {!s.pr && reviewPrs.length > PR_CHIPS && (
            <span className="chip pr" title={`${reviewPrs.length} PRs under review`}>
              +{reviewPrs.length - PR_CHIPS}
            </span>
          )}
          {/* All of them, not the first: the strip scrolls now, so a second
              tag is reachable rather than silently dropped. */}
          {s.user.tags.map((t) => (
            <span className="chip tag" key={t} title={t}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
});
