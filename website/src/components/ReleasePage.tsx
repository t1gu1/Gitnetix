import ReleaseCard from './ReleaseCard';
import { releases, longDate, u } from '../lib/changelog';

/** One release on its own page, with links to its neighbours. */
export default function ReleasePage({ i }: { i: number }) {
  const r = releases[i];
  const newer = releases[i - 1];
  const older = releases[i + 1];
  return (
    <div style={{ maxWidth: '1040px', margin: '0 auto', padding: '0 24px 120px' }}>
    <nav aria-label="Breadcrumb" className="crumbs" style={{ paddingBottom: '40px' }}><a className="faint" href={u()}>Gitnetix</a> <span aria-hidden="true">/</span> <a className="faint" href={u('releases/')}>Releases</a> <span aria-hidden="true">/</span> <span>v{r.version}</span></nav>
    <p style={{ margin: '0 0 16px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', color: 'var(--muted)' }}>
    <span className="vtag mono">v{r.version}</span>
    <span>Released <time dateTime={r.date}>{longDate(r.date)}</time></span>
    {i === 0 && <span className="vtag inv">Latest</span>}
    </p>
    <ReleaseCard r={r} latest={i === 0} heading="h1" />
    <a className="btn-s" href={u('releases/')} style={{ marginTop: '28px' }}>See all release notes</a>
    <nav aria-label="Other releases" style={{ marginTop: '32px', display: 'flex', flexWrap: 'wrap', gap: '16px', justifyContent: 'space-between' }}>
    {older ? <a className="muted" href={u(`releases/${older.version}/`)} style={{ minHeight: '44px', display: 'flex', alignItems: 'center' }}>← v{older.version}: {older.title}</a> : <span></span>}
    {newer && <a className="muted" href={u(`releases/${newer.version}/`)} style={{ minHeight: '44px', display: 'flex', alignItems: 'center' }}>v{newer.version}: {newer.title} →</a>}
    </nav>
    </div>
  );
}
