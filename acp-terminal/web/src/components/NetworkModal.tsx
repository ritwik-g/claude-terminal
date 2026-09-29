import React, { useState, useEffect } from 'react';
import { api } from '../api';

interface NetworkModalProps {
  onClose: () => void;
}

export const NetworkModal: React.FC<NetworkModalProps> = ({ onClose }) => {
  const [networkInfo, setNetworkInfo] = useState<{
    port: number;
    token: string;
    ips: string[];
    localUrl: string;
    networkUrls: string[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedUrlIndex, setCopiedUrlIndex] = useState<number | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  useEffect(() => {
    api.getNetworkInfo()
      .then((info) => setNetworkInfo(info))
      .catch((err) => console.error('Failed to fetch network info:', err))
      .finally(() => setLoading(false));

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const copyToClipboard = (text: string, isToken = false, index?: number) => {
    navigator.clipboard.writeText(text);
    if (isToken) {
      setCopiedToken(true);
      setTimeout(() => setCopiedToken(false), 2000);
    } else if (index !== undefined) {
      setCopiedUrlIndex(index);
      setTimeout(() => setCopiedUrlIndex(null), 2000);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card network-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '580px' }}>
        <div className="modal-header">
          <div>
            <h3 style={{ margin: 0, fontSize: '17px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>📡</span> Local Network (LAN) Access
            </h3>
            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Connect to ACP Terminal from any device on your Wi-Fi or local network.
            </div>
          </div>
          <button className="btn-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {loading ? (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-dim)' }}>
              Loading network interfaces...
            </div>
          ) : !networkInfo || networkInfo.ips.length === 0 ? (
            <div style={{ padding: '20px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px' }}>
              <div style={{ fontWeight: 600, color: '#f87171', marginBottom: '4px' }}>No active local network interfaces found</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Please ensure this Mac is connected to Wi-Fi or Ethernet.
              </div>
            </div>
          ) : (
            <>
              {/* Network URLs Section */}
              <div className="network-section">
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
                  Shareable Network URLs (Pre-Authenticated)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {networkInfo.networkUrls.map((url, idx) => (
                    <div key={url} className="network-url-row">
                      <div className="network-url-text" title={url}>
                        <span className="network-badge">Wi-Fi / LAN</span>
                        <code>{url}</code>
                      </div>
                      <button
                        type="button"
                        className="btn-action btn-copy-link"
                        onClick={() => copyToClipboard(url, false, idx)}
                      >
                        {copiedUrlIndex === idx ? '✓ Copied!' : '📋 Copy Link'}
                      </button>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', marginTop: '6px' }}>
                  Open this link in Safari, Chrome, or any browser on another laptop, tablet, or phone.
                </div>
              </div>

              {/* Security Token Section */}
              <div className="network-section">
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
                  🔑 Security Access Token
                </div>
                <div className="network-token-row">
                  <code className="token-code">{networkInfo.token}</code>
                  <button
                    type="button"
                    className="btn-action"
                    onClick={() => copyToClipboard(networkInfo.token, true)}
                  >
                    {copiedToken ? '✓ Copied!' : '📋 Copy Token'}
                  </button>
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-dim)', marginTop: '4px' }}>
                  Requests from other machines on your LAN require this token to prevent unauthorized access.
                </div>
              </div>

              {/* Quick Checklist / Tips */}
              <div className="network-tips-card">
                <div style={{ fontWeight: 600, color: '#93c5fd', fontSize: '12px', marginBottom: '6px' }}>
                  💡 Local Network Checklist:
                </div>
                <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: '1.6' }}>
                  <li><strong>Same Network:</strong> Ensure both devices are connected to the same Wi-Fi or router subnet.</li>
                  <li><strong>Mac Firewall:</strong> If macOS displays a prompt asking to allow incoming connections for Node.js, click <strong>Allow</strong>.</li>
                  <li><strong>Pre-Authenticated:</strong> The links above contain <code>?token=...</code> so connecting devices are automatically logged in.</li>
                </ul>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
          <button type="button" className="btn-action" onClick={onClose} style={{ padding: '6px 16px' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
