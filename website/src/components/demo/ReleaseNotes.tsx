import { useState, type CSSProperties } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { Busy, Choice, EmptyState, Markdown, Seg, useDemo, useLater } from './ui';

/** src/screens/ReleaseNotes.tsx with a made-up history: pick a range, a template and a language, and "AI" writes the notes. */

/** Where each ref sits in the history; step i runs from position i to i + 1. */
const AT: Record<string, number> = { 'v0.4.0': 0, 'v0.5.0': 1, 'v0.5.1': 2, 'v0.5.2': 3, main: 3, 'release/0.6.0': 4, 'fix/stale-remote': 4, 'feat/branch-tree': 5, HEAD: 5 };
/** Each step's commits, merges and tickets. */
const COUNTS: [number, number, number][] = [[64, 11, 9], [7, 2, 2], [5, 1, 1], [23, 6, 5], [4, 0, 1]];
const REFS = [
  ...['v0.5.2', 'v0.5.1', 'v0.5.0', 'v0.4.0'].map((t) => ({ value: t, label: `${t} · tag` })),
  ...['release/0.6.0', 'main', 'feat/branch-tree', 'fix/stale-remote', 'HEAD'].map((b) => ({ value: b, label: b })),
];
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
type Lang = 'en' | 'fr';
type Item = { k: Kind; en: string; fr: string; t?: string };
/** What each step of the history changed. */
const ITEMS: Item[][] = [
  [
    { k: 'feat', en: 'Ship a release in one click: the changelog gets its date, `main` fast-forwards and the tag is pushed', fr: 'Livrez une version en un clic : le changelog est daté, `main` avance et le tag est poussé', t: 'WEB-150' },
    { k: 'feat', en: 'Squash-merged pull requests land under the right release', fr: 'Les pull requests fusionnées en squash se rangent sous la bonne version', t: 'WEB-161' },
    { k: 'fix', en: "Ahead and behind counts compare with the branch's real parent", fr: 'Les compteurs en avance et en retard comparent avec le vrai parent de la branche', t: 'WEB-158' },
    { k: 'internal', en: 'Branch views are cached per project', fr: 'Les vues des branches sont mises en cache par projet' },
  ],
  [
    { k: 'fix', en: 'Tags pushed from another clone show up after a fetch', fr: 'Les tags poussés depuis un autre clone apparaissent après un fetch', t: 'WEB-171' },
    { k: 'fix', en: 'The diff keeps its scroll position when the file reloads', fr: 'Le diff garde sa position quand le fichier se recharge' },
  ],
  [{ k: 'fix', en: 'Worktrees in folders with spaces open again on Windows', fr: "Les worktrees dans un dossier avec des espaces s'ouvrent de nouveau sous Windows", t: 'WEB-176' }],
  [
    { k: 'feat', en: 'Each agent session gets its own worktree, so you keep working while it runs', fr: "Chaque session d'agent a son propre worktree : vous continuez à travailler pendant qu'il tourne", t: 'WEB-198' },
    { k: 'feat', en: 'Unplanned tickets get a suggested release', fr: 'Les tickets non planifiés reçoivent une version suggérée', t: 'WEB-203' },
    { k: 'feat', en: 'Hidden project commands fold into one pill in the terminal', fr: 'Les commandes de projet masquées se replient en une pastille dans le terminal' },
    { k: 'fix', en: 'Branches deleted on origin leave the tree on the next fetch', fr: "Les branches supprimées sur origin quittent l'arbre au fetch suivant", t: 'WEB-218' },
    { k: 'fix', en: 'Long branch names no longer push the row actions out of view', fr: 'Les noms de branche longs ne poussent plus les actions hors de la ligne', t: 'WEB-209' },
    { k: 'internal', en: 'Fetch runs with `--prune` every five minutes', fr: 'Le fetch tourne avec `--prune` toutes les cinq minutes' },
  ],
  [{ k: 'feat', en: 'A pulse travels down the path to the checked-out branch', fr: "Une pulsation parcourt le chemin jusqu'à la branche extraite", t: 'WEB-212' }],
];
const INCLUDE = [['feat', 'Features'], ['fix', 'Fixes'], ['internal', 'Internal changes'], ['tickets', 'Ticket links']] as const;

function write(items: Item[], version: string, tpl: string, lang: Lang, inc: Record<Kind | 'tickets', boolean>) {
  const shown = items.filter((i) => inc[i.k]);
  const line = (i: Item) => `${i[lang]}${inc.tickets && i.t ? ` (${i.t})` : ''}`;
  if (tpl === 'internal') return [`## ${version}`, '', ...shown.map((i) => `- ${i.k === 'internal' ? 'chore' : i.k}: ${line(i)}`)].join('\n');
  const heads = HEADS[tpl === 'github' ? 'github' : 'customer'][lang];
  const sections = (['feat', 'fix', 'internal'] as const).flatMap((k, j) => {
    const of = shown.filter((i) => i.k === k);
    return of.length ? ['', `### ${heads[j]}`, ...of.map((i) => `- ${line(i)}`)] : [];
  });
  return [`## ${version}`, ...sections].join('\n');
}

export default function ReleaseNotes() {
  const { flash } = useDemo();
  const later = useLater();
  const [from, setFrom] = useState('v0.5.2');
  const [to, setTo] = useState('release/0.6.0');
  const [tpl, setTpl] = useState('');
  const [lang, setLang] = useState<Lang>('en');
  const [inc, setInc] = useState({ feat: true, fix: true, internal: true, tickets: true });
  const [view, setView] = useState<'preview' | 'markdown'>('preview');
  const [md, setMd] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [a, b] = [AT[from], AT[to]];
  const error = a > b ? `${to} is behind ${from}: swap them to compare.` : '';
  const counts = COUNTS.slice(a, b).reduce<number[]>((s, c) => s.map((x, i) => x + c[i]), [0, 0, 0]);
  const version = to.startsWith('v') ? to : 'v0.6.0';
  const run = () => {
    setBusy(true);
    later(1400, () => {
      setBusy(false);
      setMd(write(ITEMS.slice(a, b).flat(), version, tpl, lang, inc));
      setModel('claude-sonnet-5-5');
    });
  };

  return (
    <>
      <aside aria-label="Options" className="sidenav" style={{ '--sidenav-w': '360px', gap: 24, padding: 24 } as CSSProperties}>
        <section className="col" style={{ gap: 10 }}>
          <h2 className="label">Range</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 32px minmax(0,1fr)', gap: 6, alignItems: 'end' }}>
            <div className="field">
              <label htmlFor="rn-from">From</label>
              <Choice id="rn-from" className="select menu-select mono" style={{ fontSize: 12 }} label="From" value={from} options={REFS} onChange={setFrom} />
            </div>
            <button className="btn btn-ghost btn-icon" style={{ height: 36 }} aria-label="Swap" onClick={() => { setFrom(to); setTo(from); }}>
              <Icon name="swap" />
            </button>
            <div className="field">
              <label htmlFor="rn-to">To</label>
              <Choice id="rn-to" className="select menu-select mono" style={{ fontSize: 12 }} label="To" value={to} options={REFS} onChange={setTo} />
            </div>
          </div>
          <div className="row note-box muted" style={{ gap: 14, fontSize: 12, background: 'var(--bg)' }}>
            {error ? (
              <span className="c-del">{error}</span>
            ) : (
              <>
                <span><strong style={{ color: 'var(--fg)' }}>{counts[0]}</strong> commits</span>
                <span><strong style={{ color: 'var(--fg)' }}>{counts[1]}</strong> merges</span>
                <span><strong style={{ color: 'var(--fg)' }}>{counts[2]}</strong> tickets</span>
              </>
            )}
          </div>
        </section>
        <section className="col" style={{ gap: 10 }}>
          <h2 className="label">Template</h2>
          <Choice className="select menu-select" label="Template" value={tpl} options={TEMPLATES} onChange={setTpl} />
          <Seg grid label="Language" value={lang} onChange={setLang} options={[['en', 'English'], ['fr', 'Français']]} />
        </section>
        <section className="col" style={{ gap: 4 }}>
          <h2 className="label" style={{ marginBottom: 6 }}>Include</h2>
          {INCLUDE.map(([k, l]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={inc[k]} onChange={() => setInc({ ...inc, [k]: !inc[k] })} />
              <span>{l}</span>
            </label>
          ))}
        </section>
        <span className="grow" />
        <button className="btn btn-primary btn-lg" disabled={!!error || !counts[0] || busy} onClick={run}>
          <Busy on={busy}><Icon name="sparkle" size={13} /></Busy>
          <span>Generate notes</span>
        </button>
      </aside>
      <main className="col grow" style={{ gap: 0, minWidth: 0, minHeight: 0 }}>
        <div className="row wrap" style={{ minHeight: 56, margin: 0, padding: '8px 24px', borderBottom: '1px solid var(--line)', gap: 12 }}>
          <Seg label="View" value={view} onChange={setView} options={[['preview', 'Preview'], ['markdown', 'Markdown']]} />
          {model && <span className="faint" style={{ fontSize: 12 }}>{model}</span>}
          <span className="grow" />
          <div className="row wrap" style={{ gap: 6, margin: 0 }}>
            <button className="btn" disabled={!md || busy} onClick={run}>
              <Icon name="refresh" size={12} />
              Regenerate
            </button>
            <button className="btn" disabled={!md} onClick={() => navigator.clipboard?.writeText(md).then(() => flash('Copied'))}>Copy</button>
            <button className="btn" disabled={!md} onClick={() => flash('Added to CHANGELOG.md')}>Add to CHANGELOG.md</button>
            <button className="btn btn-raised" disabled={!md} onClick={() => flash(`Published https://github.com/acme/acme-web/releases/tag/${version}`)}>Publish GitHub release</button>
          </div>
        </div>
        <div className="scroll" style={{ flex: '1 1 auto', padding: '40px 24px 64px' }}>
          <article style={{ maxWidth: 680, margin: '0 auto' }}>
            {!md && !busy && <EmptyState icon="sparkle" title="No notes yet">Pick a range and press Generate notes. AI reads the commits and linked tickets, using your release-notes template.</EmptyState>}
            {busy && <div className="empty"><span className="spinner" /></div>}
            {md && view === 'preview' && <Markdown text={md} />}
            {md && view === 'markdown' && (
              <>
                <label htmlFor="rn-md" className="sr-only">Markdown</label>
                <textarea id="rn-md" className="textarea mono" style={{ width: '100%', minHeight: 420, fontSize: 12.5 }} value={md} onChange={(e) => setMd(e.target.value)} />
              </>
            )}
          </article>
        </div>
      </main>
    </>
  );
}
