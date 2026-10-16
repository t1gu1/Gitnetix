import { useEffect, useRef } from "react";

import type { LogLine } from "../api/types";

export function AgentLog({ lines, empty }: { lines: LogLine[]; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <div
      ref={ref}
      className="term-log"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <div className="l-dim">{empty ?? "No output yet."}</div>}
      {lines.map((l, i) => (
        <div key={i} className={`l-${l.kind}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
