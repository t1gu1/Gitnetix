import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAction, useConfig } from "../api/hooks";
import { renderSVG } from "uqr";

import { allowFirewall, companionInfo, isLocal, openExternal, rpc, type CompanionInfo } from "../api/transport";
import type { Config, GitProfile, JiraConn } from "../api/types";
import { GRAVATAR_KEY } from "../components/Avatar";
import { Icon } from "../components/Icon";
import { useTermDefault } from "../components/Shell";
import { Confirm, Seg } from "../components/ui";
import { comboOf, DEFAULT_KEYS, showKeys, useDictationKeys } from "../lib/dictation";
import { ANIMATIONS, useAnimations } from "../lib/motion";
import { useNav } from "../lib/nav";
import { useStoredFlag } from "../lib/stored";
import { ansi, resolveTheme, THEMES, type Theme } from "../lib/themes";
import { copyToClipboard, toast } from "../lib/toast";

const JIRA_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** App settings by group: id, label, icon, listed as rows in the menu. Project settings are in the menu too, beside them. */
export const GROUPS: [string, [string, string, string][]][] = [
  ["General", [["appearance", "Appearance", "brush"], ["animations", "Animations", "play"], ["avatars", "Avatars", "smile"], ["terminal", "Terminal", "terminal"], ["worktrees", "Worktrees", "layers"], ["dictation", "Voice dictation", "mic"]]],
  ["AI", [["ai", "AI setup", "sparkle"], ["templates", "Templates", "edit"]]],
  ["Git", [["profiles", "Git identities", "user"], ["git", "Git providers", "pr"]]],
  ["Integrations", [["tools", "Jira, Trello, Asana", "ticket"], ["companion", "Companion & MCP", "phone"]]],
];

/** One section of GROUPS (but AI setup and templates, framed pages of their own), opened from the menu. */
export function SettingsSection({ id, cfg }: { id: string; cfg: Config }) {
  return (
    <>
      {id === "appearance" && <Appearance />}
      {id === "animations" && <Animations />}
      {id === "avatars" && <Avatars />}
      {id === "terminal" && <TerminalSection />}
      {id === "worktrees" && <WorktreesSection cfg={cfg} />}
      {id === "dictation" && <DictationSection />}
      {id === "profiles" && <Profiles cfg={cfg} />}
      {id === "git" && <GitProviders cfg={cfg} />}
      {id === "tools" && <Integrations cfg={cfg} />}
      {id === "companion" && <Companion cfg={cfg} />}
    </>
  );
}

/** Saved on blur, so a half-typed path is not copied into the next worktree. */
export function WorktreeFiles({ files, onSave }: { files: string[]; onSave: (files: string[]) => void }) {
  const [text, setText] = useState(files.join("\n"));
  const save = () => {
    const next = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (next.join("\n") !== files.join("\n")) onSave(next);
  };
  return (
    <textarea
      aria-label="Worktree files"
      className="textarea mono"
      rows={4}
      placeholder={"graphify-out\n.env"}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
    />
  );
}

function Appearance() {
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Appearance</h1>
        <p className="muted" style={{ margin: 0 }}>For every project. System follows your computer's light or dark mode, in Tokyo Night Storm or Day.</p>
      </div>
      <ThemeChoices />
    </>
  );
}

/** Every theme with its colors, System first; a pick applies at once. Also the first step of the first-run setup. */
export function ThemeChoices() {
  const nav = useNav();
  const card = (id: string, label: string, preview: ReactNode) => (
    <button key={id} className="radio-card" role="radio" aria-checked={nav.themePref === id} style={{ alignItems: "center" }} onClick={() => nav.setThemePref(id)}>
      {preview}
      <span>{label}</span>
    </button>
  );
  return (
    <div role="radiogroup" aria-label="Theme" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
      {card(
        "system",
        "System",
        <span className="row" style={{ gap: 4, margin: 0 }}>
          {(["dark", "light"] as const).map((m) => <Swatch key={m} t={resolveTheme("system", m)} />)}
        </span>,
      )}
      {THEMES.map((t) => card(t.id, t.name, <Swatch t={t} />))}
    </div>
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
      <div className="anim-head">
        <div className="col page-intro" style={{ gap: 6 }}>
          <h1>Animations</h1>
          <p className="muted" style={{ margin: 0 }}>For every project. With reduced motion on in your system settings, they all stay off.</p>
        </div>
        <div className="row" style={{ margin: "0 0 0 auto" }}>
          <button className="btn" disabled={off.length === 0} onClick={() => setAll(true)}>Turn all on</button>
          <button className="btn" disabled={off.length === ANIMATIONS.length} onClick={() => setAll(false)}>Turn all off</button>
        </div>
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
    </>
  );
}

function Avatars() {
  const [gravatar, setGravatar] = useStoredFlag(GRAVATAR_KEY);
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
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
  const ui = useConfig().data?.ui;
  const polish = ui?.dictationPolish ?? true;
  const setUi = useAction("ui.set", { invalidate: [["config"]] });
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Voice dictation</h1>
        <p className="muted" style={{ margin: 0 }}>Speak into any text box. Press the shortcut or click the mic at the right of the box to start listening, then press either again or Stop to put the words in.</p>
        <p className="hint" style={{ margin: 0 }}>Speech is turned into text on this computer, in English, French and 23 more European languages, even mixed in one sentence. The first time downloads the speech model (740 MB) from Hugging Face. Without Rewrite with AI, nothing you say leaves the computer.</p>
        <p className="hint" style={{ margin: 0 }}>Speech model: Parakeet Ultra by Moondream, built on NVIDIA Parakeet TDT 0.6B v3, both under CC BY 4.0 (creativecommons.org/licenses/by/4.0), quantized to 8 bits for transcribe.cpp.</p>
      </div>
      <ul className="list">
        <DictationKeys />
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

/** The dictation shortcut as a list row: click it, then press the new keys. Also in the first-run setup. */
export function DictationKeys() {
  const [keys, setKeys] = useDictationKeys();
  const [picking, setPicking] = useState(false);
  return (
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
  );
}

function TerminalSection() {
  const [tab, setTab] = useTermDefault();
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
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

function WorktreesSection({ cfg }: { cfg: Config }) {
  const save = useAction("worktrees.setFiles", { invalidate: [["config"]] });
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Worktrees</h1>
        <p className="muted" style={{ margin: 0 }}>For every project. Each project can add its own in the menu, under This project.</p>
      </div>
      <section className="section">
        <h2>Worktree files</h2>
        <p className="hint" style={{ margin: 0 }}>Git leaves ignored files out of a new worktree. These are copied from the main checkout into it when the project has them, one path from the project root per line: a knowledge graph, .env, local settings.</p>
        <WorktreeFiles files={cfg.worktreeFiles} onSave={(files) => save.mutate({ files })} />
      </section>
    </>
  );
}

function Profiles({ cfg }: { cfg: Config }) {
  const save = useAction<GitProfile>("profiles.save", { invalidate: [["config"]], success: "Identity saved" });
  const del = useAction("profiles.delete", { invalidate: [["config"]] });
  const [edit, setEdit] = useState<GitProfile | null>(null);
  const [deleting, setDeleting] = useState<GitProfile | null>(null);
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Git identities</h1>
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
        {cfg.profiles.length === 0 && <li className="empty">No identity yet.</li>}
      </ul>
      <div>
        <button className="btn" onClick={() => setEdit({ id: "", label: "", name: "", email: "", sign: false })}>Add identity</button>
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
              ["label", "Identity name"],
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
          title="Delete Git identity"
          sub={deleting.label}
          action="Delete identity"
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
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Git providers</h1>
        <p className="muted" style={{ margin: 0 }}>Used to open PRs, read reviews and publish releases. Tokens are stored in your OS keychain.</p>
      </div>
      <ul className="list">
        <GitHosts cfg={cfg} />
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

/** The GitHub and Azure DevOps rows of a list: sign in with a code, or paste a token. Also in the first-run setup. */
export function GitHosts({ cfg }: { cfg: Config }) {
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

/** Which Gitnetix projects show a connection's tickets; nothing to pick before the first project. */
function RepoChecks({ cfg, value, onChange }: { cfg: Config; value: string[]; onChange: (v: string[]) => void }) {
  if (!cfg.projects.length) return null;
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

/** The Jira connections, then the form adding one. Also a step of the first-run setup. */
export function JiraConnections({ cfg }: { cfg: Config }) {
  return <ConnectionList items={cfg.integrations.jira} add="Add a Jira connection" row={(c, onDone) => <JiraConnection cfg={cfg} conn={c} onDone={onDone} />} />;
}

function Integrations({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Jira, Trello, Asana</h1>
        <p className="muted" style={{ margin: 0 }}>Tickets show in Tickets, linked to their branch and release. Tokens go to your OS keychain.</p>
      </div>
      <JiraConnections cfg={cfg} />
      <ConnectionList items={i.trello} add="Add a Trello connection" row={(c, onDone) => <TokenConnection cfg={cfg} k={TRELLO} conn={c} onDone={onDone} />} />
      <ConnectionList items={i.asana} add="Add an Asana connection" row={(c, onDone) => <TokenConnection cfg={cfg} k={ASANA} conn={c} onDone={onDone} />} />
    </>
  );
}

/**
 * Gitnetix on a phone: a QR code that opens it there already paired, with the address and token to type instead.
 * Until phones can connect: what allows them, or the restart that applies it. In the menu and in Companion & MCP.
 */
export function PhoneCard({ server: s }: { server: Config["server"] }) {
  const [info, setInfo] = useState<CompanionInfo | null>(null);
  const set = useAction("server.set", { invalidate: [["config"]] });
  useEffect(() => {
    companionInfo().then(setInfo).catch(() => {});
  }, [s.token, s.enabled, s.lan, s.port]);
  if (!isLocal) return null;
  const head = (text: ReactNode) => (
    <div className="col" style={{ gap: 4, minWidth: 0 }}>
      <strong className="phone-title">Gitnetix on your phone</strong>
      <p className="hint" style={{ margin: 0 }}>{text}</p>
    </div>
  );
  const icon = (
    <span className="phone-icon">
      <Icon name="phone" size={18} />
    </span>
  );
  if (!s.enabled || !s.lan)
    return (
      <div className="phone-card">
        {icon}
        <div className="col" style={{ gap: 12, alignItems: "flex-start", minWidth: 0 }}>
          {head("Manage releases, agents, PRs and tickets from your phone. Anyone on your network with the pairing token can then run Git commands and agents on this computer: allow it only on networks you trust, or use a VPN like Tailscale.")}
          <button className="btn btn-sm" disabled={set.isPending} onClick={() => set.mutate({ enabled: true, lan: true })}>
            Allow devices on my network
          </button>
        </div>
      </div>
    );
  if (!info) return null;
  if (!info.listening)
    return (
      <div className="phone-card">
        {icon}
        <div className="col" style={{ gap: 12, alignItems: "flex-start", minWidth: 0 }}>
          {/* Relaunching a dev build ends `pnpm app`'s Vite server, and the new window would stay blank. */}
          {head(<>Phones can't connect yet: Gitnetix isn't listening on port <span className="mono">{s.port}</span> with these settings. {import.meta.env.DEV ? "Restart pnpm app" : "Restart Gitnetix"} to apply them. If this stays after a restart, another app is using the port.</>)}
          {!import.meta.env.DEV && (
            <button className="btn btn-sm btn-primary" onClick={() => import("@tauri-apps/plugin-process").then((p) => p.relaunch()).catch((e) => toast(String(e), "error"))}>
              Restart Gitnetix
            </button>
          )}
        </div>
      </div>
    );
  const host = info.hosts[0];
  if (!host) return null;
  const address = `${host}:${s.port}`;
  const copy = (label: string, text: string) => (
    <button className="btn btn-ghost btn-icon btn-sm" aria-label={label} data-tip={label} onClick={() => copyToClipboard(text)}>
      <Icon name="copy" size={13} />
    </button>
  );
  return (
    <div className="phone-card">
      <div className="phone-qr" role="img" aria-label="QR code to open Gitnetix on your phone" dangerouslySetInnerHTML={{ __html: renderSVG(`https://${address}/#token=${s.token}`) }} />
      <div className="col" style={{ gap: 12, minWidth: 0 }}>
        {head("Scan it with the phone camera: Gitnetix opens in its browser, already paired.")}
        <div className="phone-kv">
          <span>Address</span>
          <span className="mono ellipsis">{address}</span>
          {copy("Copy address", address)}
          <span>Token</span>
          <span className="mono ellipsis">{s.token.slice(0, 12)}…</span>
          {copy("Copy token", s.token)}
        </div>
      </div>
      <div className="phone-foot">
        <p className="hint" style={{ margin: 0 }}>The first time, the browser warns that the connection isn't private: open the details and continue to the site. The code holds the token: don't share it.</p>
        {info.ufw && (
          <button className="btn btn-sm" title="Lets devices on this network reach the companion port (asks for your password)" onClick={() => allowFirewall().then((m) => toast(m || "Allowed through the firewall", "ok"), (e) => toast(String(e), "error"))}>
            Allow through firewall
          </button>
        )}
      </div>
    </div>
  );
}

function Companion({ cfg }: { cfg: Config }) {
  const [regenerating, setRegenerating] = useState(false);
  const set = useAction<{ restartRequired: boolean }>("server.set", { invalidate: [["config"]], success: "Saved — restart Gitnetix to apply" });
  const s = cfg.server;
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
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
          {s.enabled && s.lan ? <PhoneCard server={s} /> : <p className="hint" style={{ margin: 0 }}>Allow devices on your network above to show the QR code.</p>}
          <div className="row wrap">
            {/* Also for scripts and browsers on this computer, which reach 127.0.0.1 without network access. */}
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
