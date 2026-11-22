import { useEffect, useState } from "react";

import { useAction, useConfig, useTemplates } from "../api/hooks";
import type { Template } from "../api/types";
import { MenuChoice } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { PageTools, SheetBox, SheetKey, SheetRow, SheetSwitch } from "../components/Sheet";
import { Busy, Confirm, LANGS, Loading, RELEASE_LANGS, Seg } from "../components/ui";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";

const inv = [["templates"], ["config"]];

/**
 * Templates in the settings panel: a box per job, its templates as rows. The radio picks the one a job uses by default,
 * a global skill switches on and off, and a name opens the template's editor page. `sub`: that template's id, when its page is open.
 */
export function TemplatesPanes({ sub, open, back }: { sub?: string; open: (id: string, title?: string) => void; back: () => void }) {
  const q = useTemplates();
  const cfg = useConfig().data;
  const save = useAction<Template>("templates.save", { invalidate: inv, success: "Template saved" });
  const setDef = useAction("templates.setDefault", { invalidate: inv });
  if (!q.data) return <Loading />;
  if (sub) return <TemplateEditor key={sub} id={sub} open={open} back={back} />;
  const { templates: list, kinds } = q.data;
  const unaffected = new Intl.ListFormat("en", { type: "conjunction" }).format(kinds.filter((k) => k.id !== "global" && !k.globals).map((k) => k.label));
  const scope = (t: Template) => (t.scope === "all" ? "All projects" : (cfg?.projects.find((p) => p.id === t.scope)?.name ?? "One project"));
  const edit = (t: Template) => open(`templates:${t.id}`, t.name);
  const create = (kind: string) => {
    const body = kind === "global" ? "Describe how the AI should write, whatever the template." : "Describe what the AI should write.\n\nWrite the result in {language}.";
    save.mutate({ template: { id: "", kind, name: "New template", scope: "all", isDefault: kind === "global", body, rules: [], model: null } }, { onSuccess: edit });
  };
  const box = (k: (typeof kinds)[number]) => {
    const global = k.id === "global";
    const mine = list.filter((t) => t.kind === k.id);
    return (
      <SheetBox
        key={k.id}
        title={k.label}
        sub={
          global && (
            <span className="ais-tipped" data-tip={`While on, these instructions go in front of every other template. Not sent with ${unaffected}.`} tabIndex={0}>
              in front of every template
            </span>
          )
        }
        aside={
          <button className="btn btn-ghost btn-sm btn-icon" aria-label={`New ${k.label} template`} data-tip="New template" disabled={save.isPending} onClick={() => create(k.id)}>
            <Icon name="plus" size={12} />
          </button>
        }
      >
        <div className="sheet-col" role={global ? undefined : "radiogroup"} aria-label={global ? undefined : `${k.label} used by default`}>
          {mine.map((t) => (
            <div key={t.id} className="sheet-row tpl-row">
              {!global && (
                <label className="check tpl-pick" data-tip={t.isDefault ? "Used by default" : "Use it by default"}>
                  <input type="radio" name={`tpl-${k.id}`} aria-label={`Use ${t.name} by default`} checked={t.isDefault} onChange={() => setDef.mutate({ id: t.id })} />
                </label>
              )}
              <button type="button" className="tpl-open" onClick={() => edit(t)}>
                <span className="sheet-k">{t.name}</span>
                {t.isDefault && !global && <span className="tpl-def">default</span>}
                <span className="tpl-scope">{scope(t)}</span>
                <Icon name="chevronRight" size={12} />
              </button>
              {/* A global skill is on or off, like every switch at the end of its row. */}
              {global && <input type="checkbox" role="switch" className="switch" aria-label={`${t.name} on`} checked={t.isDefault} disabled={save.isPending} onChange={() => save.mutate({ template: { ...t, isDefault: !t.isDefault } })} />}
            </div>
          ))}
          {!mine.length && <p className="hint tpl-none">No template yet: the job uses its built-in prompt.</p>}
        </div>
      </SheetBox>
    );
  };
  const half = Math.ceil(kinds.length / 2);
  return (
    <div className="tpl-grid">
      <PageTools>
        <span className="hint">{plural(list.length, "template")}</span>
      </PageTools>
      <div className="tpl-stack">{kinds.slice(0, half).map(box)}</div>
      <div className="tpl-stack">
        {kinds.slice(half).map(box)}
        <p className="hint">
          A template for one project shows that project's name instead of All projects. <span className="mono">{"{language}"}</span> is filled in when you generate.
        </p>
      </div>
    </div>
  );
}

/** One template's page: its instructions beside its name, scope, rules and model, then a preview run on the open project. */
function TemplateEditor({ id, open, back }: { id: string; open: (id: string, title?: string) => void; back: () => void }) {
  const nav = useNav();
  const q = useTemplates();
  const cfg = useConfig().data;
  const project = cfg?.projects.find((p) => p.id === nav.projectId);
  const save = useAction<Template>("templates.save", { invalidate: inv, success: "Template saved" });
  const del = useAction("templates.delete", { invalidate: inv, success: "Template deleted" });
  const setDef = useAction("templates.setDefault", { invalidate: inv });
  const run = useAction<{ output: string; source: string }>("templates.preview");
  const tpl = q.data?.templates.find((t) => t.id === id);
  const [draft, setDraft] = useState<Template | null>(tpl ? structuredClone(tpl) : null);
  const [lang, setLang] = useState("en");
  const [preview, setPreview] = useState<{ output: string; source: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The list arrives after the page opens on a fresh load.
  useEffect(() => {
    if (tpl && !draft) setDraft(structuredClone(tpl));
  }, [tpl]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!q.data) return <Loading />;
  if (!tpl || !draft) return <p className="hint">This template was deleted. Go back to the templates.</p>;
  const kinds = q.data.kinds;
  const kind = kinds.find((k) => k.id === draft.kind);
  const isGlobal = draft.kind === "global";
  const unaffected = new Intl.ListFormat("en", { type: "conjunction" }).format(kinds.filter((k) => k.id !== "global" && !k.globals).map((k) => k.label));
  const dirty = JSON.stringify(draft) !== JSON.stringify(tpl);
  const setRule = (i: number, value: boolean | number) => {
    const rules = [...draft.rules];
    rules[i] = { ...rules[i], value };
    setDraft({ ...draft, rules });
  };
  return (
    <div className="tpl-edit">
      <SheetBox title="Instructions">
        <div className="tpl-body">
          {isGlobal && <p className="hint">While on, these instructions go in front of every other template. Not sent with {unaffected}.</p>}
          {kind && !isGlobal && !kind.globals && <p className="hint">Global skills are not sent with this template.</p>}
          <textarea aria-label="Instructions" className="textarea mono tpl-text" rows={18} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <div className="tpl-insert">
            <span className="hint">Insert</span>
            {kind?.variables.map((v) => (
              <button key={v.name} className="btn btn-sm mono" data-tip={v.hint} onClick={() => setDraft({ ...draft, body: draft.body + v.name })}>
                {v.name}
              </button>
            ))}
            <span className="hint tpl-fill">{"{language}"} is filled in when you generate</span>
          </div>
        </div>
      </SheetBox>
      <div className="tpl-stack">
        <SheetBox
          title={kind?.label ?? "Template"}
          aside={
            <>
              <button className="btn btn-sm btn-ghost" onClick={() => save.mutate({ template: { ...draft, id: "", name: `${draft.name} (copy)`, isDefault: false } }, { onSuccess: (t) => open(`templates:${t.id}`, t.name) })}>
                <Icon name="copy" size={12} />
                Duplicate
              </button>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => setDeleting(true)}>
                <Icon name="trash" size={12} />
                Delete
              </button>
              <button className="btn btn-sm btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate({ template: draft }, { onSuccess: (t) => open(`templates:${t.id}`, t.name) })}>
                Save
              </button>
            </>
          }
        >
          <div className="sheet-col">
            <SheetRow label="Name">
              <input aria-label="Name" className="input tpl-field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </SheetRow>
            <SheetRow label="Applies to">
              <Seg
                label="Applies to"
                value={draft.scope === "all" ? "all" : "project"}
                onChange={(v) => setDraft({ ...draft, scope: v === "all" ? "all" : (nav.projectId ?? "all") })}
                options={[{ value: "all", label: "All projects" }, { value: "project", label: `${project?.name ?? "This project"} only` }]}
              />
            </SheetRow>
            {isGlobal ? (
              <SheetSwitch
                label="On"
                tip="In front of every other template while on"
                on={!!tpl.isDefault}
                disabled={save.isPending}
                flip={() => {
                  const on = !tpl.isDefault;
                  save.mutate({ template: { ...tpl, isDefault: on } });
                  setDraft({ ...draft, isDefault: on });
                }}
              />
            ) : (
              <SheetRow label="Default" tip="The template its job uses unless another is picked">
                {tpl.isDefault ? <span className="sheet-v">Used by default</span> : <button className="btn btn-sm" onClick={() => setDef.mutate({ id: draft.id })}>Set as default</button>}
              </SheetRow>
            )}
            {!isGlobal && (
              <SheetRow label="Model" tip="Overrides the model from task routing in AI setup">
                <MenuChoice
                  className="sheet-val"
                  alignRight
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
              </SheetRow>
            )}
            {dirty && <p className="hint tpl-dirty">Unsaved changes</p>}
          </div>
        </SheetBox>
        {draft.rules.length > 0 && (
          <SheetBox title="Rules">
            <div className="sheet-col">
              {draft.rules.map((r, i) =>
                r.kind === "check" ? (
                  <SheetSwitch key={r.key} label={r.label} on={!!r.value} flip={() => setRule(i, !r.value)} />
                ) : (
                  <div key={r.key} className="sheet-row">
                    <SheetKey label={r.label} />
                    <span className="mono faint tpl-var">{`{${r.key}}`}</span>
                    <input aria-label={r.label} type="number" className="input tpl-num" value={Number(r.value)} onChange={(e) => setRule(i, Number(e.target.value))} />
                  </div>
                ),
              )}
            </div>
          </SheetBox>
        )}
        <SheetBox
          title="Preview"
          aside={
            !isGlobal && (
              <button
                className="btn btn-sm"
                disabled={!nav.projectId || run.isPending || dirty}
                data-tip={dirty ? "Save first" : undefined}
                onClick={() => run.mutate({ projectId: nav.projectId!, id: draft.id, language: lang === "template" && draft.kind !== "release" ? "en" : lang }, { onSuccess: setPreview })}
              >
                <Busy on={run.isPending}>
                  <Icon name="sparkle" size={12} />
                </Busy>
                {preview ? "Run again" : "Run preview"}
              </button>
            )
          }
        >
          <div className="tpl-body">
            {isGlobal ? (
              <p className="hint">A global skill has no preview of its own. Preview another template to see its output with the global skills that are on.</p>
            ) : (
              <>
                <div className="tpl-lang">
                  <span className="muted">Generate in</span>
                  <Seg label="Generate in" value={lang} onChange={setLang} options={draft.kind === "release" ? RELEASE_LANGS : LANGS} />
                </div>
                <p className="hint">
                  {preview ? (
                    <>
                      Ran on <span className="mono">{preview.source}</span>. Nothing is committed or posted.
                    </>
                  ) : nav.projectId ? (
                    "Runs this template on real data from the open project. Nothing is committed or posted."
                  ) : (
                    "Open a project to preview."
                  )}
                </p>
                {preview ? <pre className="pre">{preview.output}</pre> : <div className="empty card">No preview yet.</div>}
              </>
            )}
          </div>
        </SheetBox>
      </div>
      {deleting && (
        <Confirm title="Delete template" sub={draft.name} action="Delete template" busy={del.isPending} onBack={() => setDeleting(false)} onConfirm={() => del.mutate({ id: draft.id }, { onSuccess: back })}>
          Its prompt and rules are deleted.
        </Confirm>
      )}
    </div>
  );
}
