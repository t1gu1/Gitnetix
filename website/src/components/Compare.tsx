import { REPO, longDate, releases, u } from '../lib/changelog';

/** The day every claim below was checked against the vendors' own sites. Re-check before changing it. */
export const CHECKED = '2026-10-25';

const APPS = ['Gitnetix', 'GitKraken', 'Fork', 'Sourcetree'];

type Mark = 'yes' | 'part' | 'no';
/** A table cell: a mark with an optional note, or only a note when the row is not a yes/no question. */
type Cell = { mark?: Mark; note?: string };
const y = (note?: string): Cell => ({ mark: 'yes', note });
const p = (note: string): Cell => ({ mark: 'part', note });
const n = (note?: string): Cell => ({ mark: 'no', note });
const t = (note: string): Cell => ({ note });

const GROUPS: { title: string; rows: [string, Cell, Cell, Cell, Cell][] }[] = [
  {
    title: 'The basics',
    rows: [
      ['Price', t('Free'), t('Free for local and public repos. Private repos need a paid plan.'), t('$59.99 once. Free to evaluate.'), t('Free')],
      ['macOS, Windows, Linux', y('All three'), y('All three'), p('macOS and Windows'), p('macOS and Windows')],
      ['Use it without an account', y(), p('Sign-in asked at setup (GitKraken account)'), y(), p('Sign-in asked at setup (Atlassian account)')],
      ['Manage it from your phone', y('Any browser, paired by QR code'), n(), n(), n()],
    ],
  },
  {
    title: 'How it shows your repo',
    rows: [
      ['Main view', t('Branch tree: main, then releases, then features and fixes'), t('Commit graph'), t('Commit graph'), t('Commit graph')],
      ['Knows which release a branch belongs to', y('Even after a squash-merged pull request'), n(), n(), n()],
    ],
  },
  {
    title: 'Shipping',
    rows: [
      ['One-click release', y('Dates the changelog, fast-forwards main, tags, pushes'), p('Git-flow finish: merge and tag'), p('Git-flow finish: merge and tag'), p('Git-flow finish: merge and tag')],
      ['Changelog written for you', y('AI adds each branch to Unreleased'), n(), n(), n()],
    ],
  },
  {
    title: 'AI and agents',
    rows: [
      ['AI commit messages', y(), y('Paid plans'), y('Through Claude or Cursor'), n()],
      ['AI conflict resolution', y('Proposed per file during a rebase'), y('Paid plans'), n(), n()],
      ['AI pull request descriptions', y(), y('Paid plans'), n(), n()],
      ['Coding agents on branches', y('Built-in agent chat per branch, in its own worktree'), y('Agent Sessions run your CLI agent in a worktree'), p('Worktrees, no agent runner'), n()],
      ['AI provider', t('Your signed-in CLI or API key: Claude Code, Codex, Gemini, Copilot, Ollama'), t('GitKraken AI credits in paid plans, or your own key'), t('Your Claude or Cursor CLI'), t('No AI features')],
      ['Other agents can drive it (MCP)', y('Every action is a tool'), y('GitKraken MCP server'), n(), n()],
    ],
  },
  {
    title: 'Everyday Git',
    rows: [
      ['Stash, cherry-pick, tags, submodules', y(), y(), y(), y()],
      ['Worktrees', y(), y(), y(), n()],
      ['Stage single lines or hunks', n('Whole files only'), y(), y(), y()],
      ['Interactive rebase', n('Rebase onto the parent only'), y(), y(), y()],
      ['Merge conflict editor', p('AI proposal you review, no 3-way editor'), y('Built-in merge tool'), y('Built-in resolver'), p('Mine, theirs, or an external tool')],
      ['Blame and file history', n(), y(), y(), y()],
      ['Git LFS', n('No UI for it'), y(), y(), y()],
      ['Clone from the app', n('Open a local folder'), y(), y(), y()],
    ],
  },
  {
    title: 'Team tools',
    rows: [
      ['Pull requests in the app', y('GitHub and Azure DevOps. GitLab and Bitbucket not yet.'), y('GitHub, GitLab, Bitbucket, Azure DevOps (some on higher plans)'), n(), n()],
      ['Tickets', y('Jira, Trello, Asana'), y('Jira, Trello'), p('Issue links in commits'), p('Issue links in commits')],
    ],
  },
];

const CARDS = [
  { name: 'Gitnetix', price: 'Free', os: 'macOS · Windows · Linux', view: 'Branch tree', best: 'You ship from release branches and run coding agents on them.' },
  { name: 'GitKraken', price: 'Free for public repos, paid for private', os: 'macOS · Windows · Linux', view: 'Commit graph', best: 'A team that wants the most complete graph client, with GitLab and Bitbucket built in.' },
  { name: 'Fork', price: '$59.99, once', os: 'macOS · Windows', view: 'Commit graph', best: 'A native app you pay for once, with strong rebase and history tools.' },
  { name: 'Sourcetree', price: 'Free', os: 'macOS · Windows', view: 'Commit graph', best: 'A free, classic client close to Bitbucket, and still the one for Mercurial.' },
];

const MARKS = { yes: ['Yes', 'var(--add)'], part: ['Partly', 'var(--warn)'], no: ['No', 'var(--faint)'] } as const;

function MarkIcon({ mark }: { mark: Mark }) {
  const [label, color] = MARKS[mark];
  return (
    <svg role="img" aria-label={label} width="18" height="18" viewBox="0 0 18 18" style={{ flex: 'none', color, marginTop: '2px' }}>
    {mark === 'yes' && <><circle cx="9" cy="9" r="9" fill="currentColor" opacity=".18"></circle><path d="M5.5 9.3l2.3 2.3 4.7-4.9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"></path></>}
    {mark === 'part' && <><circle cx="9" cy="9" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.8"></circle><path d="M9 4a5 5 0 0 1 0 10z" fill="currentColor"></path></>}
    {mark === 'no' && <path d="M5.5 9h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round"></path>}
    </svg>
  );
}

const card = { background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '26px', display: 'flex', flexDirection: 'column', gap: '14px' } as const;
const eyebrow = { margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' } as const;
const h2 = { margin: '0', fontSize: 'clamp(30px, 4vw, 44px)', lineHeight: '1.08', letterSpacing: '-0.03em', textWrap: 'balance' } as const;

/** The comparison page: Gitnetix next to GitKraken, Fork and Sourcetree. Table styles live in pages/compare.astro. */
export default function Compare() {
  const first = releases[releases.length - 1];
  const others = [
    ['You stage single lines or hunks, or reorder commits with interactive rebase.', 'Fork, GitKraken, Sourcetree'],
    ['You need blame, file history or Git LFS inside the app.', 'Fork, GitKraken, Sourcetree'],
    ['Your pull requests live on GitLab or Bitbucket.', 'GitKraken'],
    ['You think best with the full commit graph in front of you.', 'Any of the three'],
    [`You want a tool with years behind it. Gitnetix shipped its first release on ${longDate(first.date)}.`, 'Any of the three'],
    ['You still work in Mercurial.', 'Sourcetree'],
  ];
  const ours = [
    'You ship from release branches and want to see what goes out next, not a wall of commits.',
    'You want one click to date the changelog, fast-forward main, tag and push.',
    'You run coding agents and want one per branch, each in its own worktree.',
    'You want it free on macOS, Windows and Linux, private repos included, no account.',
    'You want AI to bill only your own provider, or run free on Ollama.',
    'You want to check on releases and agents from your phone.',
  ];
  return (
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '0 24px 40px' }}>
    {/* HERO */}
    <section aria-labelledby="cmp-h" style={{ padding: '88px 0 56px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', background: 'radial-gradient(700px 360px at 50% 0%, var(--accent-soft), transparent 70%)' }}>
    <p style={{ ...eyebrow, margin: '0' }}>COMPARE</p>
    <h1 id="cmp-h" style={{ margin: '0', fontSize: 'clamp(40px, 6vw, 76px)', lineHeight: '1.02', letterSpacing: '-0.035em', textWrap: 'balance', maxWidth: '940px' }}>Gitnetix, GitKraken, Fork or Sourcetree?</h1>
    <p style={{ margin: '0', fontSize: 'clamp(18px, 2vw, 21px)', color: 'var(--muted)', maxWidth: '700px', textWrap: 'pretty' }}>Four good desktop Git clients. Three of them draw your commit graph. Gitnetix draws your releases. Here is what each one does well, and what it costs.</p>
    <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)', maxWidth: '620px' }}>Written by the Gitnetix team, so we tried hard to be fair. Checked against each vendor's site on <time dateTime={CHECKED}>{longDate(CHECKED)}</time>.</p>
    </section>

    {/* THE SHORT VERSION */}
    <section aria-labelledby="short-h">
    <h2 id="short-h" style={{ margin: '0 0 20px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--faint)', fontWeight: '600' }}>THE SHORT VERSION</h2>
    <ul style={{ listStyle: 'none', margin: '0', padding: '0', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '16px' }}>
    {CARDS.map((c, i) => (
    <li key={c.name} style={{ ...card, ...(i === 0 && { borderColor: 'rgba(240,164,58,.55)', boxShadow: '0 0 50px -24px rgba(240,164,58,.6)' }) }}>
    <h3 style={{ margin: '0', fontSize: '24px', letterSpacing: '-0.02em', color: i === 0 ? 'var(--accent-fg)' : 'var(--fg)' }}>{c.name}</h3>
    <dl style={{ margin: '0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '15px' }}>
    <dt style={{ color: 'var(--faint)' }}>Price</dt><dd style={{ margin: '0', fontWeight: '600' }}>{c.price}</dd>
    <dt style={{ color: 'var(--faint)' }}>Runs on</dt><dd style={{ margin: '0' }}>{c.os}</dd>
    <dt style={{ color: 'var(--faint)' }}>Shows</dt><dd style={{ margin: '0' }}>{c.view}</dd>
    </dl>
    <p style={{ margin: 'auto 0 0', paddingTop: '14px', borderTop: '1px solid var(--line)', fontSize: '15px', color: 'var(--muted)' }}><strong style={{ color: 'var(--fg)', fontWeight: '600' }}>Best for: </strong>{c.best}</p>
    </li>
    ))}
    </ul>
    </section>

    {/* SIDE BY SIDE */}
    <section aria-labelledby="tbl-h" style={{ marginTop: '96px' }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: '20px 40px', marginBottom: '24px' }}>
    <div style={{ maxWidth: '640px' }}>
    <p style={eyebrow}>SIDE BY SIDE</p>
    <h2 id="tbl-h" style={h2}>Feature by feature.</h2>
    </div>
    <ul aria-label="Legend" style={{ listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexWrap: 'wrap', gap: '8px 20px', fontSize: '14px', color: 'var(--muted)' }}>
    <li style={{ display: 'flex', gap: '8px' }}><MarkIcon mark="yes" />Yes</li>
    <li style={{ display: 'flex', gap: '8px' }}><MarkIcon mark="part" />Partly, or with limits</li>
    <li style={{ display: 'flex', gap: '8px' }}><MarkIcon mark="no" />No</li>
    </ul>
    </div>
    <div className="cmp-scroll" role="region" aria-labelledby="tbl-h" tabIndex={0}>
    <table className="cmp" aria-labelledby="tbl-h">
    <thead><tr><td></td>{APPS.map((a) => <th key={a} scope="col">{a}</th>)}</tr></thead>
    {GROUPS.map((g) => (
    <tbody key={g.title}>
    <tr className="grp"><th scope="colgroup" colSpan={5}>{g.title}</th></tr>
    {g.rows.map(([label, ...cells]) => (
    <tr key={label}>
    <th scope="row">{label}</th>
    {cells.map((c, i) => (
    <td key={APPS[i]}><div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>{c.mark && <MarkIcon mark={c.mark} />}{c.note && <span style={{ color: c.mark ? 'var(--muted)' : 'var(--fg)' }}>{c.note}</span>}</div></td>
    ))}
    </tr>
    ))}
    </tbody>
    ))}
    </table>
    </div>
    <p style={{ margin: '16px 0 0', fontSize: '14px', color: 'var(--faint)' }}>Something wrong or out of date? <a className="muted" href={`${REPO}/issues`} style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>Open an issue</a> and we will fix it.</p>
    </section>

    {/* WHICH ONE */}
    <section aria-labelledby="pick-h" style={{ marginTop: '96px' }}>
    <div style={{ maxWidth: '700px' }}>
    <p style={eyebrow}>WHICH ONE</p>
    <h2 id="pick-h" style={h2}>Pick the one that fits how you work.</h2>
    <p style={{ margin: '18px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>Gitnetix is not trying to be a better commit graph. If the graph is how you think, one of the others will suit you better.</p>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gap: '18px', marginTop: '40px' }}>
    <div style={{ ...card, padding: '30px', borderColor: 'rgba(240,164,58,.55)' }}>
    <h3 style={{ margin: '0', fontSize: '22px', color: 'var(--accent-fg)' }}>Pick Gitnetix if</h3>
    <ul style={{ listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    {ours.map((o) => <li key={o} style={{ display: 'flex', gap: '12px' }}><MarkIcon mark="yes" /><span>{o}</span></li>)}
    </ul>
    </div>
    <div style={{ ...card, padding: '30px' }}>
    <h3 style={{ margin: '0', fontSize: '22px' }}>Pick another client if</h3>
    <ul style={{ listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: '14px' }}>
    {others.map(([o, who]) => <li key={o} style={{ display: 'flex', gap: '12px' }}><span aria-hidden="true" style={{ color: 'var(--faint)', lineHeight: '1.4' }}>→</span><span>{o} <span style={{ color: 'var(--faint)', whiteSpace: 'nowrap' }}>{who}</span></span></li>)}
    </ul>
    </div>
    </div>
    </section>

    {/* CTA */}
    <section aria-labelledby="try-h" style={{ padding: '120px 0 80px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '22px' }}>
    <h2 id="try-h" style={{ margin: '0', fontSize: 'clamp(36px, 5.4vw, 64px)', lineHeight: '1.04', letterSpacing: '-0.035em', textWrap: 'balance' }}>Try it on your own repo.</h2>
    <p style={{ margin: '0', fontSize: '19px', color: 'var(--muted)' }}>Free on macOS, Windows and Linux. Keep your current client next to it.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '6px' }}>
    <a className="btn-p" href={u('download/')} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', padding: '15px 24px', borderRadius: '12px', boxShadow: '0 8px 30px -8px rgba(240,164,58,.6)' }}>Download Gitnetix</a>
    <a className="btn-s" href={u()} style={{ fontWeight: '500', padding: '15px 22px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--panel)' }}>See how it works</a>
    </div>
    </section>
    </div>
  );
}
