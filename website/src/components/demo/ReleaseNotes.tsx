import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { Busy, Choice, EmptyState, Markdown, PageHead, Seg, useDemo, useLater } from './ui';

/** src/screens/ReleaseNotes.tsx with a made-up history: pick a range, check what goes in, "AI" writes the notes, then ship them. */

/** Where each ref sits in the history; step i runs from position i to i + 1. */
const AT: Record<string, number> = { 'v0.4.0': 0, 'v0.5.0': 1, 'v0.5.1': 2, 'v0.5.2': 3, main: 3, 'release/0.6.0': 4, 'fix/stale-remote': 4, 'feat/branch-tree': 5, HEAD: 5 };
/** Each step's commits, merges and tickets. */
const COUNTS: [number, number, number][] = [[64, 11, 9], [7, 2, 2], [5, 1, 1], [23, 6, 5], [4, 0, 1]];
const TAGS = ['v0.5.2', 'v0.5.1', 'v0.5.0', 'v0.4.0'];
const REFS = [
  ...TAGS.map((t) => ({ value: t, label: `${t} · tag` })),
  ...['release/0.6.0', 'main', 'feat/branch-tree', 'fix/stale-remote', 'HEAD'].map((b) => ({ value: b, label: b })),
];
/** The open release: a range ending at its branch publishes its version. */
const NEXT = { branch: 'release/0.6.0', version: 'v0.6.0' };
/** The release templates crates/core/src/templates.rs ships. */
const TEMPLATES = [
  { value: '', label: 'Default (Customer-facing)' },
  { value: 'customer', label: 'Customer-facing' },
  { value: 'internal', label: 'Internal changelog' },
  { value: 'github', label: 'GitHub release' },
];
const HEADS = {
  customer: { en: ['New', 'Fixed', 'Under the hood'], fr: ['Nouveautés', 'Corrections', 'Sous le capot'] },
  github: { en: ["What's new", 'Bug fixes', 'Other changes'], fr: ['Nouveautés', 'Corrections de bugs', 'Autres changements'] },
};
type Kind = 'feat' | 'fix' | 'internal';
type Lang = 'en' | 'fr' | 'template';
/** One change in the range: a merged branch (with its PR) or a commit made on the range's own line. */
type Item = { id: string; kind: Kind; en: string; fr: string; pr?: string; commits: number; tickets: string[] };
const GROUPS: [Kind, string][] = [['feat', 'Features'], ['fix', 'Fixes'], ['internal', 'Internal']];
/** What each step of the history changed, oldest first. */
const ITEMS: Item[][] = [
  [
    { id: 'a41c0e2', kind: 'feat', en: 'Publish a release from any branch: the changelog gets its date and the branch is pushed with its tag', fr: "Publiez une version depuis n'importe quelle branche : le changelog est daté et la branche est poussée avec son tag", pr: '#118', commits: 9, tickets: ['WEB-150'] },
    { id: 'c7d93b1', kind: 'feat', en: 'Squash-merged pull requests land under the right release', fr: 'Les pull requests fusionnées en squash se rangent sous la bonne version', pr: '#124', commits: 4, tickets: ['WEB-161'] },
    { id: '5e08fa4', kind: 'fix', en: "Ahead and behind counts compare with the branch's real parent", fr: 'Les compteurs en avance et en retard comparent avec le vrai parent de la branche', pr: '#121', commits: 3, tickets: ['WEB-158', 'WEB-159'] },
    { id: '93b2d6c', kind: 'internal', en: 'Branch views are cached per project', fr: 'Les vues des branches sont mises en cache par projet', commits: 1, tickets: [] },
  ],
  [
    { id: 'e1f47a9', kind: 'fix', en: 'Tags pushed from another clone show up after a fetch', fr: 'Les tags poussés depuis un autre clone apparaissent après un fetch', pr: '#131', commits: 2, tickets: ['WEB-171'] },
    { id: '2b6c8d0', kind: 'fix', en: 'The diff keeps its scroll position when the file reloads', fr: 'Le diff garde sa position quand le fichier se recharge', commits: 1, tickets: [] },
  ],
  [{ id: '7a90e35', kind: 'fix', en: 'Worktrees in folders with spaces open again on Windows', fr: "Les worktrees dans un dossier avec des espaces s'ouvrent de nouveau sous Windows", pr: '#137', commits: 2, tickets: ['WEB-176'] }],
  [
    { id: 'd4e1b72', kind: 'feat', en: 'Each agent session gets its own worktree, so you keep working while it runs', fr: "Chaque session d'agent a son propre worktree : vous continuez à travailler pendant qu'il tourne", pr: '#142', commits: 7, tickets: ['WEB-198'] },
    { id: '0c5f3e8', kind: 'feat', en: 'Unplanned tickets get a suggested release', fr: 'Les tickets non planifiés reçoivent une version suggérée', pr: '#145', commits: 3, tickets: ['WEB-203'] },
    { id: 'f82a6d1', kind: 'feat', en: 'Hidden project commands fold into one pill in the terminal', fr: 'Les commandes de projet masquées se replient en une pastille dans le terminal', commits: 1, tickets: [] },
    { id: '61d0c4b', kind: 'fix', en: 'Branches deleted on origin leave the map on the next fetch', fr: 'Les branches supprimées sur origin quittent la carte au fetch suivant', pr: '#149', commits: 2, tickets: ['WEB-218'] },
    { id: 'b3e97f0', kind: 'fix', en: 'Long branch names no longer push the row actions out of view', fr: 'Les noms de branche longs ne poussent plus les actions hors de la ligne', pr: '#147', commits: 2, tickets: ['WEB-209'] },
    { id: '48a2c19', kind: 'internal', en: 'Fetch runs with `--prune` every five minutes', fr: 'Le fetch tourne avec `--prune` toutes les cinq minutes', commits: 1, tickets: [] },
  ],
  [{ id: '9f13b6e', kind: 'feat', en: 'A pulse travels down the path to the checked-out branch', fr: "Une pulsation parcourt le chemin jusqu'à la branche extraite", pr: '#151', commits: 4, tickets: ['WEB-212'] }],
];

/** The notes for `items` the way the picked template lays them out. */
function write(items: Item[], version: string, tpl: string, lang: Lang, tickets: boolean) {
  const l = lang === 'template' ? 'en' : lang;
  const line = (i: Item) => `${i[l]}${tickets && i.tickets.length ? ` (${i.tickets.join(', ')})` : ''}`;
  if (tpl === 'internal') return [`## ${version}`, '', ...items.map((i) => `- ${i.kind === 'internal' ? 'chore' : i.kind}: ${line(i)}`)].join('\n');
  const heads = HEADS[tpl === 'github' ? 'github' : 'customer'][l];
  const sections = GROUPS.flatMap(([k], j) => {
    const of = items.filter((i) => i.kind === k);
    return of.length ? ['', `### ${heads[j]}`, ...of.map((i) => `- ${line(i)}`)] : [];
  });
  return [`## ${version}`, ...sections].join('\n');
}

/** A checkbox that also shows "some" (indeterminate), which only the DOM property can set. */
function Check({ on, some, onChange, children, className = 'check' }: { on: boolean; some?: boolean; onChange: () => void; children: ReactNode; className?: string }) {
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

export default function ReleaseNotes() {
  const { flash } = useDemo();
  const later = useLater();
  const [from, setFrom] = useState('v0.5.2');
  const [to, setTo] = useState(NEXT.branch);
  const [tpl, setTpl] = useState('');
  const [lang, setLang] = useState<Lang>('en');
  const [tickets, setTickets] = useState(true);
  /** Ids of the range's changes left out of the notes. */
  const [off, setOff] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'preview' | 'markdown'>('preview');
  const [md, setMd] = useState('');
  const [model, setModel] = useState('');
  /** The settings the notes on screen were written with, to tell when they no longer match. */
  const [madeWith, setMadeWith] = useState('');
  const [busy, setBusy] = useState<'' | 'gen' | 'publish' | 'changelog'>('');
  const [shippedTo, setShippedTo] = useState<'' | 'publish' | 'changelog'>('');
  /** Phone only: the setup steps or the notes. */
  const [pane, setPane] = useState<'setup' | 'notes'>('setup');
  const page = useRef<HTMLDivElement>(null);
  // The phone scrolls the whole page: a pane switched to starts at its top.
  useEffect(() => {
    page.current?.scrollTo(0, 0);
  }, [pane]);
  // Another range has other changes: none stays left out.
  useEffect(() => {
    setOff(new Set());
  }, [from, to]);

  const [a, b] = [AT[from], AT[to]];
  const error = a > b ? `${to} is behind ${from}: swap them to compare.` : '';
  const counts = COUNTS.slice(a, b).reduce<number[]>((s, c) => s.map((x, i) => x + c[i]), [0, 0, 0]);
  // Newest first, like notes.range lists them.
  const items = error ? [] : ITEMS.slice(a, b).flat().reverse();
  const kept = items.filter((i) => !off.has(i.id));
  const settings = JSON.stringify([from, to, tpl, lang, tickets, [...off].sort()]);
  const stale = !!md && settings !== madeWith;
  const rangeOk = !error;
  const tag = TAGS.includes(to) ? to : to === NEXT.branch ? NEXT.version : undefined;
  const toName = to === NEXT.branch ? NEXT.version : to;
  const shipped = shippedTo === 'publish' ? `Published ${tag}` : shippedTo === 'changelog' ? 'Added to CHANGELOG.md' : 'Not shipped yet';
  const peek = md.trim().split('\n').filter((l) => l.trim()).slice(0, 3);

  const run = () => {
    setBusy('gen');
    later(1400, () => {
      setBusy('');
      setMd(write(kept, tag ?? NEXT.version, tpl, lang, tickets));
      setModel('claude-sonnet-5-5');
      setMadeWith(settings);
      setPane('notes');
      setShippedTo('');
    });
  };
  const ship = (dest: 'publish' | 'changelog', msg: string) => {
    setBusy(dest);
    later(900, () => {
      setBusy('');
      setShippedTo(dest);
      flash(msg);
    });
  };
  const flip = (ids: string[], on: boolean) => {
    const next = new Set(off);
    for (const id of ids) on ? next.delete(id) : next.add(id);
    setOff(next);
  };

  return (
    <>
      <PageHead title="Release notes" sub="acme-web" />
      <div ref={page} className="body rn" data-pane-on={pane}>
        <nav className="rn-steps" aria-label="Steps">
          <div className="rn-step" data-on={rangeOk}>
            <span className="rn-stn" aria-hidden />
            <h2 className="label">Range</h2>
            <span className="rn-step-meta mono">
              {from} <span className="faint">to</span> {to}
            </span>
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
            <span className="rn-rl" data-on={!!shippedTo} />
          </div>
          <div className="rn-step" data-on={!!shippedTo}>
            <span className="rn-stn" aria-hidden />
            <h2 className="label">Ship</h2>
            {md && <span className="rn-step-meta">{shipped}</span>}
          </div>
        </nav>

        <section className="rn-col rn-range" aria-label="Range" data-pane="setup">
          <div className="rn-pad">
            <div className="rn-fld">
              <label className="label" htmlFor="rn-from">From</label>
              <Choice id="rn-from" className="select menu-select mono" style={{ fontSize: 12 }} label="From" value={from} options={REFS} onChange={setFrom} />
            </div>
            <div className="rn-swap">
              <button className="btn btn-ghost btn-icon" aria-label="Swap From and To" title="Swap" onClick={() => { setFrom(to); setTo(from); }}>
                <Icon name="swap" size={13} />
              </button>
            </div>
            <div className="rn-fld">
              <label className="label" htmlFor="rn-to">To</label>
              <Choice id="rn-to" className="select menu-select mono" style={{ fontSize: 12 }} label="To" value={to} options={REFS} onChange={setTo} />
            </div>
            <div className="rn-rail">
              {error ? (
                <span className="c-del">{error}</span>
              ) : (
                <>
                  <div className="rn-rail-line" aria-hidden>
                    {/* Oldest change on the left, like the range reads. */}
                    {items.map((it, i, all) => (
                      <span key={it.id} className="rn-rail-dot" data-off={off.has(it.id)} style={{ left: `${((all.length - i) / (all.length + 1)) * 100}%` }} />
                    ))}
                  </div>
                  <div className="rn-rail-ends mono">
                    <span>{from}</span>
                    <span>{toName}</span>
                  </div>
                  <div className="rn-nums">
                    <span><b>{counts[0]}</b> commits</span>
                    <span><b>{counts[1]}</b> merges</span>
                    <span><b>{counts[2]}</b> tickets</span>
                  </div>
                </>
              )}
            </div>
            <div className="rn-fld">
              <label className="label" htmlFor="rn-tpl">Template</label>
              <Choice id="rn-tpl" className="select menu-select" label="Template" value={tpl} options={TEMPLATES} onChange={setTpl} />
            </div>
            <div className="rn-fld">
              <span className="label">Language</span>
              <Seg grid label="Language" value={lang} onChange={setLang} options={[['en', 'English'], ['fr', 'Français'], ['template', 'Template']]} />
            </div>
          </div>
        </section>

        <section className="rn-col rn-items" aria-label="What goes in" data-pane="setup">
          <div className="rn-pad scroll">
            {error && <p className="c-del">{error}</p>}
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
                      <span className="rn-it-t" title={it.en}>
                        {it.en}
                        <span className="rn-it-ref mono">{it.pr ?? it.id}{it.commits > 1 ? ` · ${it.commits} commits` : ''}</span>
                      </span>
                      {it.tickets[0] && <span className="rn-chip mono" title={it.tickets.join(', ')}>{it.tickets[0]}{it.tickets.length > 1 ? ` +${it.tickets.length - 1}` : ''}</span>}
                    </Check>
                  ))}
                </div>
              );
            })}
            {rangeOk && counts[2] > 0 && (
              <div className="rn-grp">
                <Check className="check rn-gh" on={tickets} onChange={() => setTickets(!tickets)}>
                  <span className="grow">Link tickets in the notes</span>
                  <span className="rn-n mono">{counts[2]}</span>
                </Check>
              </div>
            )}
          </div>
          <div className="rn-foot">
            <button className={`btn ${md && !stale ? '' : 'btn-primary'}`} style={{ height: 40 }} disabled={!rangeOk || !kept.length || busy === 'gen'} onClick={run}>
              <Busy on={busy === 'gen'}><Icon name="sparkle" size={13} /></Busy>
              <span>{md ? 'Rewrite notes' : 'Write notes'}</span>
            </button>
            <p className="rn-hint">{!md ? 'Reads the commits and linked tickets of the checked changes, using the template.' : stale ? 'Changed since the notes were written.' : 'The notes match these boxes.'}</p>
          </div>
        </section>

        <section className="rn-col rn-notes" aria-label="Notes" data-pane="notes">
          <div className="rn-bar">
            <button className="btn btn-sm show-narrow" onClick={() => setPane('setup')}>
              <Icon name="back" size={12} />
              Setup
            </button>
            <Seg label="View" value={view} onChange={setView} options={[['preview', 'Preview'], ['markdown', 'Markdown']]} />
            {stale && <span className="rn-hint">Changed since written</span>}
          </div>
          <div className="scroll rn-paper">
            <article>
              {!md && busy !== 'gen' && <EmptyState icon="sparkle" title="No notes yet">Check what goes in and press Write notes.</EmptyState>}
              {busy === 'gen' && <div className="empty"><span className="spinner" /></div>}
              {md && busy !== 'gen' && view === 'preview' && <Markdown text={md} />}
              {md && busy !== 'gen' && view === 'markdown' && (
                <>
                  <label htmlFor="rn-md" className="sr-only">Markdown</label>
                  <textarea id="rn-md" className="textarea mono" style={{ width: '100%', minHeight: 420, fontSize: 12.5 }} value={md} onChange={(e) => setMd(e.target.value)} />
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
                <>Publishes <span className="mono" style={{ color: 'var(--fg)' }}>{tag}</span> on the git host with these notes, targeting <span className="mono">{to}</span>.</>
              ) : (
                "Pick a tag as the range's end, or open a release: the hosted release needs a version tag."
              )}
            </p>
            <button className="btn btn-primary" style={{ height: 40 }} disabled={!md || !tag || busy === 'publish'} onClick={() => ship('publish', `Published https://github.com/acme/acme-web/releases/tag/${tag}`)}>
              <Busy on={busy === 'publish'}><Icon name="ship" size={12} /></Busy>
              {tag ? `Publish ${tag}` : 'Publish release'}
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
            <button className="btn" disabled={!md || busy === 'changelog'} onClick={() => ship('changelog', 'Added to CHANGELOG.md')}>
              <Busy on={busy === 'changelog'}><Icon name="plus" size={12} /></Busy>
              Add to changelog
            </button>
          </div>
          <div className="rn-dest">
            <h3 className="rn-dest-h"><Icon name="copy" size={13} />Clipboard</h3>
            <p>Markdown, for a chat or an email.</p>
            <button className="btn" disabled={!md} onClick={() => navigator.clipboard?.writeText(md).then(() => flash('Copied'))}>Copy Markdown</button>
          </div>
        </section>
      </div>
    </>
  );
}
