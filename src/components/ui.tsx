import { type CSSProperties, Fragment, memo, type ReactNode, type RefObject, type TouchEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { link } from "./Adf";
import { Icon } from "./Icon";
import { isPageRoute } from "./TopBar";
import { useTokens } from "../lib/highlight";
import { comboOf, useKeys } from "../lib/keys";
import { copyToClipboard } from "../lib/toast";
import { useNav } from "../lib/nav";

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  grid,
  cols,
  size,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  grid?: boolean;
  /** With `grid`, wraps the options onto rows of this many columns. */
  cols?: number;
  size?: "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.findIndex((o) => o.value === value);
  const thumb = useThumb(ref, selected, options.length);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={`seg${grid ? " grid" : ""}${size ? " " + size : ""}`}
      style={grid && cols ? { gridAutoFlow: "row", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
      // Dragging across the control selects the option nearest the pointer, like a slider.
      // Touch captures the pressed button, whose click on release would undo the drag.
      onPointerDown={(e) => (e.target as Element).releasePointerCapture(e.pointerId)}
      onPointerMove={(e) => {
        if (!e.buttons) return;
        const away = (b: Element) => {
          const r = b.getBoundingClientRect();
          return Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
        };
        const btns = [...e.currentTarget.querySelectorAll(":scope > button")];
        const near = btns.reduce((a, b) => (away(b) < away(a) ? b : a));
        const next = options[btns.indexOf(near)].value;
        if (next !== value) onChange(next);
      }}
    >
      {/* The highlight sliding behind the buttons to the selected one. */}
      {thumb && <span className="seg-thumb" style={thumb} aria-hidden />}
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {grid ? o.label : <FixedWidth>{o.label}</FixedWidth>}
        </button>
      ))}
    </div>
  );
}

/** Box of the `index`th button (or `sel` match) of `ref`, for a highlight that slides to it; again whenever one resizes (label change, wrap, shown after hidden). */
export function useThumb(ref: RefObject<HTMLElement | null>, index: number, count: number, sel = ":scope > button") {
  const [thumb, setThumb] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const el = ref.current!;
    const btns = el.querySelectorAll<HTMLElement>(sel);
    let last = "";
    // `resized`: follow at once instead of sliding, and only when the box really moved, since the observer also fires on its first observe.
    const place = (resized?: boolean) => {
      const b = btns[index];
      const box = b?.offsetWidth ? [b.offsetWidth, b.offsetHeight, b.offsetLeft, b.offsetTop].join() : "";
      if (resized && box === last) return;
      last = box;
      // Hidden (no box): no highlight, so it appears in place rather than sliding in when shown.
      setThumb(b?.offsetWidth ? { width: b.offsetWidth, height: b.offsetHeight, transform: `translate(${b.offsetLeft}px, ${b.offsetTop}px)`, ...(resized && { transition: "none" }) } : undefined);
    };
    place();
    const ro = new ResizeObserver(() => place(true));
    // The container too: fixed-size items (mobile tab icons) move without resizing when it does.
    ro.observe(el);
    btns.forEach((b) => ro.observe(b));
    return () => ro.disconnect();
  }, [index, count]);
  return thumb;
}

/** Reserves the width of the bold rendering so toggling the active weight doesn't resize the control. */
export function FixedWidth({ children }: { children: ReactNode }) {
  return (
    <span className="fixed-w">
      <span>{children}</span>
      <span className="fixed-w-ghost" aria-hidden>{children}</span>
    </span>
  );
}

/** `hideWide`: drop the row on wide windows, where the page tabs already name the page. */
export function Header({ title, sub, back = "back", right, onBack, hideWide }: { title: ReactNode; sub?: ReactNode; back?: "back" | "workspace" | "none"; right?: ReactNode; onBack?: () => void; hideWide?: boolean }) {
  const nav = useNav();
  // Page tabs replace history back; a page's onBack steps from detail to list, which only the narrow layout splits.
  const page = nav.projectId && isPageRoute(nav.route);
  if (page && !onBack) back = "none";
  return (
    <header className={page && hideWide ? "hdr show-narrow" : "hdr"}>
      {back !== "none" && (
        <button
          className={page ? "hdr-icon show-narrow" : "hdr-icon"}
          aria-label={back === "back" ? "Back" : "Back to workspace"}
          onClick={() => (onBack ? onBack() : back === "back" ? nav.back() : nav.go({ name: "workspace" }))}
        >
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
      {right && <div className="hdr-tools">{right}</div>}
    </header>
  );
}

// One finger swipes at a time, so every swipe area can share the start point.
let swipeStart: { x: number; y: number } | null = null;

/** Touch handlers calling `onSwipe(1)` on a swipe to the left (next) and `onSwipe(-1)` on one to the right (back). */
export function swipeProps(onSwipe: (dir: 1 | -1) => void) {
  return {
    onTouchStart: (e: TouchEvent) => {
      // Leave horizontal swipes to content that scrolls sideways (diff lines, terminal).
      const sideways = (el: Element | null): boolean => !!el && el !== e.currentTarget && (el.scrollWidth > el.clientWidth + 1 || sideways(el.parentElement));
      swipeStart = e.touches.length === 1 && !sideways(e.target as Element) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    },
    onTouchEnd: (e: TouchEvent) => {
      const s = swipeStart;
      swipeStart = null;
      if (!s) return;
      const dx = e.changedTouches[0].clientX - s.x;
      const dy = e.changedTouches[0].clientY - s.y;
      if (Math.abs(dx) >= 60 && Math.abs(dx) >= 2 * Math.abs(dy)) onSwipe(dx < 0 ? 1 : -1);
    },
  };
}

/** Without `onClose` it stays up (no close button): while what it started is still running. */
/** `actions` stand in the head, before the close button. */
/** `minimize`: closing (Escape, a click outside, its button) only tucks it away, the work it shows going on. */
export function Modal({ title, sub, onClose, children, footer, width, actions, minimize }: { title: ReactNode; sub?: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; width?: number; actions?: ReactNode; minimize?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  // Portaled out of #root so the rule hiding scrollbars behind the modal (app.css) skips the modal's own.
  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        <div className="modal-head">
          <div className="col" style={{ gap: 3 }}>
            <h1>{title}</h1>
            {sub && <span className="muted" style={{ fontSize: 12 }}>{sub}</span>}
          </div>
          {actions && <div className="modal-actions">{actions}</div>}
          {onClose && (
            <button className="btn btn-ghost btn-icon" aria-label={minimize ? "Minimize" : "Close"} data-tip={minimize ? "Minimize · it carries on, back from the chip in the corner" : undefined} onClick={onClose}>
              <Icon name={minimize ? "minus" : "close"} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Asks before an action that cannot be undone. Focus starts on Back, so a stray Enter throws nothing away. */
export function Confirm({ title, sub, action, busy, onConfirm, onBack, children }: { title: ReactNode; sub?: ReactNode; action: ReactNode; busy?: boolean; onConfirm: () => void; onBack: () => void; children: ReactNode }) {
  return (
    <Modal
      title={title}
      sub={sub}
      onClose={() => !busy && onBack()}
      footer={
        <>
          <button className="btn btn-md" autoFocus disabled={busy} onClick={onBack}>Back</button>
          <button className="btn btn-md btn-danger" disabled={busy} onClick={onConfirm}>
            {busy && <span className="spinner" />}
            {action}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>{children} This cannot be undone.</p>
    </Modal>
  );
}

export function Busy({ on, children }: { on: boolean; children: ReactNode }) {
  return on ? <span className="spinner" aria-label="Working" /> : <>{children}</>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div className="err-box">{msg}</div>;
}

/** Calls `open` on the find shortcut (Ctrl+F, Cmd+F on macOS), outside a terminal (its Ctrl+F is the shell's) and with no dialog or menu up.
 * A `capture` one runs first and keeps the key to itself: the diff's find wins over the branches'. */
export function useFindKey(open: () => void, capture = false) {
  const run = useRef(open);
  run.current = open;
  const keys = useKeys().find;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (comboOf(e) !== keys) return;
      if ((e.target as HTMLElement).closest?.(".xterm") || document.querySelector("[role=dialog], [role=menu]")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run.current();
    };
    window.addEventListener("keydown", onKey, capture);
    return () => window.removeEventListener("keydown", onKey, capture);
  }, [capture, keys]);
}

/** A find bar: the text, which match of how many, previous / next and close. Enter steps forward, Shift+Enter back; Escape
 * closes it from inside it, or from anywhere with `escapeAnywhere` (no dialog or menu up). */
export function FindBar({
  className,
  label,
  query,
  onQuery,
  hits,
  onStep,
  onClose,
  inputRef,
  icon,
  escapeAnywhere,
}: {
  className: string;
  label: string;
  query: string;
  onQuery: (q: string) => void;
  hits?: { i: number; n: number };
  onStep: (back: boolean) => void;
  onClose: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  icon?: ReactNode;
  escapeAnywhere?: boolean;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!escapeAnywhere) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("[role=dialog], [role=menu]")) return;
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [escapeAnywhere]);
  return (
    <div className={`find-bar ${className}`} role="search" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), onClose())}>
      {icon}
      <input
        ref={inputRef}
        className="input"
        autoFocus
        aria-label={label}
        placeholder={label}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onStep(e.shiftKey))}
      />
      <span className="faint find-count">{query && hits ? (hits.n ? `${hits.i + 1}/${hits.n}` : "0/0") : ""}</span>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Previous match" data-tip="Previous (Shift+Enter)" disabled={hits?.n === 0} onClick={() => onStep(true)}>
        <Icon name="chevronUp" size={12} />
      </button>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Next match" data-tip="Next (Enter)" disabled={hits?.n === 0} onClick={() => onStep(false)}>
        <Icon name="chevronDown" size={12} />
      </button>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Close find" data-tip="Close (Esc)" onClick={onClose}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A whole pane with nothing to show yet: icon, title, a line of help and the action that fills it. */
export function EmptyState({ icon, title, children, action }: { icon: string; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading() {
  return (
    <div className="empty">
      <span className="spinner" />
    </div>
  );
}

export const LANGS = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
];

/** Release notes can also follow the template: one version per language it asks for. */
export const RELEASE_LANGS = [...LANGS, { value: "template", label: "Template base" }];

const TAG_LABEL: Record<string, string> = { next: "Next", hotfix: "Hotfix", released: "Released" };

export function releaseTagLabel(tag: string) {
  return TAG_LABEL[tag] ?? tag;
}

export function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function ago(iso?: string | null) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 2) return "yesterday";
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const INLINE = /(`[^`]+`)|\*\*(.+?)\*\*|~~(.+?)~~|!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)|(https?:\/\/[^\s<>)]*[^\s<>).,;:!?])|(?<![\w*])[*_](?![\s*_])(.+?)[*_](?![\w*])/g;

/** Inline Markdown: `code`, **bold**, *italic*, ~~strike~~ and links. */
export function inline(s: string, key?: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    out.push(s.slice(last, m.index));
    const [, code, bold, strike, label, href, url, em] = m;
    const j = m.index;
    if (code) out.push(<code key={j}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={j}>{inline(bold)}</strong>);
    else if (strike) out.push(<s key={j}>{inline(strike)}</s>);
    else if (href) out.push(<Fragment key={j}>{link(href, label ? inline(label) : href)}</Fragment>);
    else if (url) out.push(<Fragment key={j}>{link(url, url)}</Fragment>);
    else out.push(<em key={j}>{inline(em)}</em>);
    last = j + m[0].length;
  }
  out.push(s.slice(last));
  return <span key={key}>{out}</span>;
}

const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BLOCK = /^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s|>|\s*\||\s*(-{3,}|\*{3,})\s*$)/;
const item = (t: string, j: number) => {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(t);
  return (
    <li key={j}>
      {task ? <><input type="checkbox" checked={task[1] !== " "} disabled aria-readonly /> {inline(task[2])}</> : inline(t)}
    </li>
  );
};

/** A fenced code block under its language and a copy button, in syntax colors once the worker sends them. */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const hunks = useMemo(() => [{ header: "", oldStart: 1, newStart: 1, lines: text.split("\n").map((t) => ({ kind: " " as const, text: t })) }], [text]);
  // The text the colors are for: a reply still coming keeps the colored previous version until the new colors land.
  const shown = useTokens(`code.${lang}`, hunks);
  const rows = shown.hunks[0].lines;
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="ellipsis">{lang || "code"}</span>
        <button type="button" className="btn btn-ghost code-copy" aria-label="Copy the code" data-tip="Copy" onClick={() => copyToClipboard(text)}>
          <Icon name="copy" size={12} />
        </button>
      </div>
      <pre className="pre">
        {rows.map((r, j) => (
          <Fragment key={j}>
            {/* Not `code()`: its colour swatches would take "#1234" in a log for a colour. */}
            {shown.tokens?.[0]?.[j]?.map(([t, cls], k) => (cls ? <span key={k} className={cls}>{t}</span> : t)) ?? r.text}
            {j < rows.length - 1 && "\n"}
          </Fragment>
        ))}
      </pre>
    </div>
  );
}

// Memo: an agent log redraws every reply when a line arrives; only new text is parsed again.
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  // PR templates leave <!-- hints --> behind.
  const lines = text.replace(/\r/g, "").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      blocks.push(<h3 key={i}>{inline(h[2], "h")}</h3>);
      i++;
      continue;
    }
    if (l.startsWith("```")) {
      const lang = l.slice(3).trim().split(/\s/)[0];
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={i} lang={lang} text={code.join("\n")} />);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) {
      blocks.push(<hr key={i} />);
      i++;
      continue;
    }
    if (l.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={i}><Markdown text={quote.join("\n")} /></blockquote>);
      continue;
    }
    if (l.trim().startsWith("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={i} className="adf-table">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>{rows.map((r, k) => <tr key={k}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "")}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push(<ul key={i}>{items.map(item)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={i}>{items.map(item)}</ol>);
      continue;
    }
    // The first line goes in whatever it starts: a "|" row with no "|---|" under it is no table, and would loop forever.
    const para: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !BLOCK.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i}>{inline(para.join(" "), "p")}</p>);
  }
  return <div className="md">{blocks}</div>;
});
