import { REPO, longDate, u, type Download as File, type Release } from '../lib/changelog';

const MAC_USER_INSTALL = `mkdir -p ~/Applications
cp -R /Applications/Gitnetix.app ~/Applications/
xattr -cr ~/Applications/Gitnetix.app
open ~/Applications/Gitnetix.app`;

type Props ={ latest: { version: string; downloads: File[] }; notes?: Release };

/** Download page body. The page's inline script highlights the visitor's OS and wires the copy button. */
export default function Download({ latest, notes }: Props) {
  return (
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '0 24px 120px' }}>
    <section aria-labelledby="dl-h" style={{ padding: '88px 0 56px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '18px', background: 'radial-gradient(700px 360px at 50% 0%, var(--accent-soft), transparent 70%)' }}>
    <img src={u("icon-192.png")} alt="Gitnetix app icon" width="96" height="96" style={{ width: '96px', height: '96px', borderRadius: '22px', boxShadow: '0 20px 60px -20px color-mix(in srgb,var(--accent) 55%,transparent)' }} />
    <h1 id="dl-h" style={{ margin: '0', fontSize: 'clamp(40px, 5.6vw, 68px)', lineHeight: '1.04', letterSpacing: '-0.035em' }}>Download Gitnetix</h1>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '18px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px', justifyContent: 'center', alignItems: 'center' }}>
    <span className="mono" style={{ color: 'var(--accent-fg)', background: 'var(--accent-soft)', fontWeight: '600', padding: '2px 10px', borderRadius: '999px', fontSize: '14px' }}>v{latest.version}</span>
    {notes && <span>Released <time dateTime={notes.date}>{longDate(notes.date)}</time></span>}
    {notes && <a className="dl-new" href={u(`releases/${notes.version}/`)} style={{ fontWeight: '600' }}>What's new →</a>}
    </p>
    </section>

    <ul style={{ listStyle: 'none', margin: '0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '18px' }}>
    {latest.downloads.map((p) => (
    <li key={p.id} className="pf" data-os={p.id} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '18px', padding: '28px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
    <h2 style={{ margin: '0', fontSize: '26px', letterSpacing: '-0.02em', flex: '1' }}>{p.name}</h2>
    <span className="sys" style={{ fontSize: '12px', fontWeight: '600', color: 'var(--accent-fg)', background: 'var(--accent-soft)', padding: '3px 10px', borderRadius: '999px' }}>Your system</span>
    </div>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px', flex: '1' }}>{p.desc}</p>
    <p className="mono" style={{ margin: '0', fontSize: '13px', color: 'var(--faint)', background: 'var(--raised)', padding: '10px 12px', borderRadius: '8px', overflowX: 'auto', whiteSpace: 'nowrap' }}>{p.file}</p>
    <a className="pbtn" href={p.url} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', minHeight: '48px', borderRadius: '12px', fontWeight: '600', background: 'var(--raised)', color: 'var(--fg)', border: '1px solid var(--line)' }}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"></path></svg>
    <span>Download {p.ext}</span>
    </a>
    </li>
    ))}
    </ul>
    <p style={{ margin: '20px 0 0', textAlign: 'center', fontSize: '14px', color: 'var(--faint)' }}>Installed apps check for new releases on launch and update themselves. <a className="dl-all" href={`${REPO}/releases`} style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>All releases on GitHub</a></p>

    <section aria-labelledby="mac-h" style={{ marginTop: '72px', display: 'flex', flexWrap: 'wrap', gap: '28px 56px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '18px', padding: 'clamp(24px, 4vw, 44px)' }}>
    <div style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <h2 id="mac-h" style={{ margin: '0', fontSize: '28px', letterSpacing: '-0.02em' }}>On macOS: the first launch</h2>
    <p style={{ margin: '0', color: 'var(--muted)' }}>Gitnetix isn't notarized yet, so macOS may say it "is damaged" or "cannot be verified". The app is fine; macOS just can't check who made it. Clear the quarantine flag once after dragging it to Applications.</p>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px' }}>Or open it once, then go to System Settings › Privacy &amp; Security and click <strong style={{ color: 'var(--fg)' }}>Open Anyway</strong>. Updates from inside the app don't need this again.</p>
    </div>
    <div style={{ flex: '1 1 380px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '10px', minWidth: '0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--term)', border: '1px solid var(--line)', borderRadius: '12px', padding: '8px 8px 8px 18px' }}>
    <code style={{ flex: '1', color: '#e8e9eb', fontSize: '14px', overflowX: 'auto', whiteSpace: 'nowrap' }}><span style={{ color: '#868c96' }}>$ </span>xattr -cr /Applications/Gitnetix.app</code>
    <button type="button" data-copy="xattr -cr /Applications/Gitnetix.app" aria-label="Copy command" style={{ background: '#24282e', color: '#e8e9eb', border: '0', borderRadius: '8px', font: 'inherit', fontSize: '13px', padding: '0 14px', minHeight: '40px', minWidth: '72px' }}>Copy</button>
    </div>
    <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Getting "Permission denied", for example without admin rights? Copy the app to your own Applications folder and clear the flag there:</p>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', background: 'var(--term)', border: '1px solid var(--line)', borderRadius: '12px', padding: '8px 8px 8px 18px' }}>
    <pre className="mono" style={{ flex: '1', margin: '0', padding: '10px 0', color: '#e8e9eb', fontSize: '14px', overflowX: 'auto' }}>{MAC_USER_INSTALL.split('\n').map((l) => <div key={l}><span style={{ color: '#868c96' }}>$ </span>{l}</div>)}</pre>
    <button type="button" data-copy={MAC_USER_INSTALL} aria-label="Copy commands" style={{ background: '#24282e', color: '#e8e9eb', border: '0', borderRadius: '8px', font: 'inherit', fontSize: '13px', padding: '0 14px', minHeight: '40px', minWidth: '72px' }}>Copy</button>
    </div>
    <p style={{ margin: '0', fontSize: '13px', color: 'var(--faint)' }}>Universal build: runs natively on Apple Silicon and Intel.</p>
    </div>
    </section>

    <section aria-labelledby="more-h" style={{ marginTop: '72px' }}>
    <h2 id="more-h" style={{ margin: '0 0 24px', fontSize: '32px', letterSpacing: '-0.02em' }}>Other ways to run it</h2>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '18px' }}>
    <article style={{ background: 'var(--panel)', border: '1px solid color-mix(in srgb,var(--accent) 45%,transparent)', borderRadius: '16px', padding: '26px', display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
    <img src={u("phone.jpg")} alt="Gitnetix branch tree in a phone browser" width="640" height="1152" loading="lazy" style={{ width: '96px', height: 'auto', borderRadius: '14px', border: '2px solid var(--rail)', flex: 'none' }} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <h3 style={{ margin: '0', fontSize: '20px' }}>On your phone</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px' }}>Nothing to install. In Settings › Companion &amp; MCP, allow devices on your network, then scan the QR code. Gitnetix opens in your phone's browser.</p>
    </div>
    </article>
    <article style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <h3 style={{ margin: '0', fontSize: '20px' }}>Headless, on a dev box</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px' }}>No window. Drive it from your phone or any browser, or from another agent over MCP.</p>
    <pre className="mono" style={{ margin: '0', background: 'var(--term)', color: '#e8e9eb', borderRadius: '10px', padding: '14px 16px', fontSize: '13px', overflowX: 'auto' }}>cargo run -p gitnetix-server</pre>
    </article>
    <article style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <h3 style={{ margin: '0', fontSize: '20px' }}>As an MCP tool</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px' }}>Every RPC method becomes a tool, forwarded to the running app.</p>
    <pre className="mono" style={{ margin: '0', background: 'var(--term)', color: '#e8e9eb', borderRadius: '10px', padding: '14px 16px', fontSize: '13px', overflowX: 'auto' }}>cargo build -p gitnetix-server --release
    claude mcp add gitnetix -- "$(pwd)/target/release/gitnetix-mcp"</pre>
    </article>
    <article style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <h3 style={{ margin: '0', fontSize: '20px' }}>From source</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px' }}>Rust 1.80+, Node 20+, pnpm, and <code>git</code> on your PATH.</p>
    <pre className="mono" style={{ margin: '0', background: 'var(--term)', color: '#e8e9eb', borderRadius: '10px', padding: '14px 16px', fontSize: '13px', overflowX: 'auto' }}>pnpm install
    pnpm app</pre>
    </article>
    </div>
    </section>

    <section aria-labelledby="req-h" style={{ marginTop: '72px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '18px 48px' }}>
    <div>
    <h2 id="req-h" style={{ margin: '0 0 14px', fontSize: '24px', letterSpacing: '-0.02em' }}>What you need</h2>
    <ul style={{ margin: '0', paddingLeft: '20px', color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <li><code>git</code> installed and on your PATH. Gitnetix drives the real git CLI.</li>
    <li>For AI: a signed-in CLI (<code>claude</code>, <code>codex</code>, <code>gemini</code>, <code>copilot</code>, <code>ollama</code>) or an API key.</li>
    <li>For pull requests: a GitHub or Azure DevOps sign-in. No token to create.</li>
    </ul>
    </div>
    <div>
    <h2 style={{ margin: '0 0 14px', fontSize: '24px', letterSpacing: '-0.02em' }}>Your data stays yours</h2>
    <ul style={{ margin: '0', paddingLeft: '20px', color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <li>API keys and tokens go to your OS keychain.</li>
    <li>Config lives in <code>~/.config/gitnetix</code> (Linux), <code>~/Library/Application Support/gitnetix</code> (macOS), or <code>$GITNETIX_HOME</code>.</li>
    <li>Gravatar avatars are off unless you turn them on.</li>
    </ul>
    </div>
    </section>
    </div>
  );
}
