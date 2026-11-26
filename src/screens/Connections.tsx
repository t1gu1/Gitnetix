import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { renderSVG } from "uqr";

import { useAction } from "../api/hooks";
import { allowFirewall, companionInfo, isLocal, openExternal, rpc, type CompanionInfo } from "../api/transport";
import type { Config, JiraConn } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { SheetBox, SheetKey, SheetLabel, SheetLink, SheetRow, SheetSwitch } from "../components/Sheet";
import { Confirm } from "../components/ui";
import { copyToClipboard, toast } from "../lib/toast";

const JIRA_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";

/* Git providers, ticket trackers and the companion: the settings pages that connect Gitnetix to other services and devices. */

type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };

/** "Sign in with GitHub / Azure DevOps / GitLab": show a code, open the provider's page to enter it, poll until it hands over a token.
 * `params`: a self-managed GitLab's server and OAuth app. `small`: a row's short Sign in, whose code then shows on a line of its own under the row. */
export function DeviceSignIn({ method, name, site, params, onDone, small }: { method: "github" | "azure" | "gitlab" | "account"; name: string; site: string; params?: Record<string, string>; onDone?: () => void; small?: boolean }) {
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
          type="button"
          className={small ? "btn btn-sm conn-go" : "btn btn-primary"}
          aria-label={small ? `Sign in with ${name}` : undefined}
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
          {start.isPending ? `Opening ${site}…` : small ? "Sign in" : `Sign in with ${name}`}
        </button>
      </div>
    );
  return (
    <div className="col conn-wait" style={{ gap: 8 }}>
      <span className="hint">
        Enter this code on {site} (copied to your clipboard), then authorize Gitnetix.{method === "github" && " For organization repos, click Grant or Request next to each organization."} Waiting…
      </span>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn mono" style={{ fontSize: 18, letterSpacing: 2 }} title="Copy code" onClick={() => copyToClipboard(code.userCode)}>
          {code.userCode}
        </button>
        <button type="button" className="btn" onClick={() => openExternal(code.verificationUri)}>Open {site}</button>
        <button type="button" className="btn" onClick={() => setCode(null)}>Cancel</button>
      </div>
    </div>
  );
}

/** A page's first line: what the page is for, and where its tokens go. */
function PageLead({ children }: { children: ReactNode }) {
  return (
    <div className="conn-lead">
      <p className="hint">{children}</p>
      <span className="hint conn-keychain">
        <Icon name="lock" size={12} />
        Tokens stay in your OS keychain
      </span>
    </div>
  );
}

/** A connected account's head: its name, who is signed in, and Disconnect. Its facts follow as rows. */
function Account({ name, user, onDisconnect }: { name: string; user?: string | null; onDisconnect: () => void }) {
  return (
    <div className="conn-acct">
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <strong>{name}</strong>
        <span className="c-add conn-who ellipsis">{user ? `Signed in as ${user}` : "Connected · token in keychain"}</span>
      </span>
      <button className="btn btn-sm" onClick={onDisconnect}>Disconnect</button>
    </div>
  );
}

/** A setting changed under its row: its value, then its editor while the row is open. */
function EditRow({ label, tip, value, none, mono, open, onToggle, children }: { label: string; tip?: string; value?: ReactNode; none?: boolean; mono?: boolean; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <button type="button" className="sheet-row sheet-link" data-tip={tip} aria-expanded={open} onClick={onToggle}>
        <SheetKey label={label} tip={tip} />
        {value != null && <span className={`sheet-v${mono ? " mono" : ""}${none ? " none" : ""}`}>{value}</span>}
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      </button>
      {open && children}
    </>
  );
}

/** A form's last line: Cancel, then its one loud button. */
function Acts({ label, disabled, onCancel }: { label: string; disabled: boolean; onCancel?: () => void }) {
  return (
    <div className="conn-acts">
      {onCancel && (
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      )}
      <button className="btn btn-primary" disabled={disabled}>
        {label}
      </button>
    </div>
  );
}

export function GitProviders({ cfg }: { cfg: Config }) {
  return (
    <>
      <PageLead>Used to open PRs, read reviews and publish releases.</PageLead>
      <GitHosts cfg={cfg} />
      <p className="hint conn-note">GitHub issues and project boards come through the GitHub account: no ticket tracker needed.</p>
    </>
  );
}

const HOST_KINDS = ["github", "azure", "gitlab", "bitbucket", "gitea"] as const;

/** Every git host in one box: the connected accounts with their facts, then the others with their sign-in. Also in the first-run setup. */
export function GitHosts({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  const on = (k: (typeof HOST_KINDS)[number]) => (k === "github" ? i.githubConnected : k === "azure" ? i.azureConnected : i[k].connected);
  const connected = HOST_KINDS.filter(on);
  const others = HOST_KINDS.filter((k) => !on(k));
  const host = (k: (typeof HOST_KINDS)[number]) => (k === "github" ? <GitHubHost key={k} cfg={cfg} /> : k === "azure" ? <AzureHost key={k} cfg={cfg} /> : <HostRow key={k} kind={k} cfg={cfg} />);
  const col = (label: string, list: (typeof HOST_KINDS)[number][]) =>
    list.length > 0 && (
      <div className="sheet-col">
        <SheetLabel>{label}</SheetLabel>
        {list.map(host)}
      </div>
    );
  return (
    <SheetBox className="conn-box" title="Accounts" sub={`${connected.length} of ${HOST_KINDS.length} connected`}>
      <div className={`sheet-cols${connected.length && others.length ? "" : " conn-solo"}`}>
        {col("Connected", connected)}
        {col("Not connected", others)}
      </div>
    </SheetBox>
  );
}

/** GitHub: signed in with a device code, or a personal access token (with a GitHub Enterprise server's API base). */
function GitHubHost({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  const [token, setToken] = useState("");
  const [api, setApi] = useState(i.githubApi ?? "");
  const [open, setOpen] = useState(false);
  const save = useAction("integrations.save", { invalidate: [["config"], ["prs"]], success: "GitHub connected" });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["prs"]], success: "GitHub disconnected" });
  const on = i.githubConnected;
  const form = (
    <form
      className="conn-open conn-fields"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ kind: "github", token, config: { apiBase: api } }, { onSuccess: () => { setToken(""); setOpen(false); } });
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
      <Acts label={on ? "Save" : "Connect"} disabled={!token && !on} onCancel={() => setOpen(false)} />
    </form>
  );
  if (on)
    return (
      <>
        <Account name="GitHub" user={i.githubUser} onDisconnect={() => disc.mutate({ kind: "github" })} />
        <SheetRow label="API base" tip="GitHub Enterprise only: the API address of your own server. Empty for github.com.">
          <span className={`sheet-v mono${i.githubApi ? "" : " none"}`}>{i.githubApi || "api.github.com"}</span>
        </SheetRow>
        {i.githubUser && (
          // The OAuth app's page on github.com (client ID from crates/core/src/providers/github_auth.rs), where each organization grants or requests access.
          <button type="button" className="sheet-row sheet-link" data-tip="Grant or request access to your organizations' repos" onClick={() => openExternal("https://github.com/settings/connections/applications/Ov23liwKERI7iyaZzzMf")}>
            <SheetKey label="Organization access" tip="Grant or request access to your organizations' repos" />
            <span className="sheet-v">On github.com</span>
            <Icon name="external" size={12} />
          </button>
        )}
        <EditRow label="Replace with a personal access token" open={open} onToggle={() => setOpen(!open)}>
          {form}
        </EditRow>
      </>
    );
  return (
    <>
      <div className="sheet-row conn-row">
        <SheetKey label="GitHub" />
        <button type="button" className="btn btn-sm" aria-expanded={open} data-tip="Use a personal access token or GitHub Enterprise" onClick={() => setOpen(!open)}>
          Token or Enterprise
        </button>
        <DeviceSignIn small method="github" name="GitHub" site="GitHub" />
      </div>
      {open && form}
    </>
  );
}

/** Azure DevOps: signed in with a device code, or a personal access token and the organization. */
function AzureHost({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  const [token, setToken] = useState("");
  const [org, setOrg] = useState("");
  const [open, setOpen] = useState(false);
  const save = useAction("integrations.save", { invalidate: [["config"]], success: "Azure DevOps connected" });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"]], success: "Azure DevOps disconnected" });
  const on = i.azureConnected;
  const form = (
    <form
      className="conn-open conn-fields"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ kind: "azure", token, config: { org } }, { onSuccess: () => { setToken(""); setOpen(false); } });
      }}
    >
      <div className="field">
        <label htmlFor="az-token">{on ? "Replace token" : "Personal access token"}</label>
        <input id="az-token" type="password" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} />
        <span className="hint">Token with the Code (Read &amp; write) scope, to read and act on pull requests.</span>
      </div>
      <div className="field">
        <label htmlFor="az-org">Organization</label>
        <input id="az-org" className="input mono" placeholder="https://dev.azure.com/your-org" value={org} onChange={(e) => setOrg(e.target.value)} />
      </div>
      <Acts label={on ? "Save" : "Connect"} disabled={!token || !org.trim() || save.isPending} onCancel={() => setOpen(false)} />
    </form>
  );
  if (on)
    return (
      <>
        <Account name="Azure DevOps" user={i.azureUser} onDisconnect={() => disc.mutate({ kind: "azure" })} />
        <EditRow label="Replace with a personal access token" open={open} onToggle={() => setOpen(!open)}>
          {form}
        </EditRow>
      </>
    );
  return (
    <>
      <div className="sheet-row conn-row">
        <SheetKey label="Azure DevOps" />
        <button type="button" className="btn btn-sm" aria-expanded={open} data-tip="Use a personal access token" onClick={() => setOpen(!open)}>
          Token
        </button>
        <DeviceSignIn small method="azure" name="Azure DevOps" site="Microsoft" />
      </div>
      {open && form}
    </>
  );
}

/** Where a Gitea server sends the browser back after sign-in; any port is allowed on 127.0.0.1. */
const GITEA_REDIRECT = "http://127.0.0.1/callback";

/** What differs between the GitLab, Bitbucket and Gitea rows; `alt`: the button opening the token form, and its full sentence. */
const HOSTS = {
  gitlab: {
    alt: ["Self-managed or token", "Use a self-managed GitLab or a personal access token"],
    name: "GitLab",
    server: "https://gitlab.example.com",
    token: "Personal access token with the api scope.",
    app: "Register it on your server under Edit profile › Applications: untick Confidential, tick Device authorization grant and the api scope (any redirect URI).",
  },
  bitbucket: {
    alt: ["API token", "Use an API token"],
    name: "Bitbucket",
    server: "",
    token: "API token with the read:user, read:repository, read:pullrequest and write:pullrequest scopes.",
    app: "",
  },
  gitea: {
    alt: ["Server and token", "Your own Gitea server, then sign in or paste a token"],
    name: "Gitea",
    server: "https://gitea.example.com",
    token: "Access token with read and write on repository and read on user.",
    app: "Register it on your server under Settings › Applications › OAuth2 applications, Confidential client unticked, with this redirect URI:",
  },
} as const;

/** A GitLab, Bitbucket or Gitea account: sign in, or paste a token. GitLab and Gitea also on your own server, Gitea always. */
function HostRow({ kind, cfg }: { kind: keyof typeof HOSTS; cfg: Config }) {
  const h = cfg.integrations[kind];
  const meta = HOSTS[kind];
  const [open, setOpen] = useState(false);
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
  if (h.connected)
    return (
      <>
        <Account name={meta.name} user={h.user} onDisconnect={() => disc.mutate({ kind })} />
        {h.url && (
          <SheetRow label="Server">
            <span className="sheet-v mono">{h.url.replace(/^https?:\/\//, "")}</span>
          </SheetRow>
        )}
      </>
    );
  return (
    <>
      <div className="sheet-row conn-row">
        <SheetKey label={meta.name} />
        <button type="button" className="btn btn-sm" aria-expanded={open} data-tip={meta.alt[1]} onClick={() => setOpen(!open)}>
          {meta.alt[0]}
        </button>
        {kind === "gitlab" && !own && <DeviceSignIn small method="gitlab" name="GitLab" site="GitLab" />}
        {kind === "bitbucket" && <BrowserSignIn small method="bitbucket" label="Sign in with Bitbucket" name="Bitbucket" keys={["config", "prs"]} />}
      </div>
      {open && (
        <div className="conn-open conn-fields">
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
            className="conn-fields"
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
            <Acts label="Connect" disabled={!token.trim() || (kind === "gitea" && !url) || save.isPending} onCancel={() => setOpen(false)} />
          </form>
        </div>
      )}
    </>
  );
}

/** Browser sign-in: the host (Atlassian, Trello, Asana, Linear, Bitbucket, Gitea) redirects back to a listener the app opens on this computer.
 * `keys`: queries to refetch once signed in; `params`: a Gitea server and OAuth app; `small`: a row's short Sign in. */
function BrowserSignIn({ method, label, name, keys, params, onDone, small }: { method: "jira" | "trello" | "asana" | "linear" | "bitbucket" | "gitea"; label: string; name: string; keys: string[]; params?: Record<string, string>; onDone?: () => void; small?: boolean }) {
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
    <div className="row conn-wait" style={{ gap: 10 }}>
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
      <button type="button" className={small ? "btn btn-sm conn-go" : "btn btn-primary"} aria-label={small ? label : undefined} onClick={() => signIn()}>{small ? "Sign in" : label}</button>
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
      <input className="input" type="search" data-no-mic aria-label={`Search ${label.toLowerCase()}`} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 6 }} />
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

/** One Jira connection as a box of rows, each changed under it, or the box adding a new one when `conn` is missing. */
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
  const saved = () => ({ baseUrl: conn?.baseUrl ?? "", email: conn?.email ?? "", jql: conn?.jql ?? "", token: "", projects: conn?.projects ?? [], repos: conn?.repos ?? [] });
  const [f, setF] = useState(saved);
  const oauth = !!conn?.cloudId;
  const [tokenMode, setTokenMode] = useState(!!conn && !oauth);
  // The row being changed; opening another one drops what was left unsaved in this one.
  const [edit, setEdit] = useState<string | null>(null);
  const openEdit = (key: string) => {
    setF(saved());
    setEdit(edit === key ? null : key);
  };
  const tokens = tokenMode || edit === "token";
  const filters = { jql: f.jql || null, projects: f.projects, repos: f.repos };
  const submit = () =>
    save.mutate(
      tokens
        ? { kind: "jira", token: f.token, config: { id: conn?.id ?? null, baseUrl: f.baseUrl, email: f.email, ...filters } }
        : { kind: "jira", config: { id: conn!.id, baseUrl: conn!.baseUrl, cloudId: conn!.cloudId, ...filters } },
      { onSuccess: () => { setEdit(null); onDone?.(); } },
    );
  const canSave = tokens ? !!f.baseUrl && !!f.email && (!!f.token || (!!conn && !oauth)) : !!conn;
  const id = conn?.id ?? "new";
  const tokenFields = (
    <>
      {input(`jr-url-${id}`, "Site", f.baseUrl, (v) => setF({ ...f, baseUrl: v }), { ph: "https://yourteam.atlassian.net" })}
      {input(`jr-email-${id}`, "Account email", f.email, (v) => setF({ ...f, email: v }))}
      {input(`jr-token-${id}`, "API token", f.token, (v) => setF({ ...f, token: v }), { type: "password", hint: <>Create one at {tokensLink} (scoped tokens need read:jira-user and read:jira-work)</> })}
      {save.isError && (
        <span className="c-del" style={{ fontSize: 12 }}>
          {save.error.message} · Make sure you did create the API token here: {tokensLink}
        </span>
      )}
    </>
  );
  const jql = input(`jr-jql-${id}`, "JQL (optional)", f.jql, (v) => setF({ ...f, jql: v }), { ph: "project = ATL AND statusCategory != Done" });
  const repos = <RepoChecks cfg={cfg} value={f.repos} onChange={(v) => setF({ ...f, repos: v })} />;
  const form = (children: ReactNode) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {children}
    </form>
  );
  if (!conn)
    return (
      <SheetBox className="conn-box" title="Jira" sub="Not connected" aside={onDone && <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>}>
        {form(
          <div className="conn-new conn-fields">
            <p className="hint">Issues from your Jira site: all of them, or a JQL query and the projects you pick.</p>
            {!tokenMode ? (
              <div className="conn-signin">
                <BrowserSignIn method="jira" label="Sign in with Atlassian" name="Jira" keys={["config", "tickets", "jiraAuth"]} onDone={onDone} />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTokenMode(true)}>Use an API token instead</button>
              </div>
            ) : (
              <>
                {tokenFields}
                {jql}
                {repos}
                <Acts label="Connect" disabled={!canSave || save.isPending} />
              </>
            )}
          </div>,
        )}
      </SheetBox>
    );
  const site = conn.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const acts = <Acts label="Save" disabled={!canSave || save.isPending} onCancel={() => openEdit(edit!)} />;
  return (
    <SheetBox className="conn-box" title="Jira" sub={<ConnStatus auth={auth} />} aside={<button type="button" className="btn btn-sm" onClick={() => disc.mutate({ kind: "jira", id: conn.id })}>Disconnect</button>}>
      {form(
        <div className="sheet-col conn-col">
          <SheetRow label="Site">
            <span className="sheet-v mono">{site}</span>
          </SheetRow>
          <SheetRow label="Signed in with">
            <span className="sheet-v">{oauth ? "Atlassian" : "API token"}</span>
          </SheetRow>
          <EditRow label="JQL" tip="Optional Jira query that narrows the tickets" value={conn.jql || "None"} none={!conn.jql} mono={!!conn.jql} open={edit === "jql"} onToggle={() => openEdit("jql")}>
            <div className="conn-open conn-fields">
              {jql}
              {acts}
            </div>
          </EditRow>
          <EditRow label="Jira projects" tip="None ticked = every project this account can see" value={conn.projects.join(", ") || "All"} none={!conn.projects.length} open={edit === "projects"} onToggle={() => openEdit("projects")}>
            <div className="conn-open conn-fields">
              {projects.data ? (
                <Checks label="Jira projects" hint="None ticked = every project this account can see." options={projects.data.map((p) => ({ value: p.key, label: `${p.name} (${p.key})` }))} value={f.projects} onChange={(v) => setF({ ...f, projects: v })} />
              ) : (
                <span className="faint" style={{ fontSize: 12 }}>{auth.isError ? "Sign in again to pick Jira projects." : "Loading Jira projects…"}</span>
              )}
              {acts}
            </div>
          </EditRow>
          {cfg.projects.length > 0 && (
            <EditRow label="Show in" tip="The Gitnetix projects whose Tickets show this site's issues" value={shownIn(cfg, conn.repos)} none={!conn.repos.length} open={edit === "repos"} onToggle={() => openEdit("repos")}>
              <div className="conn-open conn-fields">
                {repos}
                {acts}
              </div>
            </EditRow>
          )}
          <EditRow label={oauth ? "Replace with an API token" : "Change the API token"} open={edit === "token"} onToggle={() => openEdit("token")}>
            <div className="conn-open conn-fields">
              {tokenFields}
              {acts}
            </div>
          </EditRow>
        </div>,
      )}
    </SheetBox>
  );
}

/** The Gitnetix projects a connection shows in, by name; none picked is every project. */
const shownIn = (cfg: Config, ids: string[]) => (ids.length ? ids.map((id) => cfg.projects.find((p) => p.id === id)?.name ?? id).join(", ") : "Every project");

/** A saved connection's state, from its check: the saved token may have expired or been revoked since. */
function ConnStatus({ auth }: { auth?: UseQueryResult<{ user?: string | null }> }) {
  const line = (cls: string, text: string) => <span className={cls} style={{ fontSize: 12 }}>{text}</span>;
  if (!auth) return line("faint", "Not connected");
  if (auth.isPending) return line("faint", "Checking…");
  if (auth.isError) return line("c-del", `Not signed in · ${auth.error.message}`);
  return line("c-add", auth.data?.user ? `Connected as ${auth.data.user}` : "Connected");
}

type Place = { id: string; name: string };
/** A Trello, Asana or Linear connection's check: who is signed in, and the boards, workspaces or teams to pick from. */
type Account = { user?: string | null; boards?: Place[]; workspaces?: Place[]; teams?: Place[]; org?: string | null };
type TrackerConn = { id: string; repos: string[]; oauth?: boolean } & Record<string, unknown>;
type Field = { key: string; label: string; hint?: string };
type Kind = {
  kind: "trello" | "asana" | "linear";
  title: string;
  /** What its connection shows, in the box before signing in. */
  desc: string;
  /** Its browser sign-in; none = only the token. */
  signIn?: "trello" | "asana" | "linear";
  /** What signing in can be replaced with. */
  tokenName: string;
  token: string;
  tokenHint: string;
  /** Asked with the token. */
  fields: Field[];
  /** Config keys the pickers set once the account is known, with their empty values. */
  place: Record<string, string | string[]>;
  /** Places ticked among the account's (Trello boards, Linear teams); none = Asana's own pickers. */
  pick?: { key: "boards" | "teams"; label: string; hint: string };
  name: (c: TrackerConn, a?: Account) => string;
};
const TRELLO: Kind = {
  kind: "trello",
  title: "Trello",
  desc: "Cards assigned to you, or from the boards you pick.",
  signIn: "trello",
  tokenName: "an API key and token",
  token: "Token",
  tokenHint: "From the Token link next to the API key",
  fields: [{ key: "apiKey", label: "API key", hint: "trello.com/power-ups/admin › your Power-Up › API key" }],
  place: { boards: [] },
  pick: { key: "boards", label: "Trello boards", hint: "None ticked = the cards assigned to you, on every board." },
  name: (c, a) => {
    const ids = (c.boards as string[] | undefined) ?? [];
    if (ids.length > 1) return `${ids.length} boards`;
    return ids.length ? (a?.boards?.find((b) => b.id === ids[0])?.name ?? "1 board") : "My cards";
  },
};
const ASANA: Kind = {
  kind: "asana",
  title: "Asana",
  desc: "Tasks assigned to you in a workspace, or from the projects you pick.",
  signIn: "asana",
  tokenName: "a personal access token",
  token: "Personal access token",
  tokenHint: "Create one at app.asana.com/0/my-apps",
  fields: [],
  place: { workspaceGid: "", projects: [] },
  name: (c, a) => a?.workspaces?.find((w) => w.id === c.workspaceGid)?.name ?? `workspace ${c.workspaceGid}`,
};
const LINEAR: Kind = {
  kind: "linear",
  title: "Linear",
  desc: "Issues from every team, or from the teams you pick.",
  signIn: "linear",
  tokenName: "a personal API key",
  token: "Personal API key",
  tokenHint: "Create one at linear.app/settings/account/security",
  fields: [],
  place: { teams: [] },
  pick: { key: "teams", label: "Linear teams", hint: "None ticked = every team." },
  name: (_, a) => a?.org ?? "workspace",
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

/** One Trello, Asana or Linear connection as a box of rows, each changed under it, or the box adding a new one when `conn` is missing: signed in in the browser like Jira, or with a token. */
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
  const savedFields = () => Object.fromEntries(k.fields.map((x) => [x.key, String(conn?.[x.key] ?? "")]));
  const savedPlace = (): Places => Object.fromEntries(Object.entries(k.place).map(([key, empty]) => [key, (conn?.[key] as string | string[] | undefined) ?? empty]));
  const [f, setF] = useState<Record<string, string>>(savedFields);
  const [place, setPlace] = useState<Places>(savedPlace);
  const [token, setToken] = useState("");
  const [repos, setRepos] = useState(conn?.repos ?? []);
  const oauth = !!conn?.oauth;
  const [tokenMode, setTokenMode] = useState(!k.signIn || (!!conn && !oauth));
  // The row being changed; opening another one drops what was left unsaved in this one.
  const [edit, setEdit] = useState<string | null>(null);
  const openEdit = (key: string) => {
    setF(savedFields());
    setPlace(savedPlace());
    setRepos(conn?.repos ?? []);
    setToken("");
    setEdit(edit === key ? null : key);
  };
  const tokens = tokenMode || edit === "token";
  const uid = `${k.kind}-${conn?.id ?? "new"}`;
  const canSave = tokens ? k.fields.every((x) => f[x.key]) && (!!token || (!!conn && !oauth)) : !!conn;
  const tokenName = k.tokenName.replace(/^an? /, "");
  const tokenFields = (
    <>
      {k.fields.map((x) => (
        <Fragment key={x.key}>{input(`${uid}-${x.key}`, x.label, f[x.key], (v) => setF({ ...f, [x.key]: v }), { hint: x.hint })}</Fragment>
      ))}
      {input(`${uid}-token`, k.token, token, setToken, { type: "password", hint: conn && !oauth ? "Empty = keep the saved one" : k.tokenHint })}
    </>
  );
  const repoChecks = <RepoChecks cfg={cfg} value={repos} onChange={setRepos} />;
  const form = (children: ReactNode) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // No token keeps the saved one, or the sign-in.
        save.mutate({ kind: k.kind, token: tokens ? token : undefined, config: { id: conn?.id ?? null, repos, ...f, ...place } }, { onSuccess: () => { setEdit(null); onDone?.(); } });
      }}
    >
      {children}
    </form>
  );
  if (!conn)
    return (
      <SheetBox className="conn-box" title={k.title} sub="Not connected" aside={onDone && <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>}>
        {form(
          <div className="conn-new conn-fields">
            <p className="hint">{k.desc}</p>
            {!tokenMode && k.signIn ? (
              <div className="conn-signin">
                <BrowserSignIn method={k.signIn} label={`Sign in with ${k.title}`} name={k.title} keys={["config", "tickets", `${k.kind}Auth`]} onDone={onDone} />
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTokenMode(true)}>Use {k.tokenName} instead</button>
              </div>
            ) : (
              <>
                {tokenFields}
                {repoChecks}
                <Acts label="Connect" disabled={!canSave || save.isPending} />
              </>
            )}
          </div>,
        )}
      </SheetBox>
    );
  const acts = <Acts label="Save" disabled={!canSave || save.isPending} onCancel={() => openEdit(edit!)} />;
  const a = auth.data;
  const pickValue = k.pick && (k.pick.key === "boards" ? k.name(conn, a) : (conn.teams as string[]).length ? (conn.teams as string[]).map((id) => a?.teams?.find((t) => t.id === id)?.name ?? id).join(", ") : "Every team");
  const asanaValue = k.kind === "asana" && `${k.name(conn, a)}${(conn.projects as string[]).length ? ` · ${(conn.projects as string[]).length} projects` : ""}`;
  return (
    <SheetBox className="conn-box" title={k.title} sub={<ConnStatus auth={auth} />} aside={<button type="button" className="btn btn-sm" onClick={() => disc.mutate({ kind: k.kind, id: conn.id })}>Disconnect</button>}>
      {form(
        <div className="sheet-col conn-col">
          {k.kind === "linear" && a?.org && (
            <SheetRow label="Workspace">
              <span className="sheet-v">{a.org}</span>
            </SheetRow>
          )}
          <SheetRow label="Signed in with">
            <span className="sheet-v">{oauth ? k.title : tokenName[0].toUpperCase() + tokenName.slice(1)}</span>
          </SheetRow>
          {k.pick && (
            <EditRow label={k.pick.label} tip={k.pick.hint} value={pickValue} none={!(conn[k.pick.key] as string[]).length} open={edit === "pick"} onToggle={() => openEdit("pick")}>
              <div className="conn-open conn-fields">
                {a ? (
                  <Checks label={k.pick.label} hint={k.pick.hint} options={(a[k.pick.key] ?? []).map((b) => ({ value: b.id, label: b.name }))} value={place[k.pick.key] as string[]} onChange={(v) => setPlace({ ...place, [k.pick!.key]: v })} />
                ) : (
                  <span className="faint" style={{ fontSize: 12 }}>{auth.isError ? `Sign in again to pick ${k.pick.label.toLowerCase()}.` : "Loading…"}</span>
                )}
                {acts}
              </div>
            </EditRow>
          )}
          {asanaValue && (
            <EditRow label="Tasks from" tip="The Asana workspace, then which of its projects to show tasks from" value={asanaValue} open={edit === "place"} onToggle={() => openEdit("place")}>
              <div className="conn-open conn-fields">
                {a ? <AsanaPlaces conn={conn} uid={uid} workspaces={a.workspaces ?? []} place={place} setPlace={setPlace} /> : <span className="faint" style={{ fontSize: 12 }}>{auth.isError ? "Sign in again to pick a workspace." : "Loading…"}</span>}
                {acts}
              </div>
            </EditRow>
          )}
          {cfg.projects.length > 0 && (
            <EditRow label="Show in" tip={`The Gitnetix projects whose Tickets show these ${k.kind === "trello" ? "cards" : k.kind === "asana" ? "tasks" : "issues"}`} value={shownIn(cfg, conn.repos)} none={!conn.repos.length} open={edit === "repos"} onToggle={() => openEdit("repos")}>
              <div className="conn-open conn-fields">
                {repoChecks}
                {acts}
              </div>
            </EditRow>
          )}
          <EditRow label={oauth ? `Replace with ${k.tokenName}` : `Change the ${tokenName}`} open={edit === "token"} onToggle={() => openEdit("token")}>
            <div className="conn-open conn-fields">
              {tokenFields}
              {acts}
            </div>
          </EditRow>
        </div>,
      )}
    </SheetBox>
  );
}

/** What "Another …" adds beside a tracker's connections. */
const ANOTHER = { jira: "Another Jira site", trello: "Another Trello connection", asana: "Another Asana workspace", linear: "Another Linear workspace" };

/** The Jira, Trello, Asana and Linear connections, a box each, a box to sign in to a tracker with none, then buttons adding another. Also a step of the first-run setup. */
export function TicketConnections({ cfg }: { cfg: Config }) {
  const i = cfg.integrations;
  const [adding, setAdding] = useState<string | null>(null);
  const list = <T extends { id: string }>(kind: keyof typeof ANOTHER, items: T[], box: (c?: T, onDone?: () => void) => ReactNode) => (
    <>
      {items.map((c) => (
        <Fragment key={c.id}>{box(c)}</Fragment>
      ))}
      {(adding === kind || items.length === 0) && box(undefined, items.length ? () => setAdding(null) : undefined)}
    </>
  );
  const more = (Object.keys(ANOTHER) as (keyof typeof ANOTHER)[]).filter((kind) => i[kind].length > 0 && adding !== kind);
  return (
    <>
      <div className="conn-grid">
        {list("jira", i.jira, (c, onDone) => <JiraConnection cfg={cfg} conn={c} onDone={onDone} />)}
        {list("trello", i.trello, (c, onDone) => <TrackerConnection cfg={cfg} k={TRELLO} conn={c} onDone={onDone} />)}
        {list("asana", i.asana, (c, onDone) => <TrackerConnection cfg={cfg} k={ASANA} conn={c} onDone={onDone} />)}
        {list("linear", i.linear, (c, onDone) => <TrackerConnection cfg={cfg} k={LINEAR} conn={c} onDone={onDone} />)}
      </div>
      {more.length > 0 && (
        <div className="conn-adds">
          {more.map((kind) => (
            <button key={kind} className="btn btn-sm" onClick={() => setAdding(kind)}>
              <Icon name="plus" size={12} />
              {ANOTHER[kind]}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** `open`: opens Git providers, where the GitHub account behind GitHub issues is. */
export function Integrations({ cfg, open }: { cfg: Config; open: (id: string) => void }) {
  const i = cfg.integrations;
  return (
    <>
      <PageLead>Tickets show in Tickets, linked to their branch and release.</PageLead>
      <TicketConnections cfg={cfg} />
      <div className="sheet-box conn-gh">
        <SheetLink label="GitHub issues" tip="GitHub issues need no connection here: a project whose origin is on GitHub shows its issues, with their project board column and labels, through the GitHub account under Git providers." value={i.githubConnected ? `Through ${i.githubUser ?? "your GitHub account"}` : "Through Git providers"} none={!i.githubConnected} onClick={() => open("git")} />
      </div>
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
          {/* Relaunching a dev build ends `bun run app`'s Vite server, and the new window would stay blank. */}
          {head(<>Phones can't connect yet: Gitnetix isn't listening on port <span className="mono">{s.port}</span> with these settings. {import.meta.env.DEV ? "Restart bun run app" : "Restart Gitnetix"} to apply them. If this stays after a restart, another app is using the port.</>)}
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

/** The companion API's switches and pairing token beside the phone card, then the MCP server: read only from a phone or browser paired with this computer. */
export function Companion({ cfg }: { cfg: Config }) {
  const [regenerating, setRegenerating] = useState(false);
  const set = useAction<{ restartRequired: boolean }>("server.set", { invalidate: [["config"]], success: "Saved — restart Gitnetix to apply" });
  const s = cfg.server;
  const mcp = "claude mcp add gitnetix -- gitnetix-mcp";
  return (
    <>
      <p className="hint conn-intro">The companion API exposes every Gitnetix action over HTTP. The mobile app uses it to manage releases, agents, PRs and tickets, and the MCP server uses it so AI agents can drive Gitnetix.</p>
      {!isLocal && <div className="note-box">You are connected remotely. Change these on the computer.</div>}
      <div className="conn-grid">
        <SheetBox className="conn-box" title="Companion API" sub={!s.enabled ? "Off" : s.lan ? "On, your network" : "On, this computer only"}>
          <div className="sheet-col">
            <SheetLabel>Access</SheetLabel>
            <label className="sheet-row" data-tip="The phone and the MCP server reach Gitnetix through it">
              <SheetKey label="API" tip="The phone and the MCP server reach Gitnetix through it" />
              <span className="sheet-v mono">port {s.port}</span>
              <input type="checkbox" role="switch" className="switch" aria-label={`Companion API on port ${s.port}`} checked={s.enabled} disabled={!isLocal} onChange={() => set.mutate({ enabled: !s.enabled })} />
            </label>
            <SheetSwitch
              label="Devices on my network"
              tip="Allow devices on my network (needed for the phone). Phones connect over HTTPS with a certificate made on this computer, so their browser warns once and then allows voice dictation. The pairing token protects every call. Anyone with the token on the same network can run Git commands and agents on this computer: turn it on only on networks you trust, or use a VPN like Tailscale."
              on={s.lan}
              disabled={!isLocal}
              flip={() => set.mutate({ lan: !s.lan })}
            />
            {isLocal && (
              <>
                <SheetLabel>Pairing token</SheetLabel>
                {/* Also for scripts and browsers on this computer, which reach 127.0.0.1 without network access. */}
                <SheetRow label="Token" tip="Pairs a phone, a script or a browser with this computer">
                  <span className="sheet-v mono">{s.token.slice(0, 6)}…</span>
                  <button className="btn btn-sm" onClick={() => copyToClipboard(s.token)}>
                    <Icon name="copy" size={12} />
                    Copy
                  </button>
                </SheetRow>
                <SheetRow label="Paired devices" tip="A new token disconnects every paired device once Gitnetix restarts">
                  <button className="btn btn-sm btn-danger" onClick={() => setRegenerating(true)}>New token (unpairs devices)</button>
                </SheetRow>
              </>
            )}
          </div>
          {s.enabled && s.lan && (
            <div className="conn-warn">
              <div className="err-box warn" role="alert">
                Devices on your network can also reach this computer over plain HTTP. Anyone on the network who sees one of those requests can read the pairing token and run commands here. Keep this on only on networks you trust, and turn it off on public or shared Wi-Fi.
              </div>
            </div>
          )}
        </SheetBox>
        {isLocal && <PhoneCard server={s} />}
      </div>
      <SheetBox className="conn-box" title="MCP server" sub="Needs the app running">
        <div className="sheet-col">
          <div className="conn-code">
            <span className="faint">$</span>
            <span className="mono ellipsis grow">{mcp}</span>
            <button className="btn btn-ghost btn-icon btn-sm" aria-label="Copy the command" data-tip="Copy the command" onClick={() => copyToClipboard(mcp)}>
              <Icon name="copy" size={13} />
            </button>
          </div>
          <SheetRow label="Binary" tip="Built next to the app, it speaks MCP over stdio and forwards to the companion API">
            <span className="hint conn-aside">built next to the app, speaks MCP over stdio</span>
            <span className="sheet-v mono">gitnetix-mcp</span>
          </SheetRow>
          <SheetRow label="Tools" tip="Each RPC becomes a tool">
            <span className="sheet-v mono">projects_list, workspace_overview, items_create, agents_start, prs_review…</span>
          </SheetRow>
        </div>
      </SheetBox>
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
