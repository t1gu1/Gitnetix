import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { useAction, useConfig, useProjectPrefs } from "../api/hooks";
import { currentRemote, isLocal, isTauri, saveRemote } from "../api/transport";
import type { Config, DialogPrefs, Project, UserProfile } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { BranchTypesEditor } from "../components/BranchTypes";
import { Icon } from "../components/Icon";
import { checkUpdate, devVersion } from "../components/UpdatePrompt";
import { DeleteProfile, ProfileAvatar, ProfileDialog, useProfiles } from "../components/Profiles";
import { plural } from "../lib/format";
import { useTermDefault } from "../components/Shell";
import { Confirm, LANGS, RELEASE_LANGS } from "../components/ui";
import { DEFAULTS, SHORTCUTS, useKeys } from "../lib/keys";
import { animates, useAnimations } from "../lib/motion";
import { useNav } from "../lib/nav";
import { THEMES } from "../lib/themes";
import { toast } from "../lib/toast";
import { AISetupPanes } from "./AISetup";
import { LogsPane } from "./Logs";
import { GROUPS, Keys, LINK_PLACEHOLDER, PhoneCard, SettingsSection, WorktreeFiles } from "./Settings";
import { TemplatesPanes } from "./Templates";

/** Titles of the pages opened in place inside the panel, by id: the GROUPS sections, the project's pages and the logs. */
const TITLES: Record<string, string> = Object.fromEntries([...GROUPS.flatMap(([, items]) => items.map(([id, label]) => [id, label])), ["logs", "Logs"], ["branchTypes", "Branch types"], ["projectFiles", "Worktree files"]]);
/** Pages of the open project's settings, opened from its box. */
const PROJECT_PAGES = ["branchTypes", "projectFiles"];
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
  // The app's own version; a plain browser has no app to ask. A dev build shows the release tag it builds on.
  const [version, setVersion] = useState<string | null>(devVersion ?? null);
  useEffect(() => {
    if (!isTauri || devVersion) return;
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setVersion, () => {});
  }, []);
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    checkUpdate()
      .then((u) => !u && toast("Gitnetix is up to date", "ok"))
      .catch((e) => toast(`Could not check for updates: ${e}`, "error"))
      .finally(() => setChecking(false));
  };
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
      // A dialog over the menu (a confirmation) or an open value menu takes this Escape for itself.
      if (e.key === "Escape" && !document.querySelector(".modal, .ctx-menu")) (view ? back() : close());
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
        aria-label="Settings"
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
            {view ? <strong>{TITLES[view]}</strong> : <h1 className="hdr-settings">Settings</h1>}
            {!view && version && (
              <span className="mono faint hdr-version">
                v{version}
                {devVersion && " dev"}
              </span>
            )}
          </div>
          {!view && isLocal && (
            <div className="hdr-tools">
              <button className="btn btn-ghost btn-sm" disabled={checking} onClick={check}>
                {checking ? "Checking…" : "Check and update"}
              </button>
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
              <div className="page-inner">{PROJECT_PAGES.includes(view) ? project && <ProjectPage id={view} project={project} /> : cfg && <SettingsSection id={view} cfg={cfg} />}</div>
            </main>
          ) : (
            <nav aria-label="Main menu" className="menu menu-home">
              <div className="menu-sheet">
                <div className="menu-duo">
                  {cfg && <ProfileCard cfg={cfg} />}
                  <PhoneSlot cfg={cfg} onUnpair={onUnpair} />
                </div>
                <div className={`sheet${project ? "" : " solo"}`}>
                  {project && <ProjectSettings key={project.id} project={project} open={open} />}
                  <AppSettings cfg={cfg} open={open} />
                  <div className="sheet-foot">
                    {project && <RemoveProject key={project.id} project={project} />}
                    <button className="btn btn-sm btn-ghost sheet-logs" onClick={() => open("logs")}>
                      <Icon name="file" size={12} />
                      Logs
                    </button>
                  </div>
                </div>
              </div>
            </nav>
          )}
        </div>
      </div>
      <div className="menu-scrim" onClick={close} aria-hidden="true" />
    </div>
  );
}

/** The active profile, first of the settings, which are all its own: its actions beside its name, the other profiles to switch to, and new ones. */
function ProfileCard({ cfg }: { cfg: Config }) {
  const { list, active, switchTo } = useProfiles();
  const [dialog, setDialog] = useState<{ profile?: UserProfile; from?: string } | null>(null);
  const [deleting, setDeleting] = useState<UserProfile | null>(null);
  if (!active) return null;
  const i = cfg.integrations;
  const me = cfg.profiles[0];
  const who = [me?.name, me?.email && `<${me.email}>`].filter(Boolean).join(" ");
  const facts = [plural(cfg.projects.length, "project"), i.githubConnected && "GitHub", i.azureConnected && "Azure DevOps", i.gitlab.connected && "GitLab", i.bitbucket.connected && "Bitbucket", i.gitea.connected && "Gitea", i.jira.length && "Jira", i.trello.length && "Trello", i.asana.length && "Asana", i.linear.length && "Linear"];
  const others = list.filter((p) => p.id !== active.id);
  return (
    <>
      <section className="profile-card" aria-labelledby="menu-profile-name" data-hue={active.hue != null || undefined} style={{ "--p-hue": active.hue ?? undefined } as CSSProperties}>
        <ProfileAvatar profile={active} size={64} />
        <div className="profile-card-id">
          <div className="profile-card-name">
            <h2 id="menu-profile-name" className="ellipsis">{active.name}</h2>
            <div className="profile-card-actions">
              <button className="btn btn-sm" onClick={() => setDialog({ profile: active })}>
                <Icon name="edit" size={12} />
                Edit
              </button>
              <button className="btn btn-sm" onClick={() => setDialog({ from: active.id })}>
                <Icon name="copy" size={12} />
                Duplicate
              </button>
              <button className="btn btn-sm btn-ghost btn-danger" disabled={!others.length} title={others.length ? undefined : "The only profile stays"} onClick={() => setDeleting(active)}>
                <Icon name="trash" size={12} />
                Delete
              </button>
            </div>
          </div>
          <span className="hint ellipsis" title={who || undefined}>
            {who ? `Commits as ${who}${me?.sign ? ", signed" : ""}` : "Commits with your Git config's name and email"}
          </span>
          <span className="hint">{facts.filter(Boolean).join(" · ")}</span>
        </div>
        <p className="hint profile-card-note">The Git identity, projects, connections, AI setup and every setting below belong to this profile. Each profile keeps its own.</p>
        <div className="profile-others">
          {others.map((p) => (
            <div key={p.id} className="profile-chip">
              <button className="profile-chip-open" data-tip={`Switch to ${p.name}`} onClick={() => void switchTo(p, true)}>
                <ProfileAvatar profile={p} size={22} />
                <span className="ellipsis">{p.name}</span>
              </button>
              <button className="act" aria-label={`Delete ${p.name}`} data-tip={`Delete ${p.name}`} onClick={() => setDeleting(p)}>
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
          <button className="profile-chip profile-chip-new" onClick={() => setDialog({})}>
            <Icon name="plus" size={12} />
            New profile
          </button>
        </div>
      </section>
      {dialog && <ProfileDialog {...dialog} menu onClose={() => setDialog(null)} />}
      {deleting && <DeleteProfile profile={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

/** Gitnetix on a phone beside the profile: its QR code on the computer, the desktop it is paired with on the phone. */
function PhoneSlot({ cfg, onUnpair }: { cfg?: Config; onUnpair: () => void }) {
  if (isLocal) return cfg ? <PhoneCard server={cfg.server} /> : null;
  return (
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
  );
}

/**
 * A short label, the full sentence when it leaves words out: shown on hover and on the row's keyboard focus, under the label on a touch screen.
 * `restates`: the sentence only repeats the label in more words, so a touch screen leaves it out.
 */
function SheetKey({ label, tip, restates }: { label: string; tip?: string; restates?: boolean }) {
  return (
    <span className="sheet-k" data-tip-overflow={tip ? undefined : ""}>
      {label}
      {tip && !restates && <span className="sheet-tip">{tip}</span>}
    </span>
  );
}

/** A path under the user's home folder starts with ~. */
const tilde = (path: string) => path.replace(/^(\/home\/[^/]+|\/Users\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, "~");

/** A box of settings for one scope: this project, the app, AI and connections. */
function SheetBox({ title, sub, path, className = "", children }: { title: string; sub?: string; path?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`sheet-box ${className}`} aria-label={title}>
      <header className="sheet-h">
        <h2 className="ellipsis">{title}</h2>
        {sub && <span className="hint">{sub}</span>}
        {/* Cut from its start: the end of a path names the project. */}
        {path && (
          <span className="mono faint sheet-path" title={path}>
            <bdi>{tilde(path)}</bdi>
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

/** A group's name; `tip` says what its settings do, on hover and keyboard focus, under the name on a touch screen. */
function SheetLabel({ children, tip }: { children: ReactNode; tip?: string }) {
  return (
    <>
      <h3 className="label sheet-lab" data-tip={tip} tabIndex={tip ? 0 : undefined}>
        {children}
      </h3>
      {tip && <p className="hint sheet-lab-tip">{tip}</p>}
    </>
  );
}

/** On or off, flipped in place: the whole row is the switch's label. */
function SheetSwitch({ label, tip, restates, on, flip, disabled }: { label: string; tip?: string; restates?: boolean; on: boolean; flip: () => void; disabled?: boolean }) {
  return (
    <label className="sheet-row" data-tip={tip}>
      <SheetKey label={label} tip={tip} restates={restates} />
      <input type="checkbox" role="switch" className="switch" aria-label={tip ?? label} checked={on} disabled={disabled} onChange={flip} />
    </label>
  );
}

/** One of a few values, picked from a menu under it. */
function SheetChoice({ label, tip, restates, value, options, onChange, sub, mono }: { label: string; tip?: string; restates?: boolean; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; sub?: boolean; mono?: boolean }) {
  return (
    <div className={`sheet-row${sub ? " sub" : ""}`} data-tip={tip}>
      <SheetKey label={label} tip={tip} restates={restates} />
      <MenuChoice className={`sheet-val${mono && value === "branch" ? " mono" : ""}`} alignRight label={tip ?? label} value={value} options={options} onChange={onChange} />
    </div>
  );
}

/** A setting with a page of its own, opened in place: its current value, and the arrow of a row that opens. */
function SheetLink({ label, tip, restates, value, mono, none, onClick }: { label: string; tip?: string; restates?: boolean; value?: ReactNode; mono?: boolean; none?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="sheet-row sheet-link" data-tip={tip} onClick={onClick}>
      <SheetKey label={label} tip={tip} restates={restates} />
      {value != null && <span className={`sheet-v${mono ? " mono" : ""}${none ? " none" : ""}`}>{value}</span>}
      <Icon name="chevronRight" size={12} />
    </button>
  );
}

const SPOKEN = [...LANGS, { value: "spoken", label: "Spoken" }];

/** Everything set for the open project, in two columns: what the AI writes in, what the dialogs start with, worktree files. */
function ProjectSettings({ project: p, open }: { project: Project; open: (id: string) => void }) {
  const setLang = useAction("projects.setGenLang", { invalidate: [["config"]] });
  const prefs = useProjectPrefs(p.id);
  const { merge, dialogs: d } = prefs;
  const lang = (k: "commit" | "pr" | "ticket" | "release", label: string, tip?: string) => (
    <SheetChoice label={label} tip={tip} value={p.genLang[k]} options={k === "release" ? RELEASE_LANGS : SPOKEN} onChange={(v) => setLang.mutate({ projectId: p.id, [k]: v })} />
  );
  const mergeSwitch = (k: "squash" | "deleteBranch" | "push" | "resolveConflicts", label: string, tip: string, restates?: boolean) => <SheetSwitch label={label} tip={tip} restates={restates} on={merge[k]} flip={() => prefs.setMerge({ [k]: !merge[k] })} />;
  const dialogSwitch = (k: Exclude<keyof DialogPrefs, "finish">, label: string, tip: string, restates?: boolean) => <SheetSwitch label={label} tip={tip} restates={restates} on={d[k]} flip={() => prefs.setDialogs({ [k]: !d[k] })} />;
  const types = prefs.branchTypes.list.map((t) => t.id);
  const paths = (l: string[]) => (l.length > 2 ? `${l.slice(0, 2).join(" ")} +${l.length - 2}` : l.join(" ") || "None");
  return (
    <SheetBox className="sheet-project" title={p.name} sub="this project" path={p.path}>
      <div className="sheet-cols">
        <div className="sheet-col">
          <SheetLabel tip="The language the AI writes in for this project. Spoken follows your last voice dictation. Template base writes release notes in each language the template asks for. Templates stay the same.">AI writes in</SheetLabel>
          {lang("commit", "Commits", "Commit summary & message")}
          {lang("pr", "Pull requests", "PR title & description")}
          {lang("ticket", "Tickets")}
          {lang("release", "Release notes")}
          <SheetLabel tip="What the merge dialog starts with. Changing them there changes them here too.">Merging</SheetLabel>
          <SheetChoice
            label="How to merge"
            value={merge.rebase ? "rebase" : "merge"}
            onChange={(v) => prefs.setMerge({ rebase: v === "rebase" })}
            options={[{ value: "merge", label: "Merge commit" }, { value: "rebase", label: "Rebase & fast-forward" }]}
          />
          {mergeSwitch("squash", "Squash first", "Squash the branch into one renamed commit first")}
          {merge.squash && (
            <SheetChoice
              sub
              mono
              label="Squashed summary"
              tip="Squashed commit summary"
              restates
              value={merge.squashMessage}
              onChange={(v) => prefs.setMerge({ squashMessage: v as typeof merge.squashMessage })}
              options={[{ value: "branch", label: "squash | branch name" }, { value: "ai", label: "AI writes it" }]}
            />
          )}
          {mergeSwitch("deleteBranch", "Delete the branch", "Delete the branch after merging", true)}
          {mergeSwitch("push", "Push the target branch", "Push the target branch to origin after merging")}
          {mergeSwitch("resolveConflicts", "Resolve conflicts with AI", "Resolve conflicts with AI and carry on (merge, rebase, cherry-pick, revert, stash)")}
          <SheetLabel tip="Also in the menu next to the Commit button.">Committing</SheetLabel>
          <SheetSwitch label="Push after each commit" tip="Push the branch after each commit" restates on={prefs.commit.autoPush} flip={() => prefs.setCommit({ autoPush: !prefs.commit.autoPush })} />
          <SheetLabel tip="Pictures load from the sites that host them, which see your IP address. HTML keeps to the tags GitHub allows, with no scripts or styles. Tickets from other trackers than GitHub show pictures only. Markdown files like README.md always show their HTML; their pictures wait for this setting too.">
            Pictures &amp; HTML
          </SheetLabel>
          {dialogSwitch("prMedia", "In PRs, tickets and Markdown", "Show pictures and HTML in pull requests, tickets and Markdown files", true)}
        </div>
        <div className="sheet-col">
          <SheetLabel tip="What their dialogs start with. The new branch dialog remembers where you worked and whether an agent started; the others apply a change to that time only.">New branches &amp; worktrees</SheetLabel>
          {dialogSwitch("newWorktree", "Own worktree", "Give a new branch its own worktree instead of switching to it")}
          {dialogSwitch("newAgent", "Start an agent", "Start an AI agent on a new branch right away (always in a worktree)")}
          <SheetChoice label="Finishing a session" tip="Finishing a worktree session" restates value={d.finish} onChange={(finish) => prefs.setDialogs({ finish: finish as DialogPrefs["finish"] })} options={[{ value: "continue", label: "Continue on branch" }, { value: "merge", label: "Merge it" }]} />
          {dialogSwitch("finishSwitch", "Then switch to it", "Switch to where the worktree's code lands once it is closed")}
          <SheetLabel>Branch types</SheetLabel>
          <SheetLink label="Type buttons" tip="What the new branch dialog's Type buttons offer, in this order" value={types.length > 3 ? `${types.slice(0, 3).join(" ")} +${types.length - 3}` : types.join(" ")} mono onClick={() => open("branchTypes")} />
          <SheetLabel tip="Git leaves ignored files out of a new worktree. These are copied, or linked, from the main checkout into it.">Worktree files</SheetLabel>
          <SheetLink label="Copied" tip="Copied from the main checkout into each new worktree" value={paths(prefs.worktreeFiles)} mono={!!prefs.worktreeFiles.length} none={!prefs.worktreeFiles.length} onClick={() => open("projectFiles")} />
          <SheetLink label="Linked" tip="Linked to the main checkout's own, not copied" value={paths(prefs.worktreeLinks)} mono={!!prefs.worktreeLinks.length} none={!prefs.worktreeLinks.length} onClick={() => open("projectFiles")} />
          <SheetLabel>Releases &amp; deleting</SheetLabel>
          {dialogSwitch("shipChangelog", "Changelog before tagging", "Let AI add the branch's changes to the changelog before creating a version tag")}
          {dialogSwitch("deleteOrigin", "Delete on origin too", "Also delete a deleted branch on origin", true)}
          {dialogSwitch("cleanupOrigin", "Clean up on origin too", "Also delete cleaned-up behind branches on origin")}
        </div>
      </div>
    </SheetBox>
  );
}

/** The project's pages opened from its box: branch types, and the files copied or linked into its worktrees. */
function ProjectPage({ id, project: p }: { id: string; project: Project }) {
  const prefs = useProjectPrefs(p.id);
  if (id === "branchTypes")
    return (
      <>
        <div className="col page-intro" style={{ gap: 6 }}>
          <h1>Branch types</h1>
          <p className="muted" style={{ margin: 0 }}>For {p.name}. What the new branch dialog's Type buttons offer, in this order. A prefix typed in a branch name that is not listed joins them when the branch is created, after the pinned ones.</p>
        </div>
        <BranchTypesEditor key={p.id} pid={p.id} />
      </>
    );
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Worktree files</h1>
        <p className="muted" style={{ margin: 0 }}>For {p.name}. Git leaves ignored files out of a new worktree. The ones in App › Worktrees are copied or linked for every project too.</p>
      </div>
      <section className="section">
        <h2>Copied</h2>
        <p className="hint" style={{ margin: 0 }}>Copied from the main checkout into each new worktree, one path from the project root per line: a knowledge graph, .env, local settings.</p>
        <WorktreeFiles key={p.id} files={prefs.worktreeFiles} onSave={prefs.setWorktreeFiles} />
      </section>
      <section className="section">
        <h2>Linked</h2>
        <p className="hint" style={{ margin: 0 }}>Linked, not copied: the worktree reads and writes the main checkout's own, so it takes no space and changes show in both. For big folders shared by every branch. On Windows, folders need Developer Mode on. A path in both lists is linked.</p>
        <WorktreeFiles key={p.id} files={prefs.worktreeLinks} onSave={prefs.setWorktreeLinks} label="Worktree links" placeholder={LINK_PLACEHOLDER} />
      </section>
    </>
  );
}

/** Forget the open project, after a confirmation; the repository stays on disk. */
function RemoveProject({ project: p }: { project: Project }) {
  const nav = useNav();
  const remove = useAction("projects.remove", { invalidate: [["config"], ["projects"]] });
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <button className="btn btn-sm btn-ghost btn-danger" onClick={() => setRemoving(true)}>
        <Icon name="trash" size={12} />
        Remove {p.name} from Gitnetix
      </button>
      <span className="hint">The repository and its files stay on disk.</span>
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
    </>
  );
}

/** Every app setting, in a box for the app and one for AI and connections: a value picked in place, or a row opening its page. */
function AppSettings({ cfg, open }: { cfg?: Config; open: (id: string) => void }) {
  const nav = useNav();
  const setUi = useAction("ui.set", { invalidate: [["config"]] });
  const keys = useKeys();
  const changedKeys = SHORTCUTS.filter((s) => keys[s.id] !== DEFAULTS[s.id]).length;
  const { off } = useAnimations();
  const [term, setTerm] = useTermDefault();
  const i = cfg?.integrations;
  const s = cfg?.server;
  const files = cfg ? [cfg.worktreeFiles.length && `${cfg.worktreeFiles.length} copied`, cfg.worktreeLinks.length && `${cfg.worktreeLinks.length} linked`].filter(Boolean).join(", ") : "";
  const git = i ? [i.githubConnected && "GitHub", i.azureConnected && "Azure DevOps", i.gitlab.connected && "GitLab", i.bitbucket.connected && "Bitbucket", i.gitea.connected && "Gitea"].filter(Boolean).join(", ") : "";
  const trackers = i ? [i.jira.length && "Jira", i.trello.length && "Trello", i.asana.length && "Asana", i.linear.length && "Linear"].filter(Boolean).join(", ") : "";
  const companion = !isLocal ? "Set on the computer" : s ? (s.enabled ? (s.lan ? "On, your network" : "On, this computer") : "Off") : "";
  return (
    <div className="sheet-stack">
      <SheetBox title="App" sub="every project">
        <div className="sheet-col">
          <SheetLabel>Look &amp; feel</SheetLabel>
          <SheetChoice label="Language" value={cfg?.ui.language ?? "en"} options={LANGS} onChange={(v) => setUi.mutate({ language: v })} />
          <SheetLink label="Theme" value={THEMES.find((t) => t.id === nav.themePref)?.name ?? "System"} onClick={() => open("appearance")} />
          <SheetLink label="Animations" value={off.length ? `${off.length} off` : "All on"} onClick={() => open("animations")} />
          <SheetLabel>Work</SheetLabel>
          <SheetChoice label="Terminal opens on" tip="What a branch's terminal opens on until a tab is picked there" value={term} options={[{ value: "agent", label: "Agent" }, { value: "shell", label: "Shell" }]} onChange={(v) => setTerm(v as typeof term)} />
          <SheetLink label="Worktree files" tip="Copied or linked into new worktrees, for every project" value={files || "None"} none={!files} onClick={() => open("worktrees")} />
          <SheetLink label="Voice dictation" value={<Keys keys={keys.dictation} />} onClick={() => open("dictation")} />
          <SheetLink label="Shortcuts" value={changedKeys ? `${changedKeys} changed` : "Defaults"} onClick={() => open("shortcuts")} />
        </div>
      </SheetBox>
      <SheetBox title="AI & connections">
        <div className="sheet-col">
          <SheetLink label="AI setup" tip="Providers, models and task routing" restates value="Providers & models" onClick={() => open("ai")} />
          <SheetLink label="Templates" tip="Prompts for commits, PRs and release notes" value="Prompts" onClick={() => open("templates")} />
          <SheetLink label="Git providers" value={git || "None"} none={!git} onClick={() => open("git")} />
          <SheetLink label="Ticket trackers" tip="Jira, Trello, Asana, Linear" value={trackers || "None"} none={!trackers} onClick={() => open("tools")} />
          <SheetLink label="Companion & MCP" value={companion} none={companion === "Off"} onClick={() => open("companion")} />
        </div>
      </SheetBox>
    </div>
  );
}
