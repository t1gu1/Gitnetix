import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useAction, useConfig, useProjectPrefs } from "../api/hooks";
import { currentRemote, isLocal, isTauri, saveRemote } from "../api/transport";
import type { Config, DialogPrefs, GitProfile, Project } from "../api/types";
import { GRAVATAR_KEY } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { useTermDefault } from "../components/Shell";
import { Confirm, LANGS, Seg } from "../components/ui";
import { showKeys, useDictationKeys } from "../lib/dictation";
import { animates, useAnimations } from "../lib/motion";
import { useNav } from "../lib/nav";
import { useStoredFlag } from "../lib/stored";
import { THEMES } from "../lib/themes";
import { AISetupPanes } from "./AISetup";
import { LogsPane } from "./Logs";
import { GROUPS, PhoneCard, SettingsSection, WorktreeFiles } from "./Settings";
import { TemplatesPanes } from "./Templates";

/** Titles of the pages opened in place inside the panel, by id: the GROUPS sections and the logs. */
const TITLES: Record<string, string> = Object.fromEntries([...GROUPS.flatMap(([, items]) => items.map(([id, label]) => [id, label])), ["logs", "Logs"]]);
/** Pages with a list and a detail of their own, shown in a frame instead of as a settings section. */
const PANES = ["ai", "templates", "logs"];

export function Menu({ onUnpair }: { onUnpair: () => void }) {
  const nav = useNav();
  const cfg = useConfig().data;
  const project = cfg?.projects.find((p) => p.id === nav.projectId);
  const [closing, setClosing] = useState(false);
  // Pages opened in place inside the panel, newest last; empty shows the menu itself. Back pops one.
  const [views, setViews] = useState<string[]>(() => (nav.menuSection ? [nav.menuSection] : []));
  const view = views[views.length - 1];
  const open = (id: string) => setViews((vs) => [...vs, id]);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // The app's own version; a plain browser has no app to ask.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setVersion, () => {});
  }, []);
  // Slide out before unmounting; skip the animation when it is off or the user prefers reduced motion.
  const close = useCallback(() => {
    if (!animates("menu")) nav.closeMenu();
    else setClosing(true);
  }, [nav.closeMenu]);
  // Opened on a page by a link: Back from it returns to where the link was, as it did from the page it replaced.
  const back = () => (views.length === 1 && nav.menuSection ? close() : setViews((vs) => vs.slice(0, -1)));

  useEffect(() => {
    closeBtn.current?.focus();
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog over the menu (a confirmation) takes this Escape for itself.
      if (e.key === "Escape" && !document.querySelector(".modal")) (view ? back() : close());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, view]);

  return (
    <div className={`menu-overlay${closing ? " closing" : ""}`}>
      <div
        className="menu-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) nav.closeMenu();
        }}
      >
        <header className="hdr">
          {!view ? (
            <button ref={closeBtn} className="hdr-icon" aria-label="Close menu" onClick={close}>
              <Icon name="close" size={16} />
            </button>
          ) : (
            <button ref={closeBtn} className="hdr-icon" aria-label="Back" onClick={back}>
              <Icon name="back" size={16} />
            </button>
          )}
          <div className="hdr-title">
            {!view && <Logo className="hdr-logo" />}
            <strong>{view ? TITLES[view] : "Gitnetix"}</strong>
            {!view && project && (
              <>
                <span className="faint">·</span>
                <span className="muted">{project.name}</span>
              </>
            )}
          </div>
          {!view && version && (
            <div className="hdr-tools">
              <span className="mono faint" style={{ fontSize: 11.5 }}>v{version}</span>
            </div>
          )}
        </header>
        <div className="menu-wrap">
          {view && PANES.includes(view) ? (
            <div className="menu">
              <div className={`menu-grid menu-embed${view === "templates" ? " split" : ""}`}>
                {view === "ai" && <AISetupPanes />}
                {view === "templates" && <TemplatesPanes />}
                {view === "logs" && <LogsPane />}
              </div>
            </div>
          ) : view ? (
            <main className="page menu-page">
              <div className="page-inner">{cfg && <SettingsSection id={view} cfg={cfg} />}</div>
            </main>
          ) : (
            <nav aria-label="Main menu" className="menu">
              <div className={`menu-grid${project ? "" : " solo"}`}>
                {project && <ProjectSettings key={project.id} project={project} profiles={cfg?.profiles ?? []} />}
                <AppSettings cfg={cfg} open={open} onUnpair={onUnpair} />
              </div>
            </nav>
          )}
        </div>
      </div>
      <div className="menu-scrim" onClick={close} aria-hidden="true" />
    </div>
  );
}

/** A titled block of settings; `bare` leaves out the frame, for content that has its own. */
function Group({ title, id, hint, action, bare, children }: { title: string; id?: string; hint?: ReactNode; action?: ReactNode; bare?: boolean; children: ReactNode }) {
  return (
    <section className="set-group">
      <div className="set-group-head">
        <div className="col" style={{ gap: 2, minWidth: 0 }}>
          <h3 id={id}>{title}</h3>
          {hint && <p className="hint">{hint}</p>}
        </div>
        {action}
      </div>
      {bare ? children : <div className="set-card">{children}</div>}
    </section>
  );
}

function check(on: boolean, flip: () => void, label: ReactNode) {
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={flip} />
      <span>{label}</span>
    </label>
  );
}

/** Everything set for the open project: what the AI writes in, what the dialogs start with, worktree files, the Git identity. */
function ProjectSettings({ project: p, profiles }: { project: Project; profiles: GitProfile[] }) {
  const nav = useNav();
  const inv = [["config"]];
  const setLang = useAction("projects.setGenLang", { invalidate: inv });
  const setProfile = useAction("projects.setProfile", { invalidate: inv });
  const saveProfile = useAction<GitProfile>("profiles.save", { invalidate: inv });
  const remove = useAction("projects.remove", { invalidate: [["config"], ["projects"]] });
  const prefs = useProjectPrefs(p.id);
  const { merge, dialogs: d } = prefs;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ label: "", name: "", email: "", sign: true });
  const [removing, setRemoving] = useState(false);
  const mergeCheck = (k: "squash" | "deleteBranch" | "push" | "resolveConflicts", label: string) => check(merge[k], () => prefs.setMerge({ [k]: !merge[k] }), label);
  const dialogCheck = (k: Exclude<keyof DialogPrefs, "finish">, label: string) => check(d[k], () => prefs.setDialogs({ [k]: !d[k] }), label);
  const shipped = p.releases.filter((r) => r.shippedAt).length;
  return (
    <section className="menu-col menu-project" aria-labelledby="menu-this menu-project">
      <div className="menu-head">
        <h2 id="menu-this" className="label menu-section">This project</h2>
        <strong id="menu-project" className="menu-head-name">{p.name}</strong>
        <span className="mono faint ellipsis" title={p.path}>{p.path}</span>
        <span className="hint">
          {p.releases.length - shipped} open · {shipped} shipped releases · {Object.keys(p.branches).length} tracked branches · {p.aiCommits.length} AI-written commits
        </span>
      </div>

      <Group title="Generation language" hint="The language the AI writes in for this project. Spoken follows your last voice dictation. Templates stay the same.">
        {(
          [
            ["commit", "Commit summary & message"],
            ["pr", "PR title & description"],
            ["release", "Release notes"],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="set-row">
            <span>{label}</span>
            <Seg label={label} value={p.genLang[k]} options={k === "release" ? LANGS : [...LANGS, { value: "spoken", label: "Spoken" }]} onChange={(v) => setLang.mutate({ projectId: p.id, [k]: v })} />
          </div>
        ))}
      </Group>

      <Group title="Merging" hint="What the merge dialog starts with. Changing them there changes them here too.">
        <div className="set-row">
          <Seg
            grid
            label="How to merge"
            value={merge.rebase ? "rebase" : "merge"}
            onChange={(v) => prefs.setMerge({ rebase: v === "rebase" })}
            options={[{ value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase & fast-forward" }]}
          />
        </div>
        <div>
          {mergeCheck("squash", "Squash the branch into one renamed commit first")}
          {merge.squash && (
            <div className="set-sub">
              <Seg
                grid
                label="Squashed commit summary"
                value={merge.squashMessage}
                onChange={(v) => prefs.setMerge({ squashMessage: v })}
                options={[
                  { value: "branch", label: <span className="mono">squash | branch name</span> },
                  { value: "ai", label: <span className="row" style={{ gap: 6, justifyContent: "center" }}><Icon name="sparkle" size={11} />AI writes it</span> },
                ]}
              />
            </div>
          )}
        </div>
        {mergeCheck("deleteBranch", "Delete the branch after merging")}
        {mergeCheck("push", "Push the target branch to origin after merging")}
        {mergeCheck("resolveConflicts", "Resolve conflicts with AI and carry on (merge, rebase, cherry-pick, revert, stash)")}
      </Group>

      <Group title="Committing" hint="Also in the menu next to the Commit button.">
        {check(prefs.commit.autoPush, () => prefs.setCommit({ autoPush: !prefs.commit.autoPush }), "Push the branch after each commit")}
      </Group>

      <Group title="New branches & worktrees" hint="What their dialogs start with. The new branch dialog remembers where you worked and whether an agent started; the others apply a change to that time only.">
        {dialogCheck("newWorktree", "Give a new branch its own worktree instead of switching to it")}
        {dialogCheck("newAgent", "Start an AI agent on a new branch right away (always in a worktree)")}
        <div className="set-row">
          <span>Finishing a worktree session</span>
          <Seg label="Finishing a worktree session" value={d.finish} onChange={(finish) => prefs.setDialogs({ finish })} options={[{ value: "continue", label: "Continue on branch" }, { value: "merge", label: "Merge it" }]} />
        </div>
        {dialogCheck("finishSwitch", "Switch to where the worktree's code lands once it is closed")}
      </Group>

      <Group
        title="Worktree files"
        hint="Git leaves ignored files out of a new worktree. These are copied from the main checkout into it, one path from the project root per line: a knowledge graph, .env, local settings. The ones in App › Worktrees are copied for every project too."
        bare
      >
        <WorktreeFiles key={p.id} files={prefs.worktreeFiles} onSave={prefs.setWorktreeFiles} />
      </Group>

      <Group title="Releases">
        {dialogCheck("shipPush", "Push the default branch and the tag when shipping a release")}
        {dialogCheck("shipChangelog", "Let AI update the changelog before shipping a release")}
      </Group>

      <Group title="Deleting branches">
        {dialogCheck("deleteOrigin", "Also delete a deleted branch on origin")}
        {dialogCheck("cleanupOrigin", "Also delete cleaned-up behind branches on origin")}
      </Group>

      <Group
        title="Git profile"
        id="menu-profile"
        hint="Author name, email and signing key used for commits in this project."
        bare
        action={
          !adding && (
            <button className="btn btn-sm" onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} />
              Add profile
            </button>
          )
        }
      >
        <div role="radiogroup" aria-labelledby="menu-profile" className="col" style={{ gap: 6 }}>
          <button className="radio-card" role="radio" aria-checked={!p.profileId} onClick={() => setProfile.mutate({ projectId: p.id, profileId: null })}>
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Repository config</span>
              <span className="hint">Whatever user.name / user.email git already uses here</span>
            </span>
          </button>
          {profiles.map((x) => (
            <button key={x.id} className="radio-card" role="radio" aria-checked={p.profileId === x.id} onClick={() => setProfile.mutate({ projectId: p.id, profileId: x.id })}>
              <span className="radio-dot" />
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{x.label}</span>
                <span className="hint ellipsis">{x.name} &lt;{x.email}&gt;</span>
              </span>
              <span className={`pill ${x.sign ? "c-add" : "faint"}`}>{x.sign ? "Signed" : "Unsigned"}</span>
            </button>
          ))}
        </div>
        {adding && (
          <form
            className="col note-box"
            style={{ gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate(
                { profile: draft },
                {
                  onSuccess: (x) => {
                    setProfile.mutate({ projectId: p.id, profileId: x.id });
                    setAdding(false);
                    setDraft({ label: "", name: "", email: "", sign: true });
                  },
                },
              );
            }}
          >
            <span style={{ fontWeight: 500 }}>New profile</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
              {(
                [
                  ["label", "Profile name", "Client work"],
                  ["name", "Author name", "Your name"],
                  ["email", "Email", "you@client.com"],
                ] as const
              ).map(([k, l, ph]) => (
                <div key={k} className="field">
                  <label htmlFor={`np-${k}`}>{l}</label>
                  <input id={`np-${k}`} className="input" type={k === "email" ? "email" : "text"} placeholder={ph} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={draft.sign} onChange={() => setDraft({ ...draft, sign: !draft.sign })} />
              <span>Sign commits with my SSH key</span>
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={!draft.label.trim() || !draft.email.trim()}>Save and use</button>
            </div>
          </form>
        )}
      </Group>

      <div className="set-danger">
        <button className="btn btn-sm btn-ghost btn-danger" onClick={() => setRemoving(true)}>
          <Icon name="trash" size={13} />
          Remove from Gitnetix
        </button>
        <span className="hint">The repository and its files stay on disk.</span>
      </div>
      {removing && (
        <Confirm
          title="Remove project"
          sub={p.name}
          action="Remove project"
          busy={remove.isPending}
          onBack={() => setRemoving(false)}
          onConfirm={() =>
            remove.mutate(
              { projectId: p.id },
              {
                onSuccess: () => {
                  nav.setProject(undefined);
                  nav.go({ name: "home" });
                },
              },
            )
          }
        >
          Gitnetix forgets its releases, tracked branches and settings. The repository and its files stay on disk, and it can be added again.
        </Confirm>
      )}
    </section>
  );
}

/** The phone card, then every app setting as a row showing its current value, opening its page in place. */
function AppSettings({ cfg, open, onUnpair }: { cfg?: Config; open: (id: string) => void; onUnpair: () => void }) {
  const nav = useNav();
  const setUi = useAction("ui.set", { invalidate: [["config"]] });
  const [keys] = useDictationKeys();
  const { off } = useAnimations();
  const [gravatar] = useStoredFlag(GRAVATAR_KEY);
  const [term] = useTermDefault();
  const i = cfg?.integrations;
  const s = cfg?.server;
  const count = (n: number, one: string) => (n ? `${n} ${one}${n > 1 ? "s" : ""}` : "None yet");
  const value: Record<string, ReactNode> = {
    appearance: THEMES.find((t) => t.id === nav.themePref)?.name ?? "System",
    animations: off.length ? `${off.length} off` : "All on",
    avatars: gravatar ? "Gravatar" : "Initials",
    terminal: term === "shell" ? "Opens on Shell" : "Opens on Agent",
    worktrees: cfg && (cfg.worktreeFiles.length ? `${count(cfg.worktreeFiles.length, "file")} copied` : "No files copied"),
    dictation: <span className="mono">{showKeys(keys)}</span>,
    ai: "Providers, models and task routing",
    templates: "Prompts for commits, PRs and release notes",
    profiles: cfg && count(cfg.profiles.length, "profile"),
    git: i && ([i.githubConnected && "GitHub", i.azureConnected && "Azure DevOps"].filter(Boolean).join(" · ") || "Not connected"),
    tools: i && ([i.jira.length && "Jira", i.trello.length && "Trello", i.asana.length && "Asana"].filter(Boolean).join(" · ") || "Not connected"),
    companion: !isLocal ? "Set on the computer" : s && (s.enabled ? `On · ${s.lan ? "your network" : "this computer only"}` : "Off"),
    logs: "Actions and errors, to copy and share",
  };
  const row = (id: string, label: string, icon: string) => (
    <button key={id} className="app-row" onClick={() => open(id)}>
      <Icon name={icon} size={16} />
      <span className="app-row-label">{label}</span>
      <span className="app-row-sub">{value[id]}</span>
      <Icon name="chevronRight" size={12} className="app-row-chev" />
    </button>
  );
  return (
    <section className="menu-col menu-app" aria-labelledby="menu-app">
      <div className="menu-head">
        <h2 id="menu-app" className="label menu-section">App</h2>
        {isLocal ? (
          s && <PhoneCard server={s} />
        ) : (
          <div className="phone-card">
            <span className="phone-icon">
              <Icon name="phone" size={18} />
            </span>
            <div className="col" style={{ gap: 4, minWidth: 0 }}>
              <strong className="phone-title">Connected to your desktop</strong>
              <span className="mono hint ellipsis">{currentRemote()?.url}</span>
            </div>
            <div className="phone-foot">
              <button
                className="btn btn-sm btn-ghost btn-danger"
                onClick={() => {
                  saveRemote(null);
                  onUnpair();
                }}
              >
                Disconnect from this desktop
              </button>
            </div>
          </div>
        )}
      </div>
      {GROUPS.map(([g, items], n) => (
        <section key={g} className="set-group">
          <h3 className="set-group-title">{g}</h3>
          <div className="app-list">
            {n === 0 && (
              <div className="app-row">
                <Icon name="globe" size={16} />
                <span className="app-row-label">Language</span>
                <span className="grow" />
                <Seg label="Language" value={cfg?.ui.language ?? "en"} options={LANGS} onChange={(v) => setUi.mutate({ language: v })} />
              </div>
            )}
            {items.map(([id, label, icon]) => row(id, label, icon))}
          </div>
        </section>
      ))}
      <div className="app-list">{row("logs", "Logs", "file")}</div>
    </section>
  );
}
