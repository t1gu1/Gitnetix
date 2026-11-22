import { Fragment, useEffect, useState } from "react";

import { useAction, useAiCatalog, useAiModels } from "../api/hooks";
import type { AiCatalog, ConnectMethod } from "../api/types";
import { effortLabel, effortsFor, fitEffort, MenuChoice, PERMISSIONS, takesPermissions, takesUltracode } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { SheetBox, SheetChoice, SheetKey, SheetLabel, SheetRow, tilde } from "../components/Sheet";
import { Loading, Seg } from "../components/ui";
import { toast } from "../lib/toast";

/** Each task, by what it asks of the AI: writing, thinking, or working as an agent. */
const TASKS: [string, [string, string][]][] = [
  [
    "Writing",
    [
      ["commit", "Commit messages"],
      ["branch", "Branch names"],
      ["pr", "PR title & description"],
      ["ticket", "Ticket writing"],
      ["release", "Release notes"],
      ["dictation", "Voice dictation"],
    ],
  ],
  [
    "Thinking",
    [
      ["conflict", "Conflict resolution"],
      ["triage", "Ticket triage"],
      ["analytics", "Sprint questions"],
    ],
  ],
  ["Agents", [["agent", "Free-form agent"]]],
];

const METHOD_TEXT: Record<ConnectMethod, [string, string]> = {
  cli: ["Local CLI", "Uses the CLI installed on this computer and its own sign-in. No key stored in Gitnetix."],
  api: ["API key", "Talks to the provider directly with your key. Billed to your API account."],
};

const ROUTING_TIP = "Which AI handles each job. Every task follows the default AI unless picked here. Agents need a CLI provider.";
const EFFORT_TIP = "Higher effort thinks longer: better for conflicts and agent work, slower for commit messages";

/**
 * AI setup in the settings panel: the providers (each opens its own page), the default AI, and which AI runs each task.
 * `sub`: a provider's id, when its page is the one open; `open` opens it.
 */
export function AISetupPanes({ sub, open }: { sub?: string; open: (id: string, title?: string) => void }) {
  const cat = useAiCatalog();
  if (!cat.data) return <Loading />;
  const c = cat.data;
  if (sub) return c.providers.some((p) => p.info.id === sub) ? <ProviderPage key={sub} cat={c} id={sub} /> : null;
  const connected = c.providers.filter((p) => p.status?.status === "connected").length;
  return (
    <div className="ais-grid">
      <div className="ais-stack">
        <SheetBox title="Providers" sub={`${connected} connected`}>
          <div className="sheet-col">
            {c.providers.map((p) => (
              <button key={p.info.id} type="button" className="sheet-row sheet-link ais-prow" onClick={() => open(`ai:${p.info.id}`, p.info.name)}>
                <span className="mono-badge ais-badge" aria-hidden="true">{p.info.mono}</span>
                <span className="sheet-k">{p.info.name}</span>
                {c.defaultProvider === p.info.id && <span className="tag inv">Default</span>}
                <StatusText s={p.status?.status} method={p.conf?.method} local={p.info.local} />
                <Icon name="chevronRight" size={12} />
              </button>
            ))}
          </div>
        </SheetBox>
        <DefaultBox cat={c} />
        <p className="hint">Connect as many as you like, then choose which one does what in Task routing.</p>
      </div>
      <Routing cat={c} />
    </div>
  );
}

function StatusText({ s, method, local }: { s?: string; method?: ConnectMethod; local: boolean }) {
  if (s === "connected") return <span className="ais-status c-add">{local ? "Running locally" : method === "api" ? "API key" : "Local CLI"}</span>;
  if (s === "detected") return <span className="ais-status c-warn">CLI found · not tested</span>;
  return <span className="ais-status faint">Not connected</span>;
}

/** The default AI, and the model and effort it runs a task with when the task has none of its own. */
function DefaultBox({ cat }: { cat: AiCatalog }) {
  const setDef = useAction("ai.setDefault", { invalidate: [["ai"], ["config"]] });
  const def = cat.providers.find((p) => p.info.id === cat.defaultProvider);
  return (
    <SheetBox title="Default" sub="when a task has no AI of its own">
      <div className="sheet-col">
        <SheetChoice
          label="AI"
          tip="The AI every task runs on unless Task routing picks another"
          value={cat.defaultProvider}
          options={cat.providers.map((p) => ({ value: p.info.id, label: p.info.name }))}
          onChange={(id) => setDef.mutate({ id }, { onSuccess: () => toast(`${cat.providers.find((p) => p.info.id === id)?.info.name ?? id} is now the default AI`, "ok") })}
        />
        {def && <ModelRows key={def.info.id} cat={cat} id={def.info.id} />}
      </div>
    </SheetBox>
  );
}

/** Steps of effort as small bars, the picked one and those under it filled. */
function Pips({ steps, at }: { steps: number; at: number }) {
  return (
    <span className="ais-pips" aria-hidden="true">
      {Array.from({ length: steps }, (_, i) => (
        <i key={i} className={i <= at ? "on" : undefined} />
      ))}
    </span>
  );
}

/** A provider's own model and effort, as rows: what a task without a model of its own runs with. A model keeps an effort it takes. */
function ModelRows({ cat, id }: { cat: AiCatalog; id: string }) {
  const { info, conf } = cat.providers.find((x) => x.info.id === id)!;
  const saveP = useAction("ai.saveProvider", { invalidate: [["ai"], ["config"]] });
  const [model, setModel] = useState(conf?.model ?? info.models[0]?.id ?? "");
  useEffect(() => setModel(conf?.model ?? info.models[0]?.id ?? ""), [conf?.model, info.models]);
  const listed = useAiModels(id);
  const models = listed.data ?? info.models;
  const efforts = effortsFor(info, models, model);
  const effort = conf?.effort ?? "medium";
  const save = (patch: Record<string, unknown>) => saveP.mutate({ id, ...patch });
  // A provider always keeps an effort: a model without the saved one moves to medium, else its lowest.
  const pickModel = (v: string) => {
    setModel(v);
    const fit = effortsFor(info, models, v);
    save(!fit.length || fit.includes(effort) ? { model: v } : { model: v, effort: fit.includes("medium") ? "medium" : fit[0] });
  };
  return (
    <>
      <SheetRow label="Model" tip="Used when a task has no model of its own">
        {models.length > 0 || listed.isLoading ? (
          <MenuChoice
            className="sheet-val"
            alignRight
            label={`${info.name} model`}
            value={model}
            // None picked ("") runs the CLI's own default model, which a list read from the CLI may not hold.
            options={[{ value: "", label: info.models.length ? "Default model" : `${info.name}'s default` }, ...models.map((m) => ({ value: m.id, label: m.label }))]}
            onChange={pickModel}
          />
        ) : (
          <input aria-label={`${info.name} model`} className="input mono ais-input" placeholder={info.local ? "llama3.2" : "model id"} value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => save({ model })} />
        )}
      </SheetRow>
      <SheetRow label="Effort" tip={EFFORT_TIP}>
        {efforts.length ? (
          <>
            <Pips steps={efforts.length} at={efforts.indexOf(effort)} />
            <MenuChoice className="sheet-val" alignRight label={`${info.name} effort`} value={effort} options={[...(efforts.includes(effort) ? [] : [{ value: effort, label: "Default" }]), ...efforts.map((e) => ({ value: e, label: effortLabel(e) }))]} onChange={(v) => save({ effort: v })} />
          </>
        ) : (
          <span className="sheet-v none">Not available for this {info.effort || models.some((m) => m.efforts.length) ? "model" : "provider"}</span>
        )}
      </SheetRow>
    </>
  );
}

/** One provider's page: how Gitnetix connects to it, and the model and effort it runs a task with when the task has none. */
function ProviderPage({ cat, id }: { cat: AiCatalog; id: string }) {
  const { info, status, conf } = cat.providers.find((x) => x.info.id === id)!;
  const inv = [["ai"], ["config"]];
  const saveP = useAction("ai.saveProvider", { invalidate: inv });
  const setDef = useAction("ai.setDefault", { invalidate: inv, success: `${info.name} is now the default AI` });
  const test = useAction<{ ms: number; model: string; reply: string }>("ai.test", { invalidate: inv, success: (r) => `Responded in ${(r.ms / 1000).toFixed(1)} s with ${r.model}` });
  const signIn = useAction("ai.signIn", { success: "Opened a terminal — sign in there, then press Test" });
  const method: ConnectMethod = conf?.method && info.methods.includes(conf.method) ? conf.method : info.methods[0];
  const [key, setKey] = useState("");
  const [url, setUrl] = useState(conf?.baseUrl ?? "");
  const methodText =
    method === "cli" && info.local
      ? `Runs models on this computer through ${info.bin}. Nothing leaves your machine.`
      : method === "api" && id === "gemini"
        ? "Talks to Google's Gemini API with your Gemini API key. Billed to your API account."
        : METHOD_TEXT[method][1];
  return (
    <div className="ais-grid">
      <SheetBox
        title="Connection"
        sub={info.maker}
        aside={cat.defaultProvider === id ? <span className="tag inv">Default AI for every project</span> : <button className="btn btn-sm" onClick={() => setDef.mutate({ id })}>Use as default AI</button>}
      >
        <div className="sheet-col">
          {info.methods.length > 1 && (
            <SheetRow label="Connects with">
              <Seg label="Connection method" value={method} onChange={(m) => saveP.mutate({ id, method: m })} options={info.methods.map((m) => ({ value: m, label: METHOD_TEXT[m][0] }))} />
            </SheetRow>
          )}
          <p className="hint ais-note">{methodText}</p>
          {method === "cli" && (
            <>
              <SheetRow label={status?.cliBin ?? info.bin ?? "CLI"}>
                <span className={`sheet-v${status?.cliPath ? " mono" : " none"}`} title={status?.cliPath ?? undefined}>
                  {status?.cliPath ? tilde(status.cliPath) : "Not found on your PATH"}
                </span>
              </SheetRow>
              {!status?.cliPath && <p className="hint ais-note">Install it, then come back: Gitnetix checks again automatically.</p>}
              {status?.cliBin === "gemini" && (
                <p className="hint ais-note">
                  This is the older Gemini CLI, which works only with a paid Gemini API key. Install Antigravity (<span className="mono">agy</span>) to use your Google account.
                </p>
              )}
              {status?.cliPath && (
                <div className="ais-actions">
                  <button className="btn btn-sm" onClick={() => signIn.mutate({ id })}>Sign in with the CLI</button>
                  <button className="btn btn-sm btn-primary" disabled={test.isPending} onClick={() => test.mutate({ id })}>
                    {test.isPending && <span className="spinner" />}
                    Test connection
                  </button>
                </div>
              )}
              <p className="hint ais-note">Gitnetix runs the CLI in the background for each task and uses its own sign-in.</p>
            </>
          )}
          {method === "api" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveP.mutate({ id, apiKey: key, baseUrl: info.needsUrl ? url : undefined }, { onSuccess: () => { setKey(""); test.mutate({ id }); } });
              }}
            >
              {info.needsUrl && (
                <SheetRow label="Base URL">
                  <input aria-label="Base URL" className="input mono ais-field" placeholder="https://your-endpoint/v1" value={url} onChange={(e) => setUrl(e.target.value)} />
                </SheetRow>
              )}
              <SheetRow label="API key" tip={status?.hasKey ? "Saved in your OS keychain" : undefined}>
                {status?.hasKey && <span className="ais-status c-add">Saved in keychain</span>}
                <input aria-label="API key" type="password" className="input mono ais-field" placeholder={status?.hasKey ? "Paste a new key to replace it" : "Paste your key"} value={key} onChange={(e) => setKey(e.target.value)} />
              </SheetRow>
              <div className="ais-actions">
                <span className="hint grow">Encrypted in your OS keychain. Never written to disk in plain text.</span>
                <button className="btn btn-sm btn-primary" disabled={(!key && !status?.hasKey) || saveP.isPending || test.isPending}>
                  {(saveP.isPending || test.isPending) && <span className="spinner" />}
                  {key ? "Save & test" : "Test"}
                </button>
              </div>
            </form>
          )}
          {status?.status === "connected" && test.data && <p className="hint ais-note">Last test: “{test.data.reply}” in {(test.data.ms / 1000).toFixed(1)} s</p>}
        </div>
      </SheetBox>
      <SheetBox title="Model" sub="when a task has no model of its own">
        <div className="sheet-col">
          <ModelRows cat={cat} id={id} />
        </div>
      </SheetBox>
    </div>
  );
}

/** Which AI, model and effort runs each task, by group; a task left on Default AI follows the default. */
function Routing({ cat }: { cat: AiCatalog }) {
  const set = useAction("ai.setRoute", { invalidate: [["ai"], ["config"]] });
  const usable = cat.providers.filter((p) => p.conf || p.status?.status !== "none");
  const def = cat.defaultProvider;
  const defName = cat.providers.find((p) => p.info.id === def)?.info.name ?? def;
  const reset = useAction("ai.setDefault", { invalidate: [["ai"], ["config"]], success: `Every task now runs on ${defName}` });
  const pinned = TASKS.flatMap(([, tasks]) => tasks).filter(([t]) => (cat.routing[t]?.provider ?? def) !== def).length;
  return (
    <SheetBox
      title="Task routing"
      sub={
        <span className="ais-tipped" data-tip={ROUTING_TIP} tabIndex={0}>
          AI · model · effort
        </span>
      }
      aside={
        pinned > 0 && (
          <button className="btn btn-sm" disabled={reset.isPending} data-tip={`${pinned} task${pinned > 1 ? "s run" : " runs"} on another AI`} onClick={() => reset.mutate({ id: def })}>
            Use {defName} for every task
          </button>
        )
      }
    >
      <div className="sheet-col">
        <p className="hint sheet-lab-tip">{ROUTING_TIP}</p>
        {TASKS.map(([group, tasks]) => (
          <Fragment key={group}>
            <SheetLabel>{group}</SheetLabel>
            {tasks.map(([task, label]) => (
              <RouteRow key={task} cat={cat} task={task} label={label} usable={usable} set={(r) => set.mutate({ task, ...r })} />
            ))}
          </Fragment>
        ))}
      </div>
    </SheetBox>
  );
}

type RouteSet = { provider: string | null; model: string | null; effort: string | null; permission: string | null; ultracode: boolean | null };

/** One task's AI, model and effort, picked in place; the agent's permissions and ultracode under it. The effort menu lists what the model takes. */
function RouteRow({ cat, task, label, usable, set }: { cat: AiCatalog; task: string; label: string; usable: AiCatalog["providers"]; set: (r: RouteSet) => void }) {
  const r = cat.routing[task] ?? {};
  // Every change sends the whole route: one left out would be cleared.
  const put = (x: Partial<RouteSet>) => set({ provider: r.provider ?? null, model: r.model ?? null, effort: r.effort ?? null, permission: r.permission ?? null, ultracode: r.ultracode ?? null, ...x });
  const prov = cat.providers.find((p) => p.info.id === (r.provider ?? cat.defaultProvider));
  const listed = useAiModels(prov?.info.id);
  const models = listed.data ?? prov?.info.models ?? [];
  // No model of its own: the provider's default model runs, with its efforts.
  const fits = (m: string) => effortsFor(prov?.info, models, m || prov?.conf?.model || "");
  const efforts = fits(r.model ?? "");
  // "Claude Haiku 5.5" after "Claude" reads "Haiku 5.5".
  const short = (name: string) => (prov && name.startsWith(`${prov.info.name} `) ? name.slice(prov.info.name.length + 1) : name);
  const follows = !r.provider && !r.model && !r.effort;
  return (
    <>
      <SheetRow label={label} className="ais-route">
        <span className="ais-route-v">
          <MenuChoice
            className={`sheet-val${r.provider ? "" : " ais-unset"}`}
            alignRight
            label={label}
            value={r.provider ?? ""}
            options={[{ value: "", label: "Default AI" }, ...usable.map((p) => ({ value: p.info.id, label: p.info.name }))]}
            onChange={(v) => put({ provider: v || null, model: null })}
          />
          {/* A task on Default AI with nothing of its own reads just that; picking an AI brings its model and effort. */}
          {!follows && (models.length > 0 || listed.isLoading ? (
            <MenuChoice
              className="sheet-val ais-sub"
              alignRight
              label={`${label} model`}
              value={r.model ?? ""}
              options={[{ value: "", label: "default model" }, ...models.map((m) => ({ value: m.id, label: short(m.label) }))]}
              onChange={(v) => put({ model: v || null, effort: fitEffort(fits(v), r.effort ?? "") || null })}
            />
          ) : (
            <input aria-label={`${label} model`} className="input mono ais-input" placeholder="model id" defaultValue={r.model ?? ""} onBlur={(e) => put({ model: e.target.value || null })} />
          ))}
          {!follows && efforts.length > 0 && (
            <MenuChoice
              className="sheet-val ais-sub"
              alignRight
              label={`${label} effort`}
              value={r.effort ?? ""}
              options={[{ value: "", label: "default effort" }, ...efforts.map((e) => ({ value: e, label: e }))]}
              onChange={(v) => put({ effort: v || null })}
            />
          )}
        </span>
      </SheetRow>
      {task === "agent" && takesPermissions(prov?.info.id) && <SheetChoice sub label="Permissions" value={r.permission ?? ""} options={PERMISSIONS} onChange={(v) => put({ permission: v || null })} />}
      {task === "agent" && takesUltracode(prov?.info.id, models, r.model || prov?.conf?.model || "") && (
        <label className="sheet-row sub">
          <SheetKey label="Ultracode" />
          <input type="checkbox" role="switch" className="switch" aria-label={`${label} ultracode`} checked={!!r.ultracode} onChange={() => put({ ultracode: !r.ultracode || null })} />
        </label>
      )}
    </>
  );
}
