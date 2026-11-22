import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { Avatar, Busy, Menu, Modal, PageHead, Seg, useDemo, useLater, useMenu } from './ui';

/** src/screens/Submodules.tsx on made-up submodules: one of each state, each fixed by its button, with the git output it would print. */

type Sub = {
  path: string;
  url: string;
  /** The local clone's URL, when it differs from .gitmodules. */
  localUrl?: string;
  branch?: string;
  upstream?: string;
  recorded: string;
  head?: string;
  state: 'clean' | 'uninitialized' | 'moved';
  ahead: number;
  behind: number;
  upstreamBehind: number;
  dirty: number;
  staged?: boolean;
  subject?: string;
  author?: string;
  date?: string;
};
type Output = { title: string; text: string };
type Tone = 'ok' | 'new' | 'warn' | 'bad' | 'off';

const ROOT = '/home/grace/code/acme-web';
const SUBS: Sub[] = [
  { path: 'libs/ui-kit', url: 'git@github.com:acme/ui-kit.git', branch: 'main', upstream: 'origin/main', recorded: '4f1c2a9e0b7d', head: '4f1c2a9e0b7d', state: 'clean', ahead: 0, behind: 0, upstreamBehind: 0, dirty: 0, subject: 'Button: focus ring uses the accent color', author: 'Mei Lin', date: '3 days ago' },
  { path: 'libs/icons', url: 'git@github.com:acme/icons.git', branch: 'main', upstream: 'origin/main', recorded: '8d2e61f4a3c0', head: '8d2e61f4a3c0', state: 'clean', ahead: 0, behind: 0, upstreamBehind: 4, dirty: 0, subject: 'Add branch and worktree icons', author: 'Tom Becker', date: '2 weeks ago' },
  { path: 'vendor/tree-sitter-git', url: 'https://github.com/acme/tree-sitter-git.git', upstream: 'origin/master', recorded: '9a03f5d1e2b8', head: 'b71e0c2f9d44', state: 'moved', ahead: 2, behind: 0, upstreamBehind: 0, dirty: 0, subject: 'Highlight trailers in commit messages', author: 'Jules Laurent', date: 'yesterday' },
  { path: 'tools/eslint-config', url: 'git@github.com:acme/eslint-config.git', localUrl: 'https://github.com/acme/eslint-config.git', branch: 'main', upstream: 'origin/main', recorded: '1b9c7e30fa62', head: '1b9c7e30fa62', state: 'clean', ahead: 0, behind: 0, upstreamBehind: 0, dirty: 2, subject: 'Allow non-null assertions in tests', author: 'Ana Moreau', date: 'Sep 30, 2026' },
  { path: 'docs/handbook', url: 'git@github.com:acme/handbook.git', branch: 'main', recorded: 'c0ffee12ab34', state: 'uninitialized', ahead: 0, behind: 0, upstreamBehind: 0, dirty: 0 },
];

const short = (sha?: string) => sha?.slice(0, 7) ?? '—';
/** A made-up commit id, different each call. */
const sha = () => Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
/** Path a URL clones into by default (same rule as the engine). */
const defaultPath = (url: string) => (url.trim().replace(/\/+$/, '').split(/[/:\\]/).pop() ?? '').replace(/\.git$/, '');
const needsYou = (s: Sub) => s.state !== 'clean' || s.dirty > 0 || s.upstreamBehind > 0 || !!s.staged || !!s.localUrl;

/** One status per submodule, most pressing first. */
function status(s: Sub): [string, Tone] {
  if (s.state === 'uninitialized') return ['Not cloned', 'off'];
  if (s.state === 'moved') return ['Off its pin', 'warn'];
  if (s.localUrl) return ['URL out of sync', 'warn'];
  if (s.upstreamBehind > 0) return [`${s.upstreamBehind} new on remote`, 'new'];
  if (s.staged) return ['New pin staged', 'new'];
  if (s.dirty > 0) return [plural(s.dirty, 'changed file'), 'warn'];
  return ['Up to date', 'ok'];
}
/** Checked out at its pin, or at the tip of its remote, with what git would print. */
function update(s: Sub, remote: boolean): [Sub, string] {
  const head = remote ? (s.upstreamBehind ? sha() : (s.head ?? s.recorded)) : s.recorded;
  const clone = s.state === 'uninitialized' ? `Cloning into '${ROOT}/${s.path}'...\n` : '';
  const out = `${clone}Submodule path '${s.path}': checked out '${head}'`;
  const moved = head !== s.recorded;
  return [{ ...s, head, state: moved ? 'moved' : 'clean', ahead: moved ? (s.ahead || s.upstreamBehind) : 0, behind: 0, upstreamBehind: remote ? 0 : s.upstreamBehind, upstream: s.upstream ?? `origin/${s.branch ?? 'main'}`, subject: s.subject ?? 'Initial handbook', author: s.author ?? 'Ana Moreau', date: remote && moved ? 'just now' : (s.date ?? 'last month') }, out];
}

export default function Submodules() {
  const { flash } = useDemo();
  const later = useLater();
  const [list, setList] = useState(SUBS);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [sel, setSel] = useState<string>();
  // On the phone: the list, or the picked submodule in its place.
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [adding, setAdding] = useState(false);
  const [output, setOutput] = useState<Output>();
  // The path being updated, or '*' for all of them.
  const [busy, setBusy] = useState<string>();
  const [fetching, setFetching] = useState(false);
  const [checked, setChecked] = useState('4 min ago');
  const bulk = useMenu();
  const attention = list.filter(needsYou);
  const groups = [
    { id: 'you', label: 'Needs you', items: attention },
    { id: 'ok', label: 'Up to date', items: filter === 'all' ? list.filter((s) => !needsYou(s)) : [] },
  ].filter((g) => g.items.length);
  const shown = groups.flatMap((g) => g.items);
  const cur = list.find((s) => s.path === sel) ?? shown[0];
  const behind = list.filter((s) => s.upstreamBehind > 0).length;
  const set = (path: string, f: (s: Sub) => Sub) => setList((l) => l.map((s) => (s.path === path ? f(s) : s)));

  const run = (paths: string[], remote: boolean, done: string, title: string) => {
    setBusy(paths.length > 1 ? '*' : paths[0]);
    // Their buttons wait meanwhile, so nothing else changes them.
    const results = new Map(list.filter((s) => paths.includes(s.path)).map((s) => [s.path, update(s, remote)]));
    later(1200, () => {
      setList((l) => l.map((s) => results.get(s.path)?.[0] ?? s));
      setBusy(undefined);
      setOutput({ title, text: [...results.values()].map((r) => r[1]).join('\n') });
      flash(done);
    });
  };
  const updateAll = (remote: boolean) => run(list.map((s) => s.path), remote, remote ? "Every submodule moved to its remote's latest" : 'Every submodule checked out at its pin', remote ? 'Pull latest, all' : 'Update all');
  const checkRemotes = () => {
    setFetching(true);
    later(1100, () => {
      setFetching(false);
      setChecked('just now');
      // Someone pushed to the UI kit meanwhile.
      set('libs/ui-kit', (s) => ({ ...s, upstreamBehind: s.upstreamBehind || 1 }));
      flash(`Checked ${plural(list.filter((s) => s.head).length, 'remote')}`);
    });
  };

  const bulkBtn = (cls: string) => (
    <span className={`split-btn ${cls}`}>
      <button className="btn btn-sm btn-primary split-main" disabled={!!busy} title="Clone missing submodules and check each out at the commit the project pins, nested ones included" onClick={() => updateAll(false)}>
        {busy === '*' ? <span className="spinner" /> : <Icon name="box" size={13} />}
        {busy === '*' ? 'Updating…' : 'Update all'}
      </button>
      <button className="btn btn-sm btn-primary btn-icon split-more" aria-label="More bulk actions" title="More bulk actions" aria-haspopup="menu" disabled={!!busy} onClick={(e) => bulk.toggle(e, true)}>
        <Icon name="chevronDown" size={13} />
      </button>
    </span>
  );

  return (
    <>
      <PageHead title="Submodules" sub="acme-web" onBack={pane === 'detail' ? () => setPane('list') : undefined} />
      <div className="map-bar sm-bar" data-detail={pane === 'detail' || undefined}>
        <h2 className="map-title hide-narrow">Submodules</h2>
        <span className="pr-where mono ellipsis hide-narrow">acme-web · {list.length} in .gitmodules</span>
        {list.length > 0 && <Seg label="Filter" value={filter} onChange={setFilter} options={[['all', <>All <span className="faint">{list.length}</span></>], ['attention', <>Needs you <span className="faint">{attention.length}</span></>]]} />}
        <span className="grow" />
        <span className="sm-checked hide-narrow">Remotes checked {checked}</span>
        <button className="btn btn-sm btn-icon" aria-label="Check remotes for updates" title={`Check remotes for updates (fetch) · ${behind ? `${behind} with new commits on their remote` : 'nothing new as of the last check'}`} disabled={fetching} onClick={checkRemotes}>
          <Busy on={fetching}><Icon name="refresh" size={14} /></Busy>
        </button>
        <button className="btn btn-sm hide-narrow" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} />
          Add submodule
        </button>
        {list.length > 0 && bulkBtn('hide-narrow')}
      </div>
      <div className="body split">
        <section className="master" style={{ '--master-w': '340px' } as CSSProperties} data-pane data-active={pane === 'list'} aria-label="Submodules">
          <div className="scroll sm-list">
            {groups.map((g) => (
              <div key={g.id}>
                <div className="group-head">
                  <span>{g.label}</span>
                  <span className="mono">{g.items.length}</span>
                </div>
                <div className="col" style={{ gap: 1 }}>
                  {g.items.map((s) => (
                    <Row key={s.path} s={s} active={s.path === cur?.path} busy={busy === s.path || busy === '*'} onPick={() => { setSel(s.path); setPane('detail'); }} />
                  ))}
                </div>
              </div>
            ))}
            {list.length > 0 && shown.length === 0 && (
              <div className="sm-none sm-clear">
                <Icon name="check" size={18} className="c-add" />
                <strong>Nothing needs you</strong>
                <p>All {list.length} submodules sit at their pins with nothing new on their remotes as of {checked}.</p>
                <button className="btn btn-sm" onClick={() => setFilter('all')}>Show all {list.length}</button>
              </div>
            )}
            {list.length === 0 && (
              <div className="sm-none sm-clear">
                <strong>No submodules in acme-web</strong>
                <button className="btn btn-sm" onClick={() => setAdding(true)}>Add a submodule</button>
              </div>
            )}
          </div>
          {list.length > 0 && <div className="sm-foot">{bulkBtn('')}</div>}
        </section>
        <main className="detail" data-pane data-active={pane === 'detail'}>
          <div className="detail-inner sm-detail">
            {cur && (
              <Detail
                key={cur.path}
                s={cur}
                busy={busy === cur.path || busy === '*'}
                checked={checked}
                set={(f) => set(cur.path, f)}
                onRemove={() => setList((l) => l.filter((s) => s.path !== cur.path))}
                onRun={(remote) => run([cur.path], remote, remote ? `${cur.path} moved to the latest of ${cur.upstream ?? 'its remote'}` : cur.head ? `${cur.path} checked out at its pin` : `${cur.path} cloned`, `${remote ? 'Pull latest' : 'Update'} · ${cur.path}`)}
              />
            )}
            {busy === '*' && (
              <section className="sm-sec" aria-label="Command output">
                <div className="sm-sec-head">
                  <h2 className="label">Update all</h2>
                  <span className="spinner" />
                  <span>Checking out every submodule at its pin</span>
                </div>
              </section>
            )}
            {output && busy !== '*' && (
              <section className="sm-sec" aria-label="Command output">
                <div className="sm-sec-head">
                  <h2 className="label">Last command</h2>
                  <span className="ellipsis">{output.title}</span>
                  <span className="grow" />
                  <button className="btn btn-sm btn-ghost" onClick={() => setOutput(undefined)}>Clear</button>
                </div>
                <pre className="pre sm-pre">{output.text}</pre>
              </section>
            )}
          </div>
        </main>
      </div>
      {bulk.at && (
        <Menu
          {...bulk.at}
          alignRight
          label="Bulk submodule actions"
          onClose={bulk.close}
          items={[
            { id: 'update', label: 'Update all to their pins', icon: 'box', run: () => updateAll(false) },
            { id: 'remote', label: 'Pull latest for all', icon: 'download', hint: 'then pin them', run: () => updateAll(true) },
            'sep',
            { id: 'sync', label: 'Sync all URLs', icon: 'swap', hint: 'from .gitmodules', run: () => { setList((l) => l.map((s) => ({ ...s, localUrl: undefined }))); flash('URLs synced'); } },
            { id: 'fetch', label: 'Check remotes for updates', icon: 'refresh', run: checkRemotes },
          ]}
        />
      )}
      {adding && (
        <AddModal
          taken={list.map((s) => s.path)}
          onAdded={(s) => {
            setList((l) => [...l, s]);
            setSel(s.path);
            setPane('detail');
            setOutput({ title: `Added ${s.path}`, text: `Cloning into '${ROOT}/${s.path}'...\nremote: Enumerating objects: 214, done.\nremote: Total 214 (delta 61), reused 198 (delta 52)\nReceiving objects: 100% (214/214), 88.41 KiB | 2.1 MiB/s, done.\nResolving deltas: 100% (61/61), done.` });
            flash(`Added ${s.path}: commit it from the workspace`);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

/** A row of the list: status ring, path and status, then the last commit's subject, uncommitted files and the commit. */
function Row({ s, active, busy, onPick }: { s: Sub; active: boolean; busy: boolean; onPick: () => void }) {
  const [label, tone] = status(s);
  return (
    <button className="item-btn sm-row" aria-pressed={active} onClick={onPick}>
      {busy ? <span className="spinner" aria-label="Updating" /> : <span className="sm-ring" data-tone={tone} aria-hidden="true" />}
      <span className="mono ellipsis sm-row-path">{s.path}</span>
      <span className="sm-row-state" data-tone={busy ? undefined : tone}>{busy ? 'Updating' : label}</span>
      <span className="sm-row-meta">
        <span className={s.subject ? 'ellipsis' : 'ellipsis mono'}>{s.subject ?? s.url}</span>
        {s.dirty > 0 && label !== plural(s.dirty, 'changed file') && <span className="c-warn" title="Uncommitted files inside">{s.dirty} changed</span>}
        <span className="mono">{short(s.head ?? s.recorded)}</span>
      </span>
    </button>
  );
}

function Detail({ s, busy, checked, set, onRun, onRemove }: { s: Sub; busy: boolean; checked: string; set: (f: (s: Sub) => Sub) => void; onRun: (remote: boolean) => void; onRemove: () => void }) {
  const { flash, go } = useDemo();
  const more = useMenu();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [label, tone] = status(s);
  const cloned = !!s.head;
  const pin = () => {
    set((x) => ({ ...x, recorded: x.head!, state: 'clean', ahead: 0, behind: 0, staged: true }));
    flash('New pin staged: commit it from the workspace');
  };
  const sync = () => {
    set((x) => ({ ...x, localUrl: undefined }));
    flash('URL synced');
  };
  const web = s.url.replace(/^git@github.com:/, 'github.com/').replace(/^https:\/\//, '').replace(/\.git$/, '');
  return (
    <>
      <header className="sm-head">
        <div className="sm-title">
          <h1 className="mono">{s.path}</h1>
          <div className="sm-sub">
            <span className="tag" data-tone={tone}>{label}</span>
            {s.branch || s.upstream ? (
              <span>
                Tracks <span className="mono c-current">{s.branch ?? s.upstream!.replace(/^origin\//, '')}</span>
                {!s.branch && <span className="faint">, the remote's default</span>}
              </span>
            ) : (
              <span>Tracks the remote's default branch</span>
            )}
          </div>
        </div>
        <div className="sm-acts">
          <button className="btn btn-sm" title={web} onClick={() => flash(`Opens ${web} in the browser`)}>
            <Icon name="external" size={12} />
            <span className="hide-narrow">View repository</span>
          </button>
          <button className="btn btn-sm hide-narrow" disabled={!cloned} title="Work on it in its own tab" onClick={() => flash(`${s.path} opens as a project in its own tab`)}>
            <Icon name="layers" size={12} />
            Open as project
          </button>
          <button className="btn btn-sm btn-icon" aria-label="More submodule actions" title="Update, edit, sync or copy the URL, remove" aria-haspopup="menu" onClick={(e) => more.toggle(e, true)}>
            <Icon name="more" size={14} />
          </button>
        </div>
      </header>

      <section className="sm-sec">
        <div className="sm-sec-head">
          <h2 className="label">Where it stands</h2>
          {cloned && <span>Remote as of {checked}</span>}
        </div>
        <PinLine s={s} busy={busy} act={{ update: () => onRun(false), latest: () => onRun(true), pin, commit: () => go('workspace') }} />
        {(s.localUrl || (cloned && s.dirty > 0)) && (
          <div className="sm-notes">
            {s.localUrl && (
              <div className="sm-note">
                <Icon name="swap" size={14} className="c-warn" />
                <span>
                  The local clone fetches from <span className="mono">{s.localUrl}</span>, but .gitmodules says <span className="mono">{s.url}</span>.
                </span>
                <button className={s.state === 'clean' && !s.staged ? 'btn btn-sm btn-primary' : 'btn btn-sm'} disabled={busy} onClick={sync}>Sync URL</button>
              </div>
            )}
            {cloned && s.dirty > 0 && (
              <div className="sm-note">
                <Icon name="alert" size={14} className="c-warn" />
                <span>{plural(s.dirty, 'uncommitted file')} inside. Commit or stash them in the submodule before you move it.</span>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="sm-grid">
        <section className="sm-sec">
          <h2 className="label">Details</h2>
          <dl className="sm-kv">
            <dt>Repository</dt>
            <dd>
              <span className="mono ellipsis" title={s.url}>{s.url}</span>
              <button className="btn btn-ghost btn-sm btn-icon" aria-label="Copy URL" title="Copy URL" onClick={() => navigator.clipboard?.writeText(s.url).then(() => flash('Copied'))}>
                <Icon name="copy" size={11} />
              </button>
            </dd>
            <dt>Tracks</dt>
            <dd>{s.branch ? <span className="mono">{s.branch}</span> : <span className="muted">Remote default{s.upstream ? ` (${s.upstream.replace(/^origin\//, '')})` : ''}</span>}</dd>
            <dt>Pinned at</dt>
            <dd>
              <span className="mono">{short(s.recorded)}</span>
              {s.staged && <span className="muted">staged</span>}
            </dd>
            <dt>Checked out</dt>
            <dd>{cloned ? <><span className="mono">{short(s.head)}</span><span className="muted">detached</span></> : <span className="muted">Not cloned</span>}</dd>
            <dt>Working tree</dt>
            <dd className={s.dirty ? 'c-warn' : undefined}>{!cloned ? <span className="muted">Not cloned</span> : s.dirty ? plural(s.dirty, 'uncommitted file') : 'Clean'}</dd>
          </dl>
        </section>
        {cloned && s.subject && (
          <section className="sm-sec">
            <h2 className="label">Last commit checked out</h2>
            <div className="sm-last">
              <strong>{s.subject}</strong>
              <span className="sm-by">
                {s.author && <Avatar name={s.author} size={16} />}
                {[s.author, s.date].filter(Boolean).join(' · ')}
                <span className="mono">{short(s.head)}</span>
              </span>
            </div>
          </section>
        )}
      </div>

      {more.at && (
        <Menu
          {...more.at}
          alignRight
          label="Submodule actions"
          onClose={more.close}
          items={[
            { id: 'update', label: cloned ? 'Update to its pin' : 'Clone', icon: 'box', hint: 'nested ones too', disabled: busy, run: () => onRun(false) },
            { id: 'edit', label: 'Edit URL or branch', icon: 'edit', run: () => setEditing(true) },
            { id: 'sync', label: 'Sync URL', icon: 'swap', hint: 'from .gitmodules', disabled: busy || !cloned, run: sync },
            { id: 'copy', label: 'Copy URL', icon: 'copy', run: () => navigator.clipboard?.writeText(s.url).then(() => flash('Copied')) },
            'sep',
            { id: 'remove', label: 'Remove', icon: 'trash', danger: true, run: () => setRemoving(true) },
          ]}
        />
      )}
      {editing && <EditModal s={s} onClose={() => setEditing(false)} onSave={(url, branch) => { set((x) => ({ ...x, url, branch: branch || undefined })); flash('Submodule updated: commit .gitmodules to share it'); }} />}
      {removing && (
        <Modal
          title={<>Remove <span className="mono">{s.path}</span>?</>}
          sub="The removal is staged. Commit it to share it."
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button className="btn btn-md" onClick={() => setRemoving(false)}>Cancel</button>
              <button className="btn btn-md btn-danger" onClick={() => { onRemove(); flash(`Removed ${s.path}: commit the removal from the workspace`); }}>{s.dirty ? 'Remove, losing local changes' : 'Remove'}</button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            Deletes the folder <span className="mono">{s.path}</span>, its local clone and its entry in <span className="mono">.gitmodules</span>. The repository at <span className="mono">{s.url}</span> is untouched.
          </p>
          {s.dirty > 0 && <div className="err-box">{plural(s.dirty, 'uncommitted file')} inside the submodule will be lost.</div>}
        </Modal>
      )}
    </>
  );
}

/** A commit the line stops at, with what can be done there. */
type Stop = { key: string; glyph: 'pin' | 'head' | 'both' | 'tip' | 'ghost'; label: string; sha: string; caption?: ReactNode; action?: ReactNode };
/** The stretch between two stops: drift off the pin, new commits on the remote, nothing, or no remote to compare with. */
type Link = { kind: 'warn' | 'dash' | 'solid' | 'off'; text?: ReactNode; commits: number };

/** The pin line of src/screens/Submodules.tsx: pinned, checked out and the remote's tip, each action under the stop it moves to. */
function PinLine({ s, busy, act }: { s: Sub; busy: boolean; act: { update: () => void; latest: () => void; pin: () => void; commit: () => void } }) {
  const btn = (label: string, icon: string, run: () => void, primary: boolean, tip?: string) => (
    <button className={`btn btn-sm${primary ? ' btn-primary' : ''}`} disabled={busy} title={tip} onClick={run}>
      {busy ? <span className="spinner" /> : <Icon name={icon} size={12} />}
      {label}
    </button>
  );
  const stops: Stop[] = [];
  const links: Link[] = [];
  const tree = `Detached · ${s.dirty ? plural(s.dirty, 'uncommitted file') : 'clean'}`;
  if (!s.head) {
    stops.push({ key: 'pin', glyph: 'ghost', label: 'Pinned', sha: short(s.recorded), caption: 'Declared but not cloned. Its folder is empty.', action: btn('Clone', 'download', act.update, true, 'Clone it and check out its pin') });
  } else {
    const same = s.recorded === s.head;
    if (same) {
      stops.push({ key: 'both', glyph: 'both', label: 'Pinned · checked out', sha: short(s.head), caption: s.staged ? 'New pin staged, not committed yet' : tree, action: s.staged ? btn('Go commit', 'commit', act.commit, true, 'Commit the new pin from the workspace so everyone gets this version') : undefined });
    } else {
      stops.push(
        { key: 'pin', glyph: 'pin', label: 'Pinned', sha: short(s.recorded), caption: 'What the project records', action: btn('Back to pin', 'box', act.update, false, 'Check out the commit the project pins') },
        { key: 'head', glyph: 'head', label: 'Checked out', sha: short(s.head), caption: tree, action: btn('Pin this commit', 'pin', act.pin, true, 'Record the checked-out commit as the new pin (staged)') },
      );
      links.push({ kind: 'warn', text: `${s.ahead} ahead of the pin`, commits: s.ahead });
    }
    const n = s.upstreamBehind;
    if (s.upstream) {
      links.push(n ? { kind: 'dash', text: <>{n} new on <span className="mono">{s.upstream}</span></>, commits: n } : { kind: 'solid', text: 'nothing new', commits: 0 });
      stops.push({ key: 'tip', glyph: 'tip', label: 'Remote', sha: s.upstream, caption: n ? `${plural(n, 'commit')} newer than checked out. Pin it afterwards to keep it.` : 'Nothing newer', action: n ? btn('Pull latest', 'download', act.latest, same && !s.staged && !s.localUrl, `Check out the tip of ${s.upstream}; then pin it to keep it`) : undefined });
    } else {
      links.push({ kind: 'off', commits: 0 });
      stops.push({ key: 'tip', glyph: 'ghost', label: 'Remote', sha: 'none', caption: 'No remote branch to compare with' });
    }
  }
  return (
    <ol className="sm-line" aria-label="Pinned, checked out and remote commits">
      {stops.map((st, i) => (
        <Fragment key={st.key}>
          {i > 0 && (
            <li className="sm-link" data-kind={links[i - 1].kind}>
              <span className="sm-rule" aria-hidden="true">
                {Array.from({ length: Math.min(9, Math.max(0, links[i - 1].commits - 1)) }, (_, t) => (
                  <i key={t} style={{ left: `${((t + 1) * 100) / Math.min(10, links[i - 1].commits)}%` }} />
                ))}
              </span>
              {links[i - 1].text && <em>{links[i - 1].text}</em>}
            </li>
          )}
          <li className="sm-stop" data-next={links[i]?.kind}>
            <span className="sm-glyph" data-glyph={st.glyph} aria-hidden="true" />
            <span className="label">{st.label}</span>
            <span className={st.sha === 'none' ? 'mono sm-sha faint' : 'mono sm-sha'}>{st.sha}</span>
            {st.caption && <span className="sm-cap">{st.caption}</span>}
            {st.action}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function AddModal({ taken, onAdded, onClose }: { taken: string[]; onAdded: (s: Sub) => void; onClose: () => void }) {
  const later = useLater();
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [branch, setBranch] = useState('');
  const [cloning, setCloning] = useState(false);
  const target = (path.trim() || defaultPath(url)).replace(/\/+$/, '');
  const clash = taken.includes(target);
  const ok = !!url.trim() && !!target && !clash && !cloning;
  const submit = () => {
    if (!ok) return;
    setCloning(true);
    later(1500, () => {
      const head = sha();
      onAdded({ path: target, url: url.trim(), branch: branch.trim() || undefined, upstream: `origin/${branch.trim() || 'main'}`, recorded: head, head, state: 'clean', ahead: 0, behind: 0, upstreamBehind: 0, dirty: 0, staged: true, subject: 'Initial commit', author: 'Mei Lin', date: 'last week' });
      onClose();
    });
  };
  return (
    <Modal
      title="Add a submodule"
      sub="Clones the repository into the project and stages it"
      onClose={cloning ? () => {} : onClose}
      footer={
        <>
          <button className="btn btn-md" disabled={cloning} onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={!ok} onClick={submit}>
            {cloning && <span className="spinner" />}
            {cloning ? 'Cloning…' : 'Add submodule'}
          </button>
        </>
      }
    >
      <form className="col" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field">
          <label htmlFor="sm-url">Repository URL</label>
          <input id="sm-url" className="input mono" placeholder="git@github.com:acme/charts.git" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="sm-path">
            Folder in the project
            {clash && <span className="c-del">Already a submodule</span>}
          </label>
          <input id="sm-path" className="input mono" aria-invalid={clash || undefined} placeholder={defaultPath(url) || 'libs/charts'} value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sm-branch">
            Branch to track
            <span className="faint">optional</span>
          </label>
          <input id="sm-branch" className="input mono" placeholder="Remote default" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <span className="hint">“Pull latest” follows this branch. Leave it empty to follow the remote's default branch.</span>
        </div>
        {url.trim() && target && !clash && (
          <p className="sm-lands">
            <span className="sm-glyph" data-glyph="pin" aria-hidden="true" />
            <span>
              Clones into <span className="mono">{target}</span> and pins the tip of {branch.trim() ? <span className="mono">{branch.trim()}</span> : "the remote's default branch"}.
              {path.trim() && defaultPath(url) && path.trim() !== defaultPath(url) ? <> Leave the folder empty to use <span className="mono">{defaultPath(url)}</span>.</> : null}
            </span>
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditModal({ s, onClose, onSave }: { s: Sub; onClose: () => void; onSave: (url: string, branch: string) => void }) {
  const [url, setUrl] = useState(s.url);
  const [branch, setBranch] = useState(s.branch ?? '');
  const changed = url.trim() !== s.url || branch.trim() !== (s.branch ?? '');
  const branchChanged = branch.trim() !== (s.branch ?? '');
  return (
    <Modal
      title="Edit submodule"
      sub={<span className="mono">{s.path}</span>}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-md" disabled={!changed || !url.trim()} onClick={() => { onSave(url.trim(), branch.trim()); onClose(); }}>Save</button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="sm-edit-url">Repository URL</label>
        <input id="sm-edit-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus />
        <span className="hint">Written to .gitmodules and synced into the local clone.</span>
      </div>
      <div className="field">
        <label htmlFor="sm-edit-branch">Branch to track</label>
        <input id="sm-edit-branch" className="input mono" placeholder="Remote default" value={branch} onChange={(e) => setBranch(e.target.value)} />
        {branchChanged && (
          <span className="hint">
            Was {s.branch ? <span className="mono">{s.branch}</span> : "the remote's default"}. “Pull latest” will follow {branch.trim() ? <span className="mono">{branch.trim()}</span> : "the remote's default branch"}.
          </span>
        )}
      </div>
    </Modal>
  );
}
