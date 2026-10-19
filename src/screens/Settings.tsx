import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAction, useConfig } from "../api/hooks";
import { companionInfo, isLocal, openExternal, rpc, type CompanionInfo } from "../api/transport";
import type { Config, GitProfile } from "../api/types";
import { Header } from "../components/ui";
import { useNav } from "../lib/nav";
import { copyToClipboard, toast } from "../lib/toast";

const GROUPS: [string, [string, string][]][] = [
  ["General", [["project", "Project"]]],
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
  const cfg = useConfig().data;
  const pick = (id: string) => {
    if (id === "ai") onAi();
    else if (id === "templates") onTemplates();
    else setSec(id);
  };
  return (
    <>
      <nav aria-label="Settings sections" className="sidenav hide-narrow">
        {GROUPS.map(([g, items]) => (
          <div key={g} className="col" style={{ gap: 2 }}>
            <span className="group-label">{g}</span>
            {items.map(([id, label]) => (
              <button key={id} className="nav-item" aria-current={sec === id ? "page" : undefined} onClick={() => pick(id)}>{label}</button>
            ))}
          </div>
        ))}
      </nav>
      <main className="page">
        <div className="show-narrow" style={{ marginBottom: 16 }}>
          <label htmlFor="st-sec" className="sr-only">Section</label>
          <select id="st-sec" className="select" style={{ width: "100%" }} value={sec} onChange={(e) => pick(e.target.value)}>
            {GROUPS.flatMap(([, items]) => items).map(([id, l]) => <option key={id} value={id}>{l}</option>)}
          </select>
        </div>
        {cfg && (
          <div className="page-inner">
            {sec === "project" && <ProjectSection cfg={cfg} />}
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
  if (!p) return <p className="muted">No project open.</p>;
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
      <p className="hint">Generation languages and the Git profile for this project are in the menu.</p>
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

function Profiles({ cfg }: { cfg: Config }) {
  const save = useAction<GitProfile>("profiles.save", { invalidate: [["config"]], success: "Profile saved" });
  const del = useAction("profiles.delete", { invalidate: [["config"]] });
  const [edit, setEdit] = useState<GitProfile | null>(null);
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
            <button className="btn btn-sm btn-danger" onClick={() => del.mutate({ id: p.id })}>Delete</button>
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
    </>
  );
}

type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresIn: number };

/** "Sign in with GitHub": show a code, open github.com to enter it, poll until GitHub hands over a token. */
function GitHubSignIn() {
  const qc = useQueryClient();
  const [code, setCode] = useState<DeviceCode | null>(null);
  const start = useAction<DeviceCode>("github.signInStart");
  useEffect(() => {
    if (!code) return;
    let interval = code.interval;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const deadline = Date.now() + code.expiresIn * 1000;
    const tick = async () => {
      try {
        const r = await rpc<{ status: string; interval?: number; user?: string | null }>("github.signInPoll", { deviceCode: code.deviceCode });
        if (stopped) return;
        if (r.status === "done") {
          setCode(null);
          qc.invalidateQueries({ queryKey: ["config"] });
          qc.invalidateQueries({ queryKey: ["prs"] });
          toast(r.user ? `Signed in to GitHub as ${r.user}` : "GitHub connected", "ok");
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
  }, [code, qc]);

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
          {start.isPending ? "Opening GitHub…" : "Sign in with GitHub"}
        </button>
      </div>
    );
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="hint">Enter this code on GitHub (copied to your clipboard), then authorize Gitnetix. Waiting…</span>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn mono" style={{ fontSize: 18, letterSpacing: 2 }} title="Copy code" onClick={() => copyToClipboard(code.userCode)}>
          {code.userCode}
        </button>
        <button className="btn" onClick={() => openExternal(code.verificationUri)}>Open GitHub</button>
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
  const on = cfg.integrations.githubConnected;
  const user = cfg.integrations.githubUser;
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
          {!on && <GitHubSignIn />}
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
        {["GitLab", "Azure DevOps", "Bitbucket", "Gitea"].map((n) => (
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

function Integrations({ cfg }: { cfg: Config }) {
  const save = useAction("integrations.save", { invalidate: [["config"], ["tickets"]], success: "Saved" });
  const disc = useAction("integrations.disconnect", { invalidate: [["config"], ["tickets"]] });
  const [jira, setJira] = useState({ baseUrl: cfg.integrations.jira?.baseUrl ?? "", email: cfg.integrations.jira?.email ?? "", jql: cfg.integrations.jira?.jql ?? "", token: "" });
  const [trello, setTrello] = useState({ apiKey: cfg.integrations.trello?.apiKey ?? "", boardId: cfg.integrations.trello?.boardId ?? "", token: "" });
  const [asana, setAsana] = useState({ workspaceGid: cfg.integrations.asana?.workspaceGid ?? "", projectGid: cfg.integrations.asana?.projectGid ?? "", token: "" });
  const block = (title: string, kind: string, on: boolean, body: React.ReactNode, onSave: () => void, canSave: boolean) => (
    <form
      className="col card"
      style={{ padding: 16, gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="row">
        <span className="col grow" style={{ gap: 2 }}>
          <span style={{ fontWeight: 500 }}>{title}</span>
          <span className={on ? "c-add" : "faint"} style={{ fontSize: 12 }}>{on ? "Connected" : "Not connected"}</span>
        </span>
        {on && <button type="button" className="btn" onClick={() => disc.mutate({ kind })}>Disconnect</button>}
      </div>
      {body}
      <div>
        <button className="btn btn-primary" disabled={!canSave}>{on ? "Save" : "Connect"}</button>
      </div>
    </form>
  );
  const input = (id: string, label: string, value: string, set: (v: string) => void, opts: { type?: string; ph?: string; hint?: string } = {}) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" type={opts.type ?? "text"} placeholder={opts.ph} value={value} onChange={(e) => set(e.target.value)} />
      {opts.hint && <span className="hint">{opts.hint}</span>}
    </div>
  );
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <h1>Jira, Trello, Asana</h1>
        <p className="muted" style={{ margin: 0 }}>Tickets show in Tickets, linked to their branch and release. Tokens go to your OS keychain.</p>
      </div>
      {block(
        "Jira Cloud",
        "jira",
        !!cfg.integrations.jira,
        <>
          {input("jr-url", "Site", jira.baseUrl, (v) => setJira({ ...jira, baseUrl: v }), { ph: "https://yourteam.atlassian.net" })}
          {input("jr-email", "Account email", jira.email, (v) => setJira({ ...jira, email: v }))}
          {input("jr-token", "API token", jira.token, (v) => setJira({ ...jira, token: v }), { type: "password", hint: "id.atlassian.com › Security › API tokens" })}
          {input("jr-jql", "JQL (optional)", jira.jql, (v) => setJira({ ...jira, jql: v }), { ph: "project = ATL AND statusCategory != Done" })}
        </>,
        () => save.mutate({ kind: "jira", token: jira.token, config: { baseUrl: jira.baseUrl, email: jira.email, jql: jira.jql || null } }),
        !!jira.baseUrl && !!jira.email && (!!jira.token || !!cfg.integrations.jira),
      )}
      {block(
        "Trello",
        "trello",
        !!cfg.integrations.trello,
        <>
          {input("tr-key", "API key", trello.apiKey, (v) => setTrello({ ...trello, apiKey: v }), { hint: "trello.com/power-ups/admin › your Power-Up › API key" })}
          {input("tr-token", "Token", trello.token, (v) => setTrello({ ...trello, token: v }), { type: "password" })}
          {input("tr-board", "Board id (optional)", trello.boardId, (v) => setTrello({ ...trello, boardId: v }), { hint: "Empty = cards assigned to you" })}
        </>,
        () => save.mutate({ kind: "trello", token: trello.token, config: { apiKey: trello.apiKey, boardId: trello.boardId || null } }),
        !!trello.apiKey && (!!trello.token || !!cfg.integrations.trello),
      )}
      {block(
        "Asana",
        "asana",
        !!cfg.integrations.asana,
        <>
          {input("as-token", "Personal access token", asana.token, (v) => setAsana({ ...asana, token: v }), { type: "password" })}
          {input("as-ws", "Workspace gid", asana.workspaceGid, (v) => setAsana({ ...asana, workspaceGid: v }))}
          {input("as-pr", "Project gid (optional)", asana.projectGid, (v) => setAsana({ ...asana, projectGid: v }), { hint: "Empty = tasks assigned to you" })}
        </>,
        () => save.mutate({ kind: "asana", token: asana.token, config: { workspaceGid: asana.workspaceGid, projectGid: asana.projectGid || null } }),
        !!asana.workspaceGid && (!!asana.token || !!cfg.integrations.asana),
      )}
    </>
  );
}

function Companion({ cfg }: { cfg: Config }) {
  const [info, setInfo] = useState<CompanionInfo | null>(null);
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
          Plain HTTP protected by the pairing token. Anyone with the token on the same network can run Git commands and agents on this computer. Turn LAN access on only on networks you trust, or use a VPN like Tailscale.
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
          <div className="row wrap">
            <button className="btn" onClick={() => copyToClipboard(`${host}:${s.port}`)}>Copy address</button>
            <button className="btn" onClick={() => copyToClipboard(s.token)}>Copy token</button>
            <button className="btn btn-danger" onClick={() => set.mutate({ regenerateToken: true })}>New token (unpairs devices)</button>
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
    </>
  );
}
