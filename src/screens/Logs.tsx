import { useEffect, useRef } from "react";

import { useAction, useLog } from "../api/hooks";
import type { LogEntry } from "../api/types";
import { copyToClipboard } from "../lib/toast";

const line = (e: LogEntry) => `${new Date(e.at).toLocaleString()} ${e.error ? "ERROR " : ""}${e.text}`;

/** What the app tried and what failed since it started, to copy and share. */
export function LogsPane() {
  const log = useLog().data ?? [];
  const clear = useAction("log.clear", { invalidate: [["log"]] });
  const box = useRef<HTMLDivElement>(null);
  // Follow new lines.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [log.length]);
  return (
    <section className="menu-col" style={{ gridColumn: "1 / -1", minWidth: 0 }}>
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        <span className="hint">Every action the app attempts and every error, since it started. Copy it to share with an agent.</span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn btn-sm" disabled={!log.length} onClick={() => copyToClipboard(log.map(line).join("\n"))}>Copy all</button>
          <button className="btn btn-sm" disabled={!log.length} onClick={() => clear.mutate({})}>Clear</button>
        </div>
      </div>
      <div ref={box} className="card mono" style={{ fontSize: 11.5, padding: 10, overflow: "auto", maxHeight: "70vh", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {log.length ? log.map((e, i) => <div key={i} className={e.error ? "c-del" : undefined}>{line(e)}</div>) : <span className="faint">Nothing logged yet.</span>}
      </div>
    </section>
  );
}
