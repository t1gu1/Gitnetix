import { useEffect, useState } from 'react';
import { Icon } from '../../../src/components/Icon';
import type { LogLine } from '../../../src/api/types';
import { questions } from '../../../src/lib/agentLog';
import { AgentLog, WAIT, ai, cmd, dim, pathOf, type Ai } from './demo/agents';

/**
 * The homepage's three worktrees side by side, each agent at work in the app's own agent pane (AgentLog, as in the demo).
 * The page ships the finished sessions; once the cards are in view, each starts over and plays again, on a loop.
 */

/** How long to wait, then the line it adds; 'pick' picks the agent's first suggestion, as a click would. */
type Frame = [number, LogLine | 'pick'];
type Card = { branch: string; head?: boolean; agent: Ai; picker: string[]; frames: Frame[] };

const CARDS: Card[] = [
  {
    branch: 'feat/checkout', head: true, agent: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, picker: ['Claude', 'Claude Opus 5.5', 'xhigh'],
    frames: [
      [600, cmd('$ claude · Make the checkout one page, and fill the address from the postcode.')],
      [1200, dim('Read src/checkout/Cart.tsx')], [700, dim('Read src/checkout/Address.tsx')], [900, dim('Edit src/checkout/Checkout.tsx')], [900, dim('Edit src/checkout/Address.tsx')], [1100, dim('Bash pnpm test checkout')],
      [1600, ai('Done: one page from cart to payment, and the address fills itself from the postcode. 38 tests pass.')], [300, WAIT],
      [2600, cmd('› Write the PR description')],
      [1100, dim('Bash git log release/2.4.0..HEAD')],
      [1500, ai('Opened **#212 One-page checkout**: summary, screenshots and a test plan.')], [300, WAIT],
    ],
  },
  {
    branch: 'fix/tax-rounding', agent: { provider: 'codex', model: 'gpt-5-codex', effort: 'high' }, picker: ['Codex', 'gpt-5-codex', 'high'],
    frames: [
      [600, cmd('$ codex · Some totals are off by a cent. Fix the rounding.')],
      [1200, dim('Grep total src/cart')], [800, dim('Read src/cart/total.ts')], [900, dim('Bash pnpm test cart')],
      [1500, ai('Floats add up wrong: 0.1 + 0.2 gives 0.30000000000000004. Two ways:\n\n1. **Cents everywhere**\n2. **Round each line**\n\nWhich one do you prefer?')], [300, WAIT],
      [2400, 'pick'],
      [1300, cmd('› 1. Cents everywhere')],
      [1000, dim('Edit src/cart/money.ts')], [800, dim('Edit src/cart/total.ts')], [1000, dim('Bash pnpm test cart')],
      [1500, ai('Done: prices stay in cents until the receipt. The 3 carts that were off now match their invoices.')], [300, WAIT],
    ],
  },
  {
    branch: 'feat/dark-mode', agent: { provider: 'gemini', model: 'gemini-2.5-pro', effort: '' }, picker: ['Gemini', 'gemini-2.5-pro'],
    frames: [
      [600, cmd('$ gemini · Add a dark mode built from the brand palette.')],
      [1200, dim('Read tokens/brand.json')], [900, dim('Edit tokens/dark.json')], [900, dim('Edit src/theme.css')], [1100, dim('Bash pnpm build')],
      [1500, { kind: 'err', text: '✕ pnpm build exited with 1: unknown token "surface-2"' }],
      [2200, cmd('› The last run failed. Read the errors above, fix them and try again.')],
      [1100, dim('Edit tokens/dark.json')], [1000, dim('Bash pnpm build')], [900, { kind: 'ok', text: '✓ Build passed' }],
      [1200, ai('Dark mode is in: every component reads the new tokens, and the build passes.')], [300, WAIT],
    ],
  },
];
/** How long a finished session stays before it plays again. */
const HOLD = 6000;

/** Frames shown: all of them at first, then from the start again after `delay`, on a loop. Reduced motion keeps them still. */
function usePlay(frames: Frame[], delay: number) {
  const [n, setN] = useState(frames.length);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = frames.length;
    let t = window.setTimeout(function next() {
      i = i >= frames.length ? 0 : i + 1;
      setN(i);
      t = window.setTimeout(next, i >= frames.length ? HOLD : frames[i][0]);
    }, delay);
    return () => clearTimeout(t);
  }, []);
  return n;
}

function AgentCard({ card, delay }: { card: Card; delay: number }) {
  const n = usePlay(card.frames, delay);
  const shown = card.frames.slice(0, n);
  const lines = shown.flatMap(([, l]) => (l === 'pick' ? [] : [l]));
  const last = lines.at(-1);
  const qs = questions(lines);
  const pick = shown.at(-1)?.[1] === 'pick' ? qs[0] : undefined;
  const status = !last ? 'idle' : last.kind === 'wait' ? 'waiting' : last.kind === 'err' ? 'failed' : 'running';
  // As on the Worktrees page: [label, class in the pane, colour on the card].
  const [label, cls, dot] = status === 'failed' ? ['Failed', 'c-del', 'var(--del)'] : status === 'waiting' ? [qs.length ? 'Waiting for you' : 'Done', 'c-add', 'var(--add)'] : ['Running', 'c-acc', 'var(--accent)'];
  const busy = status === 'running' || status === 'idle';
  return (
    <div style={{ background: 'var(--raised)', borderRadius: '12px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: '50%', boxSizing: 'border-box', ...(card.head ? { background: 'var(--accent)' } : { border: '2px solid var(--work)' }) }}></span>
        <strong style={{ fontSize: '15px', flex: '1' }}>{card.branch}</strong>
        <span aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', background: dot, transition: 'background-color .3s' }}></span>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--faint)' }}>{pathOf({ project: 'shop', branch: card.branch })}</div>
      {/* The app's agent pane in the demo's markup, so its .hd rules apply. It only plays: nothing in it takes focus or clicks. */}
      <div className="ap hd" inert style={{ height: '360px', borderRadius: '8px', boxShadow: 'none', background: 'var(--term)' }}>
        <div className="term-tabs">
          <span className="term-tab" style={{ borderLeft: 0 }} aria-pressed><Icon name="sparkle" size={12} />Agent</span>
          <span className="term-tab" style={{ borderRight: '1px solid var(--line)' }}><Icon name="terminal" size={12} />Shell</span>
          <span className="term-tab" style={{ marginLeft: 'auto', borderLeft: 0, fontSize: 11.5 }}>
            {busy && <span className="pulse" />}
            <span className={cls}>{label}</span>
          </span>
        </div>
        <AgentLog s={{ key: card.branch, ai: card.agent, lines, status }} empty="" picks={pick ? [{ q: pick.text, qi: 0, key: '', n: pick.opts[0].n, label: pick.opts[0].label }] : []} onPicks={() => {}} />
        <div className="picker-acts" style={{ flex: '0 0 30px', borderTop: '1px solid var(--line)' }}>
          {card.picker.map((p, i) => (
            <span key={p} className="picker-act" style={{ flex: '1 1 0', justifyContent: 'space-between', ...(i === 0 && { borderLeft: 0 }) }}>
              <span className="ellipsis">{p}</span>
              <Icon name="chevronDown" size={10} />
            </span>
          ))}
        </div>
        <div className="term-input">
          <span className="mono c-acc">›</span>
          <span className="grow ellipsis mono faint" style={{ fontSize: 12 }}>{busy ? 'Agent is working…' : 'Reply to the agent…'}</span>
          <span className={`btn btn-sm btn-icon ${busy ? 'btn-danger' : 'btn-primary'}`}><Icon name={busy ? 'stop' : 'send'} size={busy ? 16 : 20} /></span>
        </div>
      </div>
    </div>
  );
}

export default function AgentCards() {
  return (
    <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '16px', padding: '18px', marginTop: '48px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '14px' }}>
      {/* Staggered, so the three never move in step. */}
      {CARDS.map((c, i) => <AgentCard key={c.branch} card={c} delay={3000 + i * 1700} />)}
    </div>
  );
}
