import { REPO, u } from '../lib/changelog';

export default function Footer() {
  return (
    <footer style={{ borderTop: '1px solid var(--line)' }}>
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '36px 24px', display: 'flex', flexWrap: 'wrap', gap: '20px 40px', alignItems: 'center', fontSize: '14px', color: 'var(--muted)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 260px' }}><img src={u('favicon.png')} alt="" width="24" height="24" loading="lazy" style={{ width: '24px', height: '24px', borderRadius: '6px' }} /><span>Gitnetix</span></div>
    <nav aria-label="Footer" className="muted-links" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 24px' }}>
    <a href={REPO}>GitHub</a>
    <a href={u('releases/')}>Changelog</a>
    <a href={u('#faq')}>FAQ</a>
    <a href={u('download/')}>Download</a>
    <a href={u('releases.xml')}>RSS</a>
    <a href="https://adevjourney.wtf/en/">Made by Guillaume Huard Hughes</a>
    </nav>
    </div>
    </footer>
  );
}
