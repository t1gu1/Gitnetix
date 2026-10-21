import { useState } from "react";

import { useAiCatalog } from "../api/hooks";
import { useStored } from "../lib/stored";
import { ContextMenu } from "./ContextMenu";
import { Icon } from "./Icon";

export const EFFORTS = ["low", "medium", "high", "xhigh"];

/** Provider, model and effort for a new agent session. Empty = the "Free-form agent" routing. */
export type AgentPick = { provider?: string; model?: string; effort?: string };

/** The last pick on a project, kept between sessions. */
export const useAgentPick = (projectId: string) => useStored<AgentPick>(`gnx.agentPick.${projectId}`, {});

export function AgentPicker({ value, onChange, compact }: { value: AgentPick; onChange: (p: AgentPick) => void; compact?: boolean }) {
  const cat = useAiCatalog();
  if (!cat.data) return null;
  const c = cat.data;
  const route = value.provider ? {} : c.routing.agent ?? {};
  const provider = value.provider ?? route.provider ?? c.defaultProvider;
  const model = value.model ?? route.model ?? "";
  const effort = value.effort ?? route.effort ?? "";
  // Agents only run through a local CLI: one set up that way, or one found on this computer.
  const clis = c.providers.filter((p) => (p.conf ? p.conf.method === "cli" : p.status?.status === "detected") || p.info.id === provider);
  const prov = c.providers.find((p) => p.info.id === provider);
  const set = (patch: AgentPick) => onChange({ provider, model, effort, ...patch });
  const provs = clis.map((p) => ({ value: p.info.id, label: p.info.name }));
  const models = [{ value: "", label: "Default model" }, ...(prov?.info.models ?? []).map((m) => ({ value: m.id, label: m.label }))];
  const efforts = [{ value: "", label: "Default effort" }, ...EFFORTS.map((x) => ({ value: x, label: x }))];
  const cls = compact ? "picker-act" : "select menu-select";
  return (
    <div className={compact ? "picker-acts" : "row"} style={compact ? undefined : { gap: 6 }}>
      <MenuChoice className={cls} label="Agent provider" value={provider} options={provs} onChange={(v) => set({ provider: v, model: "" })} />
      {prov?.info.models.length ? (
        <MenuChoice className={cls} label="Agent model" value={model} options={models} onChange={(v) => set({ model: v })} />
      ) : (
        <input aria-label="Agent model" className={compact ? "picker-act mono" : "input mono"} style={{ width: 120 }} placeholder="model id" value={model} onChange={(e) => set({ model: e.target.value })} />
      )}
      {prov?.info.effort && <MenuChoice className={cls} label="Agent effort" value={effort} options={efforts} onChange={(v) => set({ effort: v })} />}
    </div>
  );
}

type ChoiceProps = { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; className?: string };

/** A button opening the options as a menu, like a branch's right-click one; `select menu-select` styles it as a form field. */
export function MenuChoice({ label, value, options, onChange, className = "picker-act" }: ChoiceProps) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={className}
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
          items={options.map((o) => ({ id: o.value || "default", label: o.label, icon: null, hint: o.value === value && <Icon name="check" size={13} />, run: () => onChange(o.value) }))}
        />
      )}
    </>
  );
}
