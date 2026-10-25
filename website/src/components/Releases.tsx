import ReleaseCard from './ReleaseCard';
import { REPO, releases, shortDate, slug, u } from '../lib/changelog';

/** The releases index: every changelog section as a story on a timeline. */
export default function Releases({ version }: { version: string }) {
  const latest = { version };
  const days = Math.round((Date.parse(releases[0].date) - Date.parse(releases[releases.length - 1].date)) / 864e5) + 1;
  return (
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '0 24px 120px' }}>
    <nav aria-label="Breadcrumb" style={{ paddingTop: '28px', fontSize: '14px', color: 'var(--faint)' }}><a href={u()} style={{ color: 'var(--faint)' }}>Gitnetix</a> <span aria-hidden="true">/</span> <span>Releases</span></nav>

    <section aria-labelledby="rel-h" style={{ padding: '56px 0 64px', display: 'flex', flexWrap: 'wrap', gap: '32px 64px', alignItems: 'flex-end', justifyContent: 'space-between' }}>
    <div style={{ flex: '1 1 560px', maxWidth: '760px' }}>
    <p style={{ margin: '0 0 12px', fontSize: '13px', letterSpacing: '.14em', color: 'var(--accent-fg)', fontWeight: '600' }}>RELEASE NOTES</p>
    <h1 id="rel-h" style={{ margin: '0', fontSize: 'clamp(42px, 6vw, 76px)', lineHeight: '1.02', letterSpacing: '-0.035em', textWrap: 'balance' }}>Every release, told as a story.</h1>
    <p style={{ margin: '20px 0 0', fontSize: '19px', color: 'var(--muted)', textWrap: 'pretty' }}>What changed in Gitnetix and why it matters, newest first. The full list from <code>CHANGELOG.md</code> sits under each story.</p>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', flex: '0 1 320px' }}>
    <dl style={{ margin: '0', display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '12px', padding: '14px' }}><dt style={{ fontSize: '12px', color: 'var(--faint)' }}>Releases</dt><dd style={{ margin: '2px 0 0', fontSize: '26px', fontWeight: '600' }}>{releases.length}</dd></div>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '12px', padding: '14px' }}><dt style={{ fontSize: '12px', color: 'var(--faint)' }}>Days</dt><dd style={{ margin: '2px 0 0', fontSize: '26px', fontWeight: '600' }}>{days}</dd></div>
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '12px', padding: '14px' }}><dt style={{ fontSize: '12px', color: 'var(--faint)' }}>Latest</dt><dd className="mono" style={{ margin: '6px 0 0', fontSize: '18px', fontWeight: '500', color: 'var(--accent-fg)' }}>{latest.version}</dd></div>
    </dl>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', fontSize: '14px' }}>
    <a href={u('releases.xml')} style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: '6px', minHeight: '32px' }}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1.5"></circle></svg>Release feed</a>
    <a href={`${REPO}/blob/main/CHANGELOG.md`} style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', minHeight: '32px' }}>CHANGELOG.md on GitHub</a>
    </div>
    </div>
    </section>

    <ol className="tl">
    {releases.map((r, i) => (
    <li key={r.version} id={slug(r.version)}>
    <div className="meta">
    <span className={i === 0 ? 'node on' : 'node'} aria-hidden="true"></span>
    <a href={u(`releases/${r.version}/`)} className="mono ver" style={{ fontSize: '20px', fontWeight: '500', color: 'var(--release)' }}>v{r.version}</a>
    <time dateTime={r.date} style={{ fontSize: '14px', color: 'var(--faint)' }}>{shortDate(r.date)}</time>
    {i === 0 && <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--accent-ink)', background: 'var(--accent)', padding: '2px 10px', borderRadius: '999px' }}>Latest</span>}
    </div>
    <ReleaseCard r={r} latest={i === 0} heading="h2" />
    </li>
    ))}
    </ol>

    <section aria-labelledby="sub-h" style={{ marginTop: '80px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '18px', padding: 'clamp(24px, 4vw, 44px)', display: 'flex', flexWrap: 'wrap', gap: '20px 40px', alignItems: 'center', justifyContent: 'space-between' }}>
    <div style={{ flex: '1 1 420px' }}>
    <h2 id="sub-h" style={{ margin: '0', fontSize: '30px', letterSpacing: '-0.02em' }}>Already installed? You'll be offered the update.</h2>
    <p style={{ margin: '8px 0 0', color: 'var(--muted)' }}>Gitnetix checks for new releases on launch and can download, install and restart for you.</p>
    </div>
    <a className="btn-p" href={u('download/')} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', padding: '14px 22px', borderRadius: '12px' }}>Download v{latest.version}</a>
    </section>
    </div>
  );
}
