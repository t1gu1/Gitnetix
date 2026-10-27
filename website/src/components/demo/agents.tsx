import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import type { LogLine } from '../../../../src/api/types';
// The app's own reading of an agent's log: chat blocks, and the options it waits on you to pick.
import { blocks, questions, type Question } from '../../../../src/lib/agentLog';
import type { File } from '../HeroDemo';
import { Avatar, Choice, Markdown, Modal, Seg, useDemo } from './ui';

/**
 * Scripted agent sessions, one per worktree, shared by the workspace's agent pane and the Worktrees & agents page.
 * Logs use the app's raw lines ("$ claude · task", "✦ reply", tool steps), so src/lib/agentLog.ts reads them as the app does.
 */

export const ME = 'Grace Hopper';
export type Ai = { provider: string; model: string; effort: string };
export type Status = 'idle' | 'running' | 'waiting' | 'paused' | 'failed' | 'stopped';
export type Session = {
  key: string;
  project: string;
  branch: string;
  base: string;
  behind: number;
  /** Lines the agent added and removed in its worktree. */
  add: number;
  del: number;
  status: Status;
  ai: Ai;
  lines: LogLine[];
  ago: string;
  /** What it does with the next messages, before the generic replies. */
  script?: Turn[];
};
/** One answer: the steps it streams, its reply, what it changed. */
type Turn = { steps: string[]; reply: string; add?: number; del?: number; wip?: File[] };

export const cmd = (text: string): LogLine => ({ kind: 'cmd', text });
export const dim = (text: string): LogLine => ({ kind: 'dim', text });
export const ai = (text: string): LogLine => ({ kind: 'ai', text: `✦ ${text}` });
export const WAIT: LogLine = { kind: 'wait', text: '' };
export const RETRY = 'The last run failed. Read the errors above, fix them and try again.';
export const keyOf = (project: string, branch: string) => `${project}/${branch}`;
/** The folder `git worktree add` gets, as worktree_path in crates/core/src/app.rs names it. */
export const pathOf = (s: { project: string; branch: string }) => `~/code/${s.project}.${s.branch.replace(/\//g, '-')}`;

/** The workspace's suggested request. */
export const TRY = 'add a pulse that travels down the branch path';
const PULSE: Turn = {
  steps: ['Read src/screens/BranchTree.tsx', 'Read src/styles/app.css', 'Edit src/screens/BranchTree.tsx', 'Bash npm test'],
  reply: 'Done: the pulse now runs from the trunk to the checked-out branch and restarts when you switch. Tests pass. Want me to slow it down on long paths?',
  add: 31,
  wip: [{ path: 'src/lib/pulse.ts', add: 31, del: 0, s: 'A' }],
};

const FILES: Record<string, [string, string]> = {
  'acme-web': ['src/screens/BranchTree.tsx', 'src/styles/app.css'],
  'acme-api': ['src/routes/orders.ts', 'src/services/cart.ts'],
  'design-system': ['src/components/Button.tsx', 'docs/button.mdx'],
};
/** No script left: a plan with options first, then the work. */
function reply(s: Session, text: string): Turn {
  if (text.includes('pulse')) return PULSE;
  const [a, b] = FILES[s.project] ?? FILES['acme-web'];
  const name = (p: string) => p.split('/').pop();
  if (!s.lines.some((l) => l.kind === 'cmd'))
    return {
      steps: [`Grep ${/[a-z]{5,}/i.exec(text)?.[0] ?? 'TODO'} src`, `Read ${a}`, `Read ${b}`],
      reply: `I read ${name(a)} and ${name(b)}. Two ways to go:\n\n1. **Small change**: touch only what the request needs\n2. **Cleaner**: tidy the module first, then add it\n\nWhich one do you prefer?`,
    };
  return {
    steps: [`Edit ${a}`, `Edit ${b}`, 'Bash pnpm test'],
    reply: `Done: ${name(a)} and ${name(b)} are updated, and every test passes.`,
    add: 46,
    del: 9,
    wip: s.project === 'acme-web' ? [{ path: a, add: 38, del: 7, s: 'M' }, { path: b, add: 8, del: 2, s: 'M' }] : undefined,
  };
}

const SEED: Session[] = [
  {
    key: 'acme-web/fix/stale-remote', project: 'acme-web', branch: 'fix/stale-remote', base: 'release/0.6.0', behind: 2, add: 14, del: 9, status: 'running', ago: 'just now',
    ai: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
    lines: [
      cmd('$ claude · Branches deleted on origin stay in the tree until the app restarts (WEB-218). Find out why and fix it.'),
      dim('Grep prune crates/core/src'), dim('Read crates/core/src/git.rs'), dim('Read crates/core/src/watch.rs'),
      ai('Found it: the background fetch runs without `--prune`, so refs deleted on origin stay until a full refresh. Fixing it in `git.rs`.'),
      dim('Edit crates/core/src/git.rs'),
    ],
  },
  {
    key: 'acme-api/fix/tax-rounding', project: 'acme-api', branch: 'fix/tax-rounding', base: 'main', behind: 0, add: 0, del: 0, status: 'waiting', ago: '4 min ago',
    ai: { provider: 'codex', model: 'gpt-5-codex', effort: 'high' },
    lines: [
      cmd('$ codex · Some cart totals are off by one cent. Find out why and fix the rounding.'),
      dim('Grep total src/cart'), dim('Read src/cart/total.ts'), dim('Read src/cart/line.ts'), dim('Bash pnpm test cart'),
      ai('Totals add floats: 0.1 + 0.2 gives 0.30000000000000004, and the last line rounds up. Three ways to fix it:\n\n1. **Cents everywhere**: store and add integer cents, format at the edge\n2. **Round each line**: keep floats, round every line to 2 decimals\n3. **Decimal library**: add decimal.js for money math\n\nWhich one do you prefer?'),
      WAIT,
    ],
    script: [{
      steps: ['Edit src/cart/money.ts', 'Edit src/cart/total.ts', 'Edit src/cart/line.ts', 'Bash pnpm test cart'],
      reply: 'Done: prices stay integer cents from the API to the receipt, and only `formatMoney()` turns them into dollars. The 3 carts that were off now match their invoices.\n\n- New `src/cart/money.ts`\n- 31 cart tests pass, 4 of them new',
      add: 96,
      del: 41,
    }],
  },
  {
    key: 'acme-api/feat/rate-limit', project: 'acme-api', branch: 'feat/rate-limit', base: 'main', behind: 3, add: 184, del: 12, status: 'waiting', ago: '12 min ago',
    ai: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    lines: [
      cmd('$ claude · Add a per-token rate limit to the public API: 100 requests a minute, then 429 with Retry-After.'),
      dim('Read src/middleware/index.ts'), dim('Read src/routes/public.ts'), dim('Edit src/middleware/rateLimit.ts'), dim('Edit src/routes/public.ts'), dim('Edit test/rateLimit.test.ts'), dim('Bash pnpm test'),
      ai('Done. `rateLimit()` keeps a sliding window per token in Redis and answers **429** with `Retry-After` once a token passes 100 requests a minute.\n\n- New middleware in `src/middleware/rateLimit.ts`\n- On every `/v1/public` route\n- 14 new tests, all 212 pass'),
      WAIT,
    ],
  },
  {
    key: 'design-system/feat/dark-tokens', project: 'design-system', branch: 'feat/dark-tokens', base: 'main', behind: 0, add: 58, del: 0, status: 'failed', ago: '1 h ago',
    ai: { provider: 'gemini', model: 'gemini-2.5-pro', effort: '' },
    lines: [
      cmd('$ gemini · Generate dark mode tokens from the light palette and export them as CSS variables.'),
      dim('Read tokens/light.json'), dim('Edit tokens/dark.json'), dim('Edit src/index.ts'), dim('Bash pnpm build'),
      { kind: 'err', text: '✕ pnpm build exited with 1: Cannot find module "./tokens/dark.css"' },
    ],
    script: [{ steps: ['Read package.json', 'Edit scripts/tokens.ts', 'Bash pnpm build'], reply: 'Fixed: the build script now writes `tokens/dark.css` before bundling. The build passes, and every light token has a dark one.', add: 12, del: 2 }],
  },
  { key: 'design-system/docs/button-usage', project: 'design-system', branch: 'docs/button-usage', base: 'main', behind: 5, add: 0, del: 0, status: 'idle', ago: '', ai: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, lines: [] },
];
/** Turns already under way, played once their page is looked at: the running agent is still at work when you get there. */
const PARKED: Record<string, { turn: Turn; i: number }> = {
  'acme-web/fix/stale-remote': {
    i: 0,
    turn: {
      steps: ['Bash cargo test -p gitnetix-core fetch', 'Read crates/core/src/cache.rs', 'Edit crates/core/src/cache.rs', 'Bash cargo test -p gitnetix-core'],
      reply: 'Done: fetch now passes `--prune`, and the branch cache drops refs that left origin, so they leave the tree on the next fetch.\n\n- `git.rs`: `--prune` on every fetch\n- `cache.rs`: evict pruned refs\n- 142 tests pass',
      add: 22,
      del: 3,
      wip: [{ path: 'crates/core/src/cache.rs', add: 19, del: 1, s: 'M' }, { path: 'crates/core/src/git.rs', add: 3, del: 2, s: 'M' }],
    },
  },
};

/** Done = waiting with changes to merge and no question asked, as shownStatus in src/lib/agentLog.ts. */
export const shown = (s: Session): Status | 'done' => (s.status === 'waiting' && s.add + s.del > 0 && !questions(s.lines).length ? 'done' : s.status);

export type Agents = ReturnType<typeof useAgents>;

/** `onTurn` hears each finished answer, to put its files in the workspace. */
export function useAgents(onTurn: (s: Session, wip: File[]) => void) {
  const [sessions, setSessions] = useState(SEED);
  // The agent picked for new sessions, like useAgentPick.
  const [pick, setPick] = useState<Ai>({ provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' });
  const timers = useRef<Record<string, number[]>>({});
  const doing = useRef(Object.fromEntries(Object.entries(PARKED).map(([k, d]) => [k, { ...d }])));
  const parked = useRef(new Set(Object.keys(PARKED)));
  const latest = useRef({ sessions, onTurn });
  latest.current = { sessions, onTurn };
  useEffect(() => () => Object.values(timers.current).flat().forEach(clearTimeout), []);

  const patch = (key: string, f: (s: Session) => Partial<Session>) => setSessions((l) => l.map((s) => (s.key === key ? { ...s, ...f(s) } : s)));
  const log = (key: string, ...lines: LogLine[]) => patch(key, (s) => ({ lines: [...s.lines, ...lines] }));
  const at = (key: string, ms: number, f: () => void) => (timers.current[key] ??= []).push(window.setTimeout(f, ms));
  const halt = (key: string) => {
    (timers.current[key] ?? []).forEach(clearTimeout);
    timers.current[key] = [];
    parked.current.delete(key);
  };
  /** Plays the rest of the turn: a step at a time, then the reply. */
  const drive = (key: string) => {
    const d = doing.current[key];
    if (!d) return;
    const left = d.turn.steps.slice(d.i);
    left.forEach((step, j) => at(key, 900 + j * 750, () => {
      d.i++;
      log(key, dim(step));
    }));
    at(key, 900 + left.length * 750 + 700, () => {
      delete doing.current[key];
      const t = d.turn;
      patch(key, (s) => ({ status: 'waiting', ago: 'just now', add: s.add + (t.add ?? 0), del: s.del + (t.del ?? 0), lines: [...s.lines, ai(t.reply), WAIT] }));
      const s = latest.current.sessions.find((x) => x.key === key);
      if (s && t.wip) latest.current.onTurn(s, t.wip);
    });
  };
  const ask = (s: Session, text: string) => {
    halt(s.key);
    const [next, ...rest] = s.script ?? [];
    doing.current[s.key] = { turn: next ?? reply(s, text), i: 0 };
    const first = !s.lines.some((l) => l.kind === 'cmd');
    patch(s.key, (x) => ({ status: 'running', ago: 'just now', script: rest, lines: [...x.lines, cmd(first ? `$ ${s.ai.provider} · ${text}` : `› ${text}`)] }));
    drive(s.key);
  };
  const get = (k: string) => sessions.find((s) => s.key === k);

  return {
    sessions,
    get,
    pick,
    setPick,
    /** A new session in its own worktree, or a first message to an idle one. */
    start: (w: { project: string; branch: string; base: string; behind?: number }, text: string, ai = pick) => {
      const s: Session = get(keyOf(w.project, w.branch)) ?? { ...w, key: keyOf(w.project, w.branch), behind: w.behind ?? 0, add: 0, del: 0, status: 'idle', ago: '', ai, lines: [] };
      if (!get(s.key)) setSessions((l) => [...l, s]);
      ask(s, text);
    },
    send: (k: string, text: string) => {
      const s = get(k);
      if (s) ask(s, text);
    },
    pause: (k: string) => {
      halt(k);
      patch(k, () => ({ status: 'paused' }));
      log(k, { kind: 'dim', text: '⏸ Paused' });
    },
    resume: (k: string) => {
      patch(k, () => ({ status: 'running' }));
      log(k, { kind: 'dim', text: '▶ Resumed' });
      drive(k);
    },
    stop: (k: string) => {
      halt(k);
      delete doing.current[k];
      patch(k, () => ({ status: 'stopped' }));
      log(k, { kind: 'dim', text: '■ Stopped' });
    },
    remove: (k: string) => {
      halt(k);
      delete doing.current[k];
      setSessions((l) => l.filter((s) => s.key !== k));
    },
    update: (k: string, p: Partial<Session>) => patch(k, () => p),
    /** Lets a parked turn play on. */
    wake: (k?: string) => {
      for (const p of [...parked.current].filter((x) => !k || x === k)) {
        parked.current.delete(p);
        drive(p);
      }
    },
  };
}

/** "Read ×3 · Edit · Bash ×2" */
function summary(lines: LogLine[]) {
  const counts = new Map<string, number>();
  for (const l of lines) {
    const name = l.text.trim().split(/\s/)[0] || 'output';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');
}

// Claude's starburst: rays of alternating length around the centre.
const RAYS = Array.from({ length: 12 }, (_, i) => {
  const a = (i * Math.PI) / 6;
  const r = i % 2 ? 5.2 : 6.6;
  return `M${8 + 1.6 * Math.cos(a)} ${8 + 1.6 * Math.sin(a)}L${8 + r * Math.cos(a)} ${8 + r * Math.sin(a)}`;
}).join('');

/** Same catalog as crates/core/src/ai.rs: models listed for Claude, typed for the others. */
const PROVIDERS: { id: string; name: string; mono: string; effort?: boolean; models?: [string, string][] }[] = [
  { id: 'claude', name: 'Claude', mono: 'CL', effort: true, models: [['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-fable-5-1', 'Claude Fable 5.1']] },
  { id: 'codex', name: 'Codex', mono: 'CX', effort: true },
  { id: 'gemini', name: 'Gemini', mono: 'GM' },
  { id: 'copilot', name: 'GitHub Copilot', mono: 'CP', effort: true },
  { id: 'ollama', name: 'Ollama', mono: 'OL' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The agent's mark, like AgentMark in src/components/AgentLog.tsx: its maker's logo when there is one, else its short code. */
function AgentMark({ provider }: { provider: string }) {
  return (
    <span className="ag-avatar" aria-hidden="true">
      {provider === 'claude' ? (
        <svg width={17} height={17} viewBox="0 0 16 16" stroke="#d97757" strokeWidth={1.7} strokeLinecap="round"><path d={RAYS} /></svg>
      ) : provider === 'gemini' ? (
        <svg width={17} height={17} viewBox="0 0 16 16" fill="#4796e3"><path d="M8 1c0 3.9 3.1 7 7 7-3.9 0-7 3.1-7 7 0-3.9-3.1-7-7-7 3.9 0 7-3.1 7-7z" /></svg>
      ) : (
        <span className="ag-mono">{PROVIDERS.find((p) => p.id === provider)?.mono ?? '✦'}</span>
      )}
    </span>
  );
}

/** Provider, model and effort, like AgentPicker in src/components/AgentPicker.tsx; `field` is the modal's form-field look. */
export function AgentPicker({ value, onChange, field }: { value: Ai; onChange: (a: Ai) => void; field?: boolean }) {
  const p = PROVIDERS.find((x) => x.id === value.provider) ?? PROVIDERS[0];
  const set = (patch: Partial<Ai>) => onChange({ ...value, ...patch });
  const cls = field ? 'select menu-select' : 'picker-act';
  return (
    <div className={field ? 'row' : 'picker-acts'} style={field ? { gap: 6, margin: 0 } : undefined}>
      <Choice className={field ? cls : `${cls} hd-opt`} label="Agent provider" value={p.id} options={PROVIDERS.map((x) => ({ value: x.id, label: x.name }))} onChange={(v) => set({ provider: v, model: v === 'claude' ? 'claude-opus-5-5' : '', effort: '' })} />
      {p.models ? (
        <Choice className={cls} label="Agent model" value={value.model} options={[{ value: '', label: 'Default model' }, ...p.models.map(([v, l]) => ({ value: v, label: l }))]} onChange={(v) => set({ model: v })} />
      ) : (
        <input aria-label="Agent model" className={field ? 'input mono' : 'picker-act mono'} style={{ width: 120 }} placeholder="model id" value={value.model} onChange={(e) => set({ model: e.target.value })} />
      )}
      {p.effort && <Choice className={cls} label="Agent effort" value={value.effort} options={[{ value: '', label: 'Default effort' }, ...EFFORTS.map((x) => ({ value: x, label: x }))]} onChange={(v) => set({ effort: v })} />}
    </div>
  );
}

/** An option picked from the agent's suggestions, waiting in the prompt box. */
export type Pick = { q: string; qi: number; key: string; n: string; label: string };
const pickText = (c: Pick) => `${c.key ? `${c.key}: ` : ''}${c.n}. ${c.label}`;

function Choices({ qs, picks, onPicks }: { qs: Question[]; picks: Pick[]; onPicks: (c: Pick[]) => void }) {
  const on = (qi: number, n: string) => picks.some((p) => p.qi === qi && p.n === n);
  const toggle = (qi: number, o: { n: string; label: string }) => {
    const rest = picks.filter((p) => p.qi !== qi);
    const key = qs.length > 1 ? qs[qi].id || `Q${qi + 1}` : '';
    onPicks(on(qi, o.n) ? rest : [...rest, { q: qs[qi].text, qi, key, n: o.n, label: o.label }].sort((a, b) => a.qi - b.qi));
  };
  return (
    <>
      {qs.map((q, i) => (
        <div key={i} className="ag-q">
          {qs.length > 1 && <span className="ag-q-text">{q.text}</span>}
          <div className="ag-choices">
            {q.opts.map((o) => (
              <button key={o.n} type="button" className="btn btn-sm" title={o.label} aria-pressed={on(i, o.n)} onClick={() => toggle(i, o)}>
                <span className="c-acc">{o.n}</span>
                <span className="ellipsis">{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** The chat, like AgentLog in src/components/AgentLog.tsx; `actions` show under "Your turn!" when the agent asked nothing. */
export function AgentLog({ s, empty, picks, onPicks, actions, error }: { s?: { key: string; lines: LogLine[]; status: Status; ai: Ai }; empty: string; picks: Pick[]; onPicks: (c: Pick[]) => void; actions?: ReactNode; error?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = s?.lines ?? [];
  const list = blocks(lines);
  const qs = questions(lines);
  // Picks for questions no longer asked (answered, another session) leave the prompt box.
  const live = picks.filter((p) => qs[p.qi]?.text === p.q && qs[p.qi].opts.some((o) => o.n === p.n));
  useEffect(() => {
    if (live.length !== picks.length) onPicks(live);
  });
  const thinking = s?.status === 'running';
  // One mark per answer: on the first reply or steps after each message of yours.
  const opens = new Set<number>();
  let fresh = true;
  list.forEach((b, i) => {
    if (b.kind === 'you') fresh = true;
    else if (fresh && (b.kind === 'ai' || b.kind === 'steps')) {
      opens.add(i);
      fresh = false;
    }
  });
  const mark = <AgentMark provider={s?.ai.provider ?? 'claude'} />;
  // New lines keep the log scrolled to the bottom.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, thinking, error, s?.key]);
  return (
    <div ref={ref} className="term-log ag-log" aria-live="polite">
      {lines.length === 0 && !error && <div className="ag-empty">{empty}</div>}
      {list.map((b, i) => {
        switch (b.kind) {
          case 'you':
            return (
              <div key={i} className="ag-you">
                <div className="ag-you-row">
                  <Avatar name={ME} size={22} />
                  <div className="ag-bubble">
                    {b.text && <span>{b.text}</span>}
                    {b.files.length > 0 && (
                      <span className="ag-files">
                        {b.files.map((f) => <span key={f} className="ag-file"><Icon name="file" size={15} /><span className="ellipsis">{f}</span></span>)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          case 'ai':
            return (
              <div key={i} className="ag-ai">
                {opens.has(i) && mark}
                <Markdown text={b.text} />
              </div>
            );
          case 'steps':
            // The newest steps stay open while the agent works on them.
            return (
              <div key={i} className="ag-act">
                {opens.has(i) && mark}
                <details className="ag-steps" open={i === list.length - 1}>
                  <summary>
                    <span className="ag-steps-n">{b.lines.length === 1 ? '1 step' : `${b.lines.length} steps`}</span>
                    <span className="ellipsis">{summary(b.lines)}</span>
                  </summary>
                  <div className="ag-steps-list">
                    {b.lines.map((l, j) => {
                      const [name, ...rest] = l.text.trim().split(' ');
                      return (
                        <div key={j} className="ag-step">
                          <span className="ag-step-name">{name}</span>
                          <span className="ag-step-detail" title={rest.join(' ')}>{rest.join(' ')}</span>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
            );
          case 'wait':
            // Only the latest wait matters; older ones are history.
            return i !== list.length - 1 ? null : (
              <div key={i} className="ag-wait">
                <span className="ag-wait-chip">Your turn!</span>
                {qs.length > 0 && (
                  <div className="ag-sugg" role="group" aria-label="Suggestions">
                    <span className="ag-sugg-label">Suggestions</span>
                    <Choices qs={qs} picks={picks} onPicks={onPicks} />
                  </div>
                )}
                {qs.length === 0 && actions}
              </div>
            );
          case 'err':
            return <div key={i} className="ag-err">✕ {b.text}</div>;
          case 'ok':
            return <div key={i} className="ag-note ag-ok">✓ {b.text}</div>;
          default:
            return <div key={i} className="ag-note">{b.text}</div>;
        }
      })}
      {error && <div className="ag-err">✕ {error}</div>}
      {thinking && (
        <div className="ag-act" role="status" aria-label="Agent is thinking">
          {fresh && mark}
          <span className="ag-dots" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
    </div>
  );
}

/** The prompt box: picked options ride above it and go first in the message; `onStop` swaps Send for Stop while the agent works. */
export function AgentInput({ id, value, onChange, picks, onPicks, onSend, onStop, placeholder, disabled, picker }: { id: string; value: string; onChange: (v: string) => void; picks: Pick[]; onPicks: (c: Pick[]) => void; onSend: (text: string) => void; onStop?: () => void; placeholder: string; disabled?: boolean; picker?: ReactNode }) {
  const ready = !disabled && !onStop && (!!value.trim() || picks.length > 0);
  return (
    <>
      {picks.length > 0 && (
        <div className="ag-attach">
          {picks.map((p) => (
            <span key={p.qi} className="ag-file ag-pick" title={p.q}>
              <span className="c-acc">{p.key ? `${p.key} · ${p.n}` : p.n}</span>
              <span className="ellipsis">{p.label}</span>
              <button type="button" className="ag-file-x" aria-label={`Remove answer ${p.n}`} onClick={() => onPicks(picks.filter((x) => x !== p))}>
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className="term-input"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          onSend([picks.map(pickText).join('\n'), value.trim()].filter(Boolean).join('\n\n'));
          onPicks([]);
        }}
      >
        <span className="mono c-acc" aria-hidden="true">›</span>
        <label htmlFor={id} className="sr-only">Ask the agent</label>
        <input id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
        {picker}
        {onStop ? (
          <button type="button" className="btn btn-sm btn-danger btn-icon" aria-label="Stop the agent" title="Stop" onClick={onStop}>
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button type="submit" className="btn btn-sm btn-primary btn-icon" aria-label="Send" title="Send" disabled={!ready}>
            <Icon name="send" size={20} />
          </button>
        )}
      </form>
    </>
  );
}

/** The close options inline under the agent's last reply, like CloseWorktreeModal in src/screens/Workspace.tsx. */
export function FinishCard({ s }: { s: Session }) {
  const { finish } = useDemo();
  const [then, setThen] = useState<'continue' | 'merge'>('merge');
  const [sw, setSw] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  return (
    <div className="ag-finish">
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        The agent will stop and the worktree folder will be deleted.
        <br />
        {then === 'merge' ? (
          <>The folder will be deleted once <span className="mono">{s.branch}</span> is merged{sw ? ', and you will switch to the branch it went into' : ''}.</>
        ) : (
          <><span className="mono">{s.branch}</span> and its commits will stay{sw ? <>, and you will switch to <span className="mono">{s.branch}</span></> : ''}.</>
        )}
      </p>
      <Seg grid label="Then" value={then} onChange={setThen} options={[['continue', 'Continue on branch'], ['merge', 'Merge it']]} />
      <label className="check">
        <input type="checkbox" checked={sw} onChange={() => setSw(!sw)} />
        <span>Switch to {then === 'merge' ? 'the branch it merges into' : <span className="mono">{s.branch}</span>}</span>
      </label>
      <div className="ag-finish-foot">
        <button type="button" className="btn btn-md btn-danger" style={{ flex: '1 1 0' }} title={`Delete the worktree, its uncommitted changes and the local ${s.branch} branch`} onClick={() => setDiscarding(true)}>Cancel and Delete all</button>
        <button type="button" className="btn btn-md btn-primary" style={{ flex: '1 1 0' }} onClick={() => finish(s.key, then, sw)}>
          {then === 'merge' ? `Finish and merge into ${s.base}` : 'Finish with the agent / worktree'}
        </button>
      </div>
      {discarding && <DiscardModal s={s} onClose={() => setDiscarding(false)} />}
    </div>
  );
}

/** DiscardWorktreeModal in src/screens/Workspace.tsx. */
export function DiscardModal({ s, onClose }: { s: Session; onClose: () => void }) {
  const { finish } = useDemo();
  return (
    <Modal
      title="Delete worktree and branch"
      sub={<span className="mono">{s.branch}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md btn-danger" onClick={() => { finish(s.key, 'discard', false); onClose(); }}>Cancel and Delete all</button>
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        The agent stops and the worktree at <span className="mono">{pathOf(s)}</span> is deleted with its uncommitted changes, then the local branch <span className="mono">{s.branch}</span>, even unmerged. The branch on origin is kept.
      </p>
    </Modal>
  );
}
