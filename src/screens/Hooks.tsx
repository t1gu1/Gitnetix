import { useRef, useState } from "react";

import { useHookRuns, useProjectPrefs } from "../api/hooks";
import type { Hook, HookRun, Project } from "../api/types";
import { Icon } from "../components/Icon";
import { Seg } from "../components/ui";
import { ago, plural } from "../lib/format";

/* Settings › Hooks: terminal commands the open project runs at moments Gitnetix makes happen. The moments on the left,
   with how their last run went; the picked one on the right, a field per command. */

type Moment = { id: string; group: string; label: string; title: string; where: string; when: string; vars: string[] };

/** Keep in step with MOMENTS in crates/core/src/hooks.rs and the variables each call site in app.rs sets. */
const MOMENTS: Moment[] = [
  { id: "branchCreated", group: "Branches", label: "Created", title: "When a branch is created", where: "Its worktree when it gets one, else the main checkout", when: "Once the branch exists and its worktree files are copied. An agent started with it waits for it, up to 30 seconds", vars: ["BRANCH", "PARENT", "WORKTREE", "MAIN"] },
  { id: "branchSwitched", group: "Branches", label: "Switched", title: "When the main checkout switches branch", where: "The main checkout", when: "Once the switch is done", vars: ["BRANCH", "FROM", "MAIN"] },
  { id: "branchMerged", group: "Branches", label: "Merged", title: "When a branch is merged", where: "The main checkout", when: "Once the merge is done, and pushed when asked", vars: ["BRANCH", "INTO", "MAIN"] },
  { id: "branchDeleted", group: "Branches", label: "Deleted", title: "When a branch is deleted", where: "The main checkout", when: "Once the branch is deleted, after its worktree", vars: ["BRANCH", "MAIN"] },
  { id: "worktreeCreated", group: "Worktrees", label: "Created", title: "When a worktree is created", where: "The new worktree", when: "Once its worktree files are copied. An agent started in it waits for it, up to 30 seconds", vars: ["BRANCH", "WORKTREE", "MAIN"] },
  { id: "worktreeRemoved", group: "Worktrees", label: "Removed", title: "When a worktree is removed", where: "The worktree, while its files are still there", when: "Before Gitnetix removes it, which waits for the commands", vars: ["BRANCH", "WORKTREE", "MAIN"] },
  { id: "releaseCreated", group: "Releases", label: "Created", title: "When a release is created", where: "The main checkout", when: "Once its release branch exists", vars: ["BRANCH", "VERSION", "MAIN"] },
  { id: "releasePublished", group: "Releases", label: "Published", title: "When a version is tagged", where: "The main checkout", when: "Once the tag is created, and pushed when asked", vars: ["BRANCH", "VERSION", "TAG", "MAIN"] },
];

const VAR_TIPS: Record<string, string> = {
  BRANCH: "The branch: feat/login, release/2.4.0",
  PARENT: "The branch it started from and merges into",
  FROM: "The branch the main checkout was on",
  INTO: "The branch it was merged into",
  WORKTREE: "The worktree's folder",
  MAIN: "The main checkout's folder",
  VERSION: "The version: 2.4.0",
  TAG: "The tag: v2.4.0",
};

// shortcut: the browser this page runs in names the shell's syntax; a phone driving a Windows desktop gets $NAME, upgrade if the companion needs it.
const WIN = /Windows/.test(navigator.userAgent);
const ref = (v: string) => (WIN ? `%GITNETIX_${v}%` : `$GITNETIX_${v}`);

const EMPTY: Hook = { commands: [], keepGoing: false, off: false };

/** How a moment's row on the left reads: its commands, and how its last run went. */
function status(hook: Hook, run?: HookRun) {
  const n = hook.commands.length;
  if (!n) return { text: "No commands" };
  if (hook.off) return { text: `Off, ${plural(n, "command")}` };
  if (!run) return { text: plural(n, "command"), dot: "" };
  return run.ok ? { text: `${plural(n, "command")}, ran ${ago(run.at)}`, dot: "ok" } : { text: `${plural(n, "command")}, failed ${ago(run.at)}`, dot: "err" };
}

export function HooksPage({ project: p, open }: { project: Project; open: (id: string) => void }) {
  const prefs = useProjectPrefs(p.id);
  const runs = useHookRuns(p.id).data ?? {};
  const [picked, setPicked] = useState(MOMENTS[0].id);
  const m = MOMENTS.find((x) => x.id === picked)!;
  const hook: Hook = { ...EMPTY, ...prefs.hooks[m.id] };
  const save = (next: Partial<Hook>) => prefs.setHooks({ ...prefs.hooks, [m.id]: { ...hook, ...next } });
  const groups = [...new Set(MOMENTS.map((x) => x.group))];
  return (
    <section className="sheet-box hk" aria-label="Hooks">
      <nav className="hk-rail" aria-label="Moments">
        {groups.map((g) => (
          <div key={g} className="hk-group">
            <h3 className="label hk-lab">{g}</h3>
            {MOMENTS.filter((x) => x.group === g).map((x) => {
              const s = status({ ...EMPTY, ...prefs.hooks[x.id] }, runs[x.id]);
              return (
                <button key={x.id} className="hk-moment" aria-current={x.id === picked || undefined} onClick={() => setPicked(x.id)}>
                  <span className={s.dot == null ? "hk-name none" : "hk-name"}>{x.label}</span>
                  <span className="hint hk-sub">
                    {s.dot != null && <span className={`hk-dot ${s.dot}`} aria-hidden />}
                    {s.text}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        <p className="hint hk-foot">Each line runs on its own in your login shell, in the folder each moment names. Their output goes to the Logs.</p>
      </nav>
      <Detail key={m.id} m={m} hook={hook} run={runs[m.id]} save={save} open={open} />
    </section>
  );
}

/** The picked moment: where and when it runs, its commands, the variables they read, its last run. */
function Detail({ m, hook, run, save, open }: { m: Moment; hook: Hook; run?: HookRun; save: (next: Partial<Hook>) => void; open: (id: string) => void }) {
  const [typed, setTyped] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const add = (lines: string[]) => {
    const more = lines.map((l) => l.trim()).filter(Boolean);
    if (more.length) save({ commands: [...hook.commands, ...more] });
    setTyped("");
  };
  const set = (i: number, line: string) => {
    const t = line.trim();
    if (t === hook.commands[i]) return;
    save({ commands: t ? hook.commands.map((c, j) => (j === i ? t : c)) : hook.commands.filter((_, j) => j !== i) });
  };
  const insert = (v: string) => {
    setTyped((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}${ref(v)}`);
    field.current?.focus();
  };
  return (
    <div className="hk-det">
      <header className="hk-h">
        <h3>{m.title}</h3>
        {hook.commands.length > 0 && (
          <label className="hk-on">
            <span className="hint">{hook.off ? "Off" : "On"}</span>
            <input type="checkbox" role="switch" className="switch" aria-label={`Run the commands ${m.title.toLowerCase()}`} checked={!hook.off} onChange={() => save({ off: !hook.off })} />
          </label>
        )}
      </header>
      <dl className="hk-kv">
        <dt>Runs in</dt>
        <dd>{m.where}</dd>
        <dt>Runs</dt>
        <dd>{m.when}</dd>
        <dt>If one fails</dt>
        <dd>
          <Seg label="If a command fails" value={hook.keepGoing ? "go" : "stop"} onChange={(v) => save({ keepGoing: v === "go" })} options={[{ value: "stop", label: "Stop" }, { value: "go", label: "Keep going" }]} />
          <span className="hint">{m.id === "worktreeRemoved" ? (hook.keepGoing ? "The worktree is removed anyway" : "The worktree stays") : hook.keepGoing ? "The next commands still run" : "The next commands don't run"}</span>
        </dd>
      </dl>
      <h4 className="label hk-lab">Commands</h4>
      <ol className="hk-cmds">
        {hook.commands.map((c, i) => (
          <li key={`${i}:${c}`} className="hk-cmd">
            <span className="hk-n mono">{i + 1}</span>
            <input
              className="input mono grow"
              aria-label={`Command ${i + 1}`}
              defaultValue={c}
              spellCheck={false}
              onBlur={(e) => set(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  // Back to the saved line, without closing the settings.
                  e.stopPropagation();
                  e.currentTarget.value = c;
                  e.currentTarget.blur();
                }
              }}
            />
            <button className="btn btn-ghost btn-icon btn-sm" aria-label={`Remove command ${i + 1}`} data-tip="Remove" onClick={() => save({ commands: hook.commands.filter((_, j) => j !== i) })}>
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
      </ol>
      <form
        className="hk-add"
        onSubmit={(e) => {
          e.preventDefault();
          add([typed]);
        }}
      >
        <input
          ref={field}
          className="input mono grow"
          aria-label="Add a command"
          placeholder={hook.commands.length ? "Another command" : "A command, as in a terminal"}
          value={typed}
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onPaste={(e) => {
            // A text field drops the line breaks of a pasted script: each line is a command.
            const text = e.clipboardData.getData("text");
            if (!text.includes("\n")) return;
            e.preventDefault();
            add(text.split(/\r?\n/));
          }}
        />
        <button className="btn btn-sm" disabled={!typed.trim()}>
          <Icon name="plus" size={12} />
          Add
        </button>
      </form>
      <div className="hk-sec">
        <h4 className="label hk-lab">Variables</h4>
        <span className="hint">Click to add to the command</span>
      </div>
      <div className="hk-vars">
        {m.vars.map((v) => (
          <button key={v} type="button" className="hk-var mono" data-tip={VAR_TIPS[v]} onClick={() => insert(v)}>
            {ref(v)}
          </button>
        ))}
      </div>
      <div className="hk-sec">
        <h4 className="label hk-lab">Last run</h4>
        {run && <span className="hint">{[run.branch, ago(run.at)].filter(Boolean).join(", ")}</span>}
        <button className="sheet-val hk-logs" onClick={() => open("logs")}>
          All in Logs
          <Icon name="chevronRight" size={12} />
        </button>
      </div>
      {run ? (
        <pre className="hk-out">
          {run.steps.map((s, i) => (
            <span key={i}>
              <span className="hk-prompt">$ </span>
              <span className="hk-line">{s.command}</span>
              {"\n"}
              {s.output.trimEnd() && `${s.output.trimEnd()}\n`}
              {s.code !== 0 && <span className="hk-fail">{s.code == null ? "Did not run" : `Exited with ${s.code}`}{"\n"}</span>}
            </span>
          ))}
          {!run.ok && run.steps.length < hook.commands.length && !hook.keepGoing && <span className="hint">The next commands did not run.</span>}
        </pre>
      ) : (
        <p className="hint">{hook.commands.length ? "Not run since Gitnetix started." : "Add a command, and its output shows here after its first run."}</p>
      )}
    </div>
  );
}
