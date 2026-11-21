import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAction, useConfig, useOverview, useTagV } from "../api/hooks";
import { rpc } from "../api/transport";
import { MenuChoice } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { Busy, EmptyState, Header, Loading, Markdown, RELEASE_LANGS, Seg } from "../components/ui";
import { useNav } from "../lib/nav";
import { copyToClipboard } from "../lib/toast";

type Kind = "feat" | "fix" | "internal";
/** One change in the range: a merged branch with its commits, or a commit made on the range's own line. */
type Item = { id: string; kind: Kind; title: string; pr?: string | null; commits: number; tickets: string[] };
type Range = { commits: number; branches: number; tickets: number; items: Item[] };

const GROUPS: [Kind, string][] = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["internal", "Internal"],
];

/** A checkbox that also shows "some" (indeterminate), which only the DOM property can set. */
function Check({ on, some, onChange, children, className = "check" }: { on: boolean; some?: boolean; onChange: () => void; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!some;
  }, [some]);
  return (
    <label className={className}>
      <input ref={ref} type="checkbox" checked={on} onChange={onChange} />
      {children}
    </label>
  );
}

export function ReleaseNotes() {
  const nav = useNav();
  const pid = nav.projectId!;
  const cfg = useConfig().data;
  const ov = useOverview(pid).data;
  const { label } = useTagV(pid);
  const project = cfg?.projects.find((p) => p.id === pid);
  const refs = useQuery({ queryKey: ["notes-refs", pid], queryFn: () => rpc<{ tags: string[]; branches: string[] }>("notes.refs", { projectId: pid }) });
  const nextRel = ov?.releases.find((r) => r.open);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tpl, setTpl] = useState("");
  const [lang, setLang] = useState(project?.genLang.release ?? "en");
  const [tickets, setTickets] = useState(true);
  /** Ids of the range's changes left out of the notes. */
  const [off, setOff] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"preview" | "markdown">("preview");
  const [md, setMd] = useState("");
  const [model, setModel] = useState("");
  /** The settings the notes on screen were written with, to tell when they no longer match. */
  const [madeWith, setMadeWith] = useState("");
  /** Phone only: the setup steps or the notes. */
  const [pane, setPane] = useState<"setup" | "notes">("setup");
  const page = useRef<HTMLDivElement>(null);
  // The phone scrolls the whole page: a pane switched to starts at its top.
  useEffect(() => {
    page.current?.scrollTo(0, 0);
  }, [pane]);

  useEffect(() => {
    if (!from && refs.data) setFrom(refs.data.tags[0] ?? ov?.defaultBranch ?? "");
    if (!to && refs.data) setTo(nextRel?.branch ?? "HEAD");
  }, [refs.data, nextRel, ov, from, to]);

  const range = useQuery({
    queryKey: ["notes-range", pid, from, to],
    queryFn: () => rpc<Range>("notes.range", { projectId: pid, from, to }),
    enabled: !!from && !!to,
    retry: false,
  });
  // Another range has other changes: none stays left out.
  useEffect(() => {
    setOff(new Set());
  }, [from, to]);

  const templates = (cfg?.templates ?? []).filter((t) => t.kind === "release" && (t.scope === "all" || t.scope === pid));
  const gen = useAction<{ markdown: string; model: string }>("notes.generate");
  const changelog = useAction<{ path: string }>("notes.changelog", { success: (r) => `Added to ${r.path}` });
  const publish = useAction<{ url: string }>("notes.publish", { success: (r) => `Published ${r.url}` });

  const items = range.data?.items ?? [];
  const kept = items.filter((i) => !off.has(i.id));
  const settings = JSON.stringify([from, to, tpl, lang, tickets, [...off].sort()]);
  const stale = !!md && settings !== madeWith;
  const refOptions = [...(refs.data?.tags ?? []).map((t) => ({ value: t, label: `${t} · tag` })), ...(refs.data?.branches ?? []).map((b) => ({ value: b, label: b })), { value: "HEAD", label: "HEAD" }];
  const run = () =>
    gen.mutate(
      { projectId: pid, from, to, templateId: tpl || undefined, language: lang, include: { feat: true, fix: true, internal: true, tickets }, exclude: [...off] },
      {
        onSuccess: (r) => {
          setMd(r.markdown);
          setModel(r.model);
          setMadeWith(settings);
          setPane("notes");
          changelog.reset();
          publish.reset();
        },
      },
    );
  const flip = (ids: string[], on: boolean) => {
    const next = new Set(off);
    for (const id of ids) on ? next.delete(id) : next.add(id);
    setOff(next);
  };
  // The hosted release's tag: the tag picked as the range's end, else the open release's version when the range ends at its
  // branch. Never one made up from another branch or HEAD, nor an unpublished version put on another commit.
  const tag = refs.data?.tags.includes(to) ? to : nextRel && to === nextRel.branch ? label(nextRel.version) : undefined;
  const toName = nextRel && to === nextRel.branch ? label(nextRel.version) : to;
  const shipped = publish.isSuccess ? `Published ${tag}` : changelog.isSuccess ? "Added to CHANGELOG.md" : "Not shipped yet";
  const peek = md.trim().split("\n").filter((l) => l.trim()).slice(0, 3);
  const rangeOk = !!range.data && !range.error;

  return (
    <>
      <Header title="Release notes" sub={project?.name} hideWide />
      <div ref={page} className="body rn" data-pane-on={pane}>
        <nav className="rn-steps" aria-label="Steps">
          <div className="rn-step" data-on={rangeOk}>
            <span className="rn-stn" aria-hidden />
            <h2 className="label">Range</h2>
            {from && to && (
              <span className="rn-step-meta mono">
                {from} <span className="faint">to</span> {to}
              </span>
            )}
            <span className="rn-rl" data-on={rangeOk && kept.length > 0} />
          </div>
          <div className="rn-step" data-on={rangeOk && kept.length > 0}>
            <span className="rn-stn" aria-hidden />
            <h2 className="label">What goes in</h2>
            {rangeOk && <span className="rn-step-meta">{kept.length} of {items.length} changes</span>}
            <span className="rn-rl" data-on={!!md} />
          </div>
          <div className="rn-step" data-on={!!md}>
            <span className="rn-stn" aria-hidden />
            <h2 className="label">Notes</h2>
            {model && <span className="rn-step-meta mono">{model}</span>}
            <span className="rn-rl" data-on={changelog.isSuccess || publish.isSuccess} />
          </div>
          <div className="rn-step" data-on={changelog.isSuccess || publish.isSuccess}>
            <span className="rn-stn" aria-hidden />
            <h2 className="label">Ship</h2>
            {md && <span className="rn-step-meta">{shipped}</span>}
          </div>
        </nav>

        <section className="rn-col rn-range" aria-label="Range" data-pane="setup">
          <div className="rn-pad">
            <div className="rn-fld">
              <label className="label" htmlFor="rn-from">From</label>
              <MenuChoice id="rn-from" className="select menu-select mono" style={{ fontSize: 12 }} label="From" search="Filter tags and branches" value={from} options={refOptions} onChange={setFrom} />
            </div>
            <div className="rn-swap">
              <button className="btn btn-ghost btn-icon" aria-label="Swap From and To" data-tip="Swap" onClick={() => { setFrom(to); setTo(from); }}>
                <Icon name="swap" size={13} />
              </button>
            </div>
            <div className="rn-fld">
              <label className="label" htmlFor="rn-to">To</label>
              <MenuChoice id="rn-to" className="select menu-select mono" style={{ fontSize: 12 }} label="To" search="Filter tags and branches" value={to} options={refOptions} onChange={setTo} />
            </div>
            <div className="rn-rail">
              {range.error ? (
                <span className="c-del">{range.error.message}</span>
              ) : (
                <>
                  <div className="rn-rail-line" aria-hidden>
                    {/* Oldest change on the left, like the range reads. */}
                    {items.slice(0, 40).map((it, i, all) => (
                      <span key={it.id} className="rn-rail-dot" data-off={off.has(it.id)} style={{ left: `${((all.length - i) / (all.length + 1)) * 100}%` }} />
                    ))}
                  </div>
                  <div className="rn-rail-ends mono">
                    <span>{from}</span>
                    <span>{toName}</span>
                  </div>
                  <div className="rn-nums">
                    <span><b>{range.data?.commits ?? "–"}</b> commits</span>
                    <span><b>{range.data?.branches ?? "–"}</b> merges</span>
                    <span><b>{range.data?.tickets ?? "–"}</b> tickets</span>
                  </div>
                </>
              )}
            </div>
            <div className="rn-fld">
              <label className="label" htmlFor="rn-tpl">Template</label>
              <MenuChoice
                id="rn-tpl"
                className="select menu-select"
                label="Template"
                value={tpl}
                options={[{ value: "", label: `Default (${templates.find((t) => t.isDefault)?.name ?? "first"})` }, ...templates.map((t) => ({ value: t.id, label: t.name }))]}
                onChange={setTpl}
              />
            </div>
            <div className="rn-fld">
              <span className="label">Language</span>
              {/* "Template base" does not fit a third of this column; under Language, "Template" says the same. */}
              <Seg grid label="Language" value={lang} onChange={setLang} options={RELEASE_LANGS.map((o) => (o.value === "template" ? { ...o, label: "Template" } : o))} />
            </div>
          </div>
        </section>

        <section className="rn-col rn-items" aria-label="What goes in" data-pane="setup">
          <div className="rn-pad scroll">
            {range.isPending && <Loading />}
            {rangeOk && items.length === 0 && <p className="muted">No changes between {from} and {to}.</p>}
            {GROUPS.map(([kind, name]) => {
              const group = items.filter((i) => i.kind === kind);
              if (!group.length) return null;
              const on = group.filter((i) => !off.has(i.id)).length;
              return (
                <div key={kind} className="rn-grp">
                  <Check className="check rn-gh" on={on === group.length} some={on > 0 && on < group.length} onChange={() => flip(group.map((i) => i.id), on < group.length)}>
                    <span className="grow">{name}</span>
                    <span className="rn-n mono">{on === group.length ? group.length : `${on} of ${group.length}`}</span>
                  </Check>
                  {group.map((it) => (
                    <Check key={it.id} className="check rn-it" on={!off.has(it.id)} onChange={() => flip([it.id], off.has(it.id))}>
                      <span className="rn-it-t" title={it.title}>
                        {it.title}
                        <span className="rn-it-ref mono">{it.pr ?? it.id.slice(0, 7)}{it.commits > 1 ? ` · ${it.commits} commits` : ""}</span>
                      </span>
                      {it.tickets[0] && <span className="rn-chip mono" title={it.tickets.join(", ")}>{it.tickets[0]}{it.tickets.length > 1 ? ` +${it.tickets.length - 1}` : ""}</span>}
                    </Check>
                  ))}
                </div>
              );
            })}
            {rangeOk && (range.data?.tickets ?? 0) > 0 && (
              <div className="rn-grp">
                <Check className="check rn-gh" on={tickets} onChange={() => setTickets(!tickets)}>
                  <span className="grow">Link tickets in the notes</span>
                  <span className="rn-n mono">{range.data?.tickets}</span>
                </Check>
              </div>
            )}
          </div>
          <div className="rn-foot">
            <button className={`btn ${md && !stale ? "" : "btn-primary"}`} style={{ height: 40 }} disabled={!rangeOk || !kept.length || gen.isPending} onClick={run}>
              <Busy on={gen.isPending}><Icon name="sparkle" size={13} /></Busy>
              <span>{md ? "Rewrite notes" : "Write notes"}</span>
            </button>
            <p className="rn-hint">{!md ? "Reads the commits and linked tickets of the checked changes, using the template." : stale ? "Changed since the notes were written." : "The notes match these boxes."}</p>
          </div>
        </section>

        <section className="rn-col rn-notes" aria-label="Notes" data-pane="notes">
          <div className="rn-bar">
            <button className="btn btn-sm show-narrow" onClick={() => setPane("setup")}>
              <Icon name="back" size={12} />
              Setup
            </button>
            <Seg label="View" value={view} onChange={setView} options={[{ value: "preview", label: "Preview" }, { value: "markdown", label: "Markdown" }]} />
            {stale && <span className="rn-hint">Changed since written</span>}
          </div>
          <div className="scroll rn-paper">
            <article>
              {!md && !gen.isPending && <EmptyState icon="sparkle" title="No notes yet">Check what goes in and press Write notes.</EmptyState>}
              {gen.isPending && <Loading />}
              {md && !gen.isPending && view === "preview" && <Markdown text={md} />}
              {md && !gen.isPending && view === "markdown" && (
                <>
                  <label htmlFor="rn-md" className="sr-only">Markdown</label>
                  <textarea id="rn-md" className="textarea mono" style={{ width: "100%", minHeight: 420, fontSize: 12.5 }} value={md} onChange={(e) => setMd(e.target.value)} />
                </>
              )}
            </article>
          </div>
        </section>

        <section className="rn-col rn-ship" aria-label="Ship" data-pane="notes">
          <div className="rn-dest">
            <h3 className="rn-dest-h"><Icon name="tag" size={13} />Hosted release</h3>
            <p>
              {tag ? (
                <>Publishes <span className="mono" style={{ color: "var(--fg)" }}>{tag}</span> on the git host with these notes, targeting <span className="mono">{to}</span>.</>
              ) : (
                "Pick a tag as the range's end, or open a release: the hosted release needs a version tag."
              )}
            </p>
            <button className="btn btn-primary" style={{ height: 40 }} disabled={!md || !tag || publish.isPending} onClick={() => tag && publish.mutate({ projectId: pid, tag, target: to, name: tag, body: md })}>
              <Busy on={publish.isPending}><Icon name="ship" size={12} /></Busy>
              {tag ? `Publish ${tag}` : "Publish release"}
            </button>
          </div>
          <div className="rn-dest">
            <h3 className="rn-dest-h"><Icon name="file" size={13} />CHANGELOG.md</h3>
            {peek.length > 0 ? (
              <div className="rn-peek mono" aria-label="Lines added at the top">
                {peek.map((l, i) => <span key={i}>{l}</span>)}
              </div>
            ) : (
              <p>Adds the notes above the latest section.</p>
            )}
            <button className="btn" disabled={!md || changelog.isPending} onClick={() => changelog.mutate({ projectId: pid, markdown: md })}>
              <Busy on={changelog.isPending}><Icon name="plus" size={12} /></Busy>
              Add to changelog
            </button>
          </div>
          <div className="rn-dest">
            <h3 className="rn-dest-h"><Icon name="copy" size={13} />Clipboard</h3>
            <p>Markdown, for a chat or an email.</p>
            <button className="btn" disabled={!md} onClick={() => copyToClipboard(md)}>Copy Markdown</button>
          </div>
        </section>
      </div>
    </>
  );
}
