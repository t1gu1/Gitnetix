import { createContext, Fragment, type ReactNode, useContext } from "react";

import { isLocal, openExternal, revealPath } from "../api/transport";
import { toast } from "../lib/toast";
import { Icon } from "./Icon";
import { Linked, Picture, PictureSource } from "./Picture";

/** A node of Atlassian Document Format, the shape of a Jira description. */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

// Links come from whoever wrote the ticket: only open web and mail ones. Others are files, shown only under a `FileRoot`.
export const link = (href: unknown, body: ReactNode) => {
  if (typeof href !== "string") return body;
  // Markdown's <destination> form.
  const to = href.replace(/^<(.*)>$/, "$1");
  return /^(https?|mailto):/i.test(to) ? (
    <a href={to} onClick={(e) => { e.preventDefault(); openExternal(to); }}><Linked.Provider value>{body}</Linked.Provider></a>
  ) : (
    <FileLink to={to}>{body}</FileLink>
  );
};

/** The folder an agent works in, and how its replies open a file in it (`open` takes the path from `root`, false when nothing
 * lists it). In its replies, links to files and `path/to/file.ts:12` code open there, or show in the file manager when outside. */
export const FileRoot = createContext<{ root: string; open?: (path: string) => Promise<boolean> } | null>(null);

// A file named in code: at least one folder, then a name with an extension, maybe with :line or :line:col.
const CODE_PATH = /^(?:[A-Za-z]:|~)?[\w.@+-]*(?:[/\\][\w.@+-]+)*[/\\][\w@+-][\w.@+-]*\.[A-Za-z][\w-]*(?::\d+(?:[:-]\d+)?)?$/;

/** `to` as a path: no file:// scheme, no %20, no #L12 or :12:3 after it. */
export function filePath(to: string) {
  let p = to.replace(/^file:\/\/(localhost)?/i, "").replace(/^\/([A-Za-z]:)/, "$1");
  try {
    p = decodeURI(p);
  } catch {
    // A lone % stays as written.
  }
  return p.replace(/#.*$/, "").replace(/:\d+(?:[:-]\d+)?$/, "");
}

/** Path `p` from `root` with / between folders, when it is inside it; null outside (`..` past it, another absolute path, ~). */
export function inside(root: string, p: string) {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  let rel = p.replace(/\\/g, "/");
  if (rel.startsWith("~")) return null;
  if (/^([A-Za-z]:)?\//.test(rel)) {
    // Windows paths ignore case.
    const head = rel.slice(0, r.length + 1);
    if (/^[A-Za-z]:/.test(r) ? head.toLowerCase() !== `${r}/`.toLowerCase() : head !== `${r}/`) return null;
    rel = rel.slice(r.length + 1);
  }
  const out: string[] = [];
  for (const s of rel.split("/")) {
    if (s === "..") {
      if (!out.length) return null;
      out.pop();
    } else if (s && s !== ".") out.push(s);
  }
  return out.length ? out.join("/") : null;
}

/** A file an agent names, as a link: one in its folder opens in the app, any other shows in the file manager (desktop only).
 * `code`: from a code span, so only when it looks like a path. Outside an agent's reply, `children` as they are. */
export function FileLink({ to, code, children }: { to: string; code?: boolean; children: ReactNode }) {
  const at = useContext(FileRoot);
  // Other schemes (tel:, vscode:…) stay text; a drive letter (C:) is one letter, no scheme.
  const other = /^[a-z][\w+.-]+:/i.test(to) && !/^file:/i.test(to);
  if (!at || !to || to.startsWith("#") || (code ? !CODE_PATH.test(to) : other)) return children;
  const { root, open } = at;
  const p = filePath(to);
  const rel = open ? inside(root, p) : null;
  if (!rel && !isLocal) return children;
  const reveal = async () => {
    const { homeDir, resolve } = await import("@tauri-apps/api/path");
    // Relative to the agent's folder; `resolve` keeps an absolute path and drops `..`.
    await revealPath(/^~[/\\]/.test(p) ? await resolve(await homeDir(), p.slice(2)) : await resolve(root, p));
  };
  const show = async () => {
    try {
      // A file no list has (ignored, gone) still shows in its folder.
      if (rel && open && (await open(rel))) return;
      if (isLocal) await reveal();
      else toast(`${p} is not in the project's files`, "error");
    } catch (e) {
      toast(`Could not show ${p}: ${e}`, "error");
    }
  };
  return (
    <a href="#" data-tip={rel ? "Open the file" : "Show in folder"} onClick={(e) => { e.preventDefault(); show(); }}>
      {children}
    </a>
  );
}

function marked(n: AdfNode) {
  let out: ReactNode = n.text;
  for (const m of n.marks ?? []) {
    if (m.type === "strong") out = <strong>{out}</strong>;
    else if (m.type === "em") out = <em>{out}</em>;
    else if (m.type === "code") out = <code>{out}</code>;
    else if (m.type === "strike") out = <s>{out}</s>;
    else if (m.type === "underline") out = <u>{out}</u>;
    else if (m.type === "subsup") out = m.attrs?.type === "sup" ? <sup>{out}</sup> : <sub>{out}</sub>;
    else if (m.type === "link") out = link(m.attrs?.href, out);
  }
  return out;
}

function node(n: AdfNode, key: number): ReactNode {
  const a = n.attrs ?? {};
  const kids = (n.content ?? []).map(node);
  const cell = { colSpan: a.colspan, rowSpan: a.rowspan };
  switch (n.type) {
    case "text":
      return <Fragment key={key}>{marked(n)}</Fragment>;
    case "paragraph":
      return <p key={key}>{kids}</p>;
    case "heading": {
      const H = `h${Math.min(Math.max(Number(a.level) || 1, 1), 6)}` as "h1";
      return <H key={key}>{kids}</H>;
    }
    case "bulletList":
      return <ul key={key}>{kids}</ul>;
    case "orderedList":
      return <ol key={key} start={a.order}>{kids}</ol>;
    case "listItem":
      return <li key={key}>{kids}</li>;
    case "taskList":
    case "decisionList":
      return <ul key={key} className="adf-tasks">{kids}</ul>;
    case "taskItem":
    case "decisionItem": {
      const done = a.state === "DONE" || a.state === "DECIDED";
      return (
        <li key={key}>
          <span className={done ? "c-add" : "faint"} aria-hidden="true"><Icon name={done ? "check" : "stop"} size={12} /></span>
          <span className={done ? "muted" : ""}>{kids}</span>
          <span className="sr-only">{done ? "(done)" : "(not done)"}</span>
        </li>
      );
    }
    case "codeBlock":
      return <pre key={key} className="pre">{(n.content ?? []).map((c) => c.text).join("")}</pre>;
    case "blockquote":
      return <blockquote key={key}>{kids}</blockquote>;
    case "rule":
      return <hr key={key} />;
    case "hardBreak":
      return <br key={key} />;
    case "panel":
      return <div key={key} className={`adf-panel adf-${a.panelType ?? "info"}`}>{kids}</div>;
    case "expand":
    case "nestedExpand":
      return <details key={key}><summary>{a.title || "Details"}</summary>{kids}</details>;
    case "table":
      return <div key={key} className="adf-table"><table><tbody>{kids}</tbody></table></div>;
    case "tableRow":
      return <tr key={key}>{kids}</tr>;
    case "tableHeader":
      return <th key={key} {...cell}>{kids}</th>;
    case "tableCell":
      return <td key={key} {...cell}>{kids}</td>;
    case "mention":
      return <span key={key} className="adf-chip">{String(a.text ?? "@someone").replace(/^@?/, "@")}</span>;
    case "status":
      return <span key={key} className="adf-chip">{a.text}</span>;
    case "emoji":
      return <Fragment key={key}>{a.text ?? a.shortName}</Fragment>;
    case "date":
      return <span key={key} className="adf-chip">{new Date(Number(a.timestamp)).toLocaleDateString()}</span>;
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return <Fragment key={key}>{link(a.url, a.url)}</Fragment>;
    case "media":
    case "mediaInline":
      return <Media key={key} a={a} />;
    default:
      return <Fragment key={key}>{kids}</Fragment>;
  }
}

/** A picture in a Jira text, where the screen allows them: a link, or an attachment known by its name only, which the
 * app loads with the Jira sign-in. Other files, and attachments with no name, stay a note. */
function Media({ a }: { a: Record<string, any> }) {
  const source = useContext(PictureSource);
  const src = a.type === "external" ? a.url : a.alt;
  return source && typeof src === "string" && src ? <Picture src={src} alt={a.alt ?? ""} /> : <span className="faint">[Attachment, open in Jira to see it]</span>;
}

/** A Jira description, laid out as Jira shows it. */
export function Adf({ doc }: { doc: AdfNode }) {
  return <div className="md adf">{node(doc, 0)}</div>;
}
