import type { ReactNode } from 'react';
import faq from '../data/faq.json';
import { REPO, releases, shortDate, longDate, plain, u } from '../lib/changelog';

/** The landing page, ported from the "Gitnetix website" design canvas. */
export default function Home({ version, demo }: { version: string; demo?: ReactNode }) {
  const first = releases[releases.length - 1];
  const days = Math.round((Date.parse(releases[0].date) - Date.parse(first.date)) / 864e5) + 1;
  const featured = releases.filter((r) => r.story).slice(0, 3);
  return (
    <>
    {/* HERO */}
    <section aria-labelledby="hero-h" style={{ position: 'relative', padding: '88px 24px 40px', background: 'radial-gradient(900px 480px at 50% 0%, var(--accent-soft), transparent 70%)' }}>
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '24px' }}>
    <a href={u(`releases/${releases[0].version}/`)} style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', fontSize: '14px', padding: '6px 14px 6px 6px', border: '1px solid var(--line)', borderRadius: '999px', background: 'var(--panel)', color: 'var(--muted)' }}>
    <span style={{ background: 'var(--accent-soft)', color: 'var(--accent-fg)', fontWeight: '600', padding: '2px 10px', borderRadius: '999px' }} className="mono">v{releases[0].version}</span>
    <span>{releases[0].title}</span>
    <span aria-hidden="true">→</span>
    </a>
    <h1 id="hero-h" style={{ margin: '0', fontSize: 'clamp(44px, 7.2vw, 92px)', lineHeight: '1.02', letterSpacing: '-0.035em', fontWeight: '700', textWrap: 'balance', maxWidth: '980px' }}>See your work, <span style={{ color: 'var(--accent-fg)' }}>not your commits.</span></h1>
    <p style={{ margin: '0', fontSize: 'clamp(18px, 2vw, 22px)', color: 'var(--muted)', maxWidth: '680px', textWrap: 'pretty' }}>Gitnetix is a Git client with no commit graph. Branches as a tree. Releases as a button. An agent on every branch.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
    <a className="btn-p" data-dl href={u("download/")} style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', fontSize: '17px', padding: '15px 24px', borderRadius: '12px', boxShadow: '0 8px 30px -8px rgba(240,164,58,.6)' }}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"></path></svg>
    <span data-dl-label>Download Gitnetix</span>
    </a>
    <a className="btn-s" href={REPO} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '500', fontSize: '17px', padding: '15px 22px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--panel)' }}>View on GitHub</a>
    </div>
    <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)' }}><span data-dl-note>v{version} · Free for macOS, Windows and Linux</span> · <a href={u("download/")} style={{ color: 'var(--muted)', textDecoration: 'underline', textUnderlineOffset: '3px' }}>Other platforms</a></p>
    </div>

    {/* hero app window */}
    <figure style={{ maxWidth: '1120px', margin: '64px auto 0', padding: '0' }}>
    {demo}
    <figcaption style={{ textAlign: 'center', fontSize: '13px', color: 'var(--faint)', marginTop: '16px' }}>Try it: pick a branch, open a file, ask the agent, commit. Double-click a branch to check it out.</figcaption>
    </figure>
    </section>

    {/* SPINE: everything below hangs off the orange path */}
    <div className="spine" style={{ maxWidth: '1240px', margin: '0 auto', padding: '40px 24px 0' }}>
    <span className="dot" aria-hidden="true"></span>

    {/* GRAPH VS TREE */}
    <section id="tree" className="sec" aria-labelledby="gvt-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>NO COMMIT GRAPH</p>
    <h2 id="gvt-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em', textWrap: 'balance' }}>Git without the subway map.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Every other Git client draws what git stored: colored rails, crossing merges, hundreds of dots. Gitnetix draws what you are working on.</p>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))', gap: '24px', marginTop: '48px' }}>
    {/* before */}
    <figure style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <div style={{ fontSize: '13px', letterSpacing: '.14em', color: 'var(--faint)' }}>OTHER GIT CLIENTS</div>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '22px', height: '360px', boxSizing: 'border-box', display: 'flex', gap: '24px', overflow: 'hidden' }}>
    <svg role="img" aria-label="A tangled commit graph with seven crossing colored rails" width="200" height="316" viewBox="90 135 200 360" style={{ flex: 'none', opacity: '.85' }}>
    <g fill="none" strokeWidth="3" strokeLinecap="round">
    <path d="M100 140 V490" stroke="#5b8def"></path>
    <path d="M100 170 C130 185 130 195 130 215 V420 C130 440 100 445 100 460" stroke="#e5534b"></path>
    <path d="M130 240 C160 255 160 265 160 285 V380 C160 395 130 400 130 410" stroke="#57ab5a"></path>
    <path d="M100 200 C190 215 190 230 190 250 V340 C190 360 160 365 160 370" stroke="#c69026"></path>
    <path d="M160 300 C220 310 220 320 220 330 V470 C220 480 100 482 100 488" stroke="#986ee2"></path>
    <path d="M190 270 C250 280 250 290 250 300 V440 C250 455 130 450 130 430" stroke="#39c5cf"></path>
    <path d="M100 320 C280 330 280 345 280 360 V400 C280 415 220 410 220 420" stroke="#e0823d"></path>
    </g>
    <g fill="#15171a" strokeWidth="2.5">
    <circle cx="100" cy="150" r="5" stroke="#5b8def"></circle><circle cx="100" cy="230" r="5" stroke="#5b8def"></circle><circle cx="100" cy="350" r="5" stroke="#5b8def"></circle><circle cx="100" cy="460" r="5" stroke="#5b8def"></circle>
    <circle cx="130" cy="225" r="5" stroke="#e5534b"></circle><circle cx="130" cy="320" r="5" stroke="#e5534b"></circle><circle cx="160" cy="290" r="5" stroke="#57ab5a"></circle><circle cx="160" cy="350" r="5" stroke="#57ab5a"></circle>
    <circle cx="190" cy="260" r="5" stroke="#c69026"></circle><circle cx="190" cy="310" r="5" stroke="#c69026"></circle><circle cx="220" cy="340" r="5" stroke="#986ee2"></circle><circle cx="220" cy="430" r="5" stroke="#986ee2"></circle>
    <circle cx="250" cy="310" r="5" stroke="#39c5cf"></circle><circle cx="250" cy="400" r="5" stroke="#39c5cf"></circle><circle cx="280" cy="370" r="5" stroke="#e0823d"></circle>
    </g>
    </svg>
    <div aria-hidden="true" style={{ flex: '1', display: 'flex', flexDirection: 'column', gap: '17px', paddingTop: '6px', minWidth: '0' }}>
    <span style={{ height: '9px', width: '90%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '70%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '96%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '60%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '84%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '75%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '92%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '66%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '88%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '58%', borderRadius: '5px', background: 'var(--rail)' }}></span><span style={{ height: '9px', width: '80%', borderRadius: '5px', background: 'var(--rail)' }}></span>
    </div>
    </div>
    <figcaption style={{ fontSize: '16px', color: 'var(--muted)' }}>Which branch is mine? What ships next? What's dead?</figcaption>
    </figure>
    {/* after */}
    <figure style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <div style={{ fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>GITNETIX</div>
    <div className="ap" style={{ background: 'var(--panel)', border: '1px solid rgba(240,164,58,.35)', borderRadius: '14px', padding: '12px 10px 12px 4px', height: '360px', boxSizing: 'border-box', overflow: 'hidden', lineHeight: '1.35' }}>
    <div className="tr">
    <span className="pth v" aria-hidden="true" style={{ left: '6px', top: '6px', height: '78px' }}></span>
    <span className="pth h" aria-hidden="true" style={{ left: '6px', top: '84px', width: '7px' }}></span>
    <span className="pth v" aria-hidden="true" style={{ left: '12px', top: '84px', height: '46px' }}></span>
    <span className="pth h" aria-hidden="true" style={{ left: '12px', top: '130px', width: '7px' }}></span>
    <span className="pth v" aria-hidden="true" style={{ left: '18px', top: '130px', height: '22px' }}></span>
    <span className="pth solid" aria-hidden="true" style={{ left: '18px', top: '130px', height: '44px' }}></span>
    <span className="streak" aria-hidden="true"></span>
    <div className="row"><span className="ic"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M2.5 7.5L8 3l5.5 4.5V13h-11z"></path></svg></span><div className="mn"><div className="nm"><span className="mono trunk">main</span></div><div className="meta"><span className="av" style={{ background: '#8e44ad' }}>AM</span><span className="dul">all commits</span></div></div></div>
    <div className="grp"><span className="chv"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6l4 4 4-4"></path></svg></span><span className="lbl child">Child branches</span><span style={{ color: 'var(--faint)' }}>2</span></div>
    <div className="kids">
    <div className="row"><span className="ic" style={{ color: 'var(--release)' }}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M2 2.5h5.5L14 9l-5 5-6.5-6.5z"></path><circle cx="5.3" cy="5.3" r="1"></circle></svg></span><div className="mn"><div className="nm"><span className="mono rel">v2.4.0</span><span className="tg">Next</span></div><div className="meta"><span className="mono">release/2.4.0</span><span style={{ color: 'var(--add)' }}>✓ 6 merged</span></div></div></div>
    <div className="kids">
    <div className="row cur"><span className="ic"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 3v10M11 6.5c0 3-3 3.5-6 4"></path><circle cx="5" cy="3" r="1.5"></circle><circle cx="5" cy="13" r="1.5"></circle><circle cx="11" cy="5" r="1.5"></circle></svg></span><div className="mn"><div className="nm"><span className="mono shine">feat/checkout-redesign</span></div><div className="meta"><span className="av" style={{ background: '#b7791f' }}>GH</span><span style={{ color: 'var(--warn)' }}>checked out</span><span className="dul">4 commits</span><span style={{ color: 'var(--add)' }}>you are here</span></div></div></div>
    <div className="row"><span className="ic"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M5 3v10M11 6.5c0 3-3 3.5-6 4"></path><circle cx="5" cy="3" r="1.5"></circle><circle cx="5" cy="13" r="1.5"></circle><circle cx="11" cy="5" r="1.5"></circle></svg></span><div className="mn"><div className="nm"><span className="mono">fix/cart-total</span></div><div className="meta"><span className="av" style={{ background: '#2f7d6d' }}>JL</span><span style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--add)' }}><span aria-hidden="true" style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--add)' }}></span>agent running</span></div></div></div>
    </div>
    <div className="row"><span className="ic" style={{ color: 'var(--release)' }}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M2 2.5h5.5L14 9l-5 5-6.5-6.5z"></path><circle cx="5.3" cy="5.3" r="1"></circle></svg></span><div className="mn"><div className="nm"><span className="mono rel">v2.3.1</span><span className="tg">Hotfix</span></div><div className="meta"><span className="mono">release/2.3.1</span><span className="dul">2 commits</span></div></div></div>
    </div>
    <div className="grp"><span className="chv"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 4l4 4-4 4"></path></svg></span><span className="lbl behind">Branches falling behind</span><span style={{ color: 'var(--faint)' }}>3</span></div>
    <div className="tsep" aria-hidden="true"></div>
    <div className="grp"><span className="chv"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 4l4 4-4 4"></path></svg></span><span className="lbl shipped">Shipped</span><span style={{ color: 'var(--faint)' }}>5</span></div>
    </div>
    </div>
    <figcaption style={{ fontSize: '16px', color: 'var(--fg)' }}>Where you are, what ships next, what's done. At a glance.</figcaption>
    </figure>
    </div>
    </section>

    {/* TREE EXPLAINED */}
    <section className="sec" aria-labelledby="exp-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>A TREE OF INTENT</p>
    <h2 id="exp-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em', textWrap: 'balance' }}>It works out where every branch belongs.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Gitnetix finds each branch's real parent on its own: the base you declared, a merge commit, a pull request on GitHub or Azure DevOps, a squash that carries it, or the closest history. Even squash-merged PRs land under the right release.</p>
    </div>
    <ol style={{ listStyle: 'none', margin: '48px 0 0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '16px' }}>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span aria-hidden="true" style={{ width: '30px', height: '4px', borderRadius: '2px', background: 'var(--trunk)', boxShadow: 'var(--glow)' }}></span><h3 style={{ margin: '0', fontSize: '20px', letterSpacing: '-0.01em' }}>The orange path</h3></div>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Where you are, and what this merges into. A soft pulse travels from <code>main</code> to your checkout.</p>
    </li>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span className="mono" aria-hidden="true" style={{ fontSize: '15px' }}><span style={{ color: 'var(--add)' }}>↑4</span> <span style={{ color: 'var(--warn)' }}>↓2</span></span><h3 style={{ margin: '0', fontSize: '20px', letterSpacing: '-0.01em' }}>Ahead and behind, for real</h3></div>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Counted against the branch's real parent, not just origin. WIP, conflicts and rewritten history sit on the same row, in the same order.</p>
    </li>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span aria-hidden="true" style={{ color: 'var(--add)', fontSize: '18px', fontWeight: '700' }}>✓</span><h3 style={{ margin: '0', fontSize: '20px', letterSpacing: '-0.01em' }}>Merged moves aside</h3></div>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Done work folds into a Merged group under its parent. Branches whose ticket key shows up in a later squash get a "likely merged" tag and are never auto-deleted.</p>
    </li>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span aria-hidden="true" style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px dashed var(--warn)', boxSizing: 'border-box' }}></span><h3 style={{ margin: '0', fontSize: '20px', letterSpacing: '-0.01em' }}>Falling behind</h3></div>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Branches 25 or more commits behind are gathered in one place. Pick the ones to delete and clean up in one click.</p>
    </li>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span aria-hidden="true" style={{ width: '16px', height: '16px', borderRadius: '4px', border: '2px solid var(--release)', boxSizing: 'border-box' }}></span><h3 style={{ margin: '0', fontSize: '20px', letterSpacing: '-0.01em' }}>Shipped, with its tag</h3></div>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Past releases sit below a separator with their version. Delete a tag and the release reopens.</p>
    </li>
    </ol>
    </section>

    {/* RELEASE FLOW */}
    <section id="ship" className="sec" aria-labelledby="ship-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>RELEASE-CENTRIC</p>
    <h2 id="ship-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em' }}>Cut. Build. Ship.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Other clients hand you raw git verbs. Gitnetix gives you the release flow your team already runs, as buttons.</p>
    </div>
    <ol style={{ listStyle: 'none', margin: '48px 0 0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))', gap: '16px' }}>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <span aria-hidden="true" style={{ width: '38px', height: '38px', borderRadius: '50%', border: '2px solid var(--release)', color: 'var(--release)', display: 'grid', placeItems: 'center', fontWeight: '700', boxSizing: 'border-box' }}>1</span>
    <h3 style={{ margin: '0', fontSize: '22px' }}>Cut a release</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}><code>release/2.4.0</code> from <code>main</code>, or from the last tag for a hotfix. The next version is suggested from your changes.</p>
    </li>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <span aria-hidden="true" style={{ width: '38px', height: '38px', borderRadius: '50%', border: '2px solid var(--work)', color: 'var(--work)', display: 'grid', placeItems: 'center', fontWeight: '700', boxSizing: 'border-box' }}>2</span>
    <h3 style={{ margin: '0', fontSize: '22px' }}>Branch work</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Features and fixes off the release, each in its own worktree if you like.</p>
    </li>
    <li style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
    <span aria-hidden="true" style={{ width: '38px', height: '38px', borderRadius: '50%', border: '2px solid var(--add)', color: 'var(--add)', display: 'grid', placeItems: 'center', fontWeight: '700', boxSizing: 'border-box' }}>3</span>
    <h3 style={{ margin: '0', fontSize: '22px' }}>Agents help</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Claude Code, Codex, Gemini work in parallel. AI adds each branch to the changelog and writes the PR.</p>
    </li>
    <li style={{ background: 'linear-gradient(160deg, var(--accent-soft), var(--panel) 60%)', border: '1px solid rgba(240,164,58,.55)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 0 40px -12px rgba(240,164,58,.45)' }}>
    <span aria-hidden="true" style={{ width: '38px', height: '38px', borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-ink)', display: 'grid', placeItems: 'center', fontWeight: '700' }}>4</span>
    <h3 style={{ margin: '0', fontSize: '22px', color: 'var(--accent-fg)' }}>Ship</h3>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '16px' }}>Dates the changelog, fast-forwards <code>main</code>, tags <code>v2.4.0</code>, pushes. One click.</p>
    </li>
    </ol>
    <p className="mono" style={{ margin: '28px 0 0', fontSize: '14px', color: 'var(--faint)', overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: '4px' }}>release/2.4.0 <span style={{ color: 'var(--accent-fg)' }}>→</span> CHANGELOG [2.4.0] - 2026-10-22 <span style={{ color: 'var(--accent-fg)' }}>→</span> main <span style={{ color: 'var(--accent-fg)' }}>→</span> v2.4.0</p>
    </section>

    {/* AGENTS */}
    <section id="agents" className="sec" aria-labelledby="ag-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>PARALLEL WORKSTATIONS</p>
    <h2 id="ag-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em', textWrap: 'balance' }}>One branch. One worktree. One agent.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Open any branch in its own worktree with one click, put an AI agent on it, and keep a shell beside it. Run them side by side. When you close a worktree, Gitnetix can merge it into the branch you choose.</p>
    </div>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '18px', marginTop: '48px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: '14px' }}>
    {[
    { branch: 'feat/checkout', path: '~/wt/checkout', head: true, status: 'var(--add)', agent: ['Claude', 'Claude Opus 5.5', 'xhigh'], log: [['✓ edited Cart.tsx', '#62d6ae'], ['✓ tests pass', '#62d6ae'], ['… writing PR body']] },
    { branch: 'fix/tax-rounding', path: '~/wt/tax', status: 'var(--warn)', agent: ['Codex', 'GPT-5', 'high'], log: [['› why is 0.1+0.2 off?'], ['✓ use cents everywhere', '#62d6ae'], ['? approve change', '#f5b65c']] },
    { branch: 'feat/dark-mode', path: '~/wt/dark', status: 'var(--add)', agent: ['Gemini', 'Gemini 2.5 Pro', 'medium'], log: [['✓ tokens added', '#62d6ae'], ['… running build'], ['$ pnpm build', '#868c96']] },
    ].map((w) => (
    <div key={w.branch} style={{ background: 'var(--raised)', borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}><span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: '50%', boxSizing: 'border-box', ...(w.head ? { background: 'var(--accent)' } : { border: '2px solid var(--work)' }) }}></span><strong style={{ fontSize: '15px', flex: '1' }}>{w.branch}</strong><span aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', background: w.status }}></span></div>
    <div style={{ fontSize: '12px', color: 'var(--faint)' }}>{w.path}</div>
    {/* mirrors the app's agent pane: Agent/Shell tabs, transcript, prompt bar with provider/model/effort */}
    <div aria-hidden="true" style={{ background: 'var(--term)', border: '1px solid var(--line)', borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column', fontSize: '11.5px' }}>
    <div style={{ display: 'flex', borderBottom: '1px solid var(--line)' }}><span style={{ padding: '6px 10px', color: 'var(--fg)', borderRight: '1px solid var(--line)' }}>✦ Agent</span><span style={{ padding: '6px 10px', color: 'var(--faint)', borderRight: '1px solid var(--line)' }}>›_ Shell</span></div>
    <div className="mono" style={{ padding: '10px 12px', lineHeight: '1.9', minHeight: '96px', color: '#a0a5ae' }}>{w.log.map(([t, c], i) => <div key={i} style={c ? { color: c } : undefined}>{t}{i === w.log.length - 1 && t.startsWith('$') && <span className="blink">▍</span>}</div>)}</div>
    <div className="mono" style={{ display: 'flex', gap: '6px', padding: '7px 10px', borderTop: '1px solid var(--line)', color: 'var(--faint)' }}><span style={{ color: 'var(--accent)' }}>›</span>Ask the agent…</div>
    <div style={{ display: 'flex', borderTop: '1px solid var(--line)', color: 'var(--muted)' }}>{w.agent.map((a) => <span key={a} style={{ padding: '6px 8px', borderRight: '1px solid var(--line)', minWidth: '0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a} ⌄</span>)}<span style={{ marginLeft: 'auto', padding: '6px 10px', background: 'var(--accent-soft)', color: 'var(--accent-fg)' }}>➤</span></div>
    </div>
    </div>
    ))}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '28px', alignItems: 'center' }}>
    <span style={{ fontSize: '14px', color: 'var(--faint)', marginRight: '6px' }}>Bring your agent:</span>
    <span style={{ fontSize: '14px', padding: '7px 14px', borderRadius: '999px', background: 'var(--panel)', border: '1px solid var(--line)' }}>Claude Code</span>
    <span style={{ fontSize: '14px', padding: '7px 14px', borderRadius: '999px', background: 'var(--panel)', border: '1px solid var(--line)' }}>Codex</span>
    <span style={{ fontSize: '14px', padding: '7px 14px', borderRadius: '999px', background: 'var(--panel)', border: '1px solid var(--line)' }}>Gemini</span>
    <span style={{ fontSize: '14px', padding: '7px 14px', borderRadius: '999px', background: 'var(--panel)', border: '1px solid var(--line)' }}>Copilot</span>
    <span style={{ fontSize: '14px', padding: '7px 14px', borderRadius: '999px', background: 'var(--panel)', border: '1px solid var(--line)' }}>Ollama</span>
    <span style={{ fontSize: '14px', padding: '7px 14px', borderRadius: '999px', border: '1px dashed var(--rail)', color: 'var(--muted)' }}>or an API key</span>
    </div>
    <p style={{ margin: '18px 0 0', fontSize: '16px', color: 'var(--muted)' }}>Every action is also an <strong style={{ color: 'var(--fg)' }}>MCP tool</strong>, so another agent can drive Gitnetix too: <code style={{ fontSize: '14px', color: 'var(--fg)', background: 'var(--panel)', padding: '2px 8px', borderRadius: '6px' }}>claude mcp add gitnetix</code></p>
    </section>

    {/* MOBILE */}
    <section className="sec" aria-labelledby="mo-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '48px', alignItems: 'center' }}>
    <div style={{ position: 'relative', flex: '1 1 380px', maxWidth: '640px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>REMOTE</p>
    <h2 id="mo-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em', textWrap: 'balance' }}>Your desktop, in your pocket.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Scan the QR code from your desktop and the same app opens in your phone's browser. Approve agents, ship hotfixes, review PRs.</p>
    </div>
    <div style={{ flex: '1 1 260px', display: 'flex', justifyContent: 'center' }}>
    <figure style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center' }}>
    <div style={{ position: 'relative', width: '264px', maxWidth: '100%', background: '#0b0c0e', border: '2px solid var(--rail)', borderRadius: '18px', padding: '10px', boxSizing: 'border-box', boxShadow: '0 30px 80px -30px rgba(0,0,0,.8), 0 0 50px -20px rgba(240,164,58,.45)' }}>
    <img src={u("phone.jpg")} alt="Gitnetix on a phone browser: the branch tree with main, a merged-into-main group, the checked-out v0.4.2 hotfix release, a Shipped group, and Releases, Agents, PRs and Tickets tabs" width="640" height="1153" loading="lazy" style={{ display: 'block', width: '100%', height: 'auto', borderRadius: '9px' }} />
    </div>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--add)', background: 'var(--panel)', border: '1px solid var(--line)', padding: '4px 12px', borderRadius: '999px' }}><span aria-hidden="true" style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--add)' }}></span>Real screenshot · paired by QR code</span>
    </figure>
    </div>
    </div>
    </section>

    {/* AI BORING TEXT */}
    <section className="sec" aria-labelledby="ai-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>TEMPLATES + MODEL ROUTING</p>
    <h2 id="ai-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em' }}>AI writes the boring text.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Editable templates decide what gets written. Per-task routing decides who writes it: a cheap model for commit messages, a strong one for conflicts. Works with a signed-in CLI or an API key.</p>
    </div>
    {/* 300px columns: three across on desktop, so the six cards fill two whole rows. */}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '1px', marginTop: '48px', background: 'var(--line)', border: '1px solid var(--line)', borderRadius: '16px', overflow: 'hidden' }}>
    <div style={{ background: 'var(--panel)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}><h3 style={{ margin: '0', fontSize: '18px' }}>Commit messages</h3><p className="mono" style={{ margin: '0', fontSize: '13px', color: 'var(--muted)' }}>"Pulse along branch path"</p></div>
    <div style={{ background: 'var(--panel)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}><h3 style={{ margin: '0', fontSize: '18px' }}>Branch names</h3><p className="mono" style={{ margin: '0', fontSize: '13px', color: 'var(--muted)' }}>fix/tax-rounding</p></div>
    <div style={{ background: 'var(--panel)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}><h3 style={{ margin: '0', fontSize: '18px' }}>PR descriptions</h3><p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>Written from the branch's real diff, ready to edit.</p></div>
    <div style={{ background: 'var(--panel)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}><h3 style={{ margin: '0', fontSize: '18px' }}>Release notes</h3><p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>"Update changelog" adds the branch to <code>Unreleased</code>.</p></div>
    <div style={{ background: 'var(--panel)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}><h3 style={{ margin: '0', fontSize: '18px' }}>Conflict resolutions</h3><p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>Proposed during a rebase, routed to your strongest model.</p></div>
    <div style={{ background: 'var(--panel)', padding: '24px', display: 'flex', flexDirection: 'column', gap: '8px' }}><h3 style={{ margin: '0', fontSize: '18px' }}>Ticket triage</h3><p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>Tickets matched to branches by key, release guessed from Jira fix version.</p></div>
    </div>
    </section>

    {/* STACK */}
    <section className="sec" aria-labelledby="st-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <h2 id="st-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em' }}>Fits your stack.</h2>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '16px', marginTop: '40px' }}>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <h3 style={{ margin: '0', fontSize: '13px', letterSpacing: '.14em', color: 'var(--faint)', fontWeight: '600' }}>PULL REQUESTS</h3>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>GitHub</span><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>Azure DevOps</span></div>
    <p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>List, review, comment, reply, resolve, merge and close, without leaving the tree.</p>
    </div>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <h3 style={{ margin: '0', fontSize: '13px', letterSpacing: '.14em', color: 'var(--faint)', fontWeight: '600' }}>TICKETS</h3>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>Jira</span><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>Trello</span><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>Asana</span></div>
    <p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>Branches matched to tickets by key, mine and sprint filters, status changes from the detail pane.</p>
    </div>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <h3 style={{ margin: '0', fontSize: '13px', letterSpacing: '.14em', color: 'var(--faint)', fontWeight: '600' }}>PLATFORMS</h3>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>macOS</span><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>Windows</span><span style={{ padding: '8px 14px', borderRadius: '10px', background: 'var(--raised)', fontWeight: '500' }}>Linux</span><span style={{ padding: '8px 14px', borderRadius: '10px', border: '1px dashed var(--rail)', color: 'var(--muted)' }}>Headless server</span></div>
    <p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>A phone or any browser pairs with your desktop to manage it remotely.</p>
    </div>
    </div>
    </section>

    {/* BUILT IN PUBLIC */}
    <section className="sec" aria-labelledby="bip-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '40px', alignItems: 'flex-end', justifyContent: 'space-between' }}>
    <div style={{ position: 'relative', maxWidth: '640px' }}>
    <span className="knot" aria-hidden="true"></span>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>BUILT IN PUBLIC</p>
    <h2 id="bip-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em', textWrap: 'balance' }}>{releases.length} releases in {days} days.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>From the first release on {longDate(first.date)} to v{releases[0].version} on {longDate(releases[0].date)}. Every release is cut, dated and tagged the way Gitnetix ships: <code>Unreleased</code>, then one click.</p>
    </div>
    <a href={u("releases/")} style={{ fontWeight: '600', color: 'var(--accent-fg)', display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px' }}>Read every release <span aria-hidden="true">→</span></a>
    </div>
    <ol style={{ listStyle: 'none', margin: '44px 0 0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: '16px' }}>
    {featured.map((r, i) => (
    <li key={r.version}><a className="card-link" href={u(`releases/${r.version}/`)} style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', boxSizing: 'border-box', background: 'var(--panel)', border: `1px solid ${i === 0 ? 'rgba(240,164,58,.4)' : 'var(--line)'}`, borderRadius: '14px', padding: '24px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}><span className="mono" style={{ color: 'var(--release)', background: 'var(--chip)', padding: '2px 10px', borderRadius: '999px' }}>v{r.version}</span><time dateTime={r.date} style={{ color: 'var(--faint)' }}>{shortDate(r.date)}</time>{r === releases[0] && <span style={{ marginLeft: 'auto', color: 'var(--accent-fg)', fontWeight: '600' }}>Latest</span>}</div>
    <h3 style={{ margin: '0', fontSize: '21px', letterSpacing: '-0.01em' }}>{r.title}</h3>
    <p style={{ margin: '0', fontSize: '15px', color: 'var(--muted)' }}>{r.highlights.length ? r.highlights.join(' · ') : plain(r.sections[0]?.items[0] ?? '')}</p>
    </a></li>
    ))}
    </ol>
    </section>

    {/* UNDER THE HOOD */}
    <section className="sec" aria-labelledby="uh-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '18px', padding: 'clamp(24px, 4vw, 48px)', display: 'flex', flexWrap: 'wrap', gap: '32px 56px', position: 'relative' }}>
    <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <p style={{ margin: '0', fontSize: '13px', letterSpacing: '.14em', color: 'var(--faint)', fontWeight: '600' }}>UNDER THE HOOD</p>
    <h2 id="uh-h" style={{ margin: '0', fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: '1.1', letterSpacing: '-0.02em' }}>Small, fast, native. And it's real git.</h2>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '17px' }}>A Rust engine wraps the <code>git</code> CLI you already trust. Branch views are cached per project and only changed branches are rebuilt. Origin is fetched and pruned every five minutes.</p>
    </div>
    <dl style={{ flex: '1 1 380px', margin: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))', gap: '22px 28px' }}>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>Rust</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Engine on the real git CLI</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>Tauri 2</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Native shell, small download</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>React</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>One UI for desktop, phone and browser</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>Keychain</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>API keys and tokens in your OS keychain</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>MCP</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Every RPC method exposed as a tool</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>Auto-update</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>New releases offered on launch</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>Calm motion</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Fluid by default, every animation can be turned off</dd></div>
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>Dark &amp; light</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Follows your system, or pick one</dd></div>
    </dl>
    </div>
    </section>

    {/* FAQ */}
    <section id="faq" className="sec" aria-labelledby="faq-h" style={{ paddingTop: '96px', paddingBottom: '40px', position: 'relative' }}>
    <div style={{ position: 'relative', maxWidth: '760px' }}>
    <span className="knot" aria-hidden="true"></span>
    <h2 id="faq-h" style={{ margin: '0', fontSize: 'clamp(34px, 4.6vw, 56px)', lineHeight: '1.05', letterSpacing: '-0.03em' }}>Questions, answered.</h2>
    </div>
    <div style={{ marginTop: '36px', maxWidth: '880px', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)' }}>
    {faq.map((f, i) => (
    <details key={f.q} open={i === 0} style={{ borderBottom: '1px solid var(--line)' }}>
    <summary style={{ display: 'flex', alignItems: 'center', gap: '16px', padding: '22px 0', minHeight: '24px' }}><h3 style={{ margin: '0', fontSize: '20px', fontWeight: '600', flex: '1' }}>{f.q}</h3><span className="chev" aria-hidden="true" style={{ color: 'var(--accent-fg)', fontSize: '24px', transition: 'transform .2s' }}>+</span></summary>
    <p style={{ margin: '0 0 22px', color: 'var(--muted)', maxWidth: '720px' }} dangerouslySetInnerHTML={{ __html: f.a }} />
    </details>
    ))}
    </div>
    </section>
    </div>

    {/* FINAL CTA: the path ends here */}
    <section aria-labelledby="cta-h" style={{ padding: '120px 24px 120px', position: 'relative', textAlign: 'center' }}>
    <div style={{ maxWidth: '860px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '22px' }}>
    <span aria-hidden="true" style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 8px var(--accent-soft), 0 0 40px rgba(240,164,58,.6)' }}></span>
    <h2 id="cta-h" style={{ margin: '0', fontSize: 'clamp(40px, 6vw, 76px)', lineHeight: '1.02', letterSpacing: '-0.035em', textWrap: 'balance' }}>Stop reading the subway map.</h2>
    <p style={{ margin: '0', fontSize: '19px', color: 'var(--muted)' }}>Free download for macOS, Windows and Linux.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '6px' }}>
    <a className="btn-p" data-dl href={u("download/")} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', padding: '15px 24px', borderRadius: '12px', boxShadow: '0 8px 30px -8px rgba(240,164,58,.6)' }}><span data-dl-label>Download Gitnetix</span></a>
    <a className="btn-s" href={u("download/")} style={{ fontWeight: '500', padding: '15px 22px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--panel)' }}>All downloads</a>
    </div>
    </div>
    </section>
    </>
  );
}
