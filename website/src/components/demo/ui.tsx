import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../../../src/components/Icon';
import type { Branch } from '../HeroDemo';
import type { Ai, Agents } from './agents';

/**
 * The demo's copies of src/components/ui.tsx, Avatar.tsx, ProfileAvatar in Profiles.tsx, ContextMenu.tsx and MenuChoice in AgentPicker.tsx:
 * the app's own pull in its server API. Same markup and class names, so site.css can keep copying app.css.
 */

/** What every demo page can reach: the toast, the other pages, the workspace's branches and the agents. */
export type Demo = {
  flash: (text: string, error?: boolean) => void;
  go: (page: string) => void;
  /** Workspace page, with this branch picked in the tree. */
  openBranch: (name: string) => void;
  /** Worktrees & agents with this row picked, from a branch's worktree link. */
  openWorktree: (key: string) => void;
  /** The row it last asked for: a new object each time, so the same row is picked again. */
  wtPick?: { key: string };
  branches: Record<string, Branch>;
  /** Selected and checked-out branches in the workspace. */
  sel: string;
  head: string;
  addBranch: (name: string, base: string) => void;
  setBranch: (name: string, p: Partial<Branch>) => void;
  /** Commits the branch's uncommitted changes. */
  commit: (name: string) => void;
  agents: Agents;
  /** Puts an agent on an acme-web branch in its own worktree; returns why it can't. */
  agentOn: (name: string, text: string, base?: string, ai?: Ai) => string | undefined;
  /** Ends a worktree session: keep the branch, merge it, or delete it all. `note` ends the toast. */
  finish: (key: string, how: 'continue' | 'merge' | 'discard', sw: boolean, note?: string) => void;
  /** The demo window: menus and modals of a pane the phone hides go here instead. */
  root: RefObject<HTMLDivElement | null>;
};
export const DemoContext = createContext<Demo>(null!);
export const useDemo = () => useContext(DemoContext);

/** Timers that die with the page. */
export function useLater() {
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (ms: number, f: () => void) => void timers.current.push(window.setTimeout(f, ms));
}

// Same as src/components/Avatar.tsx: initials on a colour picked from the name.
function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function initials(name: string) {
  const w = name.trim().split(/\s+/);
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}
export function Avatar({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className="user-avatar" role="img" aria-label={name} title={name} style={{ width: size, height: size, fontSize: Math.round(size * 0.45), background: `hsl(${hue(name)} 45% 42%)` }}>
      {initials(name)}
    </span>
  );
}

/** Reserves the width of the bold rendering, like FixedWidth in src/components/ui.tsx. */
/** A profile's round picture: its emoji, else the default silhouette, on its color. */
export function ProfileAvatar({ emoji, hue, size = 24 }: { emoji?: string; hue?: number; size?: number }) {
  return (
    <span className="profile-avatar" data-hue={hue != null || undefined} style={{ width: size, height: size, fontSize: Math.round(size * 0.55), '--p-hue': hue } as CSSProperties} aria-hidden="true">
      {emoji ?? (
        <svg viewBox="0 0 32 32" width="100%" height="100%">
          <circle cx="16" cy="12.5" r="5.75" />
          <path d="M4.5 31c1-6.4 5.6-10.2 11.5-10.2S26.5 24.6 27.5 31V32H4.5z" />
        </svg>
      )}
    </span>
  );
}

/** A find bar: the text, which match of how many, previous / next and close. Enter steps forward, Shift+Enter back, Escape closes. */
export function FindBar({ className, label, query, onQuery, hits, onStep, onClose, icon }: { className: string; label: string; query: string; onQuery: (q: string) => void; hits: { i: number; n: number }; onStep: (back: boolean) => void; onClose: () => void; icon?: ReactNode }) {
  return (
    <div className={`find-bar ${className}`} role="search" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      {icon}
      <input className="input" autoFocus aria-label={label} placeholder={label} value={query} onChange={(e) => onQuery(e.target.value)} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onStep(e.shiftKey))} />
      <span className="faint find-count">{query ? (hits.n ? `${hits.i + 1}/${hits.n}` : '0/0') : ''}</span>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!hits.n} onClick={() => onStep(true)}>
        <Icon name="chevronUp" size={12} />
      </button>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Next match" title="Next (Enter)" disabled={!hits.n} onClick={() => onStep(false)}>
        <Icon name="chevronDown" size={12} />
      </button>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Close find" title="Close (Esc)" onClick={onClose}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

export function FixedWidth({ children }: { children: ReactNode }) {
  return (
    <span className="fixed-w">
      <span>{children}</span>
      <span className="fixed-w-ghost" aria-hidden="true">{children}</span>
    </span>
  );
}

/** Box of the `index`th button of `ref`, for a highlight that slides to it, like useThumb in src/components/ui.tsx. */
export function useThumb(ref: RefObject<HTMLElement | null>, index: number, count: number, sel = ':scope > button') {
  const [thumb, setThumb] = useState<{ width: number; height: number; transform: string }>();
  useLayoutEffect(() => {
    const btns = ref.current!.querySelectorAll<HTMLElement>(sel);
    // Hidden (no box): no highlight, so it appears in place rather than sliding in when shown.
    const place = () => {
      const b = btns[index];
      setThumb(b?.offsetWidth ? { width: b.offsetWidth, height: b.offsetHeight, transform: `translate(${b.offsetLeft}px, ${b.offsetTop}px)` } : undefined);
    };
    place();
    const ro = new ResizeObserver(place);
    btns.forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [index, count]);
  return thumb;
}

/** `cols`, with `grid`: wraps the options onto rows of that many. */
export function Seg<T extends string>({ label, value, options, onChange, grid, cols }: { label: string; value: T; options: [T, ReactNode][]; onChange: (v: T) => void; grid?: boolean; cols?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const thumb = useThumb(ref, options.findIndex(([v]) => v === value), options.length);
  return (
    <div ref={ref} role="group" aria-label={label} className={`hd-seg${grid ? ' grid' : ''}`} style={grid && cols ? { gridAutoFlow: 'row', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
      {thumb && <span className="seg-thumb" style={thumb} aria-hidden="true" />}
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>{grid ? l : <FixedWidth>{l}</FixedWidth>}</button>
      ))}
    </div>
  );
}

export const Busy = ({ on, children }: { on: boolean; children: ReactNode }) => (on ? <span className="spinner" aria-label="Working" /> : <>{children}</>);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function EmptyState({ icon, title, children, action }: { icon: string; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true"><Icon name={icon} size={22} /></span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Header in src/components/ui.tsx with hideWide: only on the phone, the back arrow taking a detail back to its list. */
export function PageHead({ title, sub, onBack }: { title: string; sub?: ReactNode; onBack?: () => void }) {
  return (
    <header className="hdr pg-head">
      {onBack && (
        <button type="button" className="hdr-icon" aria-label="Back" onClick={onBack}>
          <Icon name="back" size={16} />
        </button>
      )}
      <div className="hdr-title">
        <strong>{title}</strong>
        {sub && (
          <>
            <span className="faint">·</span>
            <span className="muted ellipsis">{sub}</span>
          </>
        )}
      </div>
    </header>
  );
}

/** Over the demo window rather than the whole page. */
export function Modal({ title, sub, onClose, children, footer, actions, width }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; actions?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        <div className="modal-head">
          <div className="col" style={{ gap: 3 }}>
            <h1>{title}</h1>
            {sub && <span className="muted" style={{ fontSize: 12 }}>{sub}</span>}
          </div>
          <span className="row" style={{ gap: 8, margin: '0 0 0 auto' }}>
            {actions}
            <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
          </span>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export type MenuItem = 'sep' | { heading: ReactNode } | { id: string; label: ReactNode; icon?: string | null; hint?: ReactNode; danger?: boolean; disabled?: boolean; keep?: boolean; run: () => void };
const ITEM = '[role="menuitem"]:not(:disabled)';

/** A floating menu at a viewport point; an outside click, Escape or a scroll closes it. */
/** `up`: opens above its button whatever the room below, like a menu off a bottom bar. */
export function Menu({ x, y, items, label, alignRight, up: above, onClose }: { x: number; y: number; items: MenuItem[]; label: string; alignRight?: boolean; up?: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;
  // The button that opened it: pressing it again closes the menu instead of reopening it.
  const [opener] = useState(() => document.activeElement?.closest('[aria-haspopup="menu"]'));
  useLayoutEffect(() => {
    const el = ref.current!;
    const { width, height } = el.getBoundingClientRect();
    // Short of room below, it opens above its button.
    const up = above || y + height > innerHeight - 8;
    const top = up ? (opener?.getBoundingClientRect().top ?? y) - 2 - height : y;
    setPos({ left: Math.max(8, Math.min(alignRight ? x - width : x, innerWidth - width - 8)), top: Math.max(8, top), '--origin': `${up ? 'bottom' : 'top'} ${alignRight ? 'right' : 'left'}` } as CSSProperties);
    el.querySelector<HTMLElement>(ITEM)?.focus({ preventScroll: true });
  }, [x, y, alignRight]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && !opener?.contains(e.target as Node) && close.current();
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close.current();
    const resize = () => close.current();
    addEventListener('mousedown', away, true);
    addEventListener('scroll', away, true);
    addEventListener('keydown', key);
    addEventListener('resize', resize);
    return () => {
      removeEventListener('mousedown', away, true);
      removeEventListener('scroll', away, true);
      removeEventListener('keydown', key);
      removeEventListener('resize', resize);
      prev?.focus({ preventScroll: true });
    };
  }, []);
  const arrows = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = [...ref.current!.querySelectorAll<HTMLElement>(ITEM)];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
  };
  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={pos} onKeyDown={arrows}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={`sep-${i}`} className="ctx-sep" role="separator" />
        ) : 'heading' in it ? (
          <div key={`head-${i}`} className="ctx-head ellipsis" role="presentation">{it.heading}</div>
        ) : (
          <button key={it.id} type="button" role="menuitem" className={`ctx-item${it.danger ? ' c-del' : ''}`} disabled={it.disabled} onClick={() => { if (!it.keep) close.current(); it.run(); }}>
            {it.icon !== null && <span className="ctx-icon">{it.icon && <Icon name={it.icon} size={13} />}</span>}
            <span className="grow ellipsis">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** Opens the menu under the pressed button, or closes it when it is already open. */
export function useMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const toggle = (e: { currentTarget: HTMLElement }, right?: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(at ? null : { x: right ? r.right : r.left, y: r.bottom + 2 });
  };
  return { at, toggle, close: () => setAt(null) };
}

/** A button opening its options as a menu; `select menu-select` styles it as a form field. */
export function Choice({ label, value, options, onChange, className = 'picker-act', id, style }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; className?: string; id?: string; style?: CSSProperties }) {
  const m = useMenu();
  return (
    <>
      <button type="button" id={id} className={className} style={style} aria-haspopup="menu" aria-expanded={!!m.at} aria-label={label} onClick={(e) => m.toggle(e)}>
        <span className="ellipsis">{options.find((o) => o.value === value)?.label ?? (value || label)}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {m.at && <Menu {...m.at} label={label} onClose={m.close} items={options.map((o) => ({ id: o.value || 'default', label: o.label, icon: null, hint: o.value === value && <Icon name="check" size={13} />, run: () => onChange(o.value) }))} />}
    </>
  );
}

const INLINE = /(`[^`]+`)|\*\*(.+?)\*\*|(?<![\w*])\*(?![\s*])(.+?)\*(?!\w)/g;
function inline(s: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    out.push(s.slice(last, m.index));
    const [, code, bold, em] = m;
    out.push(code ? <code key={m.index}>{code.slice(1, -1)}</code> : bold ? <strong key={m.index}>{inline(bold)}</strong> : <em key={m.index}>{inline(em)}</em>);
    last = m.index + m[0].length;
  }
  out.push(s.slice(last));
  return out;
}
const LIST = /^\s*([-*]|\d+[.)])\s+/;

/** The part of Markdown in src/components/ui.tsx the demo's texts use: headings, lists, quotes, code blocks, `code`, **bold** and *italic*. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    if (!l.trim()) i++;
    else if (h) blocks.push(<h3 key={i++}>{inline(h[1])}</h3>);
    else if (l.startsWith('```')) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); ) code.push(lines[i++]);
      blocks.push(<pre key={i++} className="pre">{code.join('\n')}</pre>);
    } else if (l.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={i}><Markdown text={quote.join('\n')} /></blockquote>);
    } else if (LIST.test(l)) {
      const items: string[] = [];
      const ordered = /\d/.test(LIST.exec(l)![1]);
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ''));
      const lis = items.map((t, j) => <li key={j}>{inline(t)}</li>);
      blocks.push(ordered ? <ol key={i}>{lis}</ol> : <ul key={i}>{lis}</ul>);
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>)/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++]);
      blocks.push(<p key={i}>{inline(para.join(' '))}</p>);
    }
  }
  return <div className="md">{blocks}</div>;
}

/** Saved picks after `next` (null: everyone): the ones checked now, and the saved ones not in `present`, as in src/components/CheckPicker.tsx. */
export const keepAbsent = (saved: string[], present: string[], next: string[] | null) => (next ? [...saved.filter((s) => !present.includes(s)), ...next] : []);

/** src/components/CheckPicker.tsx: checkboxes over `items` (`what`: their plural), every one checked while `all`, "Only" to keep one. */
export function CheckPicker({ what, items, all, picked, onChange }: { what: string; items: { id: string; name: string; sub?: string; avatar?: boolean }[]; all: boolean; picked: string[]; onChange: (ids: string[] | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const on = (id: string) => all || picked.includes(id);
  const checked = items.filter((it) => on(it.id));
  const label = all ? `All ${what}` : checked.length === 1 ? checked[0].name : `${checked.length} ${what}`;
  const toggle = (id: string) => {
    const next = on(id) ? checked.filter((it) => it.id !== id).map((it) => it.id) : [...checked.map((it) => it.id), id];
    if (next.length) onChange(next);
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('mousedown', down, true);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', down, true);
      removeEventListener('keydown', key);
    };
  }, [open]);
  const What = what[0].toUpperCase() + what.slice(1);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="select row" style={{ height: 32, gap: 8 }} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sr-only">{What}: </span>
        <span className="ellipsis" style={{ maxWidth: 220 }}>{label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="ctx-menu" role="group" aria-label={`${What} to include`} style={{ position: 'absolute', top: 36, left: 0, minWidth: 240, maxHeight: 360, overflowY: 'auto' }}>
          <label className="check ctx-item">
            <input type="checkbox" checked={all} onChange={() => onChange(null)} />
            <span className="grow ellipsis">All {what}</span>
          </label>
          <div className="ctx-sep" role="separator" />
          {items.map((it) => (
            <div key={it.id} className="ctx-row">
              <label className="check ctx-item">
                {/* The last one checked stays: picking no one shows nothing. */}
                <input type="checkbox" checked={on(it.id)} disabled={on(it.id) && checked.length === 1} onChange={() => toggle(it.id)} />
                {it.avatar && <Avatar name={it.name} size={20} />}
                <span className="col grow" style={{ minWidth: 0, gap: 0, lineHeight: 1.25, padding: it.sub ? '4px 0' : undefined }}>
                  <span className="ellipsis">{it.name}</span>
                  {it.sub && <span className="faint ellipsis" style={{ fontSize: 11 }}>{it.sub}</span>}
                </span>
              </label>
              {items.length > 1 && <button className="ctx-only" aria-label={`Only ${it.name}`} onClick={() => onChange([it.id])}>Only</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The tracker people to count (`who`, empty: everyone) among `everyone`, as AssigneePicker does. */
export function AssigneePicker({ everyone, who, onChange }: { everyone: string[]; who: string[]; onChange: (who: string[]) => void }) {
  if (everyone.length < 2 && who.length === 0) return null;
  return <CheckPicker what="people" items={everyone.map((n) => ({ id: n, name: n, avatar: true }))} all={who.length === 0} picked={who.filter((n) => everyone.includes(n))} onChange={(v) => onChange(keepAbsent(who, everyone, v))} />;
}
