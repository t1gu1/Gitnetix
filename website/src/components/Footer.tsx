import { REPO, u } from '../lib/changelog';

export default function Footer() {
  return (
    <footer style={{ borderTop: '1px solid var(--line)' }}>
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '36px 24px', display: 'flex', flexWrap: 'wrap', gap: '20px 40px', alignItems: 'center', fontSize: '14px', color: 'var(--muted)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 260px' }}><img src={u('favicon.png')} alt="" width="24" height="24" loading="lazy" style={{ width: '24px', height: '24px', borderRadius: '6px' }} /><span>Gitnetix · a release-centric Git client</span></div>
    <nav aria-label="Footer" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
    <a href={REPO} style={{ color: 'var(--muted)' }}>GitHub</a>
    <a href={u('releases/')} style={{ color: 'var(--muted)' }}>Changelog</a>
    <a href={u('download/')} style={{ color: 'var(--muted)' }}>Download</a>
    <a href={u('releases.xml')} style={{ color: 'var(--muted)' }}>RSS</a>
    <a href="https://adevjourney.wtf/en/projects/gitnetix/" style={{ color: 'var(--muted)' }}>Made by Guillaume · A Dev Journey</a>
    </nav>
    </div>
    </footer>
  );
}
