import { u } from '../lib/changelog';
import { Icon } from '../../../src/components/Icon';

type Plan = { id: string; name: string; who: string; price: string; per: string; cta: string; href: string; lead: string; items: [title: string, text: string, soon?: boolean][] };

/** The plans as the back-end opens them (gitnetix-back-end, src/plans.ts). The amounts in `per` must match the Stripe prices (STRIPE_PRICE_PRO, STRIPE_PRICE_TEAM). */
const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    who: 'For anyone, on as many computers as you like.',
    price: '$0',
    per: 'No account, no card.',
    cta: 'Download',
    href: u('download/'),
    lead: 'The whole app, including',
    items: [
      ['The branch map', 'Your branches on a map of releases, instead of a commit graph.'],
      ['Releases from any branch', 'The changelog dated, the tag made, the branch and its tag pushed, in one action.'],
      ['An agent on every branch', 'Claude Code, Codex, Antigravity, Copilot or Ollama, each in its own worktree, on your own sign-in or API key.'],
      ['Pull requests and tickets', 'Review, comment and merge without leaving the app, with tickets matched to your branches.'],
      ['Your phone on your network', "Scan a QR code and the app opens in your phone's browser."],
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    who: 'For you, on every computer you use.',
    price: '7 days free',
    per: 'Then $5 a month.',
    cta: 'Try 7 days free',
    href: '#start',
    lead: 'Everything in Free, plus',
    items: [
      ['Sync across computers', 'Your project list and settings follow you to every computer you sign in on.'],
      ['Encrypted backups', 'Settings, projects, templates, AI setup and agent sessions, never your tokens. Once a day when something changed, or when you ask. The newest 100 are kept, up to 5 GB.'],
      ['Live updates', 'Pull requests, checks and pushes on the GitHub repositories you administer show up within seconds, not at the next check.'],
      ['End-to-end encrypted', "Your devices encrypt your lists, settings and backups, so the Gitnetix server can't read them."],
      ['Your phone from anywhere', 'Reach your computer from your phone on any network, not only your own.', true],
    ],
  },
  {
    id: 'team',
    name: 'Team',
    who: 'For a company that shares projects and rules.',
    price: '7 days free',
    per: 'Then $8 a month, per seat.',
    cta: 'Try 7 days free',
    href: '#start',
    lead: 'Pro for every member, plus',
    items: [
      ['A shared project list', "The enterprise's projects on every member's computer, encrypted with a key only members hold."],
      ['Roles and invitations', 'Owner, admin, member and viewer. Invite by GitHub login or email.'],
      ['Policies', "Protected branches, signed commits, the branch types allowed and which agents may run. Each member's Gitnetix follows them."],
      ["The enterprise's log", 'Members, roles, keys, policies and projects, for admins, kept a year.'],
      ['Billing for a company', 'Seats, card and invoices in the billing portal, with your company tax ID on invoices.'],
    ],
  },
];

/** What the back-end stores and can't open, and what it reads (gitnetix-back-end README, "What the server still sees"). */
const HIDDEN = ['Your project list and the addresses of your repositories', 'Your settings, templates and AI setup', 'Your backups', "Your enterprise's project list and policies"];
const SEEN = ['Your GitHub login, email and plan', 'Enterprise names, members, roles and invitations', 'Device names and when they are online', 'How many projects you sync, their sizes and when they changed', 'Sign-in IP addresses, in your security log'];

const FAQ: [string, string][] = [
  ['Do I need an account to use Gitnetix?', 'No. The app works without one, on as many computers as you like. An account only matters with Pro or Team.'],
  ['How do the 7 free days work?', 'A first subscription starts with 7 free days. Stripe asks for a card at checkout and charges it when the 7 days end, unless you cancel before. An account or enterprise that subscribed before pays from the first day.'],
  ['What happens if I cancel?', 'Your plan runs to the end of the period you paid for. After that, sync, new backups and live updates stop. Your data stays on your account. You can still restore or delete your backups, and sync resumes if you subscribe again.'],
  ['How do I pay? Is tax included?', "Through Stripe. Checkout shows the tax for your billing address before you pay, and takes a company tax ID. Your card, invoices, seats and cancelling are in Stripe's billing portal. Open it from Gitnetix, in Settings, Gitnetix account, Billing, Manage."],
  ['How do Team seats work?', 'Each member and each pending invitation takes a seat, and you buy at least as many seats as members. Every member gets the Pro features through the enterprise, so nobody needs their own Pro. Admins change the seat count in the billing portal.'],
  ['Can the Gitnetix server read my code?', "No. Your code never goes to it. The account's GitHub sign-in asks only for your profile and email, so the server holds no token that opens a repository. For live updates, GitHub tells the server that a repository changed, and your Gitnetix reads what changed with its own sign-in."],
  ['Do I need GitHub?', 'Yes, to sign in. The account uses Sign in with GitHub. Your projects can be on any Git host, and sync and backups work with all of them. Live updates need a GitHub repository you administer.'],
];

const h2 = { fontSize: 'clamp(36px, 4.6vw, 56px)' };

/** The pricing page: the free app, then Pro and Team, which the app sells (Settings, Gitnetix account). Styles live in pages/pricing.astro. */
export default function Pricing() {
  return (
    <div style={{ maxWidth: '1240px', margin: '0 auto', padding: '0 24px 40px' }}>
    {/* HERO */}
    <section aria-labelledby="pr-h" style={{ padding: '80px 0 56px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px' }}>
    <p className="eyebrow" style={{ margin: '0' }}>Pricing</p>
    <h1 id="pr-h" className="display" style={{ fontSize: 'clamp(48px, 6.6vw, 88px)', maxWidth: '980px' }}>The app is free. <span className="dim">The account is Pro.</span></h1>
    <p style={{ margin: '0', fontSize: 'clamp(18px, 2vw, 21px)', color: 'var(--muted)', maxWidth: '720px', textWrap: 'pretty' }}>The whole Git client is free on macOS, Windows and Linux, with no sign-in. Pro adds a Gitnetix account that syncs your projects and settings across computers, backs them up and brings live updates from GitHub. Team gives your company a shared project list and rules.</p>
    <p style={{ margin: '0', fontSize: '14px', color: 'var(--faint)' }}>A first subscription starts with 7 free days. Cancel any time.</p>
    </section>

    {/* PLANS */}
    <ul className="plans" aria-label="Plans">
    {PLANS.map((p) => (
    <li key={p.id} className={`box plan${p.id === 'pro' ? ' on' : ''}`}>
    <div>
    <h2>{p.name}</h2>
    <p className="plan-who">{p.who}</p>
    </div>
    <div>
    <p className="price">{p.price}</p>
    <p className="per">{p.per}</p>
    </div>
    <a className={p.id === 'pro' ? 'btn-p' : 'btn-s'} href={p.href}>{p.cta}</a>
    <div className="plan-adds">
    <p className="eyebrow">{p.lead}</p>
    <ul className="checks">
    {p.items.map(([title, text, soon]) => <li key={title} className={soon ? 'soon' : undefined}><Icon name={soon ? 'phone' : 'check'} size={16} stroke={1.6} /><span><b>{title}{soon && <span className="vtag">Coming soon</span>}</b>{text}</span></li>)}
    </ul>
    </div>
    </li>
    ))}
    </ul>

    {/* ENCRYPTION */}
    <section aria-labelledby="enc-h" style={{ marginTop: '96px' }}>
    <div style={{ maxWidth: '760px' }}>
    <p className="eyebrow">End-to-end encrypted</p>
    <h2 id="enc-h" className="display" style={h2}>Encrypted before it leaves your computer.</h2>
    <p className="lead" style={{ marginTop: '18px' }}>Your devices encrypt your project lists, settings and backups with a key the Gitnetix server never gets. A new computer opens them once a computer already signed in approves it, after both show the same code, or with the recovery key you keep.</p>
    </div>
    <div className="cards" style={{ marginTop: '40px', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))' }}>
    <div className="box feat" style={{ padding: '30px', gap: '18px', borderColor: 'var(--line2)' }}>
    <h3>What the server can't read</h3>
    <ul className="checks ink">{HIDDEN.map((t) => <li key={t}><Icon name="lock" size={16} />{t}</li>)}</ul>
    </div>
    <div className="box feat" style={{ padding: '30px', gap: '18px' }}>
    <h3>What the server sees</h3>
    <ul className="checks dim">{SEEN.map((t) => <li key={t}><Icon name="eye" size={16} />{t}</li>)}</ul>
    </div>
    </div>
    <p style={{ margin: '16px 0 0', fontSize: '14px', color: 'var(--faint)' }}>Lose every signed-in computer and the recovery key, and the encrypted data is gone for good. Nobody can open it, us included.</p>
    </section>

    {/* FAQ */}
    <section aria-labelledby="pfaq-h" style={{ marginTop: '96px' }}>
    <p className="eyebrow">Questions</p>
    <h2 id="pfaq-h" className="display" style={h2}>Billing, answered.</h2>
    <div className="faq">
    {FAQ.map(([q, a], i) => (
    <details key={q} open={i === 0}>
    <summary><h3>{q}</h3><span className="chev" aria-hidden="true">+</span></summary>
    <p>{a}</p>
    </details>
    ))}
    </div>
    </section>

    {/* START: subscribing happens in the app */}
    <section id="start" aria-labelledby="start-h" style={{ padding: '120px 0 80px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '22px' }}>
    <span className="stn-main" aria-hidden="true"></span>
    <h2 id="start-h" className="display" style={{ fontSize: 'clamp(44px, 6vw, 76px)' }}>Try Pro free for 7 days.</h2>
    <p style={{ margin: '0', fontSize: '19px', color: 'var(--muted)' }}>You subscribe from the app, in three steps.</p>
    <ol className="cards" style={{ width: '100%', margin: '24px 0 0', textAlign: 'left' }}>
    <li className="box feat"><span className="step-n" aria-hidden="true">1</span><h3>Download Gitnetix</h3><p>Free on macOS, Windows and Linux. Already have it? The account comes with v0.37.0, and the app offers the update on launch.</p></li>
    <li className="box feat"><span className="step-n" aria-hidden="true">2</span><h3>Sign in with GitHub</h3><p>Open Settings from your profile picture, top right, then Gitnetix account. Sign in, set up encryption and keep the recovery key it shows.</p></li>
    <li className="box feat" style={{ borderColor: 'var(--line2)' }}><span className="step-n on" aria-hidden="true">3</span><h3>Subscribe</h3><p>For Pro, press Subscribe. For Team, create an enterprise, choose its seats and press Subscribe. Stripe's checkout opens in your browser.</p></li>
    </ol>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'center', marginTop: '12px' }}>
    <a className="btn-p btn-xl" href={u('download/')}>Download Gitnetix</a>
    <a className="btn-s btn-xl" href={u()}>See how it works</a>
    </div>
    </section>
    </div>
  );
}
