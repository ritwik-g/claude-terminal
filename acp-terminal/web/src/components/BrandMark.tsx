import React from 'react';

/**
 * The CodePit logo at sidebar size. It is the app icon itself (a pit board
 * showing a prompt), served from web/public, so it keeps its own colours in
 * both themes like any app icon would.
 */
export const BrandMark: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <img className="sb-brand-logo" src="/favicon.svg" alt="" aria-hidden width={size} height={size} draggable={false} />
);
