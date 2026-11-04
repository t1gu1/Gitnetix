import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useAction, useConfig } from "../api/hooks";
import { renderSVG } from "uqr";

import { allowFirewall, companionInfo, isLocal, openExternal, rpc, type CompanionInfo } from "../api/transport";
import type { Config, JiraConn } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { useTermDefault } from "../components/Shell";
import { Confirm, Seg } from "../components/ui";
import { BUILT_IN, comboOf, DEFAULTS, keyCaps, SHORTCUTS, showKeys, usedBy, useKeys, useSetKeys } from "../lib/keys";
import { ANIMATIONS, useAnimations } from "../lib/motion";
import { useNav } from "../lib/nav";
import { ansi, resolveTheme, THEMES, type Theme } from "../lib/themes";
import { copyToClipboard, toast } from "../lib/toast";

const JIRA_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** App settings by group: id, label, icon, listed as rows in the menu. Project settings are in the menu too, beside them. */
export const GROUPS: [string, [string, string, string][]][] = [
  ["General", [["appearance", "Appearance", "brush"], ["animations", "Animations", "play"], ["terminal", "Terminal", "terminal"], ["worktrees", "Worktrees", "layers"], ["dictation", "Voice dictation", "mic"], ["shortcuts", "Shortcuts", "keyboard"]]],
  ["AI", [["ai", "AI setup", "sparkle"], ["templates", "Templates", "edit"]]],
  ["Git", [["git", "Git providers", "pr"]]],
  ["Integrations", [["tools", "Jira, Trello, Asana", "ticket"], ["companion", "Companion & MCP", "phone"]]],
];

/** One section of GROUPS (but AI setup and templates, framed pages of their own), opened from the menu. */
export function SettingsSection({ id, cfg }: { id: string; cfg: Config }) {
  return (
    <>
      {id === "appearance" && <Appearance />}
      {id === "animations" && <Animations />}
      {id === "terminal" && <TerminalSection />}
      {id === "worktrees" && <WorktreesSection cfg={cfg} />}
      {id === "dictation" && <DictationSection />}
      {id === "shortcuts" && <ShortcutsSection />}
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
  return (
    <li className="list-row">
      <span className="col grow" style={{ gap: 2 }}>
        <span style={{ fontWeight: 500 }}>Shortcut</span>
        <span className="hint">Click it, then press the new keys. They need Ctrl, Alt or ⌘. Esc keeps the current one.</span>
      </span>
      <KeysButton id="dictation" />
    </li>
  );
}

/** A shortcut as key caps. */
function Keys({ keys }: { keys: string }) {
  return (
    <span className="keys">
      {keyCaps(keys).map((k, i) => (
        <kbd key={i} className={/^\W$/.test(k) ? "keys-sym" : undefined}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

/** Shortcut `id`'s keys: click them, then press the new ones. Keys another shortcut has are refused, and Reset shows once changed. */
function KeysButton({ id }: { id: string }) {
  const keys = useKeys();
  const setKeys = useSetKeys();
  const [picking, setPicking] = useState(false);
  // What has the keys just pressed, while it keeps listening for others.
  const [taken, setTaken] = useState("");
  const label = SHORTCUTS.find((s) => s.id === id)?.label;
  const btn = useRef<HTMLButtonElement>(null);
  // Focused by hand: WebKit doesn't focus clicked buttons, and the keys must come here.
  const listen = (why = "") => {
    btn.current?.focus();
    setPicking(true);
    setTaken(why);
  };
  const stop = () => {
    setPicking(false);
    setTaken("");
  };
  // Another shortcut may have taken the default since: then Reset says so and listens for other keys instead.
  const reset = () => {
    const by = usedBy(DEFAULTS[id], id, keys);
    if (by) listen(`${showKeys(DEFAULTS[id])} is ${by}`);
    else setKeys(id, "");
  };
  return (
    <>
      {keys[id] !== DEFAULTS[id] && (
        <button className="btn btn-ghost btn-sm" aria-label={`Reset ${label} to ${showKeys(DEFAULTS[id])}`} onClick={reset}>
          Reset
        </button>
      )}
      <button
        ref={btn}
        data-keys-input
        className="keys-input"
        aria-pressed={picking}
        aria-label={picking ? taken || `Press the new keys for ${label}` : `${label}: ${showKeys(keys[id])}. Press to change`}
        onClick={() => listen()}
        onBlur={stop}
        onKeyDown={(e) => {
          if (!picking) return;
          // Kept here: Esc would also close the menu this can sit in.
          if (e.key === "Escape") {
            e.stopPropagation();
            return stop();
          }
          const combo = comboOf(e.nativeEvent);
          if (!combo) return;
          e.preventDefault();
          const by = usedBy(combo, id, keys);
          if (by) return setTaken(`${showKeys(combo)} is ${by}`);
          setKeys(id, combo);
          stop();
        }}
      >
        {picking ? <span className={taken ? "keys-taken" : "keys-wait"}>{taken || "Press keys…"}</span> : <Keys keys={keys[id]} />}
      </button>
    </>
  );
}

/** Every shortcut by group, each changed in place, then the keys the app keeps as they are. */
function ShortcutsSection() {
  const keys = useKeys();
  const setKeys = useSetKeys();
  const changed = SHORTCUTS.filter((s) => keys[s.id] !== DEFAULTS[s.id]);
  // Zoom is the desktop app's: a browser has its own.
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))].filter((g) => isLocal || g !== "Window");
  const row = (key: string, label: string, hint: string | undefined, keysEl: ReactNode) => (
    <li key={key} className="list-row">
      <span className="col grow" style={{ gap: 2 }}>
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      {keysEl}
    </li>
  );
  return (
    <>
      <div className="anim-head">
        <div className="col page-intro" style={{ gap: 6 }}>
          <h1>Keyboard shortcuts</h1>
          <p className="muted" style={{ margin: 0 }}>For every project. Click a shortcut, then press the new keys: they need Ctrl, Alt or ⌘. Esc keeps the one it has.</p>
          <p className="hint" style={{ margin: 0 }}>In a terminal, Ctrl or Alt with a letter stays the shell's, like Ctrl+W to delete a word: add Shift to use such a shortcut from there. In a text box, the arrows move the caret.</p>
        </div>
        <button className="btn" style={{ margin: "0 0 0 auto" }} disabled={!changed.length} onClick={() => changed.forEach((s) => setKeys(s.id, ""))}>
          Reset all
        </button>
      </div>
      {groups.map((g) => (
        <section key={g} className="section">
          <h2>{g}</h2>
          <ul className="list keys-list">{SHORTCUTS.filter((s) => s.group === g).map((s) => row(s.id, s.label, s.hint, <KeysButton id={s.id} />))}</ul>
        </section>
      ))}
      <section className="section">
        <h2>Built in</h2>
        <ul className="list keys-list">{BUILT_IN.map((b) => row(b.label, b.label, b.hint, <Keys keys={b.keys} />))}</ul>
      </section>
    </>
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

type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };

/** "Sign in with GitHub / Azure DevOps / GitLab": show a code, open the provider's page to enter it, poll until it hands over a token.
 * `params`: a self-managed GitLab's server and OAuth app. */
export function DeviceSignIn({ method, name, site, params, onDone }: { method: "github" | "azure" | "gitlab"; name: string; site: string; params?: Record<string, string>; onDone?: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState<DeviceCode | null>(null);
  const start = useAction<DeviceCode>(`${method}.signInStart`);
  // A ref: a new callback each render must not restart the polling.
  const done = useRef(onDone);
  done.current = onDone;
  // A string, so a new params object on each render doesn't restart the polling.
  const extra = JSON.stringify(params ?? {});
  useEffect(() => {
    if (!code) return;
    let interval = code.interval;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const deadline = Date.now() + code.expiresIn * 1000;
    const tick = async () => {
      try {
        const r = await rpc<{ status: string; interval?: number; user?: string | null }>(`${method}.signInPoll`, { ...JSON.parse(extra), deviceCode: code.deviceCode });
        if (stopped) return;
        if (r.status === "done") {
          setCode(null);
          qc.invalidateQueries({ queryKey: ["config"] });
          qc.invalidateQueries({ queryKey: ["prs"] });
          toast(r.user ? `Signed in to ${name} as ${r.user}` : `${name} connected`, "ok");
          done.current?.();
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
  }, [code, qc, method, name, extra]);

  if (!code)
    return (
      <div>
        <button
          className="btn btn-primary"
          disabled={start.isPending}
          onClick={() =>
            start.mutate(JSON.parse(extra), {
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
      <span className="hint">
        Enter this code on {site} (copied to your clipboard), then authorize Gitnetix.{method === "github" && " For organization repos, click Grant or Request next to each organization."} Waiting…
      </span>
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
      </ul>
    </>
  );
}

/** The rows of a list for each git host: sign in, or paste a token. Also in the first-run setup. */
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
          {on && user && (
            // The OAuth app's page on github.com (client ID from crates/core/src/providers/github_auth.rs), where each organization grants or requests access.
            <button className="btn" data-tip="Grant or request access to your organizations' repos" onClick={() => openExternal("https://github.com/settings/connections/applications/Ov23liwKERI7iyaZzzMf")}>
              Organization access
            </button>
          )}
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
      <HostRow kind="gitlab" cfg={cfg} />
      <HostRow kind="bitbucket" cfg={cfg} />
      <HostRow kind="gitea" cfg={cfg} />
    </>
  );
}

/** Where a Gitea server sends the browser back after sign-in; any port is allowed on 127.0.0.1. */
const GITEA_REDIRECT = "http://127.0.0.1/callback";

/** What differs between the GitLab, Bitbucket and Gitea rows. */
const HOSTS = {
  gitlab: {
    name: "GitLab",
    server: "https://gitlab.example.com",
    token: "Personal access token with the api scope.",
    app: "Register it on your server under Edit profile › Applications: untick Confidential, tick Device authorization grant and the api scope (any redirect URI).",
  },
  bitbucket: {
    name: "Bitbucket",
    server: "",
    token: "API token with the read:user, read:repository, read:pullrequest and write:pullrequest scopes.",
    app: "",
  },
  gitea: {
    name: "Gitea",
    server: "https://gitea.example.com",
    token: "Access token with read and write on repository and read on user.",
    app: "Register it on your server under Settings › Applications › OAuth2 applications, Confidential client unticked, with this redirect URI:",
  },
} as const;

/** A GitLab, Bitbucket or Gitea row: sign in, or paste a token. GitLab and Gitea also on your own server, Gitea always. */
function HostRow({ kind, cfg }: { kind: keyof typeof HOSTS; cfg: Config }) {
  const h = cfg.integrations[kind];
  const meta = HOSTS[kind];
  const [open, setOpen] = useState(kind === "gitea");
  const [server, setServer] = useState(h.url ?? "");
  const [clientId, setClientId] = useState(h.clientId ?? "");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const save = useAction("integrations.save", { invalidate: [["config"], ["prs"]], success: `${meta.name} connected` });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["prs"]], success: `${meta.name} disconnected` });
  const url = server.trim().replace(/\/+$/, "");
  const app = clientId.trim();
  // gitlab.com and bitbucket.org have built-in apps; a server of your own needs one registered there.
  const own = kind !== "bitbucket" && !!url;
  const site = url.replace(/^https?:\/\//, "");
  return (
    <li className="col" style={{ padding: 16, gap: 12 }}>
      <div className="row">
        <span className="col grow" style={{ gap: 2 }}>
          <span style={{ fontWeight: 500 }}>{meta.name}</span>
          <span className={h.connected ? "c-add" : "faint"} style={{ fontSize: 12 }}>
            {h.connected ? `${h.user ? `Signed in as ${h.user}` : "Connected · token in keychain"}${h.url ? ` · ${h.url.replace(/^https?:\/\//, "")}` : ""}` : "Not connected"}
          </span>
        </span>
        {h.connected && <button className="btn" onClick={() => disc.mutate({ kind })}>Disconnect</button>}
      </div>
      {!h.connected && kind === "gitlab" && !own && <DeviceSignIn method="gitlab" name="GitLab" site="GitLab" />}
      {!h.connected && kind === "bitbucket" && <BrowserSignIn method="bitbucket" label="Sign in with Bitbucket" name="Bitbucket" keys={["config", "prs"]} />}
      {!h.connected &&
        (!open ? (
          <div>
            <button className="btn btn-sm" onClick={() => setOpen(true)}>{kind === "gitlab" ? "Use a self-managed GitLab or a personal access token" : "Use an API token"}</button>
          </div>
        ) : (
          <div className="col" style={{ gap: 10 }}>
            {kind !== "bitbucket" && (
              <div className="field">
                <label htmlFor={`${kind}-server`}>
                  Server {kind === "gitlab" && <span className="faint" style={{ fontWeight: 400 }}>self-managed only</span>}
                </label>
                <input id={`${kind}-server`} className="input mono" placeholder={meta.server} value={server} onChange={(e) => setServer(e.target.value)} />
              </div>
            )}
            {own && (
              <div className="field">
                <label htmlFor={`${kind}-app`}>OAuth application ID <span className="faint" style={{ fontWeight: 400 }}>to sign in</span></label>
                <input id={`${kind}-app`} className="input mono" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                <span className="hint">
                  {meta.app}
                  {kind === "gitea" && (
                    <>
                      {" "}
                      <button type="button" className="btn btn-ghost btn-sm mono" data-tip="Copy" onClick={() => copyToClipboard(GITEA_REDIRECT)}>{GITEA_REDIRECT}</button>
                    </>
                  )}
                </span>
              </div>
            )}
            {own && app && (kind === "gitlab" ? (
              <DeviceSignIn method="gitlab" name="GitLab" site={site} params={{ url, clientId: app }} />
            ) : (
              <BrowserSignIn method="gitea" label="Sign in with Gitea" name="Gitea" keys={["config", "prs"]} params={{ url, clientId: app }} />
            ))}
            <form
              className="col"
              style={{ gap: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({ kind, token, config: { url, email } }, { onSuccess: () => setToken("") });
              }}
            >
              {kind === "bitbucket" && (
                <div className="field">
                  <label htmlFor="bitbucket-email">Atlassian account email</label>
                  <input id="bitbucket-email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <span className="hint">Leave it empty for a workspace or repository access token.</span>
                </div>
              )}
              <div className="field">
                <label htmlFor={`${kind}-token`}>{kind === "bitbucket" ? "API token" : "Personal access token"}</label>
                <input id={`${kind}-token`} type="password" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} />
                <span className="hint">{meta.token}</span>
              </div>
              <div>
                <button className="btn btn-primary" disabled={!token.trim() || (kind === "gitea" && !url) || save.isPending}>Connect</button>
              </div>
            </form>
          </div>
        ))}
    </li>
  );
}

/** Browser sign-in: the host (Atlassian, Trello, Asana, Bitbucket, Gitea) redirects back to a listener the app opens on this computer.
 * `keys`: queries to refetch once signed in; `params`: a Gitea server and OAuth app. */
function BrowserSignIn({ method, label, name, keys, params, onDone }: { method: "jira" | "trello" | "asana" | "bitbucket" | "gitea"; label: string; name: string; keys: string[]; params?: Record<string, string>; onDone?: () => void }) {
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const attempt = useRef(0);
  const signIn = async () => {
    const mine = ++attempt.current;
    setWaiting(true);
    try {
      const { url } = await rpc<{ url: string }>(`${method}.signInStart`, params);
      await openExternal(url);
      const r = await rpc<{ user?: string | null }>(`${method}.signInFinish`);
      if (mine !== attempt.current) return;
      for (const key of keys) qc.invalidateQueries({ queryKey: [key] });
      toast(r.user ? `Signed in to ${name} as ${r.user}` : `${name} connected`, "ok");
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
      <button type="button" className="btn btn-primary" onClick={() => signIn()}>{label}</button>
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
          <ConnStatus auth={conn ? auth : undefined} />
        </span>
        {conn ? (
          <button type="button" className="btn" onClick={() => disc.mutate({ kind: "jira", id: conn.id })}>Disconnect</button>
        ) : (
          onDone && <button type="button" className="btn" onClick={onDone}>Cancel</button>
        )}
      </div>
      {!conn && !tokenMode && <BrowserSignIn method="jira" label="Sign in with Atlassian" name="Jira" keys={["config", "tickets", "jiraAuth"]} onDone={onDone} />}
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

/** A saved connection's state, from its check: the saved token may have expired or been revoked since. */
function ConnStatus({ auth }: { auth?: UseQueryResult<{ user?: string | null }> }) {
  const line = (cls: string, text: string) => <span className={cls} style={{ fontSize: 12 }}>{text}</span>;
  if (!auth) return line("faint", "Not connected");
  if (auth.isPending) return line("faint", "Checking…");
  if (auth.isError) return line("c-del", `Not signed in · ${auth.error.message}`);
  return line("c-add", auth.data?.user ? `Connected as ${auth.data.user}` : "Connected");
}

type Place = { id: string; name: string };
/** A Trello or Asana connection's check: who is signed in, and the boards or workspaces to pick from. */
type Account = { user?: string | null; boards?: Place[]; workspaces?: Place[] };
type TrackerConn = { id: string; repos: string[]; oauth?: boolean } & Record<string, unknown>;
type Field = { key: string; label: string; hint?: string };
type Kind = {
  kind: "trello" | "asana";
  title: string;
  /** What signing in can be replaced with. */
  tokenName: string;
  token: string;
  tokenHint: string;
  /** Asked with the token. */
  fields: Field[];
  /** Config keys the pickers set once the account is known, with their empty values. */
  place: Record<string, string | string[]>;
  name: (c: TrackerConn, a?: Account) => string;
};
const TRELLO: Kind = {
  kind: "trello",
  title: "Trello",
  tokenName: "an API key and token",
  token: "Token",
  tokenHint: "From the Token link next to the API key",
  fields: [{ key: "apiKey", label: "API key", hint: "trello.com/power-ups/admin › your Power-Up › API key" }],
  place: { boards: [] },
  name: (c, a) => {
    const ids = (c.boards as string[] | undefined) ?? [];
    if (ids.length > 1) return `${ids.length} boards`;
    return ids.length ? (a?.boards?.find((b) => b.id === ids[0])?.name ?? "1 board") : "My cards";
  },
};
const ASANA: Kind = {
  kind: "asana",
  title: "Asana",
  tokenName: "a personal access token",
  token: "Personal access token",
  tokenHint: "Create one at app.asana.com/0/my-apps",
  fields: [],
  place: { workspaceGid: "", projects: [] },
  name: (c, a) => a?.workspaces?.find((w) => w.id === c.workspaceGid)?.name ?? `workspace ${c.workspaceGid}`,
};

type Places = Record<string, string | string[]>;

/** The Asana workspace, then which of its projects to show tasks from. */
function AsanaPlaces({ conn, uid, workspaces, place, setPlace }: { conn: TrackerConn; uid: string; workspaces: Place[]; place: Places; setPlace: (p: Places) => void }) {
  const ws = place.workspaceGid as string;
  const projects = useQuery({
    queryKey: ["asanaProjects", conn.id, ws],
    queryFn: () => rpc<Place[]>("asana.projects", { id: conn.id, workspace: ws }),
    staleTime: 5 * 60_000,
  });
  return (
    <>
      <div className="field">
        <label htmlFor={`${uid}-ws`}>Workspace</label>
        <MenuChoice id={`${uid}-ws`} className="select menu-select" label="Workspace" value={ws} options={workspaces.map((w) => ({ value: w.id, label: w.name }))} onChange={(v) => setPlace({ ...place, workspaceGid: v, projects: [] })} />
      </div>
      {projects.data ? (
        <Checks
          label="Asana projects"
          hint="None ticked = the tasks assigned to you in this workspace."
          options={projects.data.map((p) => ({ value: p.id, label: p.name }))}
          value={place.projects as string[]}
          onChange={(v) => setPlace({ ...place, projects: v })}
        />
      ) : projects.isError ? (
        <span className="c-del" style={{ fontSize: 12 }}>{projects.error.message}</span>
      ) : (
        <span className="faint" style={{ fontSize: 12 }}>Loading Asana projects…</span>
      )}
    </>
  );
}

/** One Trello or Asana connection, or the form adding a new one when `conn` is missing: signed in in the browser like Jira, or with a token. */
function TrackerConnection({ cfg, k, conn, onDone }: { cfg: Config; k: Kind; conn?: TrackerConn; onDone?: () => void }) {
  const save = useAction<{ user?: string | null }>("integrations.save", { invalidate: [["config"], ["tickets"], [`${k.kind}Auth`]], success: (r) => (r.user ? `Connected as ${r.user}` : "Saved") });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["tickets"]] });
  const auth = useQuery({
    queryKey: [`${k.kind}Auth`, conn?.id],
    queryFn: () => rpc<Account>(`integrations.check${k.title}`, { id: conn!.id }),
    enabled: !!conn,
    retry: false,
    staleTime: 60_000,
  });
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(k.fields.map((x) => [x.key, String(conn?.[x.key] ?? "")])));
  const [place, setPlace] = useState<Places>(() => Object.fromEntries(Object.entries(k.place).map(([key, empty]) => [key, (conn?.[key] as string | string[] | undefined) ?? empty])));
  const [token, setToken] = useState("");
  const [repos, setRepos] = useState(conn?.repos ?? []);
  const oauth = !!conn?.oauth;
  const [tokenMode, setTokenMode] = useState(!!conn && !oauth);
  const uid = `${k.kind}-${conn?.id ?? "new"}`;
  const canSave = tokenMode ? k.fields.every((x) => f[x.key]) && (!!token || (!!conn && !oauth)) : !!conn;
  return (
    <form
      className="col card"
      style={{ padding: 16, gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        // No token keeps the saved one, or the sign-in.
        save.mutate({ kind: k.kind, token: tokenMode ? token : undefined, config: { id: conn?.id ?? null, repos, ...f, ...place } }, { onSuccess: () => onDone?.() });
      }}
    >
      <div className="row">
        <span className="col grow" style={{ gap: 2 }}>
          <span style={{ fontWeight: 500 }}>{conn ? `${k.title} · ${k.name(conn, auth.data)}` : `New ${k.title} connection`}</span>
          <ConnStatus auth={conn ? auth : undefined} />
        </span>
        {conn ? (
          <button type="button" className="btn" onClick={() => disc.mutate({ kind: k.kind, id: conn.id })}>Disconnect</button>
        ) : (
          onDone && <button type="button" className="btn" onClick={onDone}>Cancel</button>
        )}
      </div>
      {!conn && !tokenMode && <BrowserSignIn method={k.kind} label={`Sign in with ${k.title}`} name={k.title} keys={["config", "tickets", `${k.kind}Auth`]} onDone={onDone} />}
      {tokenMode && (
        <>
          {k.fields.map((x) => (
            <Fragment key={x.key}>{input(`${uid}-${x.key}`, x.label, f[x.key], (v) => setF({ ...f, [x.key]: v }), { hint: x.hint })}</Fragment>
          ))}
          {input(`${uid}-token`, k.token, token, setToken, { type: "password", hint: conn && !oauth ? "Empty = keep the saved one" : k.tokenHint })}
        </>
      )}
      {conn &&
        auth.data &&
        (k.kind === "trello" ? (
          <Checks
            label="Trello boards"
            hint="None ticked = the cards assigned to you, on every board."
            options={(auth.data.boards ?? []).map((b) => ({ value: b.id, label: b.name }))}
            value={place.boards as string[]}
            onChange={(v) => setPlace({ ...place, boards: v })}
          />
        ) : (
          <AsanaPlaces conn={conn} uid={uid} workspaces={auth.data.workspaces ?? []} place={place} setPlace={setPlace} />
        ))}
      {(conn || tokenMode) && <RepoChecks cfg={cfg} value={repos} onChange={setRepos} />}
      {!tokenMode && (
        <div>
          <button type="button" className="btn btn-sm" onClick={() => setTokenMode(true)}>
            {oauth ? `Replace with ${k.tokenName}` : `Use ${k.tokenName} instead`}
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

/** The Jira, Trello and Asana connections, each kind followed by the form adding one. Also a step of the first-run setup. */
export function TicketConnections({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  return (
    <>
      <ConnectionList items={i.jira} add="Add a Jira connection" row={(c, onDone) => <JiraConnection cfg={cfg} conn={c} onDone={onDone} />} />
      <ConnectionList items={i.trello} add="Add a Trello connection" row={(c, onDone) => <TrackerConnection cfg={cfg} k={TRELLO} conn={c} onDone={onDone} />} />
      <ConnectionList items={i.asana} add="Add an Asana connection" row={(c, onDone) => <TrackerConnection cfg={cfg} k={ASANA} conn={c} onDone={onDone} />} />
    </>
  );
}

function Integrations({ cfg }: { cfg: Config }) {
  return (
    <>
      <div className="col page-intro" style={{ gap: 6 }}>
        <h1>Jira, Trello, Asana</h1>
        <p className="muted" style={{ margin: 0 }}>Tickets show in Tickets, linked to their branch and release. Tokens go to your OS keychain.</p>
      </div>
      <TicketConnections cfg={cfg} />
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
