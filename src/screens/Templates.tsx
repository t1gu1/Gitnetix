import { useEffect, useState, type CSSProperties } from "react";

import { useAction, useConfig, useTemplates } from "../api/hooks";
import type { Template } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { Resizer, usePaneWidth } from "../components/Resizer";
import { Busy, Confirm, LANGS, Loading, RELEASE_LANGS, Seg } from "../components/ui";
import { useNav } from "../lib/nav";

/** Template list and editor panes, also shown inside the menu panel. */
export function TemplatesPanes() {
  const nav = useNav();
  const q = useTemplates();
  const cfg = useConfig().data;
  const project = cfg?.projects.find((p) => p.id === nav.projectId);
  const [sel, setSel] = useState<string | undefined>();
  const navW = usePaneWidth("gnx.pane.templates", 300, 220, 520);
  const [draft, setDraft] = useState<Template | null>(null);
  const [lang, setLang] = useState("en");
  const [preview, setPreview] = useState<{ output: string; source: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const inv = [["templates"], ["config"]];
  const save = useAction<Template>("templates.save", { invalidate: inv, success: "Template saved" });
  const del = useAction("templates.delete", { invalidate: inv, success: "Template deleted" });
  const setDef = useAction("templates.setDefault", { invalidate: inv });
  const run = useAction<{ output: string; source: string }>("templates.preview");

  const list = q.data?.templates ?? [];
  const kinds = q.data?.kinds ?? [];
  const tpl = list.find((t) => t.id === sel) ?? list[0];
  useEffect(() => {
    setDraft(tpl ? structuredClone(tpl) : null);
    setPreview(null);
  }, [tpl?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q.data) return <Loading />;
  const kind = kinds.find((k) => k.id === draft?.kind);
  const isGlobal = draft?.kind === "global";
  const unaffected = new Intl.ListFormat("en", { type: "conjunction" }).format(kinds.filter((k) => k.id !== "global" && !k.globals).map((k) => k.label));
  const dirty = draft && tpl && JSON.stringify(draft) !== JSON.stringify(tpl);

  const newTemplate = () => {
    const k = draft?.kind ?? "commit";
    const body = k === "global" ? "Describe how the AI should write, whatever the template." : "Describe what the AI should write.\n\nWrite the result in {language}.";
    save.mutate(
      { template: { id: "", kind: k, name: "New template", scope: "all", isDefault: k === "global", body, rules: [], model: null } },
      { onSuccess: (t) => setSel(t.id) },
    );
  };

  return (
    <>
      <nav aria-label="Templates" className="sidenav" data-pane data-active={!sel} style={{ "--sidenav-w": `${navW.width}px` } as CSSProperties}>
        <div className="row" style={{ justifyContent: "space-between", padding: "0 6px 6px" }}>
          <span className="faint" style={{ fontSize: 12 }}>{list.length} templates</span>
          <button className="btn btn-sm" onClick={newTemplate}>
            <Icon name="plus" size={12} />
            New template
          </button>
        </div>
        {kinds.map((k) => (
          <div key={k.id} className="col" style={{ gap: 2 }}>
            <span className="group-label">{k.label}</span>
            {list.filter((t) => t.kind === k.id).map((t) => (
              <button key={t.id} className="nav-item" aria-pressed={t.id === tpl?.id} onClick={() => setSel(t.id)}>
                <span className="col grow" style={{ gap: 1 }}>
                  <span>{t.name}</span>
                  <span className="faint" style={{ fontSize: 11.5 }}>{t.scope === "all" ? "All projects" : cfg?.projects.find((p) => p.id === t.scope)?.name ?? "One project"}</span>
                </span>
                {t.kind === "global" ? <span className={t.isDefault ? "tag accent" : "tag"}>{t.isDefault ? "On" : "Off"}</span> : t.isDefault && <span className="tag accent">Default</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <Resizer pane={navW} label="Resize template list" />
      {draft && (
        <main className="page" data-pane data-active={!!sel} style={{ padding: 0, display: "flex", flexWrap: "wrap", alignContent: "flex-start" }}>
          <div className="row wrap" style={{ width: "100%", padding: "12px 24px", borderBottom: "1px solid var(--line)" }}>
            <button className="btn btn-sm show-narrow" onClick={() => setSel(undefined)}>
              <Icon name="back" size={12} />
              Templates
            </button>
            <span className="tag">{kind?.label}</span>
            {isGlobal ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!tpl?.isDefault}
                  disabled={!tpl || save.isPending}
                  onChange={() => {
                    if (!tpl) return;
                    const on = !tpl.isDefault;
                    save.mutate({ template: { ...tpl, isDefault: on } });
                    setDraft({ ...draft, isDefault: on });
                  }}
                />
                <span>On</span>
              </label>
            ) : tpl?.isDefault ? <span className="c-acc" style={{ fontSize: 12 }}>Used by default</span> : null}
            <span className="grow" />
            {!isGlobal && !tpl?.isDefault && <button className="btn" onClick={() => setDef.mutate({ id: draft.id })}>Set as default</button>}
            <button className="btn" onClick={() => save.mutate({ template: { ...draft, id: "", name: `${draft.name} (copy)`, isDefault: false } }, { onSuccess: (t) => setSel(t.id) })}>Duplicate</button>
            <button className="btn btn-danger" onClick={() => setDeleting(true)}>Delete</button>
            <button className="btn btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ template: draft })}>Save</button>
          </div>
          <section aria-label="Editor" className="col" style={{ flex: "1 1 460px", minWidth: 0, gap: 18, padding: 24 }}>
            <div className="field">
              <label htmlFor="tp-name">Name</label>
              <input id="tp-name" className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="field">
              <span className="flabel" id="tp-scope">Applies to</span>
              <Seg
                grid
                label="Applies to"
                value={draft.scope === "all" ? "all" : "project"}
                onChange={(v) => setDraft({ ...draft, scope: v === "all" ? "all" : nav.projectId ?? "all" })}
                options={[{ value: "all", label: "All projects" }, { value: "project", label: `${project?.name ?? "This project"} only` }]}
              />
            </div>
            <div className="field">
              <label htmlFor="tp-body">
                <span>Instructions</span>
                <span className="faint" style={{ fontWeight: 400 }}>{"{language}"} is filled in when you generate</span>
              </label>
              {isGlobal && <span className="hint">While on, these instructions go in front of every other template. Not sent with {unaffected}.</span>}
              {kind && !isGlobal && !kind.globals && <span className="hint">Global skills are not sent with this template.</span>}
              <textarea id="tp-body" className="textarea mono" rows={14} style={{ fontSize: 12.5 }} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="faint" style={{ fontSize: 12 }}>Insert</span>
                {kind?.variables.map((v) => (
                  <button key={v.name} className="btn btn-sm mono" title={v.hint} onClick={() => setDraft({ ...draft, body: draft.body + v.name })}>{v.name}</button>
                ))}
              </div>
            </div>
            {draft.rules.length > 0 && (
              <div className="col" style={{ gap: 4 }}>
                <h2>Rules</h2>
                {draft.rules.map((r, i) =>
                  r.kind === "check" ? (
                    <label key={r.key} className="check">
                      <input type="checkbox" checked={!!r.value} onChange={() => { const rules = [...draft.rules]; rules[i] = { ...r, value: !r.value }; setDraft({ ...draft, rules }); }} />
                      <span>{r.label}</span>
                    </label>
                  ) : (
                    <div key={r.key} className="row" style={{ minHeight: 36 }}>
                      <label htmlFor={`rule-${r.key}`} className="grow">{r.label} <span className="mono faint">{`{${r.key}}`}</span></label>
                      <input id={`rule-${r.key}`} type="number" className="input" style={{ width: 90 }} value={Number(r.value)} onChange={(e) => { const rules = [...draft.rules]; rules[i] = { ...r, value: Number(e.target.value) }; setDraft({ ...draft, rules }); }} />
                    </div>
                  ),
                )}
              </div>
            )}
            {!isGlobal && (
              <div className="field">
                <label htmlFor="tp-model">Model</label>
                <MenuChoice
                  id="tp-model"
                  className="select menu-select"
                  label="Model"
                  value={draft.model ?? ""}
                  options={[
                    { value: "", label: "Use AI setup default" },
                    { value: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
                    { value: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
                    { value: "claude-opus-5-5", label: "Claude Opus 5.5" },
                  ]}
                  onChange={(v) => setDraft({ ...draft, model: v || null })}
                />
                <span className="hint">Overrides the model from task routing in AI setup.</span>
              </div>
            )}
          </section>
          <aside aria-label="Preview" className="col" style={{ flex: "1 1 360px", minWidth: 0, gap: 12, padding: 24, borderLeft: "1px solid var(--line)" }}>
            <div className="row">
              <h2 className="grow">Preview</h2>
              {!isGlobal && (
                <button className="btn" disabled={!nav.projectId || run.isPending || !!dirty} title={dirty ? "Save first" : undefined} onClick={() => run.mutate({ projectId: nav.projectId!, id: draft.id, language: lang === "template" && draft.kind !== "release" ? "en" : lang }, { onSuccess: setPreview })}>
                  <Busy on={run.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
                  {preview ? "Run again" : "Run preview"}
                </button>
              )}
            </div>
            {isGlobal ? (
              <span className="hint">A global skill has no preview of its own. Preview another template to see its output with the global skills that are on.</span>
            ) : (
              <>
                <div className="row">
                  <span className="muted" id="tp-gen-lang">Generate in</span>
                  <Seg label="Generate in" value={lang} onChange={setLang} options={draft.kind === "release" ? RELEASE_LANGS : LANGS} />
                </div>
                <span className="hint">
                  {preview ? <>Ran on <span className="mono">{preview.source}</span>. Nothing is committed or posted.</> : nav.projectId ? "Runs this template on real data from the open project. Nothing is committed or posted." : "Open a project to preview."}
                </span>
                {preview ? <pre className="pre">{preview.output}</pre> : <div className="empty card">No preview yet.</div>}
              </>
            )}
          </aside>
          {deleting && (
            <Confirm
              title="Delete template"
              sub={draft.name}
              action="Delete template"
              busy={del.isPending}
              onBack={() => setDeleting(false)}
              onConfirm={() => del.mutate({ id: draft.id }, { onSuccess: () => { setDeleting(false); setSel(undefined); } })}
            >
              Its prompt and rules are deleted.
            </Confirm>
          )}
        </main>
      )}
    </>
  );
}
