import { useEffect, useRef, useState } from "react";

import { isTauri, remoteFromLink, saveRemote, testRemote, type Remote } from "../api/transport";
import { queryClient } from "../api/hooks";
import { Icon } from "../components/Icon";
import { Busy, ErrorBox } from "../components/ui";
import zxingWasm from "zxing-wasm/reader/zxing_reader.wasm?url";

// Serve the decoder from this app, not the library's default CDN: the companion may have no internet.
const zxingFiles = { locateFile: () => zxingWasm };

/** Mobile / browser: connect to a desktop running Gitnetix. */
export function Pair({ onPaired, error }: { onPaired: () => void; error?: string }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(error);
  const [scanning, setScanning] = useState(false);
  const cancelled = useRef(false);
  const photo = useRef<HTMLInputElement>(null);

  // The camera preview sits behind the web view, so the page goes see-through while scanning.
  useEffect(() => {
    document.documentElement.classList.toggle("scanning", scanning);
    return () => document.documentElement.classList.remove("scanning");
  }, [scanning]);

  const connect = async (u = url, t = token) => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await testRemote(u, t);
      saveRemote(r);
      queryClient.clear();
      onPaired();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pairFromQr = async (content: string) => {
    let r: Remote | null = null;
    try {
      r = remoteFromLink(new URL(content));
    } catch {
      /* not a link */
    }
    if (!r) throw new Error("This QR code is not a Gitnetix pairing code");
    setUrl(r.url);
    setToken(r.token);
    await connect(r.url, r.token);
  };

  const scanQr = async () => {
    setErr(undefined);
    cancelled.current = false;
    const qr = await import("@tauri-apps/plugin-barcode-scanner");
    try {
      if ((await qr.requestPermissions()) !== "granted") throw new Error("Camera access is off. Allow it for Gitnetix in the phone's Settings.");
      setScanning(true);
      // Windowed: the full-screen scanner has no way back to the app on iOS, so this page draws the Cancel button.
      const { content } = await qr.scan({ windowed: true, formats: [qr.Format.QRCode] });
      setScanning(false);
      await pairFromQr(content);
    } catch (e) {
      setScanning(false);
      if (!cancelled.current) setErr(e instanceof Error ? e.message : String(e));
    }
  };

  // Browser and home screen app: the page is plain HTTP, where live camera access is off, but a photo input still opens the camera.
  // The phone's Camera app can't pair a home screen app: the link it opens lands in the browser, which keeps its own storage.
  const scanPhoto = async (file: File) => {
    setErr(undefined);
    setBusy(true);
    try {
      // ZXing, not jsQR: jsQR misses photos of a screen (moiré, glare, tilt).
      const zxing = await import("zxing-wasm/reader");
      zxing.prepareZXingModule({ overrides: zxingFiles });
      const [code] = (await zxing.readBarcodes(file, { formats: ["QRCode"] })).filter((r) => r.isValid);
      if (!code) throw new Error("No QR code found in the photo. Fill the frame with the QR code and keep it sharp.");
      await pairFromQr(code.text);
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const stopScan = () => {
    cancelled.current = true;
    import("@tauri-apps/plugin-barcode-scanner").then((qr) => qr.cancel());
  };

  if (scanning)
    return (
      <div className="scan-view">
        <p>Point the camera at the QR code in Settings › Companion &amp; MCP on your computer.</p>
        <button type="button" className="btn btn-lg" onClick={stopScan}>Cancel</button>
      </div>
    );

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
          <div className="welcome-hero">
            <img src="/logo.png" alt="" width={56} height={56} />
            <div className="col" style={{ gap: 8 }}>
              <h1>Pair with Gitnetix</h1>
              <p className="muted">Your repositories stay on the computer; from here you manage releases, agents, PRs and tickets remotely.</p>
            </div>
          </div>
          <ol className="steps">
            <li><span>On your computer, open Menu › Settings › Companion &amp; MCP.</span></li>
            <li><span>Turn on <b>Allow devices on my network</b>.</span></li>
            <li><span>Scan the QR code shown there, or copy its address and pairing token below.</span></li>
          </ol>
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
            <Busy on={busy}><Icon name="phone" /></Busy>
            <span>Connect</span>
          </button>
          <button type="button" className="btn btn-lg" disabled={busy} onClick={isTauri ? scanQr : () => photo.current?.click()}>
            <Icon name="qr" />
            <span>Connect by scanning QR code</span>
          </button>
          <input
            ref={photo}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // same photo picked twice still fires change
              if (file) scanPhoto(file);
            }}
          />
          <p className="hint">Traffic is plain HTTP on your local network, protected by the token. Use it on networks you trust, or through a VPN such as Tailscale.</p>
        </form>
      </main>
    </div>
  );
}
