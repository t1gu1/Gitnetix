import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import { useAction, useAiCatalog } from "../api/hooks";
import type { AiCatalog, ConnectMethod } from "../api/types";
import { EFFORTS, MenuChoice } from "../components/AgentPicker";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { Header, Loading, Seg } from "../components/ui";

const TASKS: [string, string][] = [
  ["commit", "Commit messages"],
  ["branch", "Branch names"],
  ["pr", "PR title & description"],
  ["release", "Release notes"],
  ["conflict", "Conflict resolution"],
  ["agent", "Free-form agent"],
  ["triage", "Ticket triage"],
];

const METHOD_TEXT: Record<ConnectMethod, [string, string]> = {
  cli: ["Local CLI", "Uses the CLI installed on this computer and its own sign-in. No key stored in Gitnetix."],
  api: ["API key", "Talks to the provider directly with your key. Billed to your API account."],
};

export function AISetup() {
  const cat = useAiCatalog();
  if (!cat.data) return (<><Header title="AI setup" /><Loading /></>);
  const c = cat.data;
  const connected = c.providers.filter((p) => p.status?.status === "connected").length;
  const defName = c.providers.find((p) => p.info.id === c.defaultProvider)?.info.name ?? c.defaultProvider;
  return (
    <>
      <Header title="AI setup" sub={`${connected} connected · default: ${defName}`} />
      <div className="body">
        <AISetupPanes />
      </div>
    </>
  );
}

/** Provider list and detail panes, also shown inside Settings; `top` goes above the detail (e.g. a section picker). */
export function AISetupPanes({ top }: { top?: ReactNode }) {
  const cat = useAiCatalog();
  const [sel, setSel] = useState("claude");
  const navW = usePaneWidth("gnx.pane.ai", 300, 220, 520);
  if (!cat.data) return <Loading />;
  const c = cat.data;
  return (
    <>
      <nav aria-label="AI providers" className="sidenav hide-narrow" style={{ "--sidenav-w": `${navW.width}px` } as CSSProperties}>
        <div className="group-label">Providers</div>
        {c.providers.map((p) => (
          <button key={p.info.id} className="nav-item" style={{ minHeight: 56 }} aria-pressed={p.info.id === sel} onClick={() => setSel(p.info.id)}>
            <span className="mono-badge">{p.info.mono}</span>
            <span className="col" style={{ gap: 2 }}>
              <span className="row" style={{ gap: 6 }}>
                <span style={{ color: "var(--fg)", fontWeight: 500 }}>{p.info.name}</span>
                {c.defaultProvider === p.info.id && <span className="tag accent">Default</span>}
              </span>
              <StatusText s={p.status?.status} method={p.conf?.method} local={p.info.local} />
            </span>
          </button>
        ))}
        <div className="hint" style={{ padding: "12px 10px" }}>Connect as many as you like, then choose which one does what in Task routing.</div>
      </nav>
      <Resizer pane={navW} label="Resize AI providers" />
      <main className="page">
        {top}
        <div className="show-narrow" style={{ marginBottom: 16 }}>
          <label htmlFor="ai-pick" className="sr-only">Provider</label>
          <MenuChoice id="ai-pick" className="select menu-select" style={{ width: "100%" }} label="Provider" value={sel} options={c.providers.map((p) => ({ value: p.info.id, label: p.info.name }))} onChange={setSel} />
        </div>
        <div className="page-inner">
          <ProviderDetail key={sel} cat={c} id={sel} />
          <Routing cat={c} />
        </div>
      </main>
    </>
  );
}

function StatusText({ s, method, local }: { s?: string; method?: ConnectMethod; local: boolean }) {
  if (s === "connected") return <span className="c-add" style={{ fontSize: 12 }}>{local ? "Running locally" : `Connected · ${method === "api" ? "API key" : "local CLI"}`}</span>;
  if (s === "detected") return <span className="c-acc" style={{ fontSize: 12 }}>CLI found · not tested</span>;
  return <span className="faint" style={{ fontSize: 12 }}>Not connected</span>;
}

function ProviderDetail({ cat, id }: { cat: AiCatalog; id: string }) {
  const p = cat.providers.find((x) => x.info.id === id)!;
  const { info, status, conf } = p;
  const inv = [["ai"], ["config"]];
  const saveP = useAction("ai.saveProvider", { invalidate: inv });
  const setDef = useAction("ai.setDefault", { invalidate: inv, success: `${info.name} is now the default AI` });
  const test = useAction<{ ms: number; model: string; reply: string }>("ai.test", { invalidate: inv, success: (r) => `Responded in ${(r.ms / 1000).toFixed(1)} s with ${r.model}` });
  const signIn = useAction("ai.signIn", { success: "Opened a terminal — sign in there, then press Test" });
  const method: ConnectMethod = conf?.method && info.methods.includes(conf.method) ? conf.method : info.methods[0];
  const [key, setKey] = useState("");
  const [model, setModel] = useState(conf?.model ?? info.models[0]?.id ?? "");
  const [url, setUrl] = useState(conf?.baseUrl ?? "");
  useEffect(() => setModel(conf?.model ?? info.models[0]?.id ?? ""), [conf?.model, info.models]);
  const save = (patch: Record<string, unknown>) => saveP.mutate({ id, ...patch });
  const connected = status?.status === "connected";
  return (
    <>
      <div className="row wrap" style={{ gap: 14 }}>
        <span className="mono-badge" style={{ width: 44, height: 44, flexBasis: 44 }}>{info.mono}</span>
        <div className="col grow" style={{ gap: 2 }}>
          <h1>{info.name}</h1>
          <span className="muted" style={{ fontSize: 12.5 }}>{info.maker}</span>
        </div>
        {cat.defaultProvider === id ? (
          <span className="tag accent">Default AI for every project</span>
        ) : (
          <button className="btn" onClick={() => setDef.mutate({ id })}>Use as default AI</button>
        )}
      </div>

      <section className="section">
        <h2>How to connect</h2>
        <div role="radiogroup" aria-label="Connection method" className="col" style={{ gap: 6 }}>
          {info.methods.map((m) => (
            <button key={m} className="radio-card" role="radio" aria-checked={m === method} onClick={() => save({ method: m })}>
              <span className="radio-dot" />
              <span className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 500 }}>{METHOD_TEXT[m][0]}</span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {m === "cli" && info.local ? `Runs models on this computer through ${info.bin}. Nothing leaves your machine.` : METHOD_TEXT[m][1]}
                </span>
              </span>
            </button>
          ))}
        </div>
        {method === "cli" && (
          <div className="col card" style={{ padding: 14, gap: 8 }}>
            <div className="row wrap">
              <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span><span className="mono">{info.bin}</span> {status?.cliPath ? "found" : "not found on your PATH"}</span>
                <span className="hint mono ellipsis">{status?.cliPath ?? "Install it, then come back: Gitnetix checks again automatically."}</span>
              </span>
              {status?.cliPath && <button className="btn" onClick={() => signIn.mutate({ id })}>Sign in with the CLI</button>}
              {status?.cliPath && (
                <button className="btn btn-primary" disabled={test.isPending} onClick={() => test.mutate({ id })}>
                  {test.isPending && <span className="spinner" />}
                  Test connection
                </button>
              )}
            </div>
            <span className="hint">Gitnetix runs the CLI in the background for each task and uses its own sign-in.</span>
          </div>
        )}
        {method === "api" && (
          <form
            className="col card"
            style={{ padding: 14, gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              saveP.mutate({ id, apiKey: key, baseUrl: info.needsUrl ? url : undefined }, { onSuccess: () => { setKey(""); test.mutate({ id }); } });
            }}
          >
            {info.needsUrl && (
              <div className="field">
                <label htmlFor="ai-url">Base URL</label>
                <input id="ai-url" className="input mono" placeholder="https://your-endpoint/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label htmlFor="ai-key">API key {status?.hasKey && <span className="c-add" style={{ fontWeight: 400 }}>saved in keychain</span>}</label>
              <div className="row">
                <input id="ai-key" type="password" className="input mono grow" placeholder={status?.hasKey ? "Paste a new key to replace it" : "Paste your key"} value={key} onChange={(e) => setKey(e.target.value)} />
                <button className="btn btn-primary btn-md" disabled={(!key && !status?.hasKey) || saveP.isPending || test.isPending}>
                  {(saveP.isPending || test.isPending) && <span className="spinner" />}
                  {key ? "Save & test" : "Test"}
                </button>
              </div>
            </div>
            <span className="hint">Encrypted in your OS keychain. Never written to disk in plain text.</span>
          </form>
        )}
        {connected && test.data && <span className="hint">Last test: “{test.data.reply}” in {(test.data.ms / 1000).toFixed(1)} s</span>}
      </section>

      <section className="section">
        <div className="col" style={{ gap: 2 }}>
          <h2>Model</h2>
          <span className="hint">Used when a task has no model of its own.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
          <div className="field">
            <label htmlFor="ai-model">Default model</label>
            {info.models.length > 0 ? (
              <MenuChoice id="ai-model" className="select menu-select" label="Default model" value={model} options={info.models.map((m) => ({ value: m.id, label: m.label }))} onChange={(v) => { setModel(v); save({ model: v }); }} />
            ) : (
              <input id="ai-model" className="input mono" placeholder={info.local ? "llama3.2" : "model id"} value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => save({ model })} />
            )}
          </div>
          <div className="field">
            <span className="flabel" id="ai-effort">Effort</span>
            {info.effort ? (
              <>
                <Seg grid label="Effort" value={conf?.effort ?? "medium"} onChange={(v) => save({ effort: v })} options={EFFORTS.map((e) => ({ value: e, label: e === "xhigh" ? "XHigh" : e[0].toUpperCase() + e.slice(1) }))} />
                <span className="hint">Higher effort thinks longer: better for conflicts and agent work, slower for commit messages.</span>
              </>
            ) : (
              <div className="note-box faint">Not available for this provider</div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}

function Routing({ cat }: { cat: AiCatalog }) {
  const set = useAction("ai.setRoute", { invalidate: [["ai"], ["config"]] });
  const usable = cat.providers.filter((p) => p.conf || p.status?.status !== "none");
  return (
    <section className="section">
      <div className="col" style={{ gap: 2 }}>
        <h2>Task routing</h2>
        <span className="hint">Which AI handles each job. Lighter models for quick jobs, stronger ones where it matters. Agents need a CLI provider.</span>
      </div>
      <ul className="list route-list">
        {TASKS.map(([task, label]) => {
          const r = cat.routing[task] ?? {};
          const prov = cat.providers.find((p) => p.info.id === (r.provider ?? cat.defaultProvider));
          const models = prov?.info.models ?? [];
          return (
            <li key={task} className="list-row wrap" style={{ gap: "8px 12px", paddingBlock: 10 }}>
              <label htmlFor={`rt-${task}`} className="grow route-label" style={{ minWidth: 160 }}>{label}</label>
              <MenuChoice
                id={`rt-${task}`}
                className="select menu-select"
                style={{ height: 32, width: 140 }}
                label={label}
                value={r.provider ?? ""}
                options={[{ value: "", label: "Default AI" }, ...usable.map((p) => ({ value: p.info.id, label: p.info.name }))]}
                onChange={(v) => set.mutate({ task, provider: v || null, model: null, effort: r.effort ?? null })}
              />
              {models.length > 0 ? (
                <MenuChoice
                  className="select menu-select"
                  style={{ height: 32, width: 160 }}
                  label={`${label} model`}
                  value={r.model ?? ""}
                  options={[{ value: "", label: "Provider default" }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
                  onChange={(v) => set.mutate({ task, provider: r.provider ?? null, model: v || null, effort: r.effort ?? null })}
                />
              ) : (
                <input aria-label={`${label} model`} className="input mono" style={{ height: 32, width: 160 }} placeholder="model id" defaultValue={r.model ?? ""} onBlur={(e) => set.mutate({ task, provider: r.provider ?? null, model: e.target.value || null, effort: r.effort ?? null })} />
              )}
              {prov?.info.effort && (
                <MenuChoice
                  className="select menu-select"
                  style={{ height: 32, width: 130 }}
                  label={`${label} effort`}
                  value={r.effort ?? ""}
                  options={[{ value: "", label: "Default effort" }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
                  onChange={(v) => set.mutate({ task, provider: r.provider ?? null, model: r.model ?? null, effort: v || null })}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
