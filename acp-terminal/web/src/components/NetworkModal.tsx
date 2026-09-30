import React, { useState, useEffect, useRef } from 'react';
import { api, type LanInterface, type NetworkInfo } from '../api';
import { makeQr, type QrShape } from '../qr';
import { Modal } from './Modal';
import { Badge, Button, Card, Icon, IconButton, Segmented, Spinner, Switch, type IconName, type Tone } from '../ui';

interface NetworkModalProps {
  onClose: () => void;
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

/** Networks a phone on the same Wi-Fi usually can't reach. */
const isUnlikelyReachable = (link: LanInterface) => link.kind === 'virtual' || link.kind === 'vpn';

/** Links best first; falls back to the bare URLs if the server sends no labels. */
function lanLinks(info: NetworkInfo): LanInterface[] {
  if (info.lanInterfaces) return info.lanInterfaces;
  return info.networkUrls.map((url, i) => ({ address: info.ips[i] ?? url, name: '', kind: 'other', label: 'Network', url }));
}

/**
 * The sign-in link as a QR code, generated in the browser. Always dark on
 * light with a quiet zone, whatever the theme: phone scanners expect that.
 */
const QrCode: React.FC<{ link: LanInterface }> = ({ link }) => {
  const [shape, setShape] = useState<QrShape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShape(null);
    setError(null);
    makeQr(link.url).then(
      (s) => !cancelled && setShape(s),
      (err) => !cancelled && setError(err?.message || 'Could not draw the QR code')
    );
    return () => {
      cancelled = true;
    };
  }, [link.url]);

  return (
    <div className="net-qr-code" role="img" aria-label={`QR code for the ${link.label} link, ${link.address}`}>
      {shape ? (
        <svg viewBox={`0 0 ${shape.size} ${shape.size}`} shapeRendering="crispEdges" aria-hidden>
          <rect width={shape.size} height={shape.size} fill="#ffffff" />
          <path d={shape.path} fill="#000000" />
        </svg>
      ) : error ? (
        <span className="net-qr-status">{error}</span>
      ) : (
        <Spinner size={16} />
      )}
    </div>
  );
};

export const NetworkModal: React.FC<NetworkModalProps> = ({ onClose }) => {
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // The QR code carries the token, so like the token it stays hidden until asked for
  const [qrOpen, setQrOpen] = useState(false);
  const [qrAddress, setQrAddress] = useState<string | null>(null);
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

  const setLan = (enabled: boolean) => {
    setSwitching(true);
    setSwitchError(null);
    api
      .setLanAccess(enabled)
      .then((info) => {
        setNetworkInfo(info);
        if (!info.lanEnabled) setQrOpen(false);
      })
      .catch((err) => setSwitchError(err.message || 'Failed to change LAN access'))
      .finally(() => setSwitching(false));
  };

  // Why the switch is read-only, if it is: HOST pins the bind address, or this
  // page is open on another device, which must not be able to change who connects.
  const switchNote = networkInfo?.lockedReason
    ? networkInfo.lockedReason
    : networkInfo && !networkInfo.canToggle
      ? 'Only the computer running CodePit can turn this on or off.'
      : networkInfo?.lanEnabled
        ? 'Devices on your network can connect with the access token below. Turning this off disconnects them.'
        : 'Only this computer can connect. Takes effect right away, no restart needed.';

  const copyButton = (text: string, key: string, label: string) => (
    <Button size="sm" variant="secondary" icon={copied === key ? 'check' : 'copy'} onClick={() => copy(text, key)}>
      {copied === key ? 'Copied' : label}
    </Button>
  );

  const links = networkInfo ? lanLinks(networkInfo) : [];
  const qrLink = links.find((l) => l.address === qrAddress) ?? links[0];
  const showQr = (address: string) => {
    setQrAddress(address);
    setQrOpen(true);
  };
  // Two physical ports can share a label ("Ethernet"); the interface name tells them apart
  const linkLabel = (link: LanInterface) =>
    link.name && links.filter((l) => l.label === link.label).length > 1 ? `${link.label} (${link.name})` : link.label;

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
      ) : !networkInfo ? null : (
        <>
          <Card padding="sm">
            <Switch
              checked={networkInfo.lanEnabled}
              onChange={setLan}
              disabled={!networkInfo.canToggle || switching}
              label={
                <span className="net-switch-label">
                  Allow devices on your network
                  {switching && <Spinner size={12} />}
                </span>
              }
              description={switchNote}
            />
          </Card>

          {switchError && (
            <Callout tone="danger" icon="alert" title="Could not change LAN access">
              {switchError}.
            </Callout>
          )}

          {networkInfo.lanEnabled && networkInfo.lanErrors.length > 0 && (
            <Callout tone="warn" icon="alert" title="Some network interfaces are not reachable">
              <ul className="net-error-list">
                {networkInfo.lanErrors.map((e) => (
                  <li key={e.address}>
                    <code>{e.address}</code>: {e.error}
                  </li>
                ))}
              </ul>
              Reopen this dialog to try again.
            </Callout>
          )}

          {networkInfo.lanEnabled && networkInfo.ips.length === 0 && networkInfo.lanErrors.length === 0 && (
            <Callout tone="danger" icon="wifi" title="No local network found">
              This computer has no active network interface. Connect it to Wi-Fi or Ethernet, then reopen this dialog.
            </Callout>
          )}

          {networkInfo.lanEnabled && networkInfo.ips.length > 0 && (
            <>
              <section className="net-section">
                <div className="net-label">Connect a phone</div>
                {!qrOpen || !qrLink ? (
                  <div className="net-qr-cta">
                    <Icon name="qr" size={16} className="net-row-icon" />
                    <span>Scan a QR code with your phone's camera to open this workspace, already signed in.</span>
                    <Button size="sm" variant="secondary" icon="qr" onClick={() => showQr(qrLink?.address ?? '')}>
                      Show QR code
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="net-qr">
                      <QrCode link={qrLink} />
                      <div className="net-qr-side">
                        <div className="net-qr-title">Scan with your phone's camera</div>
                        <p className="net-hint">
                          The phone must be on the same network. The link opens this workspace, already signed in.
                        </p>
                        {links.length > 1 && links.length <= 3 && (
                          <Segmented
                            label="Network to connect over"
                            size="sm"
                            block
                            value={qrLink.address}
                            onChange={setQrAddress}
                            options={links.map((l) => ({ value: l.address, label: linkLabel(l), title: l.address }))}
                          />
                        )}
                        <div className="net-qr-address">
                          <Badge tone={isUnlikelyReachable(qrLink) ? 'neutral' : 'accent'}>{linkLabel(qrLink)}</Badge>
                          <code>
                            {qrLink.address}:{networkInfo.port}
                          </code>
                        </div>
                        {isUnlikelyReachable(qrLink) && (
                          <p className="net-qr-warn">
                            <Icon name="alert" size={13} />
                            <span>
                              Phones usually can't reach a {qrLink.kind === 'vpn' ? 'VPN' : 'virtual machine'} address. Pick
                              your Wi-Fi or Ethernet link if the phone can't connect.
                            </span>
                          </p>
                        )}
                        <Button size="sm" variant="ghost" icon="x" onClick={() => setQrOpen(false)}>
                          Hide QR code
                        </Button>
                      </div>
                    </div>
                    <p className="net-hint">
                      The code contains the access token. Keep it private: anyone who scans it can control your agents.
                    </p>
                  </>
                )}
              </section>

              <section className="net-section">
                <div className="net-label">Links</div>
                <div className="net-rows">
                  {links.map((link, idx) => (
                    <div key={link.url} className="net-row">
                      <Badge tone={isUnlikelyReachable(link) ? 'neutral' : 'accent'}>{linkLabel(link)}</Badge>
                      <code className="net-value" title={link.url}>
                        {link.url}
                      </code>
                      <IconButton
                        icon="qr"
                        label={qrOpen && qrLink?.address === link.address ? 'Hide QR code' : 'Show QR code'}
                        size="sm"
                        active={qrOpen && qrLink?.address === link.address}
                        onClick={() => (qrOpen && qrLink?.address === link.address ? setQrOpen(false) : showQr(link.address))}
                      />
                      {copyButton(link.url, `url-${idx}`, 'Copy link')}
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
                      If your firewall asks whether the app may accept incoming connections, choose <strong>Allow</strong>.
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
        </>
      )}
    </Modal>
  );
};
