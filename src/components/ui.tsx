import { type ReactNode, useEffect } from "react";

import { Icon } from "./Icon";
import { isPageRoute } from "./TopBar";
import { useNav } from "../lib/nav";

export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  grid,
  size,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  grid?: boolean;
  size?: "lg";
}) {
  return (
    <div role="group" aria-label={label} className={`seg${grid ? " grid" : ""}${size ? " " + size : ""}`}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Header({ title, sub, back = "menu", right, onBack }: { title: ReactNode; sub?: ReactNode; back?: "menu" | "workspace" | "none"; right?: ReactNode; onBack?: () => void }) {
  const nav = useNav();
  if (nav.projectId && isPageRoute(nav.route)) back = "none";
  return (
    <header className="hdr">
      {back !== "none" && (
        <button
          className="hdr-icon"
          aria-label={back === "menu" ? "Back to menu" : "Back to workspace"}
          onClick={() => (onBack ? onBack() : nav.go(back === "menu" ? { name: "menu" } : { name: "workspace" }))}
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
  return (
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
    </div>
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

/** Tiny Markdown renderer for PR bodies and notes: headings, lists, code, paragraphs. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  const inline = (s: string, key: string) => {
    const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return (
      <span key={key}>
        {parts.map((p, j) =>
          p.startsWith("`") && p.endsWith("`") ? (
            <code key={j}>{p.slice(1, -1)}</code>
          ) : p.startsWith("**") && p.endsWith("**") ? (
            <strong key={j}>{p.slice(2, -2)}</strong>
          ) : (
            p
          ),
        )}
      </span>
    );
  };
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
    if (/^\s*[-*]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push(<ul key={i}>{items.map((t, j) => <li key={j}>{inline(t, String(j))}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={i}>{items.map((t, j) => <li key={j}>{inline(t, String(j))}</li>)}</ol>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={i}>{inline(para.join(" "), "p")}</p>);
  }
  return <div className="md">{blocks}</div>;
}
