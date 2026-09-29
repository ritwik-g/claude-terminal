import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { Badge, Button, Icon, IconButton, Spinner, type IconName, type Tone } from '../ui';

interface NetworkModalProps {
  onClose: () => void;
}

interface NetworkInfo {
  port: number;
  token: string;
  ips: string[];
  localUrl: string;
  networkUrls: string[];
  lanEnabled?: boolean;
  host?: string;
}

const Callout: React.FC<{
  tone: Tone;
  icon: IconName;
  title: string;
  children: React.ReactNode;
}> = ({ tone, icon, title, children }) => (
  <div className={`net-callout tone-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
    <Icon name={icon} size={16} className="net-callout-icon" />
    <div>
      <div className="net-callout-title">{title}</div>
      <div className="net-callout-body">{children}</div>
    </div>
  </div>
);

export const NetworkModal: React.FC<NetworkModalProps> = ({ onClose }) => {
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api
      .getNetworkInfo()
      .then((info) => setNetworkInfo(info))
      .catch((err) => setLoadError(err.message || 'Failed to load network info'))
      .finally(() => setLoading(false));
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(key);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(null), 2000);
      },
      () => setCopied(null)
    );
  };

  const copyButton = (text: string, key: string, label: string) => (
    <Button size="sm" variant="secondary" icon={copied === key ? 'check' : 'copy'} onClick={() => copy(text, key)}>
      {copied === key ? 'Copied' : label}
    </Button>
  );

  return (
    <Modal
      onClose={onClose}
      heading="LAN access"
      description="Open this workspace from a phone, tablet or another computer on your network."
      icon="wifi"
      size="md"
      className="net-modal"
      bodyClassName="net-body"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {loading ? (
        <div className="net-loading">
          <Spinner size={14} /> Looking up network interfaces…
        </div>
      ) : loadError ? (
        <Callout tone="danger" icon="alert" title="Could not load network info">
          {loadError}. Check that the server is still running, then reopen this dialog.
        </Callout>
      ) : networkInfo?.lanEnabled === false ? (
        <Callout tone="warn" icon="lock" title="LAN access is off">
          The server is listening on <code>{networkInfo.host || '127.0.0.1'}</code>, so other devices can't reach it.
          Restart it with <code>ACP_LAN=1</code> to accept connections from your local network.
        </Callout>
      ) : !networkInfo || networkInfo.ips.length === 0 ? (
        <Callout tone="danger" icon="wifi" title="No local network found">
          This computer has no active network interface. Connect it to Wi-Fi or Ethernet, then reopen this dialog.
        </Callout>
      ) : (
        <>
          <section className="net-section">
            <div className="net-label">Links</div>
            <div className="net-rows">
              {networkInfo.networkUrls.map((url, idx) => (
                <div key={url} className="net-row">
                  <Badge tone="accent">LAN</Badge>
                  <code className="net-value" title={url}>
                    {url}
                  </code>
                  {copyButton(url, `url-${idx}`, 'Copy link')}
                </div>
              ))}
            </div>
            <p className="net-hint">
              Each link includes the access token, so the device signs in when it opens the link.
            </p>
          </section>

          <section className="net-section">
            <div className="net-label">Access token</div>
            <div className="net-row">
              <Icon name="key" size={14} className="net-row-icon" />
              <code className="net-value">
                {showToken ? networkInfo.token : '•'.repeat(Math.min(networkInfo.token.length, 32))}
              </code>
              <IconButton
                icon="eye"
                label={showToken ? 'Hide token' : 'Show token'}
                size="sm"
                active={showToken}
                onClick={() => setShowToken(!showToken)}
              />
              {copyButton(networkInfo.token, 'token', 'Copy token')}
            </div>
            <p className="net-hint">
              Other devices need this token. Keep it private: anyone with it can control your agents.
            </p>
          </section>

          <section className="net-section net-tips">
            <div className="net-label">If a device can't connect</div>
            <ul className="net-tip-list">
              <li>
                <Icon name="wifi" size={13} />
                <span>Both devices must be on the same Wi-Fi network or router.</span>
              </li>
              <li>
                <Icon name="shield" size={13} />
                <span>
                  If macOS asks whether Node.js may accept incoming connections, choose <strong>Allow</strong>.
                </span>
              </li>
              <li>
                <Icon name="link" size={13} />
                <span>Opening the site without a link? Paste the token on the sign-in screen.</span>
              </li>
            </ul>
          </section>
        </>
      )}
    </Modal>
  );
};
