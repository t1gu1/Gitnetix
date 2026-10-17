import type { ReactElement } from "react";

import type { Hunk } from "../api/types";

const MARKER = /^(<<<<<<<|=======|>>>>>>>)/;

export function DiffView({ hunks, mode }: { hunks: Hunk[]; mode: "unified" | "split" }) {
  return mode === "unified" ? <Unified hunks={hunks} /> : <Split hunks={hunks} />;
}

function Unified({ hunks }: { hunks: Hunk[] }) {
  const rows: ReactElement[] = [];
  hunks.forEach((h, hi) => {
    rows.push(
      <div key={`h${hi}`} className="diff-row hunk">
        <span className="ln" />
        <span className="ln" />
        <span className="sg" />
        <span className="tx">{h.header}</span>
      </div>,
    );
    let o = h.oldStart;
    let n = h.newStart;
    h.lines.forEach((l, li) => {
      const cls = l.kind === "+" ? "add" : l.kind === "-" ? "del" : "";
      const marker = MARKER.test(l.text) ? " marker" : "";
      rows.push(
        <div key={`${hi}-${li}`} className={`diff-row ${cls}${marker}`}>
          <span className="ln">{l.kind === "+" ? "" : o}</span>
          <span className="ln">{l.kind === "-" ? "" : n}</span>
          <span className="sg">{l.kind === " " ? "" : l.kind === "-" ? "−" : "+"}</span>
          <span className="tx">{l.text}</span>
        </div>,
      );
      if (l.kind !== "+") o++;
      if (l.kind !== "-") n++;
    });
  });
  return <div className="diff-u">{rows}</div>;
}

interface Half {
  num: string;
  sign: string;
  text: string;
  cls: string;
}

const empty: Half = { num: "", sign: "", text: "", cls: "empty" };

function Split({ hunks }: { hunks: Hunk[] }) {
  const rows: [Half, Half][] = [];
  for (const h of hunks) {
    rows.push([{ num: "", sign: "", text: h.header, cls: "hunk" }, { num: "", sign: "", text: "", cls: "hunk" }]);
    let o = h.oldStart;
    let n = h.newStart;
    let dels: Half[] = [];
    let adds: Half[] = [];
    const flush = () => {
      const m = Math.max(dels.length, adds.length);
      for (let i = 0; i < m; i++) rows.push([dels[i] ?? empty, adds[i] ?? empty]);
      dels = [];
      adds = [];
    };
    for (const l of h.lines) {
      if (l.kind === "-") dels.push({ num: String(o++), sign: "−", text: l.text, cls: "del" });
      else if (l.kind === "+") adds.push({ num: String(n++), sign: "+", text: l.text, cls: "add" });
      else {
        flush();
        rows.push([
          { num: String(o++), sign: "", text: l.text, cls: "" },
          { num: String(n++), sign: "", text: l.text, cls: "" },
        ]);
      }
    }
    flush();
  }
  return (
    <div className="diff-split">
      {rows.map(([l, r], i) => (
        <div key={i} className="diff-split-row">
          {[l, r].map((x, j) => (
            <div key={j} className={`diff-half ${x.cls}`}>
              <span className="ln">{x.num}</span>
              <span className="sg">{x.sign}</span>
              <span className="tx">{x.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
