import { Fragment, type ReactNode } from "react";

import { openExternal } from "../api/transport";
import { Icon } from "./Icon";

/** A node of Atlassian Document Format, the shape of a Jira description. */
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: AdfNode[];
}

// Links come from whoever wrote the ticket: only open web and mail ones.
const link = (href: unknown, body: ReactNode) =>
  typeof href === "string" && /^(https?|mailto):/i.test(href) ? (
    <a href={href} onClick={(e) => { e.preventDefault(); openExternal(href); }}>{body}</a>
  ) : (
    body
  );

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
    // Attachments need the Jira session to load.
    case "media":
    case "mediaInline":
      return <span key={key} className="faint">[Attachment, open in Jira to see it]</span>;
    default:
      return <Fragment key={key}>{kids}</Fragment>;
  }
}

/** A Jira description, laid out as Jira shows it. */
export function Adf({ doc }: { doc: AdfNode }) {
  return <div className="md adf">{node(doc, 0)}</div>;
}
