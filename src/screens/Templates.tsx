import { useEffect, useState } from "react";

import { useAction, useConfig, useTemplates } from "../api/hooks";
import type { Template } from "../api/types";
import { Icon } from "../components/Icon";
import { Busy, Header, LANGS, Loading, Seg } from "../components/ui";
import { useNav } from "../lib/nav";

export function Templates() {
  const nav = useNav();
  const q = useTemplates();
  const cfg = useConfig().data;
  const project = cfg?.projects.find((p) => p.id === nav.projectId);
  const [sel, setSel] = useState<string | undefined>();
  const [draft, setDraft] = useState<Template | null>(null);
  const [lang, setLang] = useState("en");
  const [preview, setPreview] = useState<{ output: string; source: string } | null>(null);
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

  if (!q.data) return (<><Header title="AI templates" /><Loading /></>);
  const kind = kinds.find((k) => k.id === draft?.kind);
  const dirty = draft && tpl && JSON.stringify(draft) !== JSON.stringify(tpl);

  const newTemplate = () => {
    const k = draft?.kind ?? "commit";
    save.mutate(
      { template: { id: "", kind: k, name: "New template", scope: "all", isDefault: false, body: "Describe what the AI should write.\n\nWrite the result in {language}.", rules: [], model: null } },
      { onSuccess: (t) => setSel(t.id) },
    );
  };

  return (
    <>
      <Header title="AI templates" sub={project?.name} />
      <div className="body split">
        <nav aria-label="Templates" className="sidenav" data-pane data-active={!sel} style={{ flexBasis: 300 }}>
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
                  {t.isDefault && <span className="tag accent">Default</span>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        {draft && (
          <main className="page" data-pane data-active={!!sel} style={{ padding: 0, display: "flex", flexWrap: "wrap", alignContent: "flex-start" }}>
            <div className="row wrap" style={{ width: "100%", padding: "12px 24px", borderBottom: "1px solid var(--line)" }}>
              <button className="btn btn-sm show-narrow" onClick={() => setSel(undefined)}>
                <Icon name="back" size={12} />
                Templates
              </button>
              <span className="tag">{kind?.label}</span>
              {tpl?.isDefault ? <span className="c-acc" style={{ fontSize: 12 }}>Used by default</span> : null}
              <span className="grow" />
              {!tpl?.isDefault && <button className="btn" onClick={() => setDef.mutate({ id: draft.id })}>Set as default</button>}
              <button className="btn" onClick={() => save.mutate({ template: { ...draft, id: "", name: `${draft.name} (copy)`, isDefault: false } }, { onSuccess: (t) => setSel(t.id) })}>Duplicate</button>
              <button className="btn btn-danger" onClick={() => del.mutate({ id: draft.id }, { onSuccess: () => setSel(undefined) })}>Delete</button>
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
              <div className="field">
                <label htmlFor="tp-model">Model</label>
                <select id="tp-model" className="select" value={draft.model ?? ""} onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}>
                  <option value="">Use AI setup default</option>
                  <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
                  <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
                  <option value="claude-opus-5-5">Claude Opus 5.5</option>
                </select>
                <span className="hint">Overrides the model from task routing in AI setup.</span>
              </div>
            </section>
            <aside aria-label="Preview" className="col" style={{ flex: "1 1 360px", minWidth: 0, gap: 12, padding: 24, borderLeft: "1px solid var(--line)" }}>
              <div className="row">
                <h2 className="grow">Preview</h2>
                <button className="btn" disabled={!nav.projectId || run.isPending || !!dirty} title={dirty ? "Save first" : undefined} onClick={() => run.mutate({ projectId: nav.projectId!, id: draft.id, language: lang }, { onSuccess: setPreview })}>
                  <Busy on={run.isPending}><Icon name="sparkle" size={12} className="c-acc" /></Busy>
                  {preview ? "Run again" : "Run preview"}
                </button>
              </div>
              <div className="row">
                <span className="muted" id="tp-gen-lang">Generate in</span>
                <Seg label="Generate in" value={lang} onChange={setLang} options={LANGS} />
              </div>
              <span className="hint">
                {preview ? <>Ran on <span className="mono">{preview.source}</span>. Nothing is committed or posted.</> : nav.projectId ? "Runs this template on real data from the open project. Nothing is committed or posted." : "Open a project to preview."}
              </span>
              {preview ? <pre className="pre">{preview.output}</pre> : <div className="empty card">No preview yet.</div>}
            </aside>
          </main>
        )}
      </div>
    </>
  );
}
