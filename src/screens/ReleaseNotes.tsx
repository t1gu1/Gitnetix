import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAction, useConfig, useOverview } from "../api/hooks";
import { rpc } from "../api/transport";
import { Icon } from "../components/Icon";
import { Busy, Empty, Header, LANGS, Loading, Markdown, Seg } from "../components/ui";
import { useNav } from "../lib/nav";
import { copyToClipboard } from "../lib/toast";

export function ReleaseNotes() {
  const nav = useNav();
  const pid = nav.projectId!;
  const cfg = useConfig().data;
  const ov = useOverview(pid).data;
  const project = cfg?.projects.find((p) => p.id === pid);
  const refs = useQuery({ queryKey: ["notes-refs", pid], queryFn: () => rpc<{ tags: string[]; branches: string[] }>("notes.refs", { projectId: pid }) });
  const nextRel = ov?.releases.find((r) => r.open);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tpl, setTpl] = useState("");
  const [lang, setLang] = useState(project?.genLang.release ?? "en");
  const [inc, setInc] = useState({ feat: true, fix: true, internal: true, tickets: true });
  const [view, setView] = useState<"preview" | "markdown">("preview");
  const [md, setMd] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    if (!from && refs.data) setFrom(refs.data.tags[0] ?? ov?.defaultBranch ?? "");
    if (!to && refs.data) setTo(nextRel?.branch ?? "HEAD");
  }, [refs.data, nextRel, ov, from, to]);

  const range = useQuery({
    queryKey: ["notes-range", pid, from, to],
    queryFn: () => rpc<{ commits: number; branches: number; tickets: number }>("notes.range", { projectId: pid, from, to }),
    enabled: !!from && !!to,
    retry: false,
  });
  const templates = (cfg?.templates ?? []).filter((t) => t.kind === "release" && (t.scope === "all" || t.scope === pid));
  const gen = useAction<{ markdown: string; model: string }>("notes.generate");
  const changelog = useAction<{ path: string }>("notes.changelog", { success: (r) => `Added to ${r.path}` });
  const publish = useAction<{ url: string }>("notes.publish", { success: (r) => `Published ${r.url}` });

  const refOptions = [...(refs.data?.tags ?? []).map((t) => ({ v: t, l: `${t} · tag` })), ...(refs.data?.branches ?? []).map((b) => ({ v: b, l: b })), { v: "HEAD", l: "HEAD" }];
  const run = () =>
    gen.mutate(
      { projectId: pid, from, to, templateId: tpl || undefined, language: lang, include: inc },
      { onSuccess: (r) => { setMd(r.markdown); setModel(r.model); } },
    );
  const version = nextRel ? `v${nextRel.version}` : to;

  return (
    <>
      <Header title="Release notes" sub={project?.name} />
      <div className="body split">
        <aside aria-label="Options" className="sidenav" data-pane data-active={!md} style={{ flexBasis: 360, gap: 24, padding: 24 }}>
          <section className="col" style={{ gap: 10 }}>
            <h2 className="label">Range</h2>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 32px minmax(0,1fr)", gap: 6, alignItems: "end" }}>
              <div className="field">
                <label htmlFor="rn-from">From</label>
                <select id="rn-from" className="select mono" style={{ fontSize: 12 }} value={from} onChange={(e) => setFrom(e.target.value)}>
                  {refOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
              <button className="btn btn-ghost btn-icon" style={{ height: 36 }} aria-label="Swap" onClick={() => { setFrom(to); setTo(from); }}>
                <Icon name="swap" />
              </button>
              <div className="field">
                <label htmlFor="rn-to">To</label>
                <select id="rn-to" className="select mono" style={{ fontSize: 12 }} value={to} onChange={(e) => setTo(e.target.value)}>
                  {refOptions.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
              </div>
            </div>
            <div className="row note-box muted" style={{ gap: 14, fontSize: 12, background: "var(--bg)" }}>
              {range.error ? (
                <span className="c-del">{range.error.message}</span>
              ) : (
                <>
                  <span><strong style={{ color: "var(--fg)" }}>{range.data?.commits ?? "–"}</strong> commits</span>
                  <span><strong style={{ color: "var(--fg)" }}>{range.data?.branches ?? "–"}</strong> merges</span>
                  <span><strong style={{ color: "var(--fg)" }}>{range.data?.tickets ?? "–"}</strong> tickets</span>
                </>
              )}
            </div>
          </section>
          <section className="col" style={{ gap: 10 }}>
            <h2 className="label">Template</h2>
            <label htmlFor="rn-tpl" className="sr-only">Template</label>
            <select id="rn-tpl" className="select" value={tpl} onChange={(e) => setTpl(e.target.value)}>
              <option value="">Default ({templates.find((t) => t.isDefault)?.name ?? "first"})</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <Seg grid label="Language" value={lang} onChange={setLang} options={LANGS} />
          </section>
          <section className="col" style={{ gap: 4 }}>
            <h2 className="label" style={{ marginBottom: 6 }}>Include</h2>
            {(
              [
                ["feat", "Features"],
                ["fix", "Fixes"],
                ["internal", "Internal changes"],
                ["tickets", "Ticket links"],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="check">
                <input type="checkbox" checked={inc[k]} onChange={() => setInc({ ...inc, [k]: !inc[k] })} />
                <span>{l}</span>
              </label>
            ))}
          </section>
          <span className="grow" />
          <button className="btn btn-primary btn-lg" disabled={!from || !to || gen.isPending} onClick={run}>
            <Busy on={gen.isPending}><Icon name="sparkle" size={13} /></Busy>
            <span>Generate notes</span>
          </button>
        </aside>
        <main className="col grow" data-pane data-active={!!md} style={{ gap: 0, minWidth: 0, minHeight: 0 }}>
          <div className="row wrap" style={{ minHeight: 56, padding: "8px 24px", borderBottom: "1px solid var(--line)", gap: 12 }}>
            <button className="btn btn-sm show-narrow" onClick={() => setMd("")}>Options</button>
            <Seg label="View" value={view} onChange={setView} options={[{ value: "preview", label: "Preview" }, { value: "markdown", label: "Markdown" }]} />
            {model && <span className="faint" style={{ fontSize: 12 }}>{model}</span>}
            <span className="grow" />
            <div className="row wrap" style={{ gap: 6 }}>
              <button className="btn" disabled={!md || gen.isPending} onClick={run}>
                <Icon name="refresh" size={12} />
                Regenerate
              </button>
              <button className="btn" disabled={!md} onClick={() => copyToClipboard(md)}>Copy</button>
              <button className="btn" disabled={!md || changelog.isPending} onClick={() => changelog.mutate({ projectId: pid, markdown: md })}>Add to CHANGELOG.md</button>
              <button
                className="btn btn-raised"
                disabled={!md || publish.isPending}
                onClick={() => publish.mutate({ projectId: pid, tag: version.startsWith("v") ? version : `v${version}`, target: to, name: version, body: md })}
              >
                Publish GitHub release
              </button>
            </div>
          </div>
          <div className="scroll" style={{ flex: "1 1 auto", padding: "40px 24px 64px" }}>
            <article style={{ maxWidth: 680, margin: "0 auto" }}>
              {!md && !gen.isPending && <Empty>Pick a range and press Generate. AI reads the commits and linked tickets, using your release-notes template.</Empty>}
              {gen.isPending && <Loading />}
              {md && view === "preview" && <Markdown text={md} />}
              {md && view === "markdown" && (
                <>
                  <label htmlFor="rn-md" className="sr-only">Markdown</label>
                  <textarea id="rn-md" className="textarea mono" style={{ width: "100%", minHeight: 420, fontSize: 12.5 }} value={md} onChange={(e) => setMd(e.target.value)} />
                </>
              )}
            </article>
          </div>
        </main>
      </div>
    </>
  );
}
