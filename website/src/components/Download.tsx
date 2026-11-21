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
    <section aria-labelledby="dl-h" style={{ padding: '80px 0 56px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
    <img src={u('icon-192.png')} alt="Gitnetix app icon" width="96" height="96" style={{ width: '96px', height: '96px' }} />
    <h1 id="dl-h" className="display" style={{ fontSize: 'clamp(48px, 6.4vw, 84px)' }}>Download Gitnetix</h1>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '18px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px', justifyContent: 'center', alignItems: 'center' }}>
    <span className="vtag mono">v{latest.version}</span>
    {notes && <span>Released <time dateTime={notes.date}>{longDate(notes.date)}</time></span>}
    {notes && <a className="u" href={u(`releases/${notes.version}/`)} style={{ fontWeight: '600' }}>What's new →</a>}
    </p>
    </section>

    <ul style={{ listStyle: 'none', margin: '0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '16px' }}>
    {latest.downloads.map((p) => (
    <li key={p.id} className="box feat pf" data-os={p.id} style={{ padding: '28px', gap: '16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
    <h2 className="display" style={{ fontSize: '30px', flex: '1' }}>{p.name}</h2>
    <span className="vtag inv sys">Your system</span>
    </div>
    <p style={{ flex: '1', fontSize: '15px' }}>{p.desc}</p>
    <p className="mono" style={{ fontSize: '13px', color: 'var(--faint)', background: 'var(--raised)', border: '1px solid var(--line)', padding: '10px 12px', borderRadius: '3px', overflowX: 'auto', whiteSpace: 'nowrap' }}>{p.file}</p>
    <a className="btn-s pbtn" href={p.url} style={{ minHeight: '48px' }}>
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"></path></svg>
    <span>Download {p.ext}</span>
    </a>
    </li>
    ))}
    </ul>
    <p style={{ margin: '20px 0 0', textAlign: 'center', fontSize: '14px', color: 'var(--faint)' }}>Installed apps check for new releases on launch and update themselves. <a className="muted u" href={`${REPO}/releases`}>All releases on GitHub</a></p>

    <section aria-labelledby="mac-h" className="box" style={{ marginTop: '72px', display: 'flex', flexWrap: 'wrap', gap: '28px 56px', padding: 'clamp(24px, 4vw, 44px)' }}>
    <div style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <h2 id="mac-h" className="display" style={{ fontSize: '32px' }}>On macOS: the first launch</h2>
    <p style={{ margin: '0', color: 'var(--muted)' }}>Gitnetix isn't notarized yet, so macOS may say it "is damaged" or "cannot be verified". The app is fine; macOS just can't check who made it. Clear the quarantine flag once after dragging it to Applications.</p>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '15px' }}>Or open it once, then go to System Settings › Privacy &amp; Security and click <strong style={{ color: 'var(--fg)' }}>Open Anyway</strong>. Updates from inside the app don't need this again.</p>
    </div>
    <div style={{ flex: '1 1 380px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '10px', minWidth: '0' }}>
    <div className="shell" style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 6px 6px 16px', whiteSpace: 'normal' }}>
    <code style={{ flex: '1', fontSize: '14px', overflowX: 'auto', whiteSpace: 'nowrap' }}><span className="p">$ </span>xattr -cr /Applications/Gitnetix.app</code>
    <button type="button" className="hdr-btn" data-copy="xattr -cr /Applications/Gitnetix.app" aria-label="Copy command" style={{ minWidth: '72px' }}>Copy</button>
    </div>
    <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Getting "Permission denied", for example without admin rights? Copy the app to your own Applications folder and clear the flag there:</p>
    <div className="shell" style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '6px 6px 6px 16px', whiteSpace: 'normal' }}>
    <pre className="mono" style={{ flex: '1', margin: '0', padding: '6px 0', fontSize: '14px', overflowX: 'auto' }}>{MAC_USER_INSTALL.split('\n').map((l) => <div key={l}><span className="p">$ </span>{l}</div>)}</pre>
    <button type="button" className="hdr-btn" data-copy={MAC_USER_INSTALL} aria-label="Copy commands" style={{ minWidth: '72px' }}>Copy</button>
    </div>
    <p style={{ margin: '0', fontSize: '13px', color: 'var(--faint)' }}>Universal build: runs natively on Apple Silicon and Intel.</p>
    </div>
    </section>

    <section aria-labelledby="more-h" style={{ marginTop: '72px' }}>
    <h2 id="more-h" className="display" style={{ margin: '0 0 24px', fontSize: '40px' }}>Other ways to run it</h2>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '16px' }}>
    <article className="box feat" style={{ flexDirection: 'row', gap: '20px', alignItems: 'flex-start', borderColor: 'var(--line2)' }}>
    <img src={u('phone.jpg')} alt="Gitnetix branch map in a phone browser" width="644" height="1246" loading="lazy" style={{ width: '96px', height: 'auto', borderRadius: '10px', border: '1px solid var(--line2)', flex: 'none' }} />
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <h3>On your phone</h3>
    <p style={{ fontSize: '15px' }}>Nothing to install. Open Settings from your profile picture, top right, press <strong style={{ color: 'var(--fg)' }}>Allow devices on my network</strong>, then scan the QR code. Gitnetix opens in your phone's browser.</p>
    </div>
    </article>
    <article className="box feat">
    <h3>Headless, on a dev box</h3>
    <p style={{ fontSize: '15px' }}>No window. Drive it from your phone or any browser, or from another agent over MCP.</p>
    <pre className="shell">cargo run -p gitnetix-server</pre>
    </article>
    <article className="box feat">
    <h3>As an MCP tool</h3>
    <p style={{ fontSize: '15px' }}>Every RPC method becomes a tool, forwarded to the running app.</p>
    <pre className="shell">{`cargo build -p gitnetix-server --release
claude mcp add gitnetix -- "$(pwd)/target/release/gitnetix-mcp"`}</pre>
    </article>
    <article className="box feat">
    <h3>From source</h3>
    <p style={{ fontSize: '15px' }}>Rust 1.80+, Node 20+, pnpm, and <code>git</code> on your PATH.</p>
    <pre className="shell">{`pnpm install
pnpm app`}</pre>
    </article>
    </div>
    </section>

    <section aria-labelledby="req-h" style={{ marginTop: '72px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))', gap: '18px 48px' }}>
    <div>
    <h2 id="req-h" className="display" style={{ margin: '0 0 14px', fontSize: '28px' }}>What you need</h2>
    <ul className="prose" style={{ margin: '0', paddingLeft: '20px', color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <li><code>git</code> installed and on your PATH. Gitnetix drives the real git CLI.</li>
    <li>For AI: a signed-in CLI (<code>claude</code>, <code>codex</code>, <code>agy</code>, <code>copilot</code>, <code>ollama</code>) or an API key.</li>
    <li>For pull requests: a GitHub, GitLab, Bitbucket, Gitea or Azure DevOps sign-in. No token to create.</li>
    </ul>
    </div>
    <div>
    <h2 className="display" style={{ margin: '0 0 14px', fontSize: '28px' }}>Your data stays yours</h2>
    <ul className="prose" style={{ margin: '0', paddingLeft: '20px', color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
    <li>API keys and tokens go to your OS keychain.</li>
    <li>Config lives in <code>~/.config/gitnetix</code> (Linux), <code>~/Library/Application Support/gitnetix</code> (macOS), or <code>$GITNETIX_HOME</code>.</li>
    <li>Gravatar avatars are off unless you turn them on.</li>
    </ul>
    </div>
    </section>
    </div>
  );
}
