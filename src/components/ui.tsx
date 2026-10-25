import { type CSSProperties, Fragment, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { link } from "./Adf";
import { Icon } from "./Icon";
import { isPageRoute } from "./TopBar";
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

export function Header({ title, sub, back = "back", right, onBack }: { title: ReactNode; sub?: ReactNode; back?: "back" | "workspace" | "none"; right?: ReactNode; onBack?: () => void }) {
  const nav = useNav();
  if (nav.projectId && isPageRoute(nav.route)) back = "none";
  return (
    <header className="hdr">
      {back !== "none" && (
        <button
          className="hdr-icon"
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

export function Modal({ title, sub, onClose, children, footer, width }: { title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  // Portaled out of #root so the rule hiding scrollbars behind the modal (app.css) skips the modal's own.
  return createPortal(
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width } : undefined}>
        <div className="modal-head">
          <div className="col" style={{ gap: 3 }}>
            <h1>{title}</h1>
            {sub && <span className="muted" style={{ fontSize: 12 }}>{sub}</span>}
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
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

export function Markdown({ text }: { text: string }) {
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
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      blocks.push(<pre key={i} className="pre">{code.join("\n")}</pre>);
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
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !BLOCK.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i}>{inline(para.join(" "), "p")}</p>);
  }
  return <div className="md">{blocks}</div>;
}
