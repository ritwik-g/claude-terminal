import React from 'react';
import { IconButton } from '../ui';

/** Full-size preview of an attached image. Esc is handled by the caller's escape layer. */
export const ImageLightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => (
  <div className="ws-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onClick={onClose}>
    <div className="ws-lightbox-bar" onClick={(e) => e.stopPropagation()}>
      {/* Browsers block opening data: URLs in a tab, so only offer it for served files. */}
      {!src.startsWith('data:') && (
        <IconButton icon="external" label="Open in a new tab" onClick={() => window.open(src, '_blank', 'noopener')} />
      )}
      <IconButton icon="x" label="Close preview (Esc)" onClick={onClose} autoFocus />
    </div>
    <img src={src} alt="Attachment preview" className="ws-lightbox-img" onClick={(e) => e.stopPropagation()} />
  </div>
);
