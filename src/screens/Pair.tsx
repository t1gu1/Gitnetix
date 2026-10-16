import { useState } from "react";

import { saveRemote, testRemote } from "../api/transport";
import { queryClient } from "../api/hooks";
import { Icon } from "../components/Icon";
import { ErrorBox } from "../components/ui";

/** Mobile / browser: connect to a desktop running Gitnetix. */
export function Pair({ onPaired, error }: { onPaired: () => void; error?: string }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(error);

  const connect = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await testRemote(url, token);
      saveRemote(r);
      queryClient.clear();
      onPaired();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ag app">
      <header className="hdr">
        <div className="hdr-title">
          <strong>Gitnetix</strong>
          <span className="faint">·</span>
          <span className="muted">Connect to your desktop</span>
        </div>
      </header>
      <main className="scroll" style={{ flex: 1, display: "flex", justifyContent: "center", padding: "48px 16px" }}>
        <form
          className="col"
          style={{ width: "100%", maxWidth: 460, gap: 24 }}
          onSubmit={(e) => {
            e.preventDefault();
            connect();
          }}
        >
          <div className="col" style={{ gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>Pair with Gitnetix</h1>
            <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
              On your computer open Menu › Settings › Companion, turn on LAN access, then copy the address and pairing token here.
              Your repositories stay on the computer; this app manages releases, agents, PRs and tickets remotely.
            </p>
          </div>
          <div className="field">
            <label htmlFor="pair-url">Address</label>
            <input id="pair-url" className="input mono" inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="192.168.1.20:7421" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="pair-token">Pairing token</label>
            <input id="pair-token" className="input mono" autoCapitalize="off" autoCorrect="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          {err && <ErrorBox error={err} />}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !url || !token}>
            {busy ? <span className="spinner" /> : <Icon name="phone" />}
            <span>Connect</span>
          </button>
          <p className="hint">Traffic is plain HTTP on your local network, protected by the token. Use it on networks you trust, or through a VPN such as Tailscale.</p>
        </form>
      </main>
    </div>
  );
}
