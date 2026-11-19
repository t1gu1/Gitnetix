import ReleaseCard from './ReleaseCard';
import { REPO, releases, shortDate, slug, u } from '../lib/changelog';

/** The releases index: every changelog section as a story on a timeline. */
export default function Releases({ version }: { version: string }) {
  const latest = { version };
  const days = Math.round((Date.parse(releases[0].date) - Date.parse(releases[releases.length - 1].date)) / 864e5) + 1;
  return (
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '0 24px 120px' }}>
    <nav aria-label="Breadcrumb" className="crumbs"><a className="faint" href={u()}>Gitnetix</a> <span aria-hidden="true">/</span> <span>Releases</span></nav>

    <section aria-labelledby="rel-h" style={{ padding: '56px 0 64px', display: 'flex', flexWrap: 'wrap', gap: '32px 64px', alignItems: 'flex-end', justifyContent: 'space-between' }}>
    <div style={{ flex: '1 1 560px', maxWidth: '760px' }}>
    <p className="eyebrow">Release notes</p>
    <h1 id="rel-h" className="display" style={{ fontSize: 'clamp(48px, 6.6vw, 88px)' }}>Every release, told as a story.</h1>
    <p className="lead">What changed in Gitnetix and why it matters, newest first. The full list from <code>CHANGELOG.md</code> sits under each story.</p>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: '0 1 320px' }}>
    <dl className="big">
    <div><dt>Releases</dt><dd>{releases.length}</dd></div>
    <div><dt>Days</dt><dd>{days}</dd></div>
    <div><dt>Latest</dt><dd className="mono">{latest.version}</dd></div>
    </dl>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', fontSize: '14px' }}>
    <a className="muted" href={u('releases.xml')} style={{ display: 'flex', alignItems: 'center', gap: '6px', minHeight: '32px' }}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1.5"></circle></svg>Release feed</a>
    <a className="muted" href={`${REPO}/blob/main/CHANGELOG.md`} style={{ display: 'flex', alignItems: 'center', minHeight: '32px' }}>CHANGELOG.md on GitHub</a>
    </div>
    </div>
    </section>

    <ol className="tl">
    {releases.map((r, i) => (
    <li key={r.version} id={slug(r.version)}>
    <div className="meta">
    <span className={i === 0 ? 'node on' : 'node'} aria-hidden="true"></span>
    <a href={u(`releases/${r.version}/`)} className="ver">v{r.version}</a>
    <time dateTime={r.date} style={{ fontSize: '14px', color: 'var(--faint)' }}>{shortDate(r.date)}</time>
    {i === 0 && <span className="vtag inv">Latest</span>}
    </div>
    <ReleaseCard r={r} latest={i === 0} heading="h2" />
    </li>
    ))}
    </ol>

    <section aria-labelledby="sub-h" className="box" style={{ marginTop: '80px', padding: 'clamp(24px, 4vw, 44px)', display: 'flex', flexWrap: 'wrap', gap: '20px 40px', alignItems: 'center', justifyContent: 'space-between' }}>
    <div style={{ flex: '1 1 420px' }}>
    <h2 id="sub-h" className="display" style={{ fontSize: '34px' }}>Already installed? You'll be offered the update.</h2>
    <p style={{ margin: '8px 0 0', color: 'var(--muted)' }}>Gitnetix checks for new releases on launch and can download, install and restart for you.</p>
    </div>
    <a className="btn-p btn-xl" href={u('download/')}>Download v{latest.version}</a>
    </section>
    </div>
  );
}
