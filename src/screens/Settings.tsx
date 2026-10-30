import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAction, useConfig, useProjectPrefs } from "../api/hooks";
import { renderSVG } from "uqr";

import { allowFirewall, companionInfo, isLocal, openExternal, rpc, type CompanionInfo } from "../api/transport";
import type { Config, DialogPrefs, GitProfile, JiraConn } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { GRAVATAR_KEY } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { useTermDefault } from "../components/Shell";
import { Confirm, Header, Seg } from "../components/ui";
import { comboOf, DEFAULT_KEYS, showKeys, useDictationKeys } from "../lib/dictation";
import { ANIMATIONS, useAnimations } from "../lib/motion";
import { useNav } from "../lib/nav";
import { useStoredFlag } from "../lib/stored";
import { ansi, resolveTheme, THEMES, type Theme } from "../lib/themes";
import { copyToClipboard, toast } from "../lib/toast";

const JIRA_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

const GROUPS: [string, [string, string][]][] = [
  ["General", [["project", "Project"], ["appearance", "Appearance"], ["animations", "Animations"], ["avatars", "Avatars"], ["terminal", "Terminal"], ["dictation", "Voice dictation"]]],
  ["AI", [["ai", "AI setup"], ["templates", "Templates"]]],
  ["Git", [["profiles", "Git profiles"], ["git", "Git providers"]]],
  ["Integrations", [["tools", "Jira, Trello, Asana"], ["companion", "Companion & MCP"]]],
];

export function Settings({ section }: { section?: string }) {
  const nav = useNav();
  return (
    <>
      <Header title="Settings" />
      <div className="body split">
        <SettingsPanes section={section} onAi={() => nav.go({ name: "ai" })} onTemplates={() => nav.go({ name: "templates" })} />
      </div>
    </>
  );
}

/** Section list and content panes, also shown inside the menu panel; `onAi` / `onTemplates` open those pages wherever the host shows them. */
export function SettingsPanes({ section, onAi, onTemplates }: { section?: string; onAi: () => void; onTemplates: () => void }) {
  const [sec, setSec] = useState(section ?? "git");
  const navW = usePaneWidth("gnx.pane.settings", 260, 200, 480);
  const cfg = useConfig().data;
  const pick = (id: string) => {
    if (id === "ai") onAi();
    else if (id === "templates") onTemplates();
    else setSec(id);
  };
  return (
    <>
      <nav aria-label="Settings sections" className="sidenav hide-narrow" style={{ "--sidenav-w": `${navW.width}px` } as CSSProperties}>
        {GROUPS.map(([g, items]) => (
          <div key={g} className="col" style={{ gap: 2 }}>
            <span className="group-label">{g}</span>
            {items.map(([id, label]) => (
              <button key={id} className="nav-item" aria-current={sec === id ? "page" : undefined} onClick={() => pick(id)}>{label}</button>
            ))}
          </div>
        ))}
      </nav>
      <Resizer pane={navW} label="Resize settings sections" />
      <main className="page">
        <div className="show-narrow" style={{ marginBottom: 16 }}>
          <label htmlFor="st-sec" className="sr-only">Section</label>
          <MenuChoice id="st-sec" className="select menu-select" style={{ width: "100%" }} label="Section" value={sec} options={GROUPS.flatMap(([, items]) => items).map(([id, l]) => ({ value: id, label: l }))} onChange={pick} />
        </div>
        {cfg && (
          <div className="page-inner">
            {sec === "project" && <ProjectSection cfg={cfg} />}
            {sec === "appearance" && <Appearance />}
            {sec === "animations" && <Animations />}
            {sec === "avatars" && <Avatars />}
            {sec === "terminal" && <TerminalSection />}
            {sec === "dictation" && <DictationSection />}
            {sec === "profiles" && <Profiles cfg={cfg} />}
            {sec === "git" && <GitProviders cfg={cfg} />}
            {sec === "tools" && <Integrations cfg={cfg} />}
            {sec === "companion" && <Companion cfg={cfg} />}
          </div>
        )}
      </main>
    </>
  );
}

function ProjectSection({ cfg }: { cfg: Config }) {
  const nav = useNav();
  const p = cfg.projects.find((x) => x.id === nav.projectId);
  const remove = useAction("projects.remove", { invalidate: [["config"], ["projects"]] });
  const { dialogs: d, setDialogs } = useProjectPrefs(p?.id);
  if (!p) return <p className="muted">No project open.</p>;
  const check = (k: Exclude<keyof DialogPrefs, "finish">, label: ReactNode) => (
    <label className="check">
      <input type="checkbox" checked={d[k]} onChange={() => setDialogs({ [k]: !d[k] })} />
      <span>{label}</span>
    </label>
  );
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>{p.name}</h1>
        <p className="mono muted" style={{ margin: 0 }}>{p.path}</p>
      </div>
      <div className="kv">
        <div><span>Releases</span><span>{p.releases.filter((r) => !r.shippedAt).length} open · {p.releases.filter((r) => r.shippedAt).length} shipped</span></div>
        <div><span>Tracked branches</span><span>{Object.keys(p.branches).length}</span></div>
        <div><span>AI-written commits</span><span>{p.aiCommits.length}</span></div>
      </div>
      <section className="section">
        <h2>Dialog defaults</h2>
        <p className="hint" style={{ margin: 0 }}>What the dialogs start with in this project. The new branch dialog remembers where you worked and whether an agent started; other dialogs apply a change to that time only.</p>
        <Seg
          grid
          label="Finishing a worktree session"
          value={d.finish}
          onChange={(finish) => setDialogs({ finish })}
          options={[{ value: "continue", label: "Continue on branch" }, { value: "merge", label: "Merge it" }]}
        />
        {check("finishSwitch", "Switch to where the worktree's code lands once it is closed")}
        {check("newWorktree", "Give a new branch its own worktree instead of switching to it")}
        {check("newAgent", "Start an AI agent on a new branch right away (always in a worktree)")}
        {check("shipPush", "Push the default branch and the tag when shipping a release")}
        {check("shipChangelog", "Let AI update the changelog before shipping a release")}
        {check("deleteOrigin", "Also delete a deleted branch on origin")}
        {check("cleanupOrigin", "Also delete cleaned-up behind branches on origin")}
      </section>
      <p className="hint">Generation languages, merge and commit options and the Git profile for this project are in the menu.</p>
      <div>
        <button
          className="btn btn-danger"
          onClick={() =>
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
          Remove from Gitnetix (files stay on disk)
        </button>
      </div>
    </>
  );
}

function Appearance() {
  const nav = useNav();
  const card = (id: string, label: string, preview: ReactNode) => (
    <button key={id} className="radio-card" role="radio" aria-checked={nav.themePref === id} style={{ alignItems: "center" }} onClick={() => nav.setThemePref(id)}>
      {preview}
      <span>{label}</span>
    </button>
  );
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Appearance</h1>
        <p className="muted" style={{ margin: 0 }}>For every project. System follows your computer's light or dark mode, in Tokyo Night Storm or Day.</p>
      </div>
      <div role="radiogroup" aria-label="Theme" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
        {card(
          "system",
          "System",
          <span className="row" style={{ gap: 4 }}>
            {(["dark", "light"] as const).map((m) => <Swatch key={m} t={resolveTheme("system", m)} />)}
          </span>,
        )}
        {THEMES.map((t) => card(t.id, t.name, <Swatch t={t} />))}
      </div>
    </>
  );
}

/** A theme in small: its panel, with dots for its text, accent and added / deleted / warning / changed colors. */
function Swatch({ t }: { t: Theme }) {
  const a = ansi(t);
  return (
    <span aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "repeat(3, 8px)", gap: 3, padding: 5, flex: "none", borderRadius: "var(--r-sm)", border: "1px solid var(--line)", background: t.panel }}>
      {[t.fg, t.accent, a[10], a[9], a[11], a[12]].map((c, i) => (
        <i key={i} style={{ width: 8, height: 8, borderRadius: 4, background: c }} />
      ))}
    </span>
  );
}

function Animations() {
  const { off, toggle, setAll } = useAnimations();
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Animations</h1>
        <p className="muted" style={{ margin: 0 }}>For every project. With reduced motion on in your system settings, they all stay off.</p>
      </div>
      <ul className="list">
        {ANIMATIONS.map((a) => (
          <li key={a.id} className="list-row">
            <label className="check grow">
              <input type="checkbox" checked={!off.includes(a.id)} onChange={() => toggle(a.id)} />
              <span className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{a.label}</span>
                <span className="hint">{a.hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn" disabled={off.length === 0} onClick={() => setAll(true)}>Turn all on</button>
        <button className="btn" disabled={off.length === ANIMATIONS.length} onClick={() => setAll(false)}>Turn all off</button>
      </div>
    </>
  );
}

function Avatars() {
  const [gravatar, setGravatar] = useStoredFlag(GRAVATAR_KEY);
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Avatars</h1>
        <p className="muted" style={{ margin: 0 }}>Authors on branches and commits show as their initials.</p>
      </div>
      <ul className="list">
        <li className="list-row">
          <label className="check grow">
            <input type="checkbox" checked={gravatar} onChange={() => setGravatar(!gravatar)} />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Use Gravatar</span>
              <span className="hint">Show the author's Gravatar picture when they have one. Sends a hash of each author's email to gravatar.com.</span>
            </span>
          </label>
        </li>
      </ul>
    </>
  );
}

function DictationSection() {
  const [keys, setKeys] = useDictationKeys();
  const [picking, setPicking] = useState(false);
  const ui = useConfig().data?.ui;
  const polish = ui?.dictationPolish ?? true;
  const setUi = useAction("ui.set", { invalidate: [["config"]] });
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Voice dictation</h1>
        <p className="muted" style={{ margin: 0 }}>Speak into any text box. Press the shortcut or click the mic at the right of the box to start listening, then press either again or Stop to put the words in.</p>
        <p className="hint" style={{ margin: 0 }}>Speech is turned into text on this computer, in English, French and 23 more European languages, even mixed in one sentence. The first time downloads the speech model (740 MB) from Hugging Face. Without Rewrite with AI, nothing you say leaves the computer.</p>
        <p className="hint" style={{ margin: 0 }}>Speech model: Parakeet Ultra by Moondream, built on NVIDIA Parakeet TDT 0.6B v3, both under CC BY 4.0 (creativecommons.org/licenses/by/4.0), quantized to 8 bits for transcribe.cpp.</p>
      </div>
      <ul className="list">
        <li className="list-row" style={{ gap: 12 }}>
          <span className="col grow" style={{ gap: 2 }}>
            <span style={{ fontWeight: 500 }}>Shortcut</span>
            <span className="hint">Click it, then press the new keys. They need Ctrl, Alt or ⌘. Esc keeps the current one.</span>
          </span>
          <button
            data-keys-input
            className="btn keys-input mono"
            aria-label={`Dictation shortcut: ${showKeys(keys)}. Press to change`}
            aria-pressed={picking}
            // Focused by hand: WebKit doesn't focus clicked buttons, and the keys must come here.
            onClick={(e) => {
              e.currentTarget.focus();
              setPicking(true);
            }}
            onBlur={() => setPicking(false)}
            onKeyDown={(e) => {
              if (!picking) return;
              // Kept here: Esc would also close the menu this can sit in.
              if (e.key === "Escape") {
                e.stopPropagation();
                return setPicking(false);
              }
              const combo = comboOf(e.nativeEvent);
              if (!combo) return;
              e.preventDefault();
              setKeys(combo);
              setPicking(false);
            }}
          >
            {picking ? "Press keys…" : showKeys(keys)}
          </button>
          {keys !== DEFAULT_KEYS && (
            <button className="btn btn-ghost btn-sm" onClick={() => setKeys("")}>
              Reset
            </button>
          )}
        </li>
        <li className="list-row">
          <label className="check grow">
            <input type="checkbox" checked={polish} onChange={() => setUi.mutate({ dictationPolish: !polish })} />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Rewrite with AI</span>
              <span className="hint">
                AI turns what you said into clear, structured text, and fixes misheard names with the project's files, branch, ticket and recent commits. Sends the words and that context to the AI set for “Voice dictation” in AI setup (Ollama stays on this computer). Skipped when no AI is set up.
              </span>
            </span>
          </label>
        </li>
      </ul>
    </>
  );
}

function TerminalSection() {
  const [tab, setTab] = useTermDefault();
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Terminal</h1>
        <p className="muted" style={{ margin: 0 }}>For every project. Each branch keeps the tab last picked in its terminal. Worktrees open on Agent every time you come back to them.</p>
      </div>
      <section className="section">
        <h2>Default tab</h2>
        <p className="hint" style={{ margin: 0 }}>What a branch opens on until a tab is picked there. A branch with an agent session opens on Agent.</p>
        <Seg grid label="Default terminal tab" value={tab} onChange={setTab} options={[{ value: "agent", label: "Agent" }, { value: "shell", label: "Shell" }]} />
      </section>
    </>
  );
}

function Profiles({ cfg }: { cfg: Config }) {
  const save = useAction<GitProfile>("profiles.save", { invalidate: [["config"]], success: "Profile saved" });
  const del = useAction("profiles.delete", { invalidate: [["config"]] });
  const [edit, setEdit] = useState<GitProfile | null>(null);
  const [deleting, setDeleting] = useState<GitProfile | null>(null);
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Git profiles</h1>
        <p className="muted" style={{ margin: 0 }}>Identities applied per project with <span className="mono">git -c</span>. Your global git config is never changed.</p>
      </div>
      <ul className="list">
        {cfg.profiles.map((p) => (
          <li key={p.id} className="list-row">
            <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 500 }}>{p.label}</span>
              <span className="hint ellipsis">{p.name} &lt;{p.email}&gt;{p.sign ? ` · signs with ${p.signingKey || "default SSH key"}` : ""}</span>
            </span>
            <button className="btn btn-sm" onClick={() => setEdit(p)}>Edit</button>
            <button className="btn btn-sm btn-danger" onClick={() => setDeleting(p)}>Delete</button>
          </li>
        ))}
        {cfg.profiles.length === 0 && <li className="empty">No profile yet.</li>}
      </ul>
      <div>
        <button className="btn" onClick={() => setEdit({ id: "", label: "", name: "", email: "", sign: false })}>Add profile</button>
      </div>
      {edit && (
        <form
          className="col card"
          style={{ padding: 16, gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ profile: edit }, { onSuccess: () => setEdit(null) });
          }}
        >
          {(
            [
              ["label", "Profile name"],
              ["name", "Author name"],
              ["email", "Email"],
              ["signingKey", "SSH signing key (optional, path to .pub)"],
            ] as const
          ).map(([k, l]) => (
            <div key={k} className="field">
              <label htmlFor={`pf-${k}`}>{l}</label>
              <input id={`pf-${k}`} className="input" value={(edit[k] as string) ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />
            </div>
          ))}
          <label className="check">
            <input type="checkbox" checked={edit.sign} onChange={() => setEdit({ ...edit, sign: !edit.sign })} />
            <span>Sign commits with SSH</span>
          </label>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={!edit.label || !edit.email}>Save</button>
          </div>
        </form>
      )}
      {deleting && (
        <Confirm
          title="Delete Git profile"
          sub={deleting.label}
          action="Delete profile"
          busy={del.isPending}
          onBack={() => setDeleting(null)}
          onConfirm={() => del.mutate({ id: deleting.id }, { onSuccess: () => setDeleting(null) })}
        >
          Projects using it go back to your global git identity.
        </Confirm>
      )}
    </>
  );
}

type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };

/** "Sign in with GitHub / Azure DevOps": show a code, open the provider's page to enter it, poll until it hands over a token. */
function DeviceSignIn({ method, name, site }: { method: "github" | "azure"; name: string; site: string }) {
  const qc = useQueryClient();
  const [code, setCode] = useState<DeviceCode | null>(null);
  const start = useAction<DeviceCode>(`${method}.signInStart`);
  useEffect(() => {
    if (!code) return;
    let interval = code.interval;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const deadline = Date.now() + code.expiresIn * 1000;
    const tick = async () => {
      try {
        const r = await rpc<{ status: string; interval?: number; user?: string | null }>(`${method}.signInPoll`, { deviceCode: code.deviceCode });
        if (stopped) return;
        if (r.status === "done") {
          setCode(null);
          qc.invalidateQueries({ queryKey: ["config"] });
          qc.invalidateQueries({ queryKey: ["prs"] });
          toast(r.user ? `Signed in to ${name} as ${r.user}` : `${name} connected`, "ok");
          return;
        }
        if (r.interval) interval = r.interval;
        if (Date.now() > deadline) throw new Error("The sign-in code expired — start again");
        timer = setTimeout(tick, interval * 1000);
      } catch (e) {
        if (stopped) return;
        setCode(null);
        toast((e as Error).message, "error");
      }
    };
    timer = setTimeout(tick, interval * 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [code, qc, method, name]);

  if (!code)
    return (
      <div>
        <button
          className="btn btn-primary"
          disabled={start.isPending}
          onClick={() =>
            start.mutate({}, {
              onSuccess: (c) => {
                setCode(c);
                copyToClipboard(c.userCode);
                openExternal(c.verificationUri);
              },
            })
          }
        >
          {start.isPending ? `Opening ${site}…` : `Sign in with ${name}`}
        </button>
      </div>
    );
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="hint">Enter this code on {site} (copied to your clipboard), then authorize Gitnetix. Waiting…</span>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn mono" style={{ fontSize: 18, letterSpacing: 2 }} title="Copy code" onClick={() => copyToClipboard(code.userCode)}>
          {code.userCode}
        </button>
        <button className="btn" onClick={() => openExternal(code.verificationUri)}>Open {site}</button>
        <button className="btn" onClick={() => setCode(null)}>Cancel</button>
      </div>
    </div>
  );
}

function GitProviders({ cfg }: { cfg: Config }) {
  const [token, setToken] = useState("");
  const [api, setApi] = useState(cfg.integrations.githubApi ?? "");
  const [manual, setManual] = useState(!!cfg.integrations.githubApi);
  const save = useAction("integrations.save", { invalidate: [["config"], ["prs"]], success: "GitHub connected" });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["prs"]], success: "GitHub disconnected" });
  const discAzure = useAction("integrations.disconnect", { invalidate: [["config"]], success: "Azure DevOps disconnected" });
  const saveAzure = useAction("integrations.save", { invalidate: [["config"]], success: "Azure DevOps connected" });
  const [azureToken, setAzureToken] = useState("");
  const [azureOrg, setAzureOrg] = useState("");
  const [azureManual, setAzureManual] = useState(false);
  const on = cfg.integrations.githubConnected;
  const user = cfg.integrations.githubUser;
  const azureOn = cfg.integrations.azureConnected;
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Git providers</h1>
        <p className="muted" style={{ margin: 0 }}>Used to open PRs, read reviews and publish releases. Tokens are stored in your OS keychain.</p>
      </div>
      <ul className="list">
        <li className="col" style={{ padding: 16, gap: 12 }}>
          <div className="row">
            <span className="col grow" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>GitHub</span>
              <span className={on ? "c-add" : "faint"} style={{ fontSize: 12 }}>
                {on ? (user ? `Signed in as ${user}` : "Connected · token in keychain") : "Not connected"}
              </span>
            </span>
            {on && <button className="btn" onClick={() => disc.mutate({ kind: "github" })}>Disconnect</button>}
          </div>
          {!on && <DeviceSignIn method="github" name="GitHub" site="GitHub" />}
          {!manual ? (
            <div>
              <button className="btn btn-sm" onClick={() => setManual(true)}>
                {on ? "Replace with a personal access token" : "Use a personal access token or GitHub Enterprise"}
              </button>
            </div>
          ) : (
            <form
              className="col"
              style={{ gap: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ kind: "github", token, config: { apiBase: api } }, { onSuccess: () => setToken("") });
              }}
            >
              <div className="field">
                <label htmlFor="gh-token">{on ? "Replace token" : "Personal access token"}</label>
                <input id="gh-token" type="password" className="input mono" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
                <span className="hint">Fine-grained token with Pull requests, Contents, Checks (read) and Issues permissions on your repos.</span>
              </div>
              <div className="field">
                <label htmlFor="gh-api">API base <span className="faint" style={{ fontWeight: 400 }}>GitHub Enterprise only</span></label>
                <input id="gh-api" className="input mono" placeholder="https://github.example.com/api/v3" value={api} onChange={(e) => setApi(e.target.value)} />
              </div>
              <div>
                <button className="btn btn-primary" disabled={!token && !on}>{on ? "Save" : "Connect"}</button>
              </div>
            </form>
          )}
        </li>
        <li className="col" style={{ padding: 16, gap: 12 }}>
          <div className="row">
            <span className="col grow" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>Azure DevOps</span>
              <span className={azureOn ? "c-add" : "faint"} style={{ fontSize: 12 }}>
                {azureOn ? (cfg.integrations.azureUser ? `Signed in as ${cfg.integrations.azureUser}` : "Connected · token in keychain") : "Not connected"}
              </span>
            </span>
            {azureOn && <button className="btn" onClick={() => discAzure.mutate({ kind: "azure" })}>Disconnect</button>}
          </div>
          {!azureOn && <DeviceSignIn method="azure" name="Azure DevOps" site="Microsoft" />}
          {!azureManual ? (
            <div>
              <button className="btn btn-sm" onClick={() => setAzureManual(true)}>
                {azureOn ? "Replace with a personal access token" : "Use a personal access token"}
              </button>
            </div>
          ) : (
            <form
              className="col"
              style={{ gap: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                saveAzure.mutate({ kind: "azure", token: azureToken, config: { org: azureOrg } }, { onSuccess: () => { setAzureToken(""); setAzureManual(false); } });
              }}
            >
              <div className="field">
                <label htmlFor="az-token">{azureOn ? "Replace token" : "Personal access token"}</label>
                <input id="az-token" type="password" className="input mono" value={azureToken} onChange={(e) => setAzureToken(e.target.value)} />
                <span className="hint">Token with the Code (Read &amp; write) scope, to read and act on pull requests.</span>
              </div>
              <div className="field">
                <label htmlFor="az-org">Organization</label>
                <input id="az-org" className="input mono" placeholder="https://dev.azure.com/your-org" value={azureOrg} onChange={(e) => setAzureOrg(e.target.value)} />
              </div>
              <div>
                <button className="btn btn-primary" disabled={!azureToken || !azureOrg.trim() || saveAzure.isPending}>{azureOn ? "Save" : "Connect"}</button>
              </div>
            </form>
          )}
        </li>
        {["GitLab", "Bitbucket", "Gitea"].map((n) => (
          <li key={n} className="list-row">
            <span className="col grow" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{n}</span>
              <span className="faint" style={{ fontSize: 12 }}>Not supported yet — push, pull and local work still behave normally</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Browser sign-in: Atlassian redirects back to a listener the app opens on localhost. */
function AtlassianSignIn({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const attempt = useRef(0);
  const signIn = async () => {
    const mine = ++attempt.current;
    setWaiting(true);
    try {
      const { url } = await rpc<{ url: string }>("jira.signInStart");
      await openExternal(url);
      const r = await rpc<{ user?: string | null }>("jira.signInFinish");
      if (mine !== attempt.current) return;
      for (const key of ["config", "tickets", "jiraAuth"]) qc.invalidateQueries({ queryKey: [key] });
      toast(r.user ? `Signed in to Jira as ${r.user}` : "Jira connected", "ok");
      onDone?.();
    } catch (e) {
      if (mine === attempt.current) toast((e as Error).message, "error");
    } finally {
      if (mine === attempt.current) setWaiting(false);
    }
  };
  return waiting ? (
    <div className="row" style={{ gap: 10 }}>
      <span className="spinner" />
      <span className="muted grow">Finish signing in in your browser…</span>
      <button type="button" className="btn btn-sm" onClick={() => signIn()}>Open again</button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          attempt.current++;
          setWaiting(false);
        }}
      >
        Cancel
      </button>
    </div>
  ) : (
    <div>
      <button type="button" className="btn btn-primary" onClick={() => signIn()}>Sign in with Atlassian</button>
    </div>
  );
}

const tokensLink = (
  <a href={JIRA_TOKENS} onClick={(e) => { e.preventDefault(); openExternal(JIRA_TOKENS); }}>{JIRA_TOKENS}</a>
);

function input(id: string, label: string, value: string, set: (v: string) => void, opts: { type?: string; ph?: string; hint?: ReactNode } = {}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type={opts.type ?? "text"} placeholder={opts.ph} value={value} onChange={(e) => set(e.target.value)} />
      {opts.hint && <span className="hint">{opts.hint}</span>}
    </div>
  );
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Ticks among `options`; none ticked means all of them. */
function Checks({ label, hint, options, value, onChange }: { label: string; hint: string; options: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const shown = options.filter((o) => !term || o.label.toLowerCase().includes(term));
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ padding: 0, marginBottom: 6 }}>{label}</legend>
      <input className="input" type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 6 }} />
      <div className="col" style={{ gap: 2, maxHeight: 200, overflowY: "auto" }}>
        {shown.map((o) => (
          <label key={o.value} className="check">
            <input type="checkbox" checked={value.includes(o.value)} onChange={() => onChange(toggle(value, o.value))} />
            <span>{o.label}</span>
          </label>
        ))}
        {shown.length === 0 && <span className="faint" style={{ fontSize: 12 }}>No match.</span>}
      </div>
      <span className="hint">{hint}</span>
    </fieldset>
  );
}

/** Which Gitnetix projects show a connection's tickets. */
function RepoChecks({ cfg, value, onChange }: { cfg: Config; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Checks
      label="Show in these projects"
      hint="None ticked = every project."
      options={cfg.projects.map((p) => ({ value: p.id, label: p.name }))}
      value={value}
      onChange={onChange}
    />
  );
}

/** One Jira connection, or the form adding a new one when `conn` is missing. */
function JiraConnection({ cfg, conn, onDone }: { cfg: Config; conn?: JiraConn; onDone?: () => void }) {
  const save = useAction<{ user?: string | null }>("integrations.save", { invalidate: [["config"], ["tickets"], ["jiraAuth"], ["jiraProjects"]], success: (r) => (r.user ? `Connected as ${r.user}` : "Saved") });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["tickets"]] });
  // A saved config is not enough: the token may have expired or been revoked since.
  const auth = useQuery({
    queryKey: ["jiraAuth", conn?.id],
    queryFn: () => rpc<{ user?: string | null }>("integrations.checkJira", { id: conn!.id }),
    enabled: !!conn,
    retry: false,
    staleTime: 60_000,
  });
  const projects = useQuery({
    queryKey: ["jiraProjects", conn?.id],
    queryFn: () => rpc<{ key: string; name: string }[]>("jira.projects", { id: conn!.id }),
    enabled: auth.isSuccess,
    staleTime: 5 * 60_000,
  });
  const [f, setF] = useState({ baseUrl: conn?.baseUrl ?? "", email: conn?.email ?? "", jql: conn?.jql ?? "", token: "", projects: conn?.projects ?? [], repos: conn?.repos ?? [] });
  const oauth = !!conn?.cloudId;
  const [tokenMode, setTokenMode] = useState(!!conn && !oauth);
  const filters = { jql: f.jql || null, projects: f.projects, repos: f.repos };
  const submit = () =>
    save.mutate(
      tokenMode
        ? { kind: "jira", token: f.token, config: { id: conn?.id ?? null, baseUrl: f.baseUrl, email: f.email, ...filters } }
        : { kind: "jira", config: { id: conn!.id, baseUrl: conn!.baseUrl, cloudId: conn!.cloudId, ...filters } },
      { onSuccess: () => onDone?.() },
    );
  const canSave = tokenMode ? !!f.baseUrl && !!f.email && (!!f.token || (!!conn && !oauth)) : !!conn;
  const site = conn ? conn.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  return (
    <form
      className="col card"
      style={{ padding: 16, gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="row">
        <span className="col grow" style={{ gap: 2 }}>
          <span style={{ fontWeight: 500 }}>{conn ? `Jira Cloud · ${site}` : "New Jira connection"}</span>
          {!conn ? (
            <span className="faint" style={{ fontSize: 12 }}>Not connected</span>
          ) : auth.isPending ? (
            <span className="faint" style={{ fontSize: 12 }}>Checking…</span>
          ) : auth.isError ? (
            <span className="c-del" style={{ fontSize: 12 }}>Not signed in · {auth.error.message}</span>
          ) : (
            <span className="c-add" style={{ fontSize: 12 }}>{auth.data?.user ? `Connected as ${auth.data.user}` : "Connected"}</span>
          )}
        </span>
        {conn ? (
          <button type="button" className="btn" onClick={() => disc.mutate({ kind: "jira", id: conn.id })}>Disconnect</button>
        ) : (
          onDone && <button type="button" className="btn" onClick={onDone}>Cancel</button>
        )}
      </div>
      {!conn && !tokenMode && <AtlassianSignIn onDone={onDone} />}
      {tokenMode && (
        <>
          {input(`jr-url-${conn?.id ?? "new"}`, "Site", f.baseUrl, (v) => setF({ ...f, baseUrl: v }), { ph: "https://yourteam.atlassian.net" })}
          {input(`jr-email-${conn?.id ?? "new"}`, "Account email", f.email, (v) => setF({ ...f, email: v }))}
          {input(`jr-token-${conn?.id ?? "new"}`, "API token", f.token, (v) => setF({ ...f, token: v }), { type: "password", hint: <>Create one at {tokensLink} (scoped tokens need read:jira-user and read:jira-work)</> })}
          {save.isError && (
            <span className="c-del" style={{ fontSize: 12 }}>
              {save.error.message} · Make sure you did create the API token here: {tokensLink}
            </span>
          )}
        </>
      )}
      {(tokenMode || oauth) && input(`jr-jql-${conn?.id ?? "new"}`, "JQL (optional)", f.jql, (v) => setF({ ...f, jql: v }), { ph: "project = ATL AND statusCategory != Done" })}
      {conn &&
        (projects.data ? (
          <Checks
            label="Jira projects"
            hint="None ticked = every project this account can see."
            options={projects.data.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))}
            value={f.projects}
            onChange={(v) => setF({ ...f, projects: v })}
          />
        ) : (
          projects.isFetching && <span className="faint" style={{ fontSize: 12 }}>Loading Jira projects…</span>
        ))}
      {(conn || tokenMode) && <RepoChecks cfg={cfg} value={f.repos} onChange={(v) => setF({ ...f, repos: v })} />}
      {!tokenMode && (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setTokenMode(true)}>
            {oauth ? "Replace with an API token" : "Use an API token instead"}
          </button>
        </div>
      )}
      {(conn || tokenMode) && (
        <div>
          <button className="btn btn-primary" disabled={!canSave || save.isPending}>{conn ? "Save" : "Connect"}</button>
        </div>
      )}
    </form>
  );
}

type Field = { key: string; label: string; hint?: string; optional?: boolean };
type Kind = { kind: "trello" | "asana"; title: string; token: string; fields: Field[]; name: (c: Record<string, unknown>) => string };
const TRELLO: Kind = {
  kind: "trello",
  title: "Trello",
  token: "Token",
  fields: [
    { key: "apiKey", label: "API key", hint: "trello.com/power-ups/admin › your Power-Up › API key" },
    { key: "boardId", label: "Board id (optional)", hint: "Empty = cards assigned to you", optional: true },
  ],
  name: (c) => (c.boardId ? `board ${c.boardId}` : "my cards"),
};
const ASANA: Kind = {
  kind: "asana",
  title: "Asana",
  token: "Personal access token",
  fields: [
    { key: "workspaceGid", label: "Workspace gid" },
    { key: "projectGid", label: "Project gid (optional)", hint: "Empty = tasks assigned to you", optional: true },
  ],
  name: (c) => (c.projectGid ? `project ${c.projectGid}` : "my tasks"),
};

/** One Trello or Asana connection, or the form adding a new one when `conn` is missing. */
function TokenConnection({ cfg, k, conn, onDone }: { cfg: Config; k: Kind; conn?: { id: string; repos: string[] } & Record<string, unknown>; onDone?: () => void }) {
  const save = useAction("integrations.save", { invalidate: [["config"], ["tickets"]], success: conn ? "Saved" : `${k.title} connected` });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["tickets"]] });
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(k.fields.map((x) => [x.key, String(conn?.[x.key] ?? "")])));
  const [token, setToken] = useState("");
  const [repos, setRepos] = useState(conn?.repos ?? []);
  const uid = `${k.kind}-${conn?.id ?? "new"}`;
  const canSave = k.fields.every((x) => x.optional || f[x.key]) && (!!token || !!conn);
  return (
    <form
      className="col card"
      style={{ padding: 16, gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        const config = { id: conn?.id ?? null, repos, ...Object.fromEntries(k.fields.map((x) => [x.key, f[x.key] || (x.optional ? null : "")])) };
        save.mutate({ kind: k.kind, token, config }, { onSuccess: () => onDone?.() });
      }}
    >
      <div className="row">
        <span className="col grow" style={{ gap: 2 }}>
          <span style={{ fontWeight: 500 }}>{conn ? `${k.title} · ${k.name(conn)}` : `New ${k.title} connection`}</span>
          <span className={conn ? "c-add" : "faint"} style={{ fontSize: 12 }}>{conn ? "Connected" : "Not connected"}</span>
        </span>
        {conn ? (
          <button type="button" className="btn" onClick={() => disc.mutate({ kind: k.kind, id: conn.id })}>Disconnect</button>
        ) : (
          onDone && <button type="button" className="btn" onClick={onDone}>Cancel</button>
        )}
      </div>
      {k.fields.map((x, i) => (
        <Fragment key={x.key}>
          {input(`${uid}-${x.key}`, x.label, f[x.key], (v) => setF({ ...f, [x.key]: v }), { hint: x.hint })}
          {i === 0 && input(`${uid}-token`, k.token, token, setToken, { type: "password", hint: conn ? "Empty = keep the saved one" : undefined })}
        </Fragment>
      ))}
      <RepoChecks cfg={cfg} value={repos} onChange={setRepos} />
      <div>
        <button className="btn btn-primary" disabled={!canSave || save.isPending}>{conn ? "Save" : "Connect"}</button>
      </div>
    </form>
  );
}

/** A tracker's connections, then a form or button to add one. */
function ConnectionList<T extends { id: string }>({ items, add, row }: { items: T[]; add: string; row: (c?: T, onDone?: () => void) => ReactNode }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      {items.map((c) => (
        <Fragment key={c.id}>{row(c)}</Fragment>
      ))}
      {(adding || items.length === 0) && row(undefined, items.length ? () => setAdding(false) : undefined)}
      {items.length > 0 && !adding && (
        <div>
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} />
            {add}
          </button>
        </div>
      )}
    </>
  );
}

function Integrations({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Jira, Trello, Asana</h1>
        <p className="muted" style={{ margin: 0 }}>Tickets show in Tickets, linked to their branch and release. Tokens go to your OS keychain.</p>
      </div>
      <ConnectionList items={i.jira} add="Add a Jira connection" row={(c, onDone) => <JiraConnection cfg={cfg} conn={c} onDone={onDone} />} />
      <ConnectionList items={i.trello} add="Add a Trello connection" row={(c, onDone) => <TokenConnection cfg={cfg} k={TRELLO} conn={c} onDone={onDone} />} />
      <ConnectionList items={i.asana} add="Add an Asana connection" row={(c, onDone) => <TokenConnection cfg={cfg} k={ASANA} conn={c} onDone={onDone} />} />
    </>
  );
}

/** QR that opens Gitnetix on a phone, already paired; a restart prompt until the companion listens on the LAN. Also shown in the menu panel. */
export function PairQr({ server: s }: { server: Config["server"] }) {
  const [info, setInfo] = useState<CompanionInfo | null>(null);
  useEffect(() => {
    companionInfo().then(setInfo).catch(() => {});
  }, [s.token, s.enabled, s.lan, s.port]);
  const host = info?.hosts[0];
  if (!isLocal || !s.enabled || !s.lan || !info) return null;
  if (!info.listening)
    return (
      <div className="col" style={{ alignItems: "flex-start" }}>
        <p className="hint" style={{ margin: 0 }}>
          {/* Relaunching a dev build ends `pnpm app`'s Vite server, and the new window would stay blank. */}
          Phones can't connect yet: Gitnetix isn't listening on port <span className="mono">{s.port}</span> with these settings. {import.meta.env.DEV ? "Restart pnpm app" : "Restart Gitnetix"} to apply them. If this stays after a restart, another app is using the port.
        </p>
        {!import.meta.env.DEV && (
          <button className="btn" onClick={() => import("@tauri-apps/plugin-process").then((p) => p.relaunch()).catch((e) => toast(String(e), "error"))}>
            Restart Gitnetix
          </button>
        )}
      </div>
    );
  if (!host) return null;
  return (
    <div className="row" style={{ gap: 16, alignItems: "center" }}>
      <div
        role="img"
        aria-label="QR code to open Gitnetix on your phone"
        style={{ width: 160, flexShrink: 0, background: "#fff", padding: 8, borderRadius: 8 }}
        dangerouslySetInnerHTML={{ __html: renderSVG(`https://${host}:${s.port}/#token=${s.token}`) }}
      />
      <div className="col" style={{ alignItems: "flex-start" }}>
        <p className="hint" style={{ margin: 0 }}>
          Scan with the phone camera to open Gitnetix in its browser, already paired. The first time, the browser warns that the connection isn't private: open the details and continue to the site. The code contains the token: don't share it.
        </p>
        {info.ufw && (
          <button className="btn" title="Lets devices on this network reach the companion port (asks for your password)" onClick={() => allowFirewall().then((m) => toast(m || "Allowed through the firewall", "ok"), (e) => toast(String(e), "error"))}>
            Allow through firewall
          </button>
        )}
      </div>
    </div>
  );
}

function Companion({ cfg }: { cfg: Config }) {
  const [info, setInfo] = useState<CompanionInfo | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const set = useAction<{ restartRequired: boolean }>("server.set", { invalidate: [["config"]], success: "Saved — restart Gitnetix to apply" });
  useEffect(() => {
    companionInfo().then(setInfo).catch(() => {});
  }, [cfg.server.token]);
  const s = cfg.server;
  const host = s.lan ? info?.hosts[0] ?? "<this computer's IP>" : "127.0.0.1";
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Companion & MCP</h1>
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          The companion API exposes every Gitnetix action over HTTP. The mobile app uses it to manage releases, agents, PRs and tickets, and the MCP server uses it so AI agents can drive Gitnetix.
        </p>
      </div>
      {!isLocal && <div className="note-box">You are connected remotely. Change these on the computer.</div>}
      <section className="section">
        <label className="check">
          <input type="checkbox" checked={s.enabled} disabled={!isLocal} onChange={() => set.mutate({ enabled: !s.enabled })} />
          <span>Companion API on port <span className="mono">{s.port}</span></span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.lan} disabled={!isLocal} onChange={() => set.mutate({ lan: !s.lan })} />
          <span>Allow devices on my network (needed for the phone)</span>
        </label>
        <p className="hint">
          Phones connect over HTTPS with a certificate made on this computer, so their browser warns once and then allows voice dictation. The pairing token protects every call. Anyone with the token on the same network can run Git commands and agents on this computer. Turn LAN access on only on networks you trust, or use a VPN like Tailscale.
        </p>
      </section>
      {isLocal && (
        <section className="section">
          <h2>Pair a phone</h2>
          <div className="kv">
            <div>
              <span>Address</span>
              <span className="mono">{host}:{s.port}</span>
            </div>
            <div>
              <span>Pairing token</span>
              <span className="mono ellipsis" title={s.token}>{s.token.slice(0, 12)}…</span>
            </div>
          </div>
          <PairQr server={s} />
          <div className="row wrap">
            <button className="btn" onClick={() => copyToClipboard(`${host}:${s.port}`)}>Copy address</button>
            <button className="btn" onClick={() => copyToClipboard(s.token)}>Copy token</button>
            <button className="btn btn-danger" onClick={() => setRegenerating(true)}>New token (unpairs devices)</button>
          </div>
        </section>
      )}
      <section className="section">
        <h2>MCP server</h2>
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          <span className="mono">gitnetix-mcp</span> (built next to the app) speaks MCP over stdio and forwards to the companion API, so the app must be running. Add it to Claude Code:
        </p>
        <pre className="pre">claude mcp add gitnetix -- gitnetix-mcp</pre>
        <p className="hint">Each RPC becomes a tool: projects_list, workspace_overview, items_create, agents_start, prs_review…</p>
      </section>
      {regenerating && (
        <Confirm
          title="New pairing token"
          action="New token"
          busy={set.isPending}
          onBack={() => setRegenerating(false)}
          onConfirm={() => set.mutate({ regenerateToken: true }, { onSuccess: () => setRegenerating(false) })}
        >
          Once Gitnetix restarts, every paired device is disconnected and must pair again with the new token.
        </Confirm>
      )}
    </>
  );
}
