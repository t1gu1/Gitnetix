import { u } from '../lib/changelog';

export default function NotFound() {
  return (
    <section style={{ maxWidth: '760px', margin: '0 auto', padding: '120px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
    <p className="mono" style={{ margin: '0', color: 'var(--warn)' }}>fatal: not a valid ref</p>
    <h1 style={{ margin: '0', fontSize: 'clamp(40px, 6vw, 68px)', lineHeight: '1.04', letterSpacing: '-0.035em' }}>This branch was cleaned up.</h1>
    <p style={{ margin: '0', color: 'var(--muted)', fontSize: '19px' }}>The page you were looking for isn't here.</p>
    <a className="btn-p" href={u()} style={{ background: 'var(--accent)', color: 'var(--accent-ink)', fontWeight: '600', padding: '14px 22px', borderRadius: '12px' }}>Back to main</a>
    </section>
  );
}
