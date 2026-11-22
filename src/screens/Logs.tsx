import { useEffect, useRef, useState } from "react";

import { useAction, useLog } from "../api/hooks";
import { isTauri } from "../api/transport";
import type { LogEntry } from "../api/types";
import { Icon } from "../components/Icon";
import { PageTools, SheetBox, SheetRow, tilde } from "../components/Sheet";
import { devVersion } from "../components/UpdatePrompt";
import { Seg } from "../components/ui";
import { copyToClipboard } from "../lib/toast";

const line = (e: LogEntry) => `${new Date(e.at).toLocaleString()} ${e.error ? "ERROR " : ""}${e.text}`;
const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** An entry's text: a call's arguments faint ("Will attempt to x.y {…}"), an error's lines after its first faint too. */
function EntryText({ e }: { e: LogEntry }) {
  const [head, ...more] = e.text.split("\n");
  const call = !e.error && /^(Will attempt to \S+) (.+)$/s.exec(head);
  return (
    <span className="lgs-m">
      {call ? (
        <>
          {call[1]} <span className="faint">{call[2]}</span>
        </>
      ) : (
        head
      )}
      {more.length > 0 && <span className="faint">{`\n${more.join("\n")}`}</span>}
    </span>
  );
}

/** What the app tried and what failed since it started, to copy and share: this run's counts, the file every run goes to, then the entries, all or the errors, found by their text. */
export function LogsPane() {
  const log = useLog().data ?? [];
  const clear = useAction("log.clear", { invalidate: [["log"]] });
  const [only, setOnly] = useState<"all" | "errors">("all");
  const [find, setFind] = useState("");
  const errors = log.filter((e) => e.error).length;
  const term = find.trim().toLowerCase();
  const shown = log.filter((e) => (only === "all" || e.error) && (!term || e.text.toLowerCase().includes(term)));
  // The app's own version; a plain browser has no app to ask. A dev build shows the release tag it builds on.
  const [version, setVersion] = useState<string | null>(devVersion ?? null);
  // shortcut: the folder dirs picks (store.rs `data_dir`), wrong when GITNETIX_HOME moves it; ask the engine if that matters.
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    if (!devVersion) import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setVersion, () => {});
    import("@tauri-apps/api/path").then(({ configDir, join }) => configDir().then((d) => join(d, "gitnetix", "logs", "gitnetix.log"))).then(setFile, () => {});
  }, []);
  const box = useRef<HTMLDivElement>(null);
  // Follow new lines.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length]);
  return (
    <div className="lgs">
      <div className="lgs-top">
        <section className="sheet-box" aria-label="This run">
          <header className="sheet-h">
            <h2 className="wtp-help" data-tip="Every action the app attempts and every error, since it started. Copy it to share with an agent." tabIndex={0}>
              This run
            </h2>
            {log[0] && <span className="hint">since {time(log[0].at)}</span>}
            <PageTools>
              <button className="btn btn-sm" disabled={!log.length} onClick={() => copyToClipboard(log.map(line).join("\n"))}>
                <Icon name="copy" size={12} />
                Copy all
              </button>
              <button className="btn btn-sm btn-ghost" disabled={!log.length} onClick={() => clear.mutate({})}>
                <Icon name="trash" size={12} />
                Clear
              </button>
            </PageTools>
          </header>
          <div className="sheet-col">
            <p className="hint sheet-lab-tip">Every action the app attempts and every error, since it started. Copy it to share with an agent.</p>
            <SheetRow label="Entries">
              <span className="sheet-v">{log.length.toLocaleString()}</span>
            </SheetRow>
            <SheetRow label="Errors">
              <span className={`sheet-v${errors ? " lgs-err" : " none"}`}>{errors.toLocaleString()}</span>
            </SheetRow>
            {version && (
              <SheetRow label="Version">
                <span className="sheet-v mono">
                  v{version}
                  {devVersion && " dev"}
                </span>
              </SheetRow>
            )}
          </div>
        </section>
        <SheetBox title="On disk" sub="every run">
          <div className="sheet-col">
            <SheetRow label="File" tip={file ? undefined : "In Gitnetix's data folder on the computer"}>
              <span className="sheet-v mono" title={file ?? undefined}>
                {file ? tilde(file) : "logs/gitnetix.log"}
              </span>
              {file && (
                <button className="btn btn-ghost btn-icon btn-sm lgs-copy" aria-label="Copy the path" data-tip="Copy the path" onClick={() => copyToClipboard(file)}>
                  <Icon name="copy" size={12} />
                </button>
              )}
            </SheetRow>
            <SheetRow label="Older" tip="Past 5 MB the log moves to this file beside it and a new one starts">
              <span className="sheet-v mono">gitnetix.old.log</span>
            </SheetRow>
          </div>
        </SheetBox>
      </div>
      <section className="sheet-box lgs-entries" aria-label="Entries">
        <header className="sheet-h">
          <h2>Entries</h2>
          <span className="hint">newest last</span>
          <span className="sheet-aside">
            <Seg label="Show" value={only} onChange={setOnly} options={[{ value: "all", label: "All" }, { value: "errors", label: `Errors · ${errors.toLocaleString()}` }]} />
            <input className="input lgs-find" type="search" data-no-mic aria-label="Find in the entries" placeholder="Find" value={find} onChange={(e) => setFind(e.target.value)} />
          </span>
        </header>
        <div ref={box} className="lgs-lines" role="log">
          {shown.length ? (
            shown.map((e, i) => (
              <div key={i} className="lgs-l" data-error={e.error || undefined} data-done={e.text.startsWith("Done ") || undefined}>
                <span className="lgs-t">{time(e.at)}</span>
                <span className="lgs-lv">{e.error ? "Error" : "Info"}</span>
                <EntryText e={e} />
              </div>
            ))
          ) : (
            <p className="hint lgs-none">{log.length ? "No entry matches." : "Nothing logged yet."}</p>
          )}
        </div>
      </section>
    </div>
  );
}
