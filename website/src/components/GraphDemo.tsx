import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
// The app's own graph: its drawing (rows, lanes, fades) and its engine (layout, and what an action would leave).
import { GraphCanvas, PreviewBanner } from '../../../src/components/GraphCanvas';
import { Icon } from '../../../src/components/Icon';
import type { GraphView } from '../../../src/api/types';
import { layout, repoOf, simulate, type Focus } from '../../../src/lib/graph';
import type { GraphIntent } from '../../../src/lib/graphPreview';
import { Avatar } from './demo/ui';

/**
 * The homepage's graph preview: the app's Graph column beside a branch and its open menu, on made-up commits.
 * A pointer hovers one action after the other and the graph shows what each would leave, as in the app; hovering
 * (or tapping) an action yourself takes over. The page ships the graph at rest; the pointer starts once it's in view.
 */

const SAM = 'Sam Rivera';
const ALICE = 'Alice Martin';
const BOB = 'Bob Chen';
const C = (sha: string, subject: string, author: string, parents: string[], tags: string[] = []) => ({ sha, parents, subject, author, email: '', date: '', tags });

/** main, the next release with a feature merged in, the checked-out feature (one commit not pushed yet) and a fix. */
const VIEW: GraphView = {
  commits: [
    C('a41f0c2', 'Order summary', SAM, ['93be7d1']),
    C('93be7d1', 'Payment step', BOB, ['5c2e8aa']),
    C('5c2e8aa', 'Address form', SAM, ['e07d915']),
    C('e07d915', 'Checkout page skeleton', SAM, ['7f3a2b6']),
    C('c88d0e4', 'Log slow API calls', BOB, ['7f3a2b6']),
    C('2b9f61d', 'Fix typo in footer', SAM, ['d4e1c07']),
    C('f61a3d9', 'Cover the redirect with a test', ALICE, ['0ab7e52']),
    C('0ab7e52', 'Keep the page asked for after login', ALICE, ['7f3a2b6']),
    C('7f3a2b6', "Merge branch 'feat/search-bar' into release/1.4.0", SAM, ['61c09fe', 'b5d2e10']),
    C('b5d2e10', 'Debounce search input', ALICE, ['3e8c4a1']),
    C('3e8c4a1', 'Search bar component', ALICE, ['61c09fe']),
    C('61c09fe', 'Bump version to 1.4.0', SAM, ['d4e1c07']),
    C('d4e1c07', 'Retry failed requests', BOB, ['8a0f2c3']),
    C('8a0f2c3', 'Footer links', SAM, ['16e4b9d'], ['v1.3.0']),
    C('16e4b9d', 'Cart page', ALICE, []),
  ],
  refs: [
    { name: 'feat/checkout-flow', remote: false, sha: 'a41f0c2' },
    { name: 'feat/checkout-flow', remote: true, sha: '93be7d1' },
    { name: 'release/1.4.0', remote: false, sha: 'c88d0e4' },
    { name: 'release/1.4.0', remote: true, sha: 'c88d0e4' },
    { name: 'main', remote: false, sha: '2b9f61d' },
    { name: 'main', remote: true, sha: '2b9f61d' },
    { name: 'fix/login-redirect', remote: false, sha: 'f61a3d9' },
  ],
  head: 'feat/checkout-flow',
  headSha: 'a41f0c2',
  gaps: [],
};
const AGES: Record<string, string> = {
  a41f0c2: '2h ago', '93be7d1': '1d ago', '5c2e8aa': '3d ago', e07d915: '5d ago', c88d0e4: '4d ago', '2b9f61d': '6d ago', f61a3d9: '3d ago', '0ab7e52': '5d ago',
  '7f3a2b6': '9d ago', b5d2e10: '11d ago', '3e8c4a1': '12d ago', '61c09fe': '14d ago', d4e1c07: '18d ago', '8a0f2c3': '21d ago', '16e4b9d': '25d ago',
};
const BRANCH = 'feat/checkout-flow';
const COLORS: Record<string, string> = { main: 'var(--trunk-fg)', 'release/1.4.0': 'var(--release-fg)', [BRANCH]: 'var(--mod-fg)', 'fix/login-redirect': 'var(--prop-fg)' };
// Labels read like the tree's rows: a release by its version, a feature or fix without its type.
const label = (b: string) => (b.startsWith('release/') ? `v${b.slice(8)}` : b.replace(/^(feat|fix)\//, ''));
const FOCUS: Focus = {
  lanes: ['main', 'release/1.4.0', BRANCH, 'fix/login-redirect'],
  first: [BRANCH, 'release/1.4.0', 'main', 'fix/login-redirect'],
  open: new Set(),
  color: (b) => COLORS[b] ?? 'var(--accent)',
  label,
};

/** The branch menu's actions, as BranchMenu.tsx lists them for this branch, and what each would do. */
type Item = { id: string; icon: string; label: ReactNode; hint?: string; intent: GraphIntent };
const ITEMS: (Item | 'sep')[] = [
  { id: 'push', icon: 'push', label: 'Push', hint: '↑1', intent: { kind: 'push', branch: BRANCH } },
  { id: 'stash', icon: 'stash', label: 'Stash changes', hint: '2 files', intent: { kind: 'stash', branch: BRANCH } },
  'sep',
  { id: 'rebase', icon: 'branch', label: <>Rebase onto <span className="mono">v1.4.0</span></>, hint: '1 behind', intent: { kind: 'rebase', branch: BRANCH, onto: 'release/1.4.0' } },
  { id: 'merge', icon: 'merged', label: <>Merge into <span className="mono">v1.4.0</span>…</>, hint: '4 commits', intent: { kind: 'merge', branch: BRANCH, into: 'release/1.4.0', deleteBranch: true } },
  'sep',
  { id: 'create', icon: 'plus', label: 'Create a branch from here', intent: { kind: 'create', from: BRANCH } },
  { id: 'tag', icon: 'tag', label: 'Create tag…', intent: { kind: 'tag', branch: BRANCH } },
];
const byId = new Map(ITEMS.flatMap((it) => (it === 'sep' ? [] : [[it.id, it] as const])));

/** What the pointer does on its own: rest, then hover each action a while. */
const SCRIPT: [string | null, number][] = [[null, 1800], ['push', 2800], ['rebase', 3600], ['merge', 3600], ['tag', 2800], ['stash', 2600], [null, 1400]];
/** The pointer's trip from one action to the next, and how long it rests on one before the graph previews it (as the app waits on a hover). */
const MOVE_MS = 520;
const SETTLE_MS = 90;
/** Once the visitor's own pointer leaves, the scripted one picks up again after this long; after a tap, a while later. */
const RESUME_MS = 1600;
const RESUME_TAP_MS = 6000;

function TreeRow({ row, role, icon, author, name, tag, current, pressed, act, meta }: { row: string; role: string; icon: string; author: string; name: string; tag?: string; current?: boolean; pressed?: boolean; act: string; meta: ReactNode }) {
  return (
    <div className="tree-row" data-row={row} data-role={role} data-current={current || undefined}>
      <span className="tree-btn" aria-pressed={pressed || undefined}>
        <span className="tree-lead"><span className="tree-icon"><Icon name={icon} size={13} stroke={1.5} /></span><Avatar name={author} /></span>
        <span className="tree-main">
          <span className="tree-name"><span className="mono ellipsis">{name}</span>{tag && <span className="tag accent">{tag}</span>}</span>
          <span className="branch-meta">{meta}</span>
        </span>
      </span>
      <span className="tree-acts"><span className="acts"><span className="act act-main"><Icon name={act} size={14} /></span><span className="act-stack"><span className="act"><Icon name="plus" size={12} /></span><span className="act" data-open={pressed || undefined}><Icon name="more" size={13} /></span></span></span></span>
    </div>
  );
}

export default function GraphDemo() {
  const repo = useMemo(() => repoOf(VIEW, 2), []);
  const base = useMemo(() => layout(repo, FOCUS), [repo]);
  // The action hovered: by the scripted pointer, or by the visitor's own (which wins while it is in the demo).
  const [auto, setAuto] = useState<string | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [visitor, setVisitor] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const hovered = visitor ? mine : auto;
  const item = hovered ? byId.get(hovered) : undefined;
  const preview = useMemo(() => (item ? simulate(repo, item.intent, label) : null), [repo, item]);
  const previewing = !!preview && !preview.noop;
  const shown = useMemo(() => (previewing ? layout(preview.repo, FOCUS) : base), [preview, previewing, base]);

  // Plays while in view, unless the visitor asked for less motion or has their pointer in it.
  const root = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!inView || visitor) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setPlaying(true), 250);
    return () => clearTimeout(t);
  }, [inView, visitor]);
  useEffect(() => {
    if (!playing) {
      setCursor(null);
      setAuto(null);
      return;
    }
    let step = 0;
    let t = 0;
    const timers: number[] = [];
    const run = () => {
      const [id, ms] = SCRIPT[step];
      setCursor(id);
      // Leaving an action ends its preview; the next one shows once the pointer rests on its action.
      setAuto(null);
      if (id) timers.push(window.setTimeout(() => setAuto(id), MOVE_MS + SETTLE_MS));
      step = (step + 1) % SCRIPT.length;
      t = window.setTimeout(run, ms);
    };
    run();
    return () => {
      clearTimeout(t);
      timers.forEach(clearTimeout);
    };
  }, [playing]);

  // The menu opens under the branch's "…" button, as in the app; the pointer goes to the middle-left of an action,
  // or rests by that button. Layout offsets, not boxes: the column's own entrance would be measured mid-slide.
  const menuRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ menu: CSSProperties; spots: Record<string, { x: number; y: number }> } | null>(null);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const menu = menuRef.current;
    if (!pane || !menu) return;
    const at = (el: HTMLElement) => {
      let x = 0;
      let y = 0;
      for (let e: HTMLElement | null = el; e && e !== pane; e = e.offsetParent as HTMLElement | null) {
        x += e.offsetLeft - (e.parentElement?.scrollLeft ?? 0);
        y += e.offsetTop - (e.parentElement?.scrollTop ?? 0);
      }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    };
    const measure = () => {
      const more = pane.querySelector<HTMLElement>('[data-open]');
      if (!more) return;
      const b = at(more);
      const top = b.y + b.h + 2;
      const right = pane.clientWidth - (b.x + b.w);
      const spots: Record<string, { x: number; y: number }> = { rest: { x: b.x + b.w / 2 - 3, y: b.y + b.h / 2 - 2 } };
      // The menu's items sit where it will be drawn: its own offsets, from that corner.
      const left = pane.clientWidth - right - menu.offsetWidth;
      menu.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
        spots[el.dataset.id!] = { x: left + el.offsetLeft + 46, y: top + el.offsetTop + el.offsetHeight / 2 };
      });
      setPlace({ menu: { top, right }, spots });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);
  const spot = place?.spots[cursor ?? 'rest'];

  // The visitor's pointer in the demo stops the scripted one; it picks up again a moment after they leave.
  const leave = useRef(0);
  const take = (id: string | null) => {
    clearTimeout(leave.current);
    setVisitor(true);
    setMine(id);
  };
  const release = (ms = RESUME_MS) => {
    clearTimeout(leave.current);
    leave.current = window.setTimeout(() => {
      setVisitor(false);
      setMine(null);
    }, ms);
  };
  useEffect(() => () => clearTimeout(leave.current), []);

  return (
    <div
      ref={root}
      className="ap hd gd"
      onPointerEnter={(e) => e.pointerType === 'mouse' && take(mine)}
      onPointerLeave={(e) => release(e.pointerType === 'mouse' ? RESUME_MS : RESUME_TAP_MS)}
    >
      <section className="ws-graph gd-graph" aria-label="Commit graph" data-preview={previewing || undefined}>
        <div className="pane-head">
          <span className="row" style={{ gap: 8, minWidth: 0, margin: 0 }}>
            <span className="label">Graph</span>
            <span className="faint mono ellipsis" style={{ fontSize: 11 }}>feat/checkout-flow ← v1.4.0</span>
          </span>
          <span className="btn btn-sm btn-icon" aria-hidden="true"><Icon name="close" size={12} /></span>
        </div>
        {/* It only plays: nothing in it takes focus or clicks. */}
        <div className="graph-scroll" inert>
          <GraphCanvas shown={shown} base={previewing ? base : null} wip={2} age={(n) => AGES[n.sha] ?? ''} />
        </div>
        <PreviewBanner active={!!hovered} preview={preview} />
      </section>
      <section ref={paneRef} className="ws-releases gd-tree" aria-label="Branches">
        <div className="pane-head">
          <span className="row" style={{ gap: 6, margin: 0 }}>
            <span className="label">Branches</span>
            <span className="btn btn-sm btn-icon graph-toggle" aria-hidden="true" data-on><Icon name="graph" size={13} /></span>
          </span>
        </div>
        <div className="tree" inert>
          <div className="tree-node">
            <TreeRow row="main" role="trunk" icon="home" author="Sam Rivera" name="main" act="swap" meta={<span className="meta-link">all commits</span>} />
            <div className="tree-sub">
              <div className="tree-row tree-group tree-toggle"><span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span><span className="child-label" data-active>Child branches</span><span className="faint">1</span></div>
              <div className="tree-open"><div className="tree-kids">
                <div className="tree-node">
                  <TreeRow row="v1.4.0" role="release" icon="tag" author="Bob Chen" name="v1.4.0" tag="Next" act="ship" meta={<><span className="mono">release/1.4.0</span><span className="meta-link">5 commits</span></>} />
                  <div className="tree-sub">
                    <div className="tree-row tree-group tree-toggle"><span className="tree-twist"><Icon name="chevronDown" size={12} className="chev" /></span><span className="child-label" data-active>Child branches</span><span className="faint">2</span></div>
                    <div className="tree-open"><div className="tree-kids">
                      <div className="tree-node"><TreeRow row="feat" role="branch" icon="branch" author="Sam Rivera" name="checkout-flow" current pressed act="push" meta={<><span className="wip-badge">WIP 2</span><span className="c-current">checked out</span><span className="meta-link">4 commits</span><span className="c-warn">↓1 from v1.4.0</span></>} /></div>
                      <div className="tree-node"><TreeRow row="fix" role="branch" icon="branch" author="Alice Martin" name="login-redirect" act="swap" meta={<><span className="kind-chip c-del">fix</span><span className="meta-link">2 commits</span></>} /></div>
                    </div></div>
                  </div>
                </div>
              </div></div>
            </div>
          </div>
        </div>
        {/* The branch's menu, open: hovering an action previews it in the graph, as in the app. */}
        <div ref={menuRef} className="ctx-menu gd-menu" role="menu" aria-label="Actions for feat/checkout-flow" style={place?.menu} data-placed={place ? true : undefined}>
          {ITEMS.map((it, i) =>
            it === 'sep' ? (
              <div key={i} className="ctx-sep" role="separator" />
            ) : (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                className="ctx-item"
                data-id={it.id}
                data-hover={hovered === it.id || undefined}
                onPointerEnter={(e) => e.pointerType === 'mouse' && take(it.id)}
                onPointerLeave={(e) => e.pointerType === 'mouse' && take(null)}
                onFocus={(e) => e.currentTarget.matches(':focus-visible') && take(it.id)}
                onBlur={() => release()}
                // A tap shows it, another tap on it puts the graph back.
                onClick={() => take(mine === it.id && visitor ? null : it.id)}
              >
                <span className="ctx-icon"><Icon name={it.icon} size={13} /></span>
                <span className="grow ellipsis">{it.label}</span>
                {it.hint && <span className="ctx-hint">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
        {spot && (
          <svg className="gd-cursor" data-on={playing || undefined} aria-hidden="true" width="18" height="22" viewBox="0 0 18 22" style={{ transform: `translate(${spot.x}px, ${spot.y}px)`, '--move': `${MOVE_MS}ms` } as CSSProperties}>
            <path d="M1.5 1.5v16.2l4.3-4.1 2.8 6.4 3-1.3-2.8-6.3h6.1z" />
          </svg>
        )}
      </section>
    </div>
  );
}
