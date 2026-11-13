import { useState, type CSSProperties, type ReactNode } from "react";

import { useAiCatalog, useAiModels } from "../api/hooks";
import type { ModelInfo, ProviderInfo } from "../api/types";
import { useStored } from "../lib/stored";
import { ContextMenu, SEARCH_ABOVE, type MenuItem } from "./ContextMenu";
import { Icon } from "./Icon";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** "xhigh" reads "XHigh", the others capitalized. */
export const effortLabel = (e: string) => (e === "xhigh" ? "XHigh" : e[0].toUpperCase() + e.slice(1));

/**
 * The efforts `model` takes: its own when the provider lists it, else every level, or none for a provider that takes
 * effort only for listed models (Gemini).
 */
export const effortsFor = (info: ProviderInfo | undefined, models: ModelInfo[], model: string) =>
  models.find((m) => m.id === model)?.efforts ?? (info?.effort ? EFFORTS : []);

/** The effort to keep after picking another model: the same if that model takes it, else its default (""). */
export const fitEffort = (efforts: string[], effort: string) => (efforts.includes(effort) ? effort : "");

/** How an agent's actions get approved: Claude Code's permission modes, "" (Bypass) by default. Others always bypass. */
export const PERMISSIONS = [
  { value: "", label: "Bypass" },
  { value: "auto", label: "Auto-approve" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "cli", label: "Use agent permissions" },
];

/** Provider, model, effort and permission for a new agent session. Empty = the "Free-form agent" routing. */
export type AgentPick = { provider?: string; model?: string; effort?: string; permission?: string };

/** The last pick on a project, kept between sessions. */
export const useAgentPick = (projectId: string) => useStored<AgentPick>(`gnx.agentPick.${projectId}`, {});

/**
 * The agent's provider, model, effort and permissions. `compact` (a prompt bar): one button showing the model and an effort
 * meter, opening every setting as a column of one menu; otherwise a row of fields.
 */
export function AgentPicker({ value: saved, onChange, compact }: { value: AgentPick; onChange: (p: AgentPick) => void; compact?: boolean }) {
  const cat = useAiCatalog();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // The picks made while the menu is open: the next one builds on them, not on a value still being saved.
  const [picked, setPicked] = useState<AgentPick | null>(null);
  const value = picked ?? saved;
  const c = cat.data;
  const route = value.provider ? {} : c?.routing.agent ?? {};
  const provider = value.provider ?? route.provider ?? c?.defaultProvider;
  const listed = useAiModels(provider);
  if (!c || !provider) return null;
  const model = value.model ?? route.model ?? "";
  const effort = value.effort ?? route.effort ?? "";
  // The routing's even with another provider picked: it is a choice about you, not the model.
  const permission = value.permission ?? c.routing.agent?.permission ?? "";
  // Agents only run through a local CLI: one set up that way, or one found on this computer.
  const clis = c.providers.filter((p) => (p.conf ? p.conf.method === "cli" : p.status?.status === "detected") || p.info.id === provider);
  const prov = c.providers.find((p) => p.info.id === provider);
  const set = (patch: AgentPick) => {
    const next = { provider, model, effort, permission, ...patch };
    if (menu) setPicked(next);
    onChange(next);
  };
  const provs = clis.map((p) => ({ value: p.info.id, label: p.info.name }));
  const list = listed.data ?? prov?.info.models ?? [];
  // "Default model" runs the provider's own: its efforts are that model's.
  const fits = (m: string) => effortsFor(prov?.info, list, m || prov?.conf?.model || "");
  const models = [{ value: "", label: "Default model" }, ...list.map((m) => ({ value: m.id, label: m.label }))];
  const efforts = [{ value: "", label: "Default effort" }, ...fits(model).map((x) => ({ value: x, label: effortLabel(x) }))];
  const listsModels = list.length > 0 || listed.isLoading;
  const pickModel = (v: string) => set({ model: v, effort: fitEffort(fits(v), effort) });
  const modelField = <input aria-label="Agent model" className="input mono" style={{ width: 120 }} placeholder="model id" value={model} onChange={(e) => set({ model: e.target.value })} />;
  if (compact) {
    const name = (opts: Option[], v: string) => opts.find((o) => o.value === v)?.label ?? v;
    const col = (heading: string, opts: Option[], cur: string, run: (v: string) => void): (MenuItem | { heading: ReactNode })[] => [
      { heading },
      ...opts.map((o) => ({ id: `${heading}.${o.value}`, label: o.label, icon: null, hint: o.value === cur && <Icon name="check" size={13} />, keep: true, run: () => run(o.value) })),
    ];
    const items = [
      ...col("Agent", provs, provider, (v) => set({ provider: v, model: "" })),
      "sep" as const,
      ...(listsModels ? col("Model", models, model, pickModel) : [{ heading: "Model" }, { heading: modelField }]),
      ...(efforts.length > 1 ? ["sep" as const, ...col("Effort", efforts, effort, (v) => set({ effort: v }))] : []),
      ...(provider === "claude" ? ["sep" as const, ...col("Permissions", PERMISSIONS, permission, (v) => set({ permission: v }))] : []),
    ];
    const level = EFFORTS.indexOf(effort) + 1;
    const summary = [name(provs, provider), model && name(models, model), effort && `${effortLabel(effort)} effort`, provider === "claude" && `${name(PERMISSIONS, permission)} permissions`].filter(Boolean).join(" · ");
    return (
      <>
        <button
          type="button"
          className="picker-act agent-chip"
          aria-haspopup="menu"
          aria-label={`Agent settings: ${summary}`}
          data-tip={summary}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right, y: r.bottom + 2 });
          }}
        >
          <Icon name="sparkle" size={13} className="c-acc" />
          <span className="ellipsis">{model ? name(models, model) : name(provs, provider)}</span>
          {level > 0 && (
            <span className="effort-bars" aria-hidden>
              {EFFORTS.map((x, i) => <i key={x} className={i < level ? "on" : undefined} style={{ height: `${(i + 1) * 20}%` }} />)}
            </span>
          )}
          <Icon name="chevronDown" size={10} />
        </button>
        {menu && <ContextMenu x={menu.x} y={menu.y} alignRight columns label="Agent settings" items={items} onClose={() => (setMenu(null), setPicked(null))} />}
      </>
    );
  }
  const cls = "select menu-select";
  return (
    <div className="row" style={{ gap: 6, margin: 0 }}>
      <MenuChoice className={cls} label="Agent provider" value={provider} options={provs} onChange={(v) => set({ provider: v, model: "" })} />
      {listsModels ? <MenuChoice className={cls} label="Agent model" value={model} options={models} onChange={pickModel} /> : modelField}
      {efforts.length > 1 && <MenuChoice className={cls} label="Agent effort" value={effort} options={efforts} onChange={(v) => set({ effort: v })} />}
      {provider === "claude" && <MenuChoice className={cls} label="Agent permissions" value={permission} options={PERMISSIONS} onChange={(v) => set({ permission: v })} />}
    </div>
  );
}

type Option = { value: string; label: string };

type ChoiceProps = { label: string; value: string; options: Option[]; onChange: (v: string) => void; className?: string; id?: string; style?: CSSProperties; search?: string };

/**
 * A button opening the options as a menu, like a branch's right-click one; `select menu-select` styles it as a form field.
 * `search`: the placeholder of a field filtering the options, in a wider menu (e.g. branches, whose names run long); on by itself for long lists.
 */
export function MenuChoice({ label, value, options, onChange, className = "picker-act", id, style, search }: ChoiceProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        id={id}
        className={className}
        style={style}
        aria-haspopup="menu"
        aria-label={label}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 2 });
        }}
      >
        <span className="ellipsis">{options.find((o) => o.value === value)?.label ?? (value || label)}</span>
        <Icon name="chevronDown" size={10} />
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={label}
          onClose={() => setMenu(null)}
          search={search ?? (options.length > SEARCH_ABOVE ? "Filter" : undefined)}
          items={options.map((o) => ({ id: o.value || "default", label: o.label, icon: null, hint: o.value === value && <Icon name="check" size={13} />, run: () => onChange(o.value) }))}
        />
      )}
    </>
  );
}
