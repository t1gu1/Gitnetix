import { useEffect, useRef, useState } from "react";

import { isTauri, remoteFromLink, saveRelay, saveRemote, testRemote, type Remote } from "../api/transport";
import { queryClient } from "../api/hooks";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { Busy, ErrorBox } from "../components/ui";
import { copyToClipboard } from "../lib/toast";
import zxingWasm from "zxing-wasm/reader/zxing_reader.wasm?url";

// Serve the decoder from this app, not the library's default CDN: the companion may have no internet.
const zxingFiles = { locateFile: () => zxingWasm };

/** A computer's QR code for anywhere (gitnetix-relay's `Link`), not its network address. */
const ANYWHERE = "gitnetix://pair#";

interface SignIn { userCode: string; verificationUri: string; deviceCode: string; interval: number }

/** This phone as the computer lists it. */
const phoneName = () => (/iPad/.test(navigator.userAgent) ? "iPad" : /iPhone|iPod/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone");

/** GitHub's page in the phone's browser, where the person is signed in to GitHub. */
const openGitHub = (url: string) => import("@tauri-apps/plugin-opener").then((o) => o.openUrl(url)).catch(() => window.open(url, "_blank", "noopener"));

/** The app's Rust side (src-tauri/src/remote.rs), its refusals as errors. */
async function relay<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args).catch((e: { message?: string }) => {
    throw new Error(e?.message ?? String(e));
  });
}

/**
 * Mobile / browser: connect to a desktop running Gitnetix.
 * `scan`: open the camera right away (More › Scan pairing QR code). `onBack`: opened over the app, which it can return to.
 */
export function Pair({ onPaired, error, scan, onBack }: { onPaired: () => void; error?: string; scan?: boolean; onBack?: () => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(error);
  const [scanning, setScanning] = useState(false);
  // From anywhere, GitHub's code while the phone signs in, and the computer's code it signs in for.
  const [signIn, setSignIn] = useState<SignIn | null>(null);
  const scanned = useRef("");
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

  /** Pairs through the relay. The first time, the phone signs in with GitHub to the computer's account, then pairs. */
  const pairAnywhere = async (link: string) => {
    if (!isTauri) throw new Error("Scan this code from the Gitnetix app. Reaching your computer from anywhere needs the app on your phone.");
    setBusy(true);
    try {
      const r = await relay<{ name?: string; signIn?: SignIn }>("relay_pair", { link, name: phoneName() });
      if (r.signIn) {
        scanned.current = link;
        setSignIn(r.signIn);
        copyToClipboard(r.signIn.userCode);
        openGitHub(r.signIn.verificationUri);
        return;
      }
      saveRelay(r.name ?? "");
      queryClient.clear();
      onPaired();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!signIn) return;
    let interval = signIn.interval;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await relay<{ status: string; interval?: number }>("relay_sign_in_poll", { deviceCode: signIn.deviceCode });
        if (stopped) return;
        if (r.status === "done") {
          setSignIn(null);
          return await pairAnywhere(scanned.current);
        }
        if (r.interval) interval = r.interval;
        timer = setTimeout(tick, interval * 1000);
      } catch (e) {
        if (stopped) return;
        setSignIn(null);
        setErr((e as Error).message);
      }
    };
    timer = setTimeout(tick, interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [signIn]);

  const pairFromQr = async (content: string) => {
    if (content.startsWith(ANYWHERE)) return pairAnywhere(content);
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

  // Only the app scans without a tap: a browser opens the photo picker from the button's own click.
  const started = useRef(false);
  useEffect(() => {
    if (!scan || !isTauri || started.current) return;
    started.current = true; // StrictMode runs this twice in dev: one scanner only
    scanQr();
  }, []);

  const stopScan = () => {
    cancelled.current = true;
    import("@tauri-apps/plugin-barcode-scanner").then((qr) => qr.cancel());
  };

  if (signIn)
    return (
      <div className="ag app">
        <main className="scroll" style={{ flex: 1, display: "flex", justifyContent: "center", padding: "48px 16px" }}>
          <div className="col" style={{ width: "100%", maxWidth: 460, gap: 24 }}>
            <div className="welcome-hero">
              <Logo size={56} />
              <div className="col" style={{ gap: 8 }}>
                <h1>Sign in with GitHub</h1>
                <p className="muted">Use the GitHub account your computer is signed in to Gitnetix with. This phone pairs once you authorize it.</p>
              </div>
            </div>
            <div className="col conn-wait" style={{ gap: 8 }}>
              <span className="hint">Enter this code on GitHub (copied to your clipboard), then authorize Gitnetix. Waiting…</span>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button type="button" className="btn mono" style={{ fontSize: 18, letterSpacing: 2 }} title="Copy code" onClick={() => copyToClipboard(signIn.userCode)}>
                  {signIn.userCode}
                </button>
                <button type="button" className="btn" onClick={() => openGitHub(signIn.verificationUri)}>Open GitHub</button>
                <button type="button" className="btn" onClick={() => setSignIn(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </main>
      </div>
    );

  if (scanning)
    return (
      <div className="scan-view">
        <p>Point the camera at the QR code in the Gitnetix menu on your computer.</p>
        <button type="button" className="btn btn-lg" onClick={stopScan}>Cancel</button>
      </div>
    );

  return (
    <div className="ag app">
      <header className="hdr">
        {onBack && (
          <button className="hdr-icon" aria-label="Back" onClick={onBack}>
            <Icon name="back" size={16} />
          </button>
        )}
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
            <Logo size={56} />
            <div className="col" style={{ gap: 8 }}>
              <h1>Pair with Gitnetix</h1>
              <p className="muted">Your repositories stay on the computer; from here you manage releases, agents, PRs and tickets remotely.</p>
            </div>
          </div>
          <ol className="steps">
            <li><span>On your computer, open the Gitnetix menu.</span></li>
            <li><span>Under App, press <b>Allow devices on my network</b>.</span></li>
            <li><span>Scan the QR code shown there, or copy its address and pairing token below.</span></li>
          </ol>
          <p className="hint">Away from your network, open Settings on your computer, then Gitnetix account, and press Show QR code under Your phone from anywhere. Scan that code from here. It needs the Pro plan.</p>
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
          <p className="hint">On your network, traffic is plain HTTP protected by the token, so use it on networks you trust. From anywhere, it goes through the Gitnetix relay, encrypted end to end with a key only this phone and your computer hold.</p>
        </form>
      </main>
    </div>
  );
}
