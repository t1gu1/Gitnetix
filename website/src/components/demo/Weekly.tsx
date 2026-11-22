import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { DoneTicket, WeeklyReport } from '../../../../src/api/types';
import { Icon } from '../../../../src/components/Icon';
import { downloadCsv, plural } from '../../../../src/lib/format';
import type { Pane } from './Analytics';
import { Ask, Card, day, FigStrip, NoteLayout, PageNote, r1, r2, rank, span, type Cell, type Qa } from './charts';
import { weekly } from './sprintData';
import { AssigneePicker, Avatar, Busy, Choice, Empty, useDemo, useLater } from './ui';

/** src/screens/Weekly.tsx over the made-up tickets of ./sprintData: Jira, Trello, Asana and GitHub issues, done per week, person and label. */

type Week = WeeklyReport['weeks'][number];

const WEEKS = ['8', '12', '26'];
const SUGGESTIONS = ['Is the team finishing more or less than before?', 'Who finished the most, and who the least?', 'Which weeks were slow?', 'How long do tickets take from created to done?', 'Which labels come up most, and are bugs going up?', 'Write a short summary for the team.'];

const SOURCE: Record<DoneTicket['source'], string> = { jira: 'Jira', trello: 'Trello', asana: 'Asana', linear: 'Linear', github: 'GitHub' };

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
export function Weekly({ ids, lead, header, trackers, pane, onPicked }: { ids: string[]; lead: ReactNode; header: (crumb?: string) => ReactNode; trackers: string; pane: Pane; onPicked: () => void }) {
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
  // The week shown (its Monday), and the person and label the ticket list is narrowed to.
  const [week, setWeek] = useState<string | null>(null);
  const [person, setPerson] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const controls = (
    <div className="map-bar ana-bar" data-detail={pane === 'detail' || undefined}>
      {lead}
      <Choice className="select menu-select" style={{ height: 32 }} label="Weeks shown" value={weeks} options={WEEKS.map((w) => ({ value: w, label: `Last ${w} weeks` }))} onChange={setWeeks} />
      <AssigneePicker everyone={everyone} who={who} onChange={setWho} />
      <span className="grow" />
      <span className="hint hide-narrow">Synced 4 min ago</span>
      <button className="btn btn-sm btn-icon" aria-label="Sync now" title="Sync now · synced 4 min ago" onClick={() => { setSyncing(true); later(900, () => { setSyncing(false); flash(`Synced with ${trackers}`); }); }}>
        <Busy on={syncing}><Icon name="refresh" size={13} /></Busy>
      </button>
      <button className="btn btn-sm" disabled={!r.tickets.length} onClick={() => setAsking(true)}>
        <Icon name="sparkle" size={12} className="c-acc" />
        Ask AI
      </button>
      <button className="btn btn-sm hide-narrow" onClick={() => downloadCsv(`gitnetix-done-per-week-${weeks}w.csv`, doneRows(r))}>
        <Icon name="download" size={12} />
        Export CSV
      </button>
    </div>
  );

  let body: ReactNode;
  let crumb: string | undefined;
  if (!r.tickets.length) {
    body = (
      <NoteLayout rail="Weeks">
        <PageNote
          title="Nothing done in these weeks"
          facts={[['Trackers', trackers], ['Weeks shown', `The last ${weeks}`], ['Counted', who.length ? who.join(', ') : 'Everyone']]}
          actions={
            <>
              {who.length > 0 && data.tickets.length ? <button className="btn btn-sm btn-primary" onClick={() => setWho([])}>Show everyone</button> : null}
              {weeks !== '26' && <button className="btn btn-sm" onClick={() => setWeeks('26')}>Show 26 weeks</button>}
            </>
          }
        >
          <p>No ticket was finished {who.length ? 'by the people picked ' : ''}in these weeks. A ticket counts in the week it was moved to done.</p>
        </PageNote>
      </NoteLayout>
    );
  } else {
    const w = r.weeks;
    // Nothing picked yet: the last full week, or this one when it is the only one.
    const at = Math.max(0, w.findIndex((x) => x.start === week) >= 0 ? w.findIndex((x) => x.start === week) : w.length - 2);
    const shown = w[at];
    crumb = `Week of ${weekLabel(shown.start)}`;
    const go = (i: number) => { setWeek(w[i].start); setPerson(null); setLabel(null); };
    body = (
      <div className="body split ana">
        <WeekRail r={r} at={at} onPick={(i) => { go(i); onPicked(); }} active={pane === 'rail'} />
        <main className="detail ana-det spr" data-pane data-active={pane === 'detail'}>
          <div className="hide-narrow"><Figures r={r} /></div>
          <WeekHead r={r} at={at} onGo={go} />
          <div className="spr-grid2 even">
            <WeekPeople r={r} at={at} person={person} onPick={(n) => setPerson(n === person ? null : n)} />
            <WeekLabels r={r} at={at} label={label} onPick={(l) => setLabel(l === label ? null : l)} />
          </div>
          <DoneList r={r} week={shown.start} only={person} label={label} onClear={() => { setPerson(null); setLabel(null); }} />
        </main>
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
      {header(crumb)}
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

/** Tickets done in a full week on average: the running week left out. */
function average(r: WeeklyReport) {
  const full = r.weeks.slice(0, -1);
  return full.length ? full.reduce((a, x) => a + x.done, 0) / full.length : null;
}

function Figures({ r }: { r: WeeklyReport }) {
  const w = r.weeks;
  const cur = w[w.length - 1];
  const prev = w[w.length - 2];
  const full = w.slice(0, -1);
  const avg = average(r) ?? 0;
  const best = full.reduce<Week | undefined>((b, x) => (!b || x.done > b.done ? x : b), undefined);
  const leads = r.tickets.flatMap((t) => (t.leadHours != null ? [t.leadHours] : [])).sort((a, b) => a - b);
  const lead = rank(leads, 0.5);
  const people = totals(r);
  const bugs = r.tickets.filter(isBug).length;
  return (
    <FigStrip
      items={[
        { label: 'Done this week', value: String(cur.done), sub: prev ? `${prev.done} last week` : 'First week shown' },
        { label: 'Weekly average', value: String(r1(avg)), sub: `Over ${plural(full.length, 'full week')}` },
        { label: 'Best week', value: String(best?.done ?? 0), sub: best ? weekLabel(best.start) : 'No full week yet' },
        { label: 'Created to done', value: lead == null ? '–' : span(lead), sub: 'Half the tickets took less' },
        ...(bugs ? [{ label: 'Bugs fixed', value: String(bugs), sub: `${Math.round((bugs / r.tickets.length) * 100)}% of the tickets done` }] : [{ label: 'People', value: String(people.length), sub: people[0] ? `${people[0][0]} finished the most` : '' }]),
        ...(r.points ? [{ label: 'Points done', value: String(r1(w.reduce((a, x) => a + x.points, 0))), sub: 'In the weeks shown' }] : []),
      ]}
    />
  );
}

/** The weeks shown, newest first: each row its tickets done, marked at the average, a slow week and the running one named. */
function WeekRail({ r, at, onPick, active }: { r: WeeklyReport; at: number; onPick: (i: number) => void; active: boolean }) {
  const w = r.weeks;
  const n = w.length;
  const avg = average(r);
  const max = Math.max(1, ...w.map((x) => x.done), avg ?? 0);
  const total = w.reduce((a, x) => a + x.done, 0);
  return (
    <section className="master ana-rail" data-pane data-active={active} aria-label="Weeks">
      <div className="show-narrow ana-rail-head"><Figures r={r} /></div>
      <div className="ana-rh">
        <h3>Weeks</h3>
        <span className="hint">{total} done in {plural(n, 'week')}</span>
      </div>
      {[...w].map((x, i) => ({ x, i })).reverse().map(({ x, i }) => {
        const running = i === n - 1;
        const slow = !running && avg != null && x.done < avg * 0.6;
        return (
          <button key={x.start} className="ana-row ana-week" data-soft={running || undefined} aria-pressed={i === at} aria-label={`Week of ${weekLabel(x.start)}: ${plural(x.done, 'ticket')} done${running ? ', still running' : slow ? ', a slow week' : ''}`} onClick={() => onPick(i)}>
            <span className="ana-row-l">{weekLabel(x.start)}</span>
            <span className="ana-track">
              <span className="ana-fill" style={{ '--w': x.done / max } as CSSProperties} />
              {avg != null && <span className="ana-avg" style={{ '--w': avg / max } as CSSProperties} />}
              {(running || slow) && <span className="ana-note">{running ? 'running' : 'slow'}</span>}
            </span>
            <span className="ana-n">{x.done}</span>
          </button>
        );
      })}
      <div className="ana-legend">
        <span className="ana-key"><i />Tickets done</span>
        {avg != null && <span className="ana-key"><i data-dash />Average {r1(avg)} a full week</span>}
        <span className="ana-key"><i data-soft />This week, still running</span>
        <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => downloadCsv('gitnetix-done-per-week.csv', weekRows(r))}>
          <Icon name="download" size={12} />
          CSV of the weeks
        </button>
      </div>
    </section>
  );
}

/** The week shown: its count against the average, and steps to the weeks around it. */
function WeekHead({ r, at, onGo }: { r: WeeklyReport; at: number; onGo: (i: number) => void }) {
  const x = r.weeks[at];
  const avg = average(r);
  const running = at === r.weeks.length - 1;
  const diff = avg == null ? null : r1(x.done - avg);
  return (
    <div className="ana-dh">
      <h3>Week of {weekLabel(x.start)}</h3>
      <span className="muted">
        {plural(x.done, 'ticket')} done{r.points && x.points ? ` · ${r1(x.points)} pts` : ''}
        {running ? ' so far' : diff == null ? '' : Math.abs(diff) < 0.05 ? ' · on the average' : ` · ${Math.abs(diff)} ${diff > 0 ? 'above' : 'below'} the average`}
      </span>
      <span className="grow" />
      <button className="btn btn-sm" disabled={at === 0} onClick={() => onGo(at - 1)}><Icon name="chevronLeft" size={12} />Previous week</button>
      <button className="btn btn-sm" disabled={running} onClick={() => onGo(at + 1)}>Next week<Icon name="chevronRight" size={12} /></button>
    </div>
  );
}

/** Each person's tickets done in the week shown, with a strip of their weeks (this one outlined). Picking one narrows the list. */
function WeekPeople({ r, at, person, onPick }: { r: WeeklyReport; at: number; person: string | null; onPick: (name: string) => void }) {
  const x = r.weeks[at];
  const count = (w: Week, name: string) => w.people.find(([n]) => n === name)?.[1] ?? 0;
  const people = totals(r).map(([name, total]) => ({ name, total, now: count(x, name) })).sort((a, b) => b.now - a.now || b.total - a.total);
  const top = Math.max(1, ...people.map((p) => p.now));
  const cell = Math.max(1, ...r.weeks.flatMap((w) => w.people.map(([, c]) => c)));
  return (
    <Card title="People" hint={`Done in the week · the strip is their ${plural(r.weeks.length, 'week')}, this one outlined. Pick a person to list theirs.`} rows={personRows(r)} file="gitnetix-done-per-person.csv">
      <div className="col" style={{ gap: 0 }}>
        {people.map((p) => (
          <button key={p.name} className="ana-wp" aria-pressed={person === p.name} onClick={() => onPick(p.name)} aria-label={`${p.name}: ${plural(p.now, 'ticket')} this week, ${p.total} in the weeks shown`}>
            <Avatar name={p.name} size={22} decorative />
            <span className="ana-pr-n">
              <span className="ellipsis">{p.name}</span>
              <span className="hint">{p.total} in {plural(r.weeks.length, 'week')}</span>
            </span>
            <span className="ana-meter"><span style={{ width: `${(p.now / top) * 100}%` }} /></span>
            <span className="mono ana-pr-v"><b>{p.now}</b></span>
            <span className="ana-strip" aria-hidden="true">
              {r.weeks.map((w, i) => {
                const c = count(w, p.name);
                return <i key={w.start} data-on={i === at || undefined} style={{ background: c ? `color-mix(in srgb, var(--fg) ${Math.round(18 + (c / cell) * 72)}%, var(--panel))` : undefined }} />;
              })}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** Labels of the tickets done in the week shown, over their count in all the weeks. Picking one narrows the list. */
function WeekLabels({ r, at, label, onPick }: { r: WeeklyReport; at: number; label: string | null; onPick: (l: string) => void }) {
  const week = r.weeks[at].start;
  const all = new Map<string, { total: number; now: number }>();
  for (const t of r.tickets)
    for (const l of t.labels ?? []) {
      const e = all.get(l) ?? { total: 0, now: 0 };
      e.total += 1;
      if (t.week === week) e.now += 1;
      all.set(l, e);
    }
  if (!all.size) return null;
  const list = [...all].sort((a, b) => b[1].now - a[1].now || b[1].total - a[1].total || a[0].localeCompare(b[0]));
  const top = list.slice(0, 10);
  const max = Math.max(...top.map(([, e]) => e.total));
  const none = r.tickets.filter((t) => t.week === week && !t.labels?.length).length;
  return (
    <Card title="Labels" hint={`This week in ink over all the weeks in grey. Pick one to list its tickets.${none ? ` ${plural(none, 'ticket')} this week without a label.` : ''}`} rows={[['Label', 'Tickets done this week', 'Tickets done in the weeks shown'], ...list.map(([l, e]): Cell[] => [l, e.now, e.total])]} file="gitnetix-done-by-label.csv">
      <div className="col" style={{ gap: 0 }}>
        {top.map(([l, e]) => (
          <button key={l} className="ana-lb" aria-pressed={label === l} onClick={() => onPick(l)} aria-label={`${l}: ${e.now} this week, ${e.total} in the weeks shown`}>
            <span className="ellipsis">{l}</span>
            <span className="ana-lb-t">
              <span className="ana-lb-all" style={{ width: `${(e.total / max) * 100}%` }} />
              <span className="ana-lb-now" style={{ width: `${(e.now / max) * 100}%` }} />
            </span>
            <span className="mono ana-pr-v"><b>{e.now}</b></span>
            <span className="hint ana-lb-r">{e.total} in all</span>
          </button>
        ))}
        {list.length > top.length && <span className="faint" style={{ fontSize: 12, paddingTop: 6 }}>The CSV holds all {list.length} labels.</span>}
      </div>
    </Card>
  );
}

/** The tickets done in the week shown, newest first; one person's when one is picked, one label's when a label is. */
function DoneList({ r, week, only, label, onClear }: { r: WeeklyReport; week: string; only: string | null; label: string | null; onClear: () => void }) {
  const { flash } = useDemo();
  const list = r.tickets.filter((t) => t.week === week && (!only || t.assignee === only) && (!label || t.labels?.includes(label)));
  const multi = new Set(r.tickets.map((t) => t.place)).size > 1;
  const picked = [only, label && `Label “${label}”`].filter(Boolean).join(' · ');
  return (
    <Card
      title="Tickets done"
      hint={`${plural(list.length, 'ticket')} in the week of ${weekLabel(week)}${picked ? ` · ${picked}` : ''}`}
      rows={doneRows(r)}
      file="gitnetix-tickets-done.csv"
      table={false}
      right={picked && <button className="btn btn-sm" onClick={onClear}><Icon name="close" size={11} />Everyone's, all labels</button>}
    >
      {list.length === 0 ? (
        <Empty>{picked ? 'None this week with these picks.' : 'Nothing done this week yet.'}</Empty>
      ) : (
        <div className="col" style={{ gap: 0 }}>
          {list.slice(0, 200).map((t) => (
            <div key={`${t.source}:${t.key}`} className="ana-tk ana-done">
              <span className="tk-ring" data-status="done" aria-label="Done" />
              <button className="spr-keylink" onClick={() => flash(`Opens ${t.key} in ${SOURCE[t.source]}`)} title={`Open it in ${SOURCE[t.source]}`}>{t.key}</button>
              <span className="ellipsis ana-tk-t" title={t.title}>{t.title}</span>
              <span className="faint ellipsis ana-tk-l" title={(t.labels ?? []).join(', ')}>{(t.labels ?? []).join(', ')}</span>
              <span className="muted ellipsis ana-tk-w" title={t.place}>{multi ? t.place : SOURCE[t.source]}</span>
              <Avatar name={t.assignee} size={18} />
              <span className="mono faint ana-tk-n" title="From when it was created to when it was done">{t.leadHours == null ? '–' : span(t.leadHours)}</span>
              <span className="faint ana-tk-age">{day(t.doneAt, { weekday: 'short' })}</span>
            </div>
          ))}
          {list.length > 200 && <span className="faint" style={{ paddingTop: 8 }}>The CSV holds all {list.length}.</span>}
        </div>
      )}
    </Card>
  );
}
