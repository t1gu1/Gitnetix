import ReleaseCard from './ReleaseCard';
import { releases, longDate, u } from '../lib/changelog';

/** One release on its own page, with links to its neighbours. */
export default function ReleasePage({ i }: { i: number }) {
  const r = releases[i];
  const newer = releases[i - 1];
  const older = releases[i + 1];
  return (
    <div style={{ maxWidth: '1040px', margin: '0 auto', padding: '0 24px 120px' }}>
    <nav aria-label="Breadcrumb" style={{ padding: '28px 0 40px', fontSize: '14px', color: 'var(--faint)' }}><a className="faint" href={u()}>Gitnetix</a> <span aria-hidden="true">/</span> <a className="faint" href={u('releases/')}>Releases</a> <span aria-hidden="true">/</span> <span>v{r.version}</span></nav>
    <p style={{ margin: '0 0 16px', display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center', color: 'var(--muted)' }}>
    <span className="mono" style={{ color: 'var(--release)', background: 'var(--chip)', padding: '2px 10px', borderRadius: '999px', fontSize: '14px' }}>v{r.version}</span>
    <span>Released <time dateTime={r.date}>{longDate(r.date)}</time></span>
    {i === 0 && <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--accent-ink)', background: 'var(--accent)', padding: '2px 10px', borderRadius: '999px' }}>Latest</span>}
    </p>
    <ReleaseCard r={r} latest={i === 0} heading="h1" />
    <a className="btn-s" href={u('releases/')} style={{ display: 'inline-flex', alignItems: 'center', marginTop: '28px', fontWeight: '500', padding: '13px 20px', borderRadius: '12px', border: '1px solid var(--line)', background: 'var(--panel)' }}>See all release notes</a>
    <nav aria-label="Other releases" style={{ marginTop: '32px', display: 'flex', flexWrap: 'wrap', gap: '16px', justifyContent: 'space-between' }}>
    {older ? <a className="muted" href={u(`releases/${older.version}/`)} style={{ minHeight: '44px', display: 'flex', alignItems: 'center' }}>← v{older.version}: {older.title}</a> : <span></span>}
    {newer && <a className="muted" href={u(`releases/${newer.version}/`)} style={{ minHeight: '44px', display: 'flex', alignItems: 'center' }}>v{newer.version}: {newer.title} →</a>}
    </nav>
    </div>
  );
}
