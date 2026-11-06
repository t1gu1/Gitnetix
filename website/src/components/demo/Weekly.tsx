import { useMemo, useState, type ReactNode } from 'react';
import type { WeeklyReport } from '../../../../src/api/types';
import { Icon } from '../../../../src/components/Icon';
import { downloadCsv, plural } from '../../../../src/lib/format';
import { Ask, Card, day, heat, Key, niceMax, r1, r2, rank, span, ticks, tipAt, TipRow, type Cell, type Qa } from './charts';
import { weekly } from './sprintData';
import { AssigneePicker, Avatar, Busy, Choice, Empty, EmptyState, useDemo, useLater } from './ui';

/** src/screens/Weekly.tsx over the made-up tickets of ./sprintData: Jira, Trello, Asana and GitHub issues, done per week, person and label. */

type Week = WeeklyReport['weeks'][number];

const WEEKS = ['8', '12', '26'];
const SUGGESTIONS = ['Is the team finishing more or less than before?', 'Who finished the most, and who the least?', 'Which weeks were slow?', 'How long do tickets take from created to done?', 'Which labels come up most, and are bugs going up?', 'Write a short summary for the team.'];

/** A bug by its type: "Bug", "Bogue", or a GitHub issue labelled as one. */
const isBug = (t: { kind: string }) => /bug|bogue|défaut|defect/i.test(t.kind);

/** "Nov 2 – 8", or "Oct 26 – Nov 1" across two months, for the week starting `monday`. */
function weekLabel(monday: string) {
  const start = new Date(`${monday}T12:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${day(monday)} – ${end.toLocaleDateString('en-US', end.getMonth() === start.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
}

/** `r` with only the tickets of `who`, its weeks counted again from them, as the backend counts them. */
function ofPeople(r: WeeklyReport, who: string[]): WeeklyReport {
  const tickets = r.tickets.filter((t) => who.includes(t.assignee));
  const weeks = r.weeks.map((w): Week => {
    const mine = tickets.filter((t) => t.week === w.start);
    const people = new Map<string, number>();
    for (const t of mine) people.set(t.assignee, (people.get(t.assignee) ?? 0) + 1);
    return { start: w.start, done: mine.length, points: mine.reduce((a, t) => a + (t.points ?? 0), 0), people: [...people].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
  });
  return { ...r, tickets, weeks };
}

function weekRows(r: WeeklyReport): Cell[][] {
  return [['Week (Monday)', 'Tickets done', 'Points done', 'People'], ...r.weeks.map((w): Cell[] => [w.start, w.done, r2(w.points), w.people.map(([n, c]) => `${n} (${c})`).join('; ')])];
}

function personRows(r: WeeklyReport): Cell[][] {
  return [['Week (Monday)', 'Person', 'Tickets done'], ...r.weeks.flatMap((w) => w.people.map(([n, c]): Cell[] => [w.start, n, c]))];
}

function doneRows(r: WeeklyReport): Cell[][] {
  return [
    ['Key', 'Title', 'Tracker', 'Where', 'Type', 'Labels', 'Assignee', 'Done', 'Week (Monday)', 'Created', 'Created to done (h)', 'Points', 'URL'],
    ...r.tickets.map((t): Cell[] => [t.key, t.title, t.source, t.place, t.kind, (t.labels ?? []).join('; '), t.assignee, t.doneAt, t.week, t.created, t.leadHours == null ? null : r2(t.leadHours), t.points, t.url]),
  ];
}

/** Tickets done per week and per person, from every tracker the chosen projects show tickets from. */
export function Weekly({ ids, lead, trackers }: { ids: string[]; lead: ReactNode; trackers: string }) {
  const { flash } = useDemo();
  const later = useLater();
  const [weeks, setWeeks] = useState('12');
  // Tracker names of the people counted; empty means everyone.
  const [who, setWho] = useState<string[]>([]);
  const data = useMemo(() => weekly(ids, Number(weeks)), [ids, weeks]);
  const everyone = useMemo(() => [...new Set(data.tickets.map((t) => t.assignee))].sort((a, b) => Number(a === 'Unassigned') - Number(b === 'Unassigned') || a.localeCompare(b)), [data]);
  const r = useMemo(() => (who.length ? ofPeople(data, who) : data), [data, who]);
  const [asking, setAsking] = useState(false);
  const [chat, setChat] = useState<Qa[]>([]);
  const [only, setOnly] = useState<{ name: string; week: string } | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const controls = (
    <div className="row wrap" style={{ margin: 0, gap: 12 }}>
      {lead}
      <Choice className="select menu-select" style={{ height: 32 }} label="Weeks shown" value={weeks} options={WEEKS.map((w) => ({ value: w, label: `Last ${w} weeks` }))} onChange={setWeeks} />
      <AssigneePicker everyone={everyone} who={who} onChange={setWho} />
      <span className="grow" />
      <button className="btn btn-icon" aria-label="Sync now" title="Sync now · synced 4 min ago" onClick={() => { setSyncing(true); later(900, () => { setSyncing(false); flash(`Synced with ${trackers}`); }); }}>
        <Busy on={syncing}><Icon name="refresh" size={13} /></Busy>
      </button>
      <button className="btn" disabled={!r.tickets.length} onClick={() => setAsking(true)}>
        <Icon name="sparkle" size={12} className="c-acc" />
        Ask AI
      </button>
      <button className="btn" onClick={() => downloadCsv(`gitnetix-done-per-week-${weeks}w.csv`, doneRows(r))}>Export CSV</button>
    </div>
  );

  let body: ReactNode;
  if (!r.tickets.length) {
    body = (
      <EmptyState icon="chart" title="Nothing done in these weeks" action={who.length > 0 && data.tickets.length ? <button className="btn btn-md" onClick={() => setWho([])}>Show everyone</button> : undefined}>
        No ticket was finished {who.length ? 'by the people picked ' : ''}in {trackers} over the last {weeks} weeks.
      </EmptyState>
    );
  } else {
    body = (
      <div className="col spr" style={{ gap: 16 }}>
        <Figures r={r} />
        <PerWeek r={r} />
        <PerPerson r={r} only={only} onPick={setOnly} />
        <ByLabel r={r} label={label} onPick={(l) => setLabel(l === label ? null : l)} />
        <DoneList r={r} only={only} label={label} onClear={() => { setOnly(null); setLabel(null); }} />
        {asking && (
          <Ask
            title="Ask about these weeks"
            sub={`Answers come from the tickets done in ${trackers} over the last ${weeks} weeks`}
            intro="Ask anything about the tickets done, or start with one of these:"
            suggestions={SUGGESTIONS}
            chat={chat}
            setChat={setChat}
            onClose={() => setAsking(false)}
            answer={(q) => answer(q, r)}
          />
        )}
      </div>
    );
  }
  return (
    <>
      {controls}
      {body}
    </>
  );
}

/** What the AI CLI would say about the weeks on screen, for the suggested questions. */
function answer(q: string, r: WeeklyReport) {
  const w = r.weeks;
  const full = w.slice(0, -1);
  const avg = full.reduce((a, x) => a + x.done, 0) / Math.max(1, full.length);
  const halfway = Math.floor(full.length / 2);
  const mean = (xs: Week[]) => xs.reduce((a, x) => a + x.done, 0) / Math.max(1, xs.length);
  const people = totals(r);
  const labels = new Map<string, number>();
  for (const t of r.tickets) for (const l of t.labels ?? []) labels.set(l, (labels.get(l) ?? 0) + 1);
  const top = [...labels].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const bugs = (xs: Week[]) => r.tickets.filter((t) => isBug(t) && xs.some((x) => x.start === t.week)).length;
  const leads = r.tickets.flatMap((t) => (t.leadHours != null ? [t.leadHours] : [])).sort((a, b) => a - b);
  switch (SUGGESTIONS.indexOf(q)) {
    case 0: {
      const [a, b] = [mean(full.slice(0, halfway)), mean(full.slice(halfway))];
      return `**${b > a * 1.05 ? 'More.' : b < a * 0.95 ? 'Less.' : 'About the same.'}** The last ${plural(full.length - halfway, 'full week')} averaged ${r1(b)} tickets done a week, against ${r1(a)} in the ${plural(halfway, 'week')} before. This week has ${w[w.length - 1].done} so far.`;
    }
    case 1:
      return `Tickets done in the weeks shown:\n\n${people.map(([n, c]) => `- **${n}**: ${c}`).join('\n')}\n\nCounts are tickets, not effort: a person on fewer, larger tickets finishes fewer.`;
    case 2: {
      const slow = full.filter((x) => x.done < avg * 0.6);
      return slow.length ? `Weeks under 60% of the ${r1(avg)} average:\n\n${slow.map((x) => `- Week of ${weekLabel(x.start)}: ${x.done} done`).join('\n')}` : `No full week fell under 60% of the ${r1(avg)} average.`;
    }
    case 3:
      return leads.length ? `Half the tickets took less than **${span(rank(leads, 0.5)!)}** from created to done, and 85% less than ${span(rank(leads, 0.85)!)}. The slowest took ${span(leads[leads.length - 1])}.` : 'No ticket done in these weeks has a creation date.';
    case 4:
      return `${top.length ? `Most common labels:\n\n${top.map(([l, c]) => `- **${l}**: ${c}`).join('\n')}` : 'No ticket done in these weeks has a label.'}\n\nBugs fixed: ${bugs(full.slice(halfway))} in the last ${plural(full.length - halfway, 'full week')}, against ${bugs(full.slice(0, halfway))} in the ${plural(halfway, 'week')} before.`;
    case 5:
      return `**Last ${plural(w.length, 'week')} in ${r.sources.join(', ')}**\n\n- ${plural(r.tickets.length, 'ticket')} done, ${r1(avg)} a full week on average\n- ${people[0] ? `${people[0][0]} finished the most (${people[0][1]})` : 'No one finished a ticket'}\n- ${plural(r.tickets.filter(isBug).length, 'bug')} fixed${top[0] ? `\n- Most common label: ${top[0][0]}` : ''}`;
    default:
      return 'This demo answers the suggested questions. In Gitnetix, your AI CLI reads the weeks on screen and answers any question about them.';
  }
}

/** Who finished what, over all the weeks shown, most first. */
function totals(r: WeeklyReport) {
  const m = new Map<string, number>();
  for (const w of r.weeks) for (const [n, c] of w.people) m.set(n, (m.get(n) ?? 0) + c);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function Figures({ r }: { r: WeeklyReport }) {
  const w = r.weeks;
  const cur = w[w.length - 1];
  const prev = w[w.length - 2];
  const full = w.slice(0, -1);
  const avg = full.length ? full.reduce((a, x) => a + x.done, 0) / full.length : 0;
  const best = full.reduce<Week | undefined>((b, x) => (!b || x.done > b.done ? x : b), undefined);
  const leads = r.tickets.flatMap((t) => (t.leadHours != null ? [t.leadHours] : [])).sort((a, b) => a - b);
  const lead = rank(leads, 0.5);
  const people = totals(r);
  const bugs = r.tickets.filter(isBug).length;
  const tiles: { label: string; value: string; sub: string; tone?: boolean }[] = [
    { label: 'Done this week', value: String(cur.done), sub: prev ? `${prev.done} last week` : 'First week shown' },
    { label: 'Weekly average', value: String(r1(avg)), sub: `Over ${plural(full.length, 'full week')}` },
    { label: 'Best week', value: String(best?.done ?? 0), sub: best ? `Week of ${weekLabel(best.start)}` : 'No full week yet' },
    { label: 'Created to done', value: lead == null ? '–' : span(lead), sub: 'Half the tickets took less' },
    { label: 'People', value: String(people.length), sub: people[0] ? `${people[0][0]} finished the most` : '' },
    ...(r.points ? [{ label: 'Points done', value: String(r1(w.reduce((a, x) => a + x.points, 0))), sub: 'In the weeks shown' }] : []),
    ...(bugs ? [{ label: 'Bugs fixed', value: String(bugs), sub: `${Math.round((bugs / r.tickets.length) * 100)}% of the tickets done` }] : []),
  ];
  return (
    <section aria-label="Key figures" className="kpis spr-kpis">
      {tiles.map((t) => (
        <div key={t.label} className="kpi">
          <span className="muted" style={{ fontSize: 12 }}>{t.label}</span>
          <span className="v">{t.value}</span>
          <span className="spr-delta faint">{t.sub}</span>
        </div>
      ))}
    </section>
  );
}

/** Tickets done each week around the average of the finished weeks. */
function PerWeek({ r }: { r: WeeklyReport }) {
  const [hi, setHi] = useState(-1);
  const w = r.weeks;
  const n = w.length;
  const full = w.slice(0, -1);
  const avg = full.length ? full.reduce((a, x) => a + x.done, 0) / full.length : null;
  const max = niceMax(Math.max(1, ...w.map((x) => x.done)));
  const h = hi >= 0 ? w[hi] : null;
  const every = n > 13 ? 2 : 1;
  return (
    <Card title="Tickets done per week" hint="Finished tickets each week, Monday to Sunday. This week is still running." rows={weekRows(r)} file="gitnetix-done-per-week.csv">
      <div className="spr-legend">
        <Key kind="s1" label="Done" />
        {avg != null && <Key kind="avg" label={`Average ${r1(avg)} a week`} />}
      </div>
      <div className="chart spr-chart tall">
        <div className="chart-y">{ticks(max).map((t) => <span key={t.top} style={{ top: `${t.top}%` }}>{r1(t.v)}</span>)}</div>
        <div className="chart-plot spr-plot spr-bars" onMouseLeave={() => setHi(-1)}>
          {ticks(max).map((t) => <div key={t.top} className="spr-grid" style={{ top: `${t.top}%` }} />)}
          {avg != null && <div className="spr-avg" style={{ bottom: `${(avg / max) * 100}%` }} />}
          {w.map((x, i) => {
            const low = avg != null && i < n - 1 && x.done < avg * 0.6;
            return (
              <button key={x.start} className={`spr-slot${hi >= 0 && hi !== i ? ' dim' : ''}`} aria-label={`Week of ${weekLabel(x.start)}: ${plural(x.done, 'ticket')} done`} onMouseEnter={() => setHi(i)} onFocus={() => setHi(i)} onBlur={() => setHi(-1)}>
                <span className={`spr-bar s1 wide${i === n - 1 ? ' running' : ''}`} style={{ height: `${(x.done / max) * 100}%` }}>
                  {low && <span className="spr-flag"><Icon name="alert" size={11} /></span>}
                </span>
              </button>
            );
          })}
          {h && (
            <div className="chart-tip" style={tipAt(hi, n)}>
              <div className="row" style={{ margin: 0 }}>
                <strong className="grow">Week of {weekLabel(h.start)}</strong>
                {hi === n - 1 && <span className="faint">so far</span>}
              </div>
              <TipRow kind="s1" value={String(h.done)} label={`${h.done === 1 ? 'ticket' : 'tickets'} done${r.points && h.points ? ` · ${r1(h.points)} pts` : ''}`} />
              {avg != null && hi < n - 1 && (
                <span className={`row ${h.done < avg * 0.6 ? 'c-warn' : 'muted'}`} style={{ gap: 6, margin: 0 }}>
                  {h.done < avg * 0.6 && <Icon name="alert" size={11} />}
                  {Math.abs(h.done - avg) < 0.05 ? 'On the average' : `${Math.round((Math.abs(h.done - avg) / avg) * 100)}% ${h.done > avg ? 'above' : 'below'} the average`}
                </span>
              )}
              {h.people.slice(0, 6).map(([name, c]) => (
                <div key={name} className="row" style={{ gap: 8, margin: 0 }}>
                  <Avatar name={name} size={16} />
                  <span className="grow ellipsis">{name}</span>
                  <span className="mono">{c}</span>
                </div>
              ))}
              {h.people.length > 6 && <span className="faint">+ {h.people.length - 6} more</span>}
            </div>
          )}
        </div>
        <div className="spr-xl">{w.map((x, i) => <span key={x.start} className={i === n - 1 ? 'sel' : undefined}>{i % every === 0 || i === n - 1 ? day(x.start) : ''}</span>)}</div>
      </div>
    </Card>
  );
}

/** Tickets each person finished each week: darker is more. Picking a cell lists those tickets below. */
function PerPerson({ r, only, onPick }: { r: WeeklyReport; only: { name: string; week: string } | null; onPick: (o: { name: string; week: string }) => void }) {
  const people = totals(r);
  const top = Math.max(1, ...r.weeks.flatMap((w) => w.people.map(([, c]) => c)));
  return (
    <Card title="Done per person and week" hint="Darker means more tickets finished. Pick a cell to list them." rows={personRows(r)} file="gitnetix-done-per-person.csv" table={false}>
      <div className="spr-heat-wrap">
        <table className="spr-heat weeks">
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>Person</th>
              {r.weeks.map((w, i) => <th key={w.start} scope="col" title={`Week of ${weekLabel(w.start)}`} className={i === r.weeks.length - 1 ? 'sel' : undefined}>{day(w.start)}</th>)}
              <th scope="col" className="spr-total">All</th>
            </tr>
          </thead>
          <tbody>
            {people.map(([name, total]) => (
              <tr key={name}>
                <th scope="row">
                  <span className="row" style={{ gap: 8, margin: 0 }}>
                    <Avatar name={name} size={20} />
                    <span className="ellipsis">{name}</span>
                  </span>
                </th>
                {r.weeks.map((w) => {
                  const c = w.people.find(([n]) => n === name)?.[1] ?? 0;
                  const on = only?.name === name && only.week === w.start;
                  return (
                    <td key={w.start}>
                      {c ? (
                        <button className={`spr-cell${on ? ' on' : ''}`} style={heat(c / top)} title={`${name}, week of ${weekLabel(w.start)}: ${plural(c, 'ticket')}`} onClick={() => onPick({ name, week: w.start })}>
                          <strong>{c}</strong>
                        </button>
                      ) : (
                        <span className="spr-none-cell" aria-label="None" />
                      )}
                    </td>
                  );
                })}
                <td className="spr-total"><strong>{total}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Tickets done per Jira or GitHub label, most first. Picking one lists its tickets below. */
function ByLabel({ r, label, onPick }: { r: WeeklyReport; label: string | null; onPick: (l: string) => void }) {
  const m = new Map<string, number>();
  for (const t of r.tickets) for (const l of t.labels ?? []) m.set(l, (m.get(l) ?? 0) + 1);
  if (!m.size) return null;
  const all = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = all.slice(0, 12);
  const none = r.tickets.filter((t) => !t.labels?.length).length;
  return (
    <Card
      title="Done by label"
      hint={`Pick a label to list its tickets.${none ? ` ${plural(none, 'ticket')} without a label.` : ''}`}
      rows={[['Label', 'Tickets done'], ...all.map(([l, c]): Cell[] => [l, c])]}
      file="gitnetix-done-by-label.csv"
    >
      <div className="col" style={{ gap: 4 }}>
        {top.map(([l, c]) => (
          <button key={l} className="spr-hbar spr-hbar-btn" aria-pressed={label === l} title={`${l}: ${plural(c, 'ticket')} · ${Math.round((c / r.tickets.length) * 100)}% of the tickets done`} onClick={() => onPick(l)}>
            <span className="ellipsis">{l}</span>
            <span className="spr-hbar-bar" style={{ width: `${Math.max(2, (c / top[0][1]) * 100)}%` }}>
              <span className="done" style={{ flexGrow: 1 }} />
            </span>
            <span className="mono faint">{c}</span>
          </button>
        ))}
        {all.length > top.length && <span className="faint" style={{ fontSize: 12 }}>The CSV holds all {all.length} labels.</span>}
      </div>
    </Card>
  );
}

/** The tickets done, newest first; one person's week when a cell is picked, one label's when a label is. */
function DoneList({ r, only, label, onClear }: { r: WeeklyReport; only: { name: string; week: string } | null; label: string | null; onClear: () => void }) {
  const { flash } = useDemo();
  const SRC = { jira: 'Jira', trello: 'Trello', asana: 'Asana', github: 'GitHub' };
  const list = r.tickets.filter((t) => (!only || (t.assignee === only.name && t.week === only.week)) && (!label || t.labels?.includes(label)));
  const multi = new Set(r.tickets.map((t) => t.place)).size > 1;
  const labels = r.tickets.some((t) => t.labels?.length);
  const picked = [only && `${only.name}, week of ${weekLabel(only.week)}`, label && `Label “${label}”`].filter(Boolean).join(' · ');
  return (
    <Card
      title="Tickets done"
      hint={picked || `${plural(r.tickets.length, 'ticket')} in the weeks shown`}
      rows={doneRows(r)}
      file="gitnetix-tickets-done.csv"
      table={false}
      right={picked && <button className="btn btn-sm" onClick={onClear}><Icon name="close" size={11} />All tickets</button>}
    >
      {list.length === 0 ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <div className="spr-table-wrap">
          <table className="table spr-tickets">
            <thead>
              <tr>
                <th>Key</th>
                <th>Title</th>
                {multi && <th>Where</th>}
                {labels && <th>Labels</th>}
                <th>Assignee</th>
                <th>Done</th>
                <th className="num" title="From when it was created to when it was done">Created to done</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 200).map((t) => (
                <tr key={`${t.source}:${t.key}`}>
                  <td><button className="spr-keylink" onClick={() => flash(`Opens ${t.key} in ${SRC[t.source]}`)} title="Open it">{t.key}</button></td>
                  <td><span className="ellipsis" title={t.title}>{t.title}</span></td>
                  {multi && <td className="muted">{t.place}</td>}
                  {labels && (
                    <td>
                      <span className="row" style={{ gap: 4, margin: 0, flexWrap: 'nowrap' }}>
                        {(t.labels ?? []).slice(0, 3).map((l) => <span key={l} className="tag tk-label">{l}</span>)}
                        {(t.labels?.length ?? 0) > 3 && <span className="faint">+{t.labels!.length - 3}</span>}
                      </span>
                    </td>
                  )}
                  <td>
                    <span className="row" style={{ gap: 6, margin: 0 }}>
                      <Avatar name={t.assignee} size={18} />
                      <span className="ellipsis">{t.assignee}</span>
                    </span>
                  </td>
                  <td className="faint">{day(t.doneAt)}</td>
                  <td className="num">{t.leadHours == null ? '–' : span(t.leadHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.length > 200 && <div className="faint" style={{ padding: '10px 20px' }}>The CSV holds all {list.length}.</div>}
        </div>
      )}
    </Card>
  );
}
