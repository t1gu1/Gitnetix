import type { CSSProperties, ReactNode } from 'react';
import faq from '../data/faq.json';
import { REPO, releases, shortDate, longDate, plain, u } from '../lib/changelog';
import { Icon } from '../../../src/components/Icon';
import { THEMES } from '../../../src/lib/themes';
import ThemePicker from './ThemePicker';
import type { Branch, Commit, File } from './HeroDemo';
import { MapLayer, MapLegend, PREFS, layoutMap, type Shipped } from './demo/BranchMap';

/** The Branch first map: drawn once, at build time, the way the app draws one (demo/BranchMap.tsx). Branches first, their latest commits under them. */
const work = (name: string, p: Partial<Branch>): Branch => ({ name, kind: name.slice(0, name.indexOf('/')), role: 'branch', author: 'Grace Hopper', ahead: 0, behind: 0, wip: [], files: [], ...p });
const wip: File[] = ['Checkout.tsx', 'Summary.tsx', 'checkout.css'].map((path) => ({ path, add: 14, del: 3, s: 'M' }));
const STORE: Record<string, Branch> = {
  main: { name: 'main', role: 'trunk', author: 'Ana Moreau', ahead: 0, behind: 0, wip: [], files: [], kids: ['release/2.4.0', 'feat/dark-mode'] },
  'release/2.4.0': { name: 'release/2.4.0', role: 'release', base: 'main', tag: 'Next', author: 'Ana Moreau', ahead: 3, behind: 0, wip: [], files: [], kids: ['feat/checkout-redesign', 'fix/cart-total'] },
  'feat/checkout-redesign': work('feat/checkout-redesign', { base: 'release/2.4.0', ahead: 3, wip }),
  'fix/cart-total': work('fix/cart-total', { base: 'release/2.4.0', author: 'Jules Laurent', ahead: 2, behind: 2, wt: true }),
  'feat/dark-mode': work('feat/dark-mode', { base: 'main', author: 'Riya Kapoor', ahead: 2, behind: 4 }),
};
const commit = (subject: string, when: string, author = 'Grace Hopper'): Commit => ({ sha: subject, subject, author, when, files: [] });
const STORE_LOG: Record<string, Commit[]> = {
  'release/2.4.0': [commit('Update changelog for 2.4.0', '4h', 'Ana Moreau'), commit('Merge fix/coupon-codes', '1d', 'Ana Moreau'), commit('Start 2.4.0', '2d', 'Ana Moreau')],
  'feat/checkout-redesign': [commit('Show the order summary beside the form', '1h'), commit('Check the card number as it is typed', '3h'), commit('Split the address form in two steps', '1d')],
  'fix/cart-total': [commit('Round each line before the total', '2h', 'Jules Laurent'), commit('Test carts with discounts', '5h', 'Jules Laurent')],
  'feat/dark-mode': [commit('Read the palette from the brand tokens', '1d', 'Riya Kapoor'), commit('Add a dark mode toggle', '2d', 'Riya Kapoor')],
};
// Only counted on this map: no one unfolds them here.
const shippedWith = (n: number) => Array.from({ length: n }, (_, i) => commit(`c${i}`, ''));
const STORE_SHIPPED: Shipped[] = [{ tag: 'v2.3.1', date: 'Nov 10', commits: shippedWith(4) }, { tag: 'v2.3.0', date: 'Oct 28', commits: shippedWith(12) }, { tag: 'v2.2.0', date: 'Oct 9', commits: shippedWith(9) }];
const STORE_MAP = layoutMap(STORE, 'feat/checkout-redesign', PREFS, '', new Map(), STORE_SHIPPED);

/** A section's heading: its station on the page's trunk, the eyebrow, the title and the lead. */
function Head({ id, eyebrow, title, children, style }: { id: string; eyebrow?: string; title: ReactNode; children?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="sec-head" style={style}>
      <span className="stn" aria-hidden="true"></span>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h2 id={id} className="display">{title}</h2>
      {children && <p className="lead">{children}</p>}
    </div>
  );
}

/** A card of the map's features: a sample of what it looks like on the map, its name, what it does. */
function Feat({ mark, title, children }: { mark: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="box feat">
      <div className="feat-head"><span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', minWidth: '30px' }}>{mark}</span><h3>{title}</h3></div>
      <p>{children}</p>
    </li>
  );
}

/** The landing page. */
export default function Home({ version, demo, agents, phone }: { version: string; demo?: ReactNode; agents?: ReactNode; phone?: ReactNode }) {
  const first = releases[releases.length - 1];
  const days = Math.round((Date.parse(releases[0].date) - Date.parse(first.date)) / 864e5) + 1;
  const featured = releases.slice(0, 3);
  return (
    <>
    {/* HERO */}
    <section aria-labelledby="hero-h" className="hero" style={{ padding: '80px 24px 40px' }}>
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '26px' }}>
    <a className="muted" href={u(`releases/${releases[0].version}/`)} style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', fontSize: '14px', padding: '4px 12px 4px 4px', border: '1px solid var(--line2)', borderRadius: '3px' }}>
    <span className="vtag inv" style={{ fontFamily: 'var(--mono)', fontWeight: '500', letterSpacing: '0', textTransform: 'none', fontSize: '12px' }}>v{releases[0].version}</span>
    <span>{releases[0].title}</span>
    <span aria-hidden="true">→</span>
    </a>
    <h1 id="hero-h" className="display" style={{ maxWidth: '1000px' }}>See your work, <span className="dim">not your commits.</span></h1>
    <p className="lead" style={{ margin: '0', fontSize: 'clamp(18px, 2vw, 21px)', maxWidth: '660px' }}>Gitnetix is a Git client with no commit graph. Your branches on a map. Releases from any branch. An agent on every branch.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '6px' }}>
    <a className="btn-p btn-xl" data-dl href={u('download/')}>
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"></path></svg>
    <span data-dl-label>Download Gitnetix</span>
    </a>
    <a className="btn-s btn-xl" href={REPO}>View on GitHub</a>
    </div>
    <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)' }}><span data-dl-note>v{version} · Free for macOS, Windows and Linux</span> · <a className="muted u" href={u('download/')}>Other platforms</a></p>
    </div>

    {/* THEMES: a pick repaints the whole site and the demo below */}
    <section aria-labelledby="th-h" className="box" style={{ maxWidth: '1192px', margin: '72px auto 0', boxSizing: 'border-box', padding: '24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '20px 40px' }}>
    <div style={{ flex: '1 1 340px' }}>
    <p className="eyebrow" style={{ marginBottom: '10px' }}>{THEMES.length} themes</p>
    <h2 id="th-h" className="display" style={{ fontSize: 'clamp(28px, 3vw, 36px)' }}>Make it look the way you love.</h2>
    <p style={{ margin: '12px 0 0', fontSize: '16px', color: 'var(--muted)', textWrap: 'pretty' }}>Black &amp; White by default. Catppuccin, Rosé Pine, Tokyo Night, Dracula, Nord, Gruvbox and more, dark and light. A theme colors every pane of the app, down to the terminal. Try one: this whole site and the demo below switch to it.</p>
    </div>
    <div style={{ flex: '1 1 460px' }}><ThemePicker /></div>
    </section>

    {/* hero app window */}
    <figure style={{ maxWidth: '1192px', margin: '32px auto 0', padding: '0' }}>
    <p style={{ margin: '0 0 14px', fontSize: '13px', color: 'var(--faint)', textAlign: 'center' }}>Heads up: this web demo runs on made-up data and is a bit clunkier than the real app. Not every button works.</p>
    {demo}
    <figcaption style={{ textAlign: 'center', fontSize: '13px', color: 'var(--faint)', marginTop: '16px', textWrap: 'pretty' }}>Try it: pick a branch on the map, look at its code, commit it, or open the Agent panel on the right and ask for a change. Double-click a branch to check it out, drag to move around. Every tab opens too: review a pull request, triage tickets, follow the sprint in Analytics, or answer the agents in Worktrees &amp; agents, the square button at the top left. Ctrl+F finds a branch.</figcaption>
    </figure>
    </section>

    {/* SPINE: the page's trunk, every section a station on it */}
    <div className="spine" style={{ maxWidth: '1240px', margin: '0 auto', padding: '24px 24px 0' }}>

    {/* BRANCH FIRST */}
    <section id="map" className="sec" aria-labelledby="first-h">
    <Head id="first-h" eyebrow="No commit graph" title={<>Branch first. <span className="dim">Commits second.</span></>}>
    Other Git clients draw what git stored: every commit, on colored rails that cross. Gitnetix draws your branches first: where each one comes from, what it ships with, who works on it. A branch's commits come second, right under it.
    </Head>
    {/* the app's branch map, drawn by demo/BranchMap.tsx so the app's own rules (demo.css) draw it */}
    <figure className="branch-first">
    <div className="ap hd map-static" data-w={STORE_MAP.W} style={{ '--h': STORE_MAP.H } as CSSProperties} role="img" aria-label="The Gitnetix branch map: main on its trunk with the releases it shipped, the next release v2.4.0 with the checked-out feat/checkout-redesign and fix/cart-total, where Claude is working, and feat/dark-mode off main. Each branch's latest commits sit under it.">
    <div className="map" inert>
    <div className="map-view">
    <div className="map-canvas">
    <div className="map-size" style={{ width: STORE_MAP.W, height: STORE_MAP.H }}>
    <div className="map-layer" style={{ width: STORE_MAP.W, height: STORE_MAP.H }}>
    <MapLayer layout={STORE_MAP} head="feat/checkout-redesign" shown="feat/checkout-redesign" agentOf={(n) => (n === 'fix/cart-total' ? { label: 'Claude', state: 'working' } : undefined)} logOf={(b) => STORE_LOG[b.name] ?? []} labelOf={(n) => (n.startsWith('release/') ? `v${n.slice(8)}` : n)} />
    </div>
    </div>
    </div>
    <MapLegend hint={false} behind={false} />
    </div>
    </div>
    </div>
    <figcaption>Where you are, what ships next, and each branch's latest commits under it. At a glance.</figcaption>
    </figure>
    </section>

    {/* MAP EXPLAINED */}
    <section className="sec" aria-labelledby="exp-h">
    <Head id="exp-h" eyebrow="A map of intent" title="It works out where every branch belongs.">
    Gitnetix finds each branch's real parent on its own: the base you declared, a merge commit, a pull request on GitHub or Azure DevOps, a squash that carries it, or the closest history. Even squash-merged PRs land under the right release.
    </Head>
    <ol className="cards">
    <Feat mark={<span style={{ width: '30px', height: '1.5px', background: 'var(--fg)' }}></span>} title="The path to your branch">Where you are, and what this merges into. A heavier line runs from the station of <code>main</code> to the branch you have checked out. Every other line is a hairline.</Feat>
    <Feat mark={<span className="mono" style={{ fontSize: '12px', padding: '1px 6px', border: '1px solid var(--line2)', borderRadius: '2px', color: 'var(--del)' }}>↓2</span>} title="Ahead and behind, for real">Counted against the branch's real parent, not just origin. The ↓ count sits on the branch's line and rebases it in one click. Uncommitted work and the agent at work show in its box.</Feat>
    <Feat mark={<Icon name="check" size={16} />} title="Merged moves aside">Done work turns into a small station under its parent, tagged Merged, with a Clean up button after it. Branches whose ticket key shows up in a later squash get a "likely merged" tag and are never auto-deleted.</Feat>
    <Feat mark={<svg width="30" height="8" aria-hidden="true"><path d="M1 4h28" stroke="var(--faint)" strokeDasharray="3 4"></path></svg>} title="Falling behind">Branches 25 or more commits behind hang on a dashed line and say how long they've been idle. One toggle hides them, and the broom button next to it picks the ones to delete.</Feat>
    <Feat mark={<Icon name="tag" size={16} />} title="Shipped, with its tag">Every release shipped from <code>main</code> is a station on the trunk, with the day it shipped and its commits one click away. Delete a tag and the release reopens.</Feat>
    <Feat mark={<Icon name="user" size={16} />} title="Work and personal, apart">A profile keeps its own projects, connections, tokens, AI setup and settings. Switch from your avatar at the top right and the whole app follows. Its settings open from the same menu.</Feat>
    </ol>
    </section>

    {/* RELEASE FLOW */}
    <section id="ship" className="sec" aria-labelledby="ship-h">
    <Head id="ship-h" eyebrow="Release-centric" title="Cut. Build. Tag.">
    Other clients hand you raw git verbs. Gitnetix gives you the release flow your team already runs, as buttons.
    </Head>
    <ol className="cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))' }}>
    <li className="box feat"><span className="step-n" aria-hidden="true">1</span><h3>Cut a release</h3><p><code>release/2.4.0</code> from <code>main</code>, or from the last tag for a hotfix. The next version is suggested from your changes.</p></li>
    <li className="box feat"><span className="step-n" aria-hidden="true">2</span><h3>Branch work</h3><p>Features and fixes off the release, each in its own worktree if you like.</p></li>
    <li className="box feat"><span className="step-n" aria-hidden="true">3</span><h3>Agents help</h3><p>Claude Code, Codex, Antigravity work in parallel. AI adds each branch to the changelog and writes the PR.</p></li>
    <li className="box feat" style={{ borderColor: 'var(--line2)' }}><span className="step-n on" aria-hidden="true">4</span><h3>Tag</h3><p><strong style={{ color: 'var(--fg)' }}>Create tag &amp; Update changelog…</strong> on any branch dates the changelog, tags <code>v2.4.0</code> and pushes the branch with its tag. A release reads its version from its name; anywhere else, pick Major, Minor or Patch, or type any tag name.</p></li>
    </ol>
    <p className="flow"><b>release/2.4.0</b> → <b>CHANGELOG [2.4.0] - 2026-10-22</b> → <b>v2.4.0</b> → <b>origin</b></p>
    </section>

    {/* AGENTS */}
    <section id="agents" className="sec" aria-labelledby="ag-h">
    <Head id="ag-h" eyebrow="Parallel workstations" title="One branch. One worktree. One agent.">
    Open any branch in its own worktree with one click, put an AI agent on it, and keep a shell beside it. Run them side by side. When you close a worktree, Gitnetix can merge it into the branch you choose. Ignored files you list, like <code>.env</code>, are copied into every new worktree.
    </Head>
    {/* the three agent cards, playing (AgentCards.tsx, an island from index.astro) */}
    {agents}
    <div className="chips" style={{ marginTop: '28px', alignItems: 'center' }}>
    <span style={{ fontSize: '14px', color: 'var(--faint)', marginRight: '6px' }}>Bring your agent:</span>
    <span className="chip">Claude Code</span>
    <span className="chip">Codex</span>
    <span className="chip">Antigravity</span>
    <span className="chip">Copilot</span>
    <span className="chip">Ollama</span>
    <span className="chip ghost">or an API key</span>
    </div>
    <p style={{ margin: '18px 0 0', fontSize: '16px', color: 'var(--muted)' }}>Every action is also an <strong style={{ color: 'var(--fg)' }}>MCP tool</strong>, so another agent can drive Gitnetix too: <code style={{ color: 'var(--fg)', padding: '2px 8px', border: '1px solid var(--line)', borderRadius: '3px', background: 'var(--panel)' }}>claude mcp add gitnetix</code></p>
    </section>

    {/* MOBILE */}
    <section className="sec" aria-labelledby="mo-h">
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '48px', alignItems: 'center' }}>
    <Head id="mo-h" eyebrow="Remote" title="Your desktop, in your pocket." style={{ flex: '1 1 380px', maxWidth: '640px' }}>
    Scan the QR code from your desktop and the same app opens in your phone's browser. Approve agents, ship hotfixes, review PRs.
    </Head>
    <div style={{ flex: '1 1 344px', display: 'flex', justifyContent: 'center' }}>
    <figure style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center' }}>
    <div className="phone-frame">
    {phone}
    </div>
    <figcaption style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--muted)' }}><span aria-hidden="true" className="live-dot"></span>Playable · the same app, paired by QR code</figcaption>
    </figure>
    </div>
    </div>
    </section>

    {/* AI BORING TEXT */}
    <section className="sec" aria-labelledby="ai-h">
    <Head id="ai-h" eyebrow="Templates + model routing" title="AI writes the boring text.">
    Editable templates decide what gets written. Per-task routing decides who writes it: a cheap model for commit messages, a strong one for conflicts. Works with a signed-in CLI or an API key.
    </Head>
    {/* 300px columns: three across on desktop, so the six cells fill two whole rows. */}
    <div className="cells">
    <div><h3>Commit messages</h3><p className="mono" style={{ fontSize: '13px' }}>"Pulse along branch path"</p></div>
    <div><h3>Branch names</h3><p className="mono" style={{ fontSize: '13px' }}>fix/tax-rounding</p></div>
    <div><h3>PR descriptions</h3><p>Written from the branch's real diff, ready to edit.</p></div>
    <div><h3>Release notes</h3><p>"Update changelog" adds the branch to <code>Unreleased</code>.</p></div>
    <div><h3>Conflict resolutions</h3><p>Resolved during a rebase, routed to your strongest model.</p></div>
    <div><h3>Ticket triage</h3><p>Tickets matched to branches by key, release guessed from Jira fix version.</p></div>
    </div>
    </section>

    {/* STACK */}
    <section className="sec" aria-labelledby="st-h">
    <Head id="st-h" title="Fits your stack." />
    <div className="cards" style={{ marginTop: '40px' }}>
    <div className="box feat" style={{ gap: '14px' }}>
    <h3 className="eyebrow" style={{ margin: '0' }}>Pull requests</h3>
    <div className="chips"><span className="chip">GitHub</span><span className="chip">GitLab</span><span className="chip">Bitbucket</span><span className="chip">Gitea</span><span className="chip">Azure DevOps</span></div>
    <p style={{ fontSize: '15px' }}>List, review, comment, reply, resolve, merge and close, without leaving the app.</p>
    </div>
    <div className="box feat" style={{ gap: '14px' }}>
    <h3 className="eyebrow" style={{ margin: '0' }}>Tickets</h3>
    <div className="chips"><span className="chip">Jira</span><span className="chip">Trello</span><span className="chip">Asana</span><span className="chip">GitHub issues</span></div>
    <p style={{ fontSize: '15px' }}>Branches matched to tickets by key, mine and sprint filters, status changes from the detail pane. Analytics charts each Jira sprint, and the tickets done per week, person and label.</p>
    </div>
    <div className="box feat" style={{ gap: '14px' }}>
    <h3 className="eyebrow" style={{ margin: '0' }}>Platforms</h3>
    <div className="chips"><span className="chip">macOS</span><span className="chip">Windows</span><span className="chip">Linux</span><span className="chip ghost">Headless server</span></div>
    <p style={{ fontSize: '15px' }}>A phone or any browser pairs with your desktop to manage it remotely.</p>
    </div>
    </div>
    </section>

    {/* BUILT IN PUBLIC */}
    <section className="sec" aria-labelledby="bip-h">
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '32px 40px', alignItems: 'flex-end', justifyContent: 'space-between' }}>
    <Head id="bip-h" eyebrow="Built in public" title={`${releases.length} releases in ${days} days.`} style={{ maxWidth: '680px' }}>
    From the first release on {longDate(first.date)} to v{releases[0].version} on {longDate(releases[0].date)}. Every release is cut, dated and tagged the way Gitnetix does it: <code>Unreleased</code>, then <strong style={{ color: 'var(--fg)' }}>Create tag &amp; Update changelog…</strong>
    </Head>
    <a className="btn-s" href={u('releases/')}>Read every release <span aria-hidden="true">→</span></a>
    </div>
    <ol className="cards" style={{ marginTop: '44px' }}>
    {featured.map((r, i) => (
    <li key={r.version}><a className="box feat" href={u(`releases/${r.version}/`)} style={{ height: '100%', boxSizing: 'border-box', borderColor: i === 0 ? 'var(--line2)' : undefined }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}><span className="vtag mono">v{r.version}</span><time dateTime={r.date} style={{ color: 'var(--faint)' }}>{shortDate(r.date)}</time>{r === releases[0] && <span className="vtag inv" style={{ marginLeft: 'auto' }}>Latest</span>}</div>
    <h3 style={{ fontSize: '20px' }}>{r.title}</h3>
    <p style={{ fontSize: '15px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.highlights.length ? r.highlights.join(' · ') : plain(r.sections[0]?.items[0] ?? '')}</p>
    </a></li>
    ))}
    </ol>
    </section>

    {/* UNDER THE HOOD */}
    <section className="sec" aria-labelledby="uh-h">
    <div className="box" style={{ padding: 'clamp(24px, 4vw, 48px)', display: 'flex', flexWrap: 'wrap', gap: '32px 56px', position: 'relative' }}>
    <span className="stn" aria-hidden="true" style={{ top: 'clamp(26px, 4vw, 50px)', left: '-73px' }}></span>
    <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <p className="eyebrow" style={{ margin: '0' }}>Under the hood</p>
    <h2 id="uh-h" className="display" style={{ fontSize: 'clamp(32px, 3.6vw, 44px)' }}>Small, fast, native. And it's real git.</h2>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '17px' }}>A Rust engine wraps the <code style={{ color: 'var(--fg)' }}>git</code> CLI you already trust. Branch views are cached per project and only changed branches are rebuilt. Origin is fetched and pruned every five minutes.</p>
    </div>
    <dl style={{ flex: '1 1 380px', margin: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: '22px 28px' }}>
    {[
      ['Rust', 'Engine on the real git CLI'],
      ['Tauri 2', 'Native shell, small download'],
      ['React', 'One UI for desktop, phone and browser'],
      ['Keychain', 'API keys and tokens in your OS keychain'],
      ['MCP', 'Every RPC method exposed as a tool'],
      ['Auto-update', 'New releases offered on launch'],
      ['Calm motion', 'Short and quiet, every animation can be turned off'],
      [`${THEMES.length} themes`, 'Dark or light, or follow your system'],
    ].map(([k, v]) => (
    <div key={k}><dt className="mono" style={{ fontSize: '14px', fontWeight: '600' }}>{k}</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>{v}</dd></div>
    ))}
    </dl>
    </div>
    </section>

    {/* PRO AND TEAM: a short word on the paid plans, the Pricing page has the rest */}
    <section className="sec" aria-labelledby="plans-h">
    <div className="box" style={{ padding: 'clamp(24px, 4vw, 40px)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '28px 56px', position: 'relative' }}>
    <span className="stn" aria-hidden="true" style={{ top: 'clamp(26px, 4vw, 42px)', left: '-73px' }}></span>
    <div style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <p className="eyebrow" style={{ margin: '0' }}>Pro and Team · 7 days free</p>
    <h2 id="plans-h" className="display" style={{ fontSize: 'clamp(28px, 3vw, 36px)' }}>Your Gitnetix on every computer.</h2>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px', textWrap: 'pretty' }}>The app stays free, with no account. Pro adds one: your projects and settings on every computer you sign in on, encrypted backups, and live updates from GitHub. Team shares a project list and rules with your company.</p>
    </div>
    <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: '18px', alignItems: 'flex-start' }}>
    <dl style={{ margin: '0', width: '100%', borderTop: '1px solid var(--line)' }}>
    {[['Free', 'The whole app, no account'], ['Pro', 'Sync, encrypted backups, live updates'], ['Team', 'Pro for each member, a shared project list, policies']].map(([k, v]) => (
    <div key={k} style={{ display: 'flex', gap: '16px', alignItems: 'baseline', padding: '10px 0', borderBottom: '1px solid var(--line)' }}><dt style={{ width: '56px', flex: 'none', font: '600 18px/1 var(--display)', letterSpacing: '.02em', textTransform: 'uppercase' }}>{k}</dt><dd style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>{v}</dd></div>
    ))}
    </dl>
    <a className="btn-s" href={u('pricing/')}>See the plans <span aria-hidden="true">→</span></a>
    </div>
    </div>
    </section>

    {/* FAQ */}
    <section id="faq" className="sec" aria-labelledby="faq-h">
    <Head id="faq-h" title="Questions, answered." />
    <div className="faq">
    {faq.map((f, i) => (
    <details key={f.q} open={i === 0}>
    <summary><h3>{f.q}</h3><span className="chev" aria-hidden="true">+</span></summary>
    <p className="prose" dangerouslySetInnerHTML={{ __html: f.a }} />
    </details>
    ))}
    </div>
    </section>
    </div>

    {/* FINAL CTA: the trunk ends on its main station */}
    <section aria-labelledby="cta-h" style={{ padding: '112px 24px 120px', textAlign: 'center' }}>
    <div style={{ maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '24px' }}>
    <span className="stn-main" aria-hidden="true"></span>
    <h2 id="cta-h" className="display" style={{ fontSize: 'clamp(44px, 6.4vw, 84px)', lineHeight: '.96' }}>Stop reading the commit graph.</h2>
    <p style={{ margin: '0', fontSize: '19px', color: 'var(--muted)' }}>Free download for macOS, Windows and Linux.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '4px' }}>
    <a className="btn-p btn-xl" data-dl href={u('download/')}><span data-dl-label>Download Gitnetix</span></a>
    <a className="btn-s btn-xl" href={u('download/')}>All downloads</a>
    </div>
    </div>
    </section>
    </>
  );
}
