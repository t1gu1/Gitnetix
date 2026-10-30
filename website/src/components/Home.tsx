import type { CSSProperties, ReactNode } from 'react';
import faq from '../data/faq.json';
import { REPO, releases, shortDate, longDate, plain, u } from '../lib/changelog';
import { Icon } from '../../../src/components/Icon';
import { THEMES } from '../../../src/lib/themes';
import ThemePicker from './ThemePicker';
import { PathLine, type Path } from './HeroDemo';
import { Avatar } from './demo/ui';

/** The orange path from main to the checked-out row in the "subway map" tree, measured once off the rendered rows like HeroDemo does. */
const TREE_PATH: Path = { d: 'M6.5 6V127H12.5V214H18.5V239.5', len: 245.5, x: 18.5, top: 214, mid: 239.5, bottom: 265 };

/** The "other Git clients" graph: one commit per row like a real log, seven lanes forking off and merging across each other. */
const RAILS = ['#5b8def', '#e5534b', '#57ab5a', '#c69026', '#986ee2', '#39c5cf', '#e0823d'];
const lane = (l: number) => 10 + l * 26;
const row = (r: number) => 14 + r * 24;
/** [lane, forked from lane, at row, merged into lane, at row] */
const FORKS = [[1, 0, 1, 0, 15], [2, 1, 3, 1, 10], [3, 0, 2, 0, 12], [4, 2, 5, 0, 17], [5, 3, 4, 1, 14], [6, 0, 6, 4, 13]];
/** Per row: [the commit's lane, message width %, ref label width px] */
const COMMITS: [number, number, number?][] = [[0, 70, 38], [0, 88], [1, 62, 52], [3, 80, 44], [2, 55], [5, 74], [4, 92], [6, 58, 46], [1, 84], [2, 66], [3, 90], [5, 52], [0, 76], [4, 68], [1, 94], [0, 60, 34], [4, 82], [0, 72]];

/** The hero's side rails, left side (the right mirrors it): per rail, when its pulse leaves in the glow's 8s breath (at the peak), and its [x, y, station?] points from the top.
 *  The pulse runs at the app's 90px/s, so each station flashes at its distance down the rail. */
const HERO_RAILS = ([
  [3.4, [[300, -8], [300, 56, 1], [300, 120], [256, 164], [256, 236, 1], [256, 332, 1], [256, 412, 1], [256, 520]]],
  // A branch off the first rail and back: same start, so its pulse splits off at the fork and rejoins at the merge.
  [3.4, [[300, -8], [300, 120], [256, 164], [256, 236], [288, 268], [288, 324, 1], [288, 380], [256, 412]]],
  [3.7, [[264, -8], [264, 40], [196, 108], [196, 156, 1], [196, 250, 1], [196, 300], [156, 340], [156, 400, 1], [156, 490, 1], [156, 520]]],
  [4, [[228, -8], [228, 16], [136, 108], [136, 160, 1], [136, 220], [76, 280], [76, 330, 1], [76, 430, 1], [76, 520]]],
] as [number, number[][]][]).map(([at, pts]) => {
  let run = 0;
  return {
    at,
    d: `M${pts.map(([x, y]) => `${x} ${y}`).join('L')}`,
    stops: pts.flatMap(([x, y, stop], i) => {
      if (i) run += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
      return stop ? [{ x, y, at: at + run / 90 }] : [];
    }),
  };
});

function HeroRails({ side }: { side: 'l' | 'r' }) {
  return (
    <svg className={`hero-rails hero-rails-${side}`} aria-hidden="true" width="320" height="560">
      {HERO_RAILS.map((r, i) => <path key={i} className="rail" d={r.d} />)}
      {HERO_RAILS.map((r, i) => <path key={i} className="beam" d={r.d} style={{ animationDelay: `${r.at}s` }} />)}
      {HERO_RAILS.flatMap((r) => r.stops).map((s, i) => {
        const delay = { animationDelay: `${s.at.toFixed(2)}s` };
        return <g key={i}><circle className="ring" cx={s.x} cy={s.y} r="3.5" style={delay} /><circle className="stop" cx={s.x} cy={s.y} r="3.5" style={delay} /></g>;
      })}
    </svg>
  );
}

/** A static branch row, in HeroDemo's markup (from src/screens/BranchTree.tsx). */
function TreeRow({ row, role, icon, author, name, tag, current, act, meta, ai }: { row: string; role: string; icon: string; author: string; name: string; tag?: string; current?: boolean; act: string; meta: ReactNode; ai?: boolean }) {
  return (
    <div className="tree-row" data-row={row} data-role={role} data-current={current || undefined}>
      <span className="tree-btn">
        <span className="tree-lead"><span className="tree-icon"><Icon name={icon} size={13} stroke={1.5} /></span><Avatar name={author} /></span>
        <span className="tree-main">
          <span className="tree-name"><span className="mono ellipsis">{name}</span>{tag && <span className="tag accent">{tag}</span>}</span>
          <span className="branch-meta">{meta}</span>
          {ai && <span className="branch-meta"><span className="row c-acc" style={{ gap: 4 }}><Icon name="layers" size={11} stroke={1.4} /><span className="ai-fade">AI working</span></span></span>}
        </span>
      </span>
      <span className="tree-acts"><span className="acts"><span className="act act-main"><Icon name={act} size={14} /></span><span className="act-stack"><span className="act"><Icon name="plus" size={12} /></span><span className="act"><Icon name="more" size={13} /></span></span></span></span>
    </div>
  );
}

/** The landing page, ported from the "Gitnetix website" design canvas. */
export default function Home({ version, demo, agents, phone }: { version: string; demo?: ReactNode; agents?: ReactNode; phone?: ReactNode }) {
  const first = releases[releases.length - 1];
  const days = Math.round((Date.parse(releases[0].date) - Date.parse(first.date)) / 864e5) + 1;
  const featured = releases.filter((r) => r.story).slice(0, 3);
  return (
    <>
    {/* HERO */}
    <section aria-labelledby="hero-h" className="hero-glow" style={{ '--glow-size': '900px 480px', padding: '88px 24px 40px' } as CSSProperties}>
    <HeroRails side="l" /><HeroRails side="r" />
    <div style={{ maxWidth: '1080px', margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '24px' }}>
    <a className="btn-s muted" href={u(`releases/${releases[0].version}/`)} style={{ display: 'inline-flex', alignItems: 'center', gap: '10px', fontSize: '14px', padding: '6px 14px 6px 6px', border: '1px solid var(--line)', borderRadius: '999px', background: 'var(--panel)' }}>
    <span style={{ background: 'var(--accent-soft)', color: 'var(--accent-fg)', fontWeight: '600', padding: '2px 10px', borderRadius: '999px' }} className="mono">v{releases[0].version}</span>
    <span>{releases[0].title}</span>
    <span aria-hidden="true">→</span>
    </a>
    <h1 id="hero-h" style={{ margin: '0', fontSize: 'clamp(44px, 7.2vw, 92px)', lineHeight: '1.02', letterSpacing: '-0.035em', fontWeight: '700', textWrap: 'balance', maxWidth: '980px' }}>See your work, <span style={{ color: 'var(--accent-fg)' }}>not your commits.</span></h1>
    <p style={{ margin: '0', fontSize: 'clamp(18px, 2vw, 22px)', color: 'var(--muted)', maxWidth: '680px', textWrap: 'pretty' }}>Gitnetix is a Git client with no commit graph. Branches as a tree. Releases as a button. An agent on every branch.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '8px' }}>
    <a className="btn-p" data-dl href={u("download/")} style={{ display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', fontSize: '17px', padding: '15px 24px', borderRadius: '12px', boxShadow: '0 8px 30px -8px color-mix(in srgb,var(--accent) 60%,transparent)' }}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"></path></svg>
    <span data-dl-label>Download Gitnetix</span>
    </a>
    <a className="btn-s" href={REPO} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '500', fontSize: '17px', padding: '15px 22px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--panel)' }}>View on GitHub</a>
    </div>
    <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)' }}><span data-dl-note>v{version} · Free for macOS, Windows and Linux</span> · <a className="muted" href={u("download/")} style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>Other platforms</a></p>
    </div>

    {/* THEMES: a pick repaints the whole site and the demo below */}
    <section aria-labelledby="th-h" style={{ maxWidth: '1120px', margin: '64px auto 0', boxSizing: 'border-box', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '20px 40px' }}>
    <div style={{ flex: '1 1 340px' }}>
    <p style={{ margin: '0 0 8px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>{THEMES.length} THEMES</p>
    <h2 id="th-h" style={{ margin: '0', fontSize: 'clamp(24px, 2.6vw, 30px)', lineHeight: '1.15', letterSpacing: '-0.02em', textWrap: 'balance' }}>Make it look the way you love.</h2>
    <p style={{ margin: '10px 0 0', fontSize: '16px', color: 'var(--muted)', textWrap: 'pretty' }}>Catppuccin, Rosé Pine, Tokyo Night, Dracula, Nord, Gruvbox and more, dark and light. A theme colors every pane of the app, down to the terminal. Try one: this whole site and the demo below switch to it.</p>
    </div>
    <div style={{ flex: '1 1 460px' }}><ThemePicker /></div>
    </section>

    {/* hero app window */}
    <figure style={{ maxWidth: '1120px', margin: '32px auto 0', padding: '0' }}>
    <p style={{ margin: '0 auto 16px', width: 'fit-content', maxWidth: '100%', boxSizing: 'border-box', fontSize: '13px', color: 'var(--muted)', background: 'var(--panel)', border: '1px solid var(--line)', padding: '6px 14px', borderRadius: '999px', textAlign: 'center' }}>Heads up: this web demo runs on made-up data and is a bit clunkier than the real app. Not every button works.</p>
    {demo}
    <figcaption style={{ textAlign: 'center', fontSize: '13px', color: 'var(--faint)', marginTop: '16px' }}>Try it: pick a branch, open a file, ask the agent, commit; double-click a branch to check it out. Every tab opens too: answer the agents in Worktrees &amp; agents, review a pull request, triage tickets.</figcaption>
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
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '14px', padding: '22px', height: '480px', boxSizing: 'border-box', display: 'flex', gap: '24px', overflow: 'hidden' }}>
    <svg role="img" aria-label="A tangled commit graph with seven crossing colored rails" width={lane(RAILS.length - 1) + 10} height={row(COMMITS.length) - 10} style={{ flex: 'none', opacity: '.85' }}>
    <g fill="none" strokeWidth="3" strokeLinecap="round">
    <path d={`M${lane(0)} 0V${row(COMMITS.length)}`} stroke={RAILS[0]}></path>
    {FORKS.map(([l, from, at, into, end]) => <path key={l} d={`M${lane(from)} ${row(at)}C${lane(from)} ${row(at) + 12} ${lane(l)} ${row(at) + 12} ${lane(l)} ${row(at + 1)}V${row(end - 1)}C${lane(l)} ${row(end) - 12} ${lane(into)} ${row(end) - 12} ${lane(into)} ${row(end)}`} stroke={RAILS[l]}></path>)}
    </g>
    <g fill="var(--panel)" strokeWidth="2.5">
    {COMMITS.map(([l], r) => <circle key={r} cx={lane(l)} cy={row(r)} r="5" stroke={RAILS[l]}></circle>)}
    </g>
    </svg>
    <div aria-hidden="true" style={{ flex: '1', display: 'flex', flexDirection: 'column', paddingTop: '2px', minWidth: '0' }}>
    {COMMITS.map(([l, w, ref], r) => (
    <div key={r} style={{ height: '24px', display: 'flex', alignItems: 'center', gap: '8px' }}>
    {ref && <span style={{ flex: 'none', width: `${ref}px`, height: '14px', boxSizing: 'border-box', borderRadius: '4px', border: `1px solid ${RAILS[l]}`, background: `color-mix(in srgb, ${RAILS[l]} 18%, transparent)` }}></span>}
    <span style={{ flex: '0 1 auto', height: '9px', width: `${w}%`, minWidth: '24px', borderRadius: '5px', background: 'var(--rail)' }}></span>
    <span style={{ flex: '0 1 30px', marginLeft: 'auto', height: '7px', borderRadius: '4px', background: 'var(--rail)', opacity: '.5' }}></span>
    </div>
    ))}
    </div>
    </div>
    <figcaption style={{ fontSize: '16px', color: 'var(--muted)' }}>Which branch is mine? What ships next? What's dead?</figcaption>
    </figure>
    {/* after: the app's branch pane, in HeroDemo's markup so its .hd rules (copies of src/styles/app.css) apply */}
    <figure style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    <div style={{ fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>GITNETIX</div>
    <div className="ap hd" role="img" aria-label="The Gitnetix branch pane: main, a Merged into main group, the next release v2.4.0 with the checked-out feat/checkout-redesign and fix/cart-total where AI is working, and a Shipped group" style={{ background: 'var(--panel)', border: '1px solid color-mix(in srgb,var(--accent) 35%,transparent)', borderRadius: '14px', height: '480px', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
    <div className="ws-releases" style={{ display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' }}>
    <div className="pane-head">
    <span className="label">Branches</span>
    <span className="row"><span className="acts"><span className="act act-main"><Icon name="refresh" size={14} /></span><span className="act act-main act-text"><Icon name="plus" size={14} />Release</span></span></span>
    </div>
    <div className="tree-filter">
    <Icon name="search" size={12} className="faint" />
    <span className="input" style={{ display: 'flex', alignItems: 'center', color: 'var(--faint)' }}>Filter branches</span>
    <span className="btn btn-sm" style={{ flex: '0 0 auto' }}><span className="ellipsis">All</span><Icon name="chevronDown" size={10} /></span>
    </div>
    <div className="tree">
    <PathLine p={TREE_PATH} />
    <div className="tree-node">
    <TreeRow row="main" role="trunk" icon="home" author="Ana Moreau" name="main" act="swap" meta={<span className="meta-link">all commits</span>} />
    <div className="tree-sub">
    <div className="tree-row tree-group tree-merged">
    <span className="tree-merged-toggle"><span className="tree-twist"><Icon name="chevronDown" size={12} className="chev hd-shut" /></span><span className="group-label">Merged into main</span><span className="faint">3</span></span>
    <span className="act act-main tree-cleanup"><Icon name="brush" size={14} /></span>
    </div>
    <div className="tree-row tree-group tree-toggle"><span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span><span className="child-label" data-active>Child branches</span><span className="faint">1</span></div>
    <div className="tree-open"><div className="tree-kids">
    <div className="tree-node">
    <TreeRow row="v2.4.0" role="release" icon="tag" author="Ana Moreau" name="v2.4.0" tag="Next" act="ship" meta={<><span className="mono">release/2.4.0</span><span className="meta-link">6 commits</span></>} />
    <div className="tree-sub">
    <div className="tree-row tree-group tree-toggle"><span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span><span className="child-label" data-active>Child branches</span><span className="faint">2</span></div>
    <div className="tree-open"><div className="tree-kids">
    <div className="tree-node"><TreeRow row="feat" role="branch" icon="branch" author="Grace Hopper" name="checkout-redesign" current act="merged" meta={<><span className="kind-chip c-mod">feat</span><span className="c-current">checked out</span><span className="meta-link">4 commits</span></>} /></div>
    <div className="tree-node"><TreeRow row="fix" role="branch" icon="branch" author="Jules Laurent" name="cart-total" act="swap" meta={<><span className="kind-chip c-del">fix</span><span className="meta-link">2 commits</span></>} ai /></div>
    </div></div>
    </div>
    </div>
    </div></div>
    </div>
    </div>
    <div className="tree-sep" />
    <div className="tree-row tree-group"><span className="tree-twist"><Icon name="chevronDown" size={12} className="chev hd-shut" /></span><span className="shipped-label">Shipped</span><span className="faint">5</span></div>
    </div>
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}><span aria-hidden="true" style={{ width: '16px', height: '16px', borderRadius: '4px', border: '2px solid var(--accent-fg)', boxSizing: 'border-box' }}></span><h3 style={{ margin: '0', fontSize: '20px', letterSpacing: '-0.01em' }}>Shipped, with its tag</h3></div>
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
    <li style={{ background: 'linear-gradient(160deg, var(--accent-soft), var(--panel) 60%)', border: '1px solid color-mix(in srgb,var(--accent) 55%,transparent)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 0 40px -12px color-mix(in srgb,var(--accent) 45%,transparent)' }}>
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
    {/* the three agent cards, playing (AgentCards.tsx, an island from index.astro) */}
    {agents}
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
    <div style={{ flex: '1 1 344px', display: 'flex', justifyContent: 'center' }}>
    <figure style={{ margin: '0', display: 'flex', flexDirection: 'column', gap: '14px', alignItems: 'center' }}>
    <div style={{ position: 'relative', width: '344px', maxWidth: '100%', background: '#0b0c0e', border: '2px solid var(--rail)', borderRadius: '18px', padding: '10px', boxSizing: 'border-box', boxShadow: '0 30px 80px -30px rgba(0,0,0,.8), 0 0 50px -20px color-mix(in srgb,var(--accent) 45%,transparent)' }}>
    {phone}
    </div>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--add)', background: 'var(--panel)', border: '1px solid var(--line)', padding: '4px 12px', borderRadius: '999px' }}><span aria-hidden="true" style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--add)' }}></span>Playable · the same app, paired by QR code</span>
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
    <li key={r.version}><a className="card-link" href={u(`releases/${r.version}/`)} style={{ display: 'flex', flexDirection: 'column', gap: '10px', height: '100%', boxSizing: 'border-box', background: 'var(--panel)', border: `1px solid ${i === 0 ? 'color-mix(in srgb,var(--accent) 40%,transparent)' : 'var(--line)'}`, borderRadius: '14px', padding: '24px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }}><span className="mono" style={{ color: 'var(--accent-fg)', background: 'var(--accent-soft)', fontWeight: '600', padding: '2px 10px', borderRadius: '999px' }}>v{r.version}</span><time dateTime={r.date} style={{ color: 'var(--faint)' }}>{shortDate(r.date)}</time>{r === releases[0] && <span style={{ marginLeft: 'auto', color: 'var(--accent-fg)', fontWeight: '600' }}>Latest</span>}</div>
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
    <div><dt className="mono" style={{ color: 'var(--accent-fg)', fontSize: '14px' }}>{THEMES.length} themes</dt><dd style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: '15px' }}>Dark or light, or follow your system</dd></div>
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
    <span aria-hidden="true" style={{ width: '22px', height: '22px', borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 8px var(--accent-soft), 0 0 40px color-mix(in srgb,var(--accent) 60%,transparent)' }}></span>
    <h2 id="cta-h" style={{ margin: '0', fontSize: 'clamp(40px, 6vw, 76px)', lineHeight: '1.02', letterSpacing: '-0.035em', textWrap: 'balance' }}>Stop reading the subway map.</h2>
    <p style={{ margin: '0', fontSize: '19px', color: 'var(--muted)' }}>Free download for macOS, Windows and Linux.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '6px' }}>
    <a className="btn-p" data-dl href={u("download/")} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', padding: '15px 24px', borderRadius: '12px', boxShadow: '0 8px 30px -8px color-mix(in srgb,var(--accent) 60%,transparent)' }}><span data-dl-label>Download Gitnetix</span></a>
    <a className="btn-s" href={u("download/")} style={{ fontWeight: '500', padding: '15px 22px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--panel)' }}>All downloads</a>
    </div>
    </div>
    </section>
    </>
  );
}
