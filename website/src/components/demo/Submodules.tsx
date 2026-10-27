import { useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '../../../../src/components/Icon';
import { plural } from '../../../../src/lib/format';
import { Empty, EmptyState, Menu, Modal, Seg, useDemo, useLater, useMenu } from './ui';

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
  upstreamBehind: number;
  dirty: number;
  staged?: boolean;
  subject?: string;
  author?: string;
  date?: string;
};
type Output = { title: string; text: string };

const ROOT = '/home/grace/code/acme-web';
const SUBS: Sub[] = [
  { path: 'libs/ui-kit', url: 'git@github.com:acme/ui-kit.git', branch: 'main', upstream: 'origin/main', recorded: '4f1c2a9e0b7d', head: '4f1c2a9e0b7d', state: 'clean', ahead: 0, upstreamBehind: 0, dirty: 0, subject: 'Button: focus ring uses the accent color', author: 'Mei Lin', date: '3 days ago' },
  { path: 'libs/icons', url: 'git@github.com:acme/icons.git', branch: 'main', upstream: 'origin/main', recorded: '8d2e61f4a3c0', head: '8d2e61f4a3c0', state: 'clean', ahead: 0, upstreamBehind: 4, dirty: 0, subject: 'Add branch and worktree icons', author: 'Tom Becker', date: '2 weeks ago' },
  { path: 'vendor/tree-sitter-git', url: 'https://github.com/acme/tree-sitter-git.git', upstream: 'origin/master', recorded: '9a03f5d1e2b8', head: 'b71e0c2f9d44', state: 'moved', ahead: 2, upstreamBehind: 0, dirty: 0, subject: 'Highlight trailers in commit messages', author: 'Jules Laurent', date: 'yesterday' },
  { path: 'tools/eslint-config', url: 'git@github.com:acme/eslint-config.git', localUrl: 'https://github.com/acme/eslint-config.git', branch: 'main', upstream: 'origin/main', recorded: '1b9c7e30fa62', head: '1b9c7e30fa62', state: 'clean', ahead: 0, upstreamBehind: 0, dirty: 2, subject: 'Allow non-null assertions in tests', author: 'Ana Moreau', date: 'Sep 30, 2026' },
  { path: 'docs/handbook', url: 'git@github.com:acme/handbook.git', branch: 'main', recorded: 'c0ffee12ab34', state: 'uninitialized', ahead: 0, upstreamBehind: 0, dirty: 0 },
];

const short = (sha?: string) => sha?.slice(0, 7) ?? '—';
/** A made-up commit id, different each call. */
const sha = () => Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
/** Path a URL clones into by default (same rule as the engine). */
const defaultPath = (url: string) => (url.trim().replace(/\/+$/, '').split(/[/:\\]/).pop() ?? '').replace(/\.git$/, '');
const needsYou = (s: Sub) => s.state !== 'clean' || s.dirty > 0 || s.upstreamBehind > 0 || !!s.staged || !!s.localUrl;

/** One status line per submodule, most pressing first: [label, color class]. */
function status(s: Sub): [string, string] {
  if (s.state === 'uninitialized') return ['Not cloned', 'muted'];
  if (s.state === 'moved') return ['Off its pin', 'c-warn'];
  if (s.upstreamBehind > 0) return ['Update available', 'c-acc'];
  if (s.staged) return ['New pin staged', 'c-acc'];
  return ['Up to date', 'c-add'];
}
/** Checked out at its pin, or at the tip of its remote, with what git would print. */
function update(s: Sub, remote: boolean): [Sub, string] {
  const head = remote ? (s.upstreamBehind ? sha() : (s.head ?? s.recorded)) : s.recorded;
  const clone = s.state === 'uninitialized' ? `Cloning into '${ROOT}/${s.path}'...\n` : '';
  const out = `${clone}Submodule path '${s.path}': checked out '${head}'`;
  const moved = head !== s.recorded;
  return [{ ...s, head, state: moved ? 'moved' : 'clean', ahead: moved ? (s.ahead || s.upstreamBehind) : 0, upstreamBehind: remote ? 0 : s.upstreamBehind, subject: s.subject ?? 'Initial handbook', author: s.author ?? 'Ana Moreau', date: remote && moved ? 'today' : (s.date ?? 'last month') }, out];
}

export default function Submodules() {
  const { flash } = useDemo();
  const later = useLater();
  const [list, setList] = useState(SUBS);
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [sel, setSel] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [output, setOutput] = useState<Output>();
  // The path being updated, or '*' for all of them.
  const [busy, setBusy] = useState<string>();
  const [fetching, setFetching] = useState(false);
  const bulk = useMenu();
  const shown = list.filter((s) => filter === 'all' || needsYou(s));
  const cur = list.find((s) => s.path === sel) ?? shown[0];
  const attention = list.filter(needsYou).length;
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
      // Someone pushed to the UI kit meanwhile.
      set('libs/ui-kit', (s) => ({ ...s, upstreamBehind: s.upstreamBehind || 1 }));
      flash(`Checked ${plural(list.filter((s) => s.head).length, 'remote')}`);
    });
  };

  return (
    <>
      <section className="master" style={{ '--master-w': '340px' } as CSSProperties} aria-label="Submodules">
        <div className="master-tools">
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-icon" aria-label="Check remotes for updates" title="Check remotes for updates (fetch)" disabled={fetching} onClick={checkRemotes}>
              {fetching ? <span className="spinner" /> : <Icon name="search" size={13} />}
            </button>
            <button className="btn" onClick={() => setAdding(true)}>
              <Icon name="plus" size={12} />
              Add
            </button>
          </div>
          {list.length > 0 && <Seg grid label="Filter" value={filter} onChange={setFilter} options={[['all', <>All <span className="faint">{list.length}</span></>], ['attention', <>Needs you <span className="faint">{attention}</span></>]]} />}
          {list.length > 0 && <span className="hint">{plural(list.length, 'submodule')} · {behind ? `${behind} with updates on their remote` : 'remotes as of last check'}</span>}
        </div>
        <div className="scroll" style={{ flex: '1 1 auto', padding: '8px 0 12px' }}>
          <div className="col" style={{ gap: 2 }}>
            {shown.map((s) => {
              const [label, cls] = status(s);
              return (
                <button key={s.path} className="item-btn" aria-pressed={s.path === cur?.path} onClick={() => setSel(s.path)}>
                  <span className="row">
                    {busy === s.path || busy === '*' ? <span className="spinner" /> : <Icon name="box" size={13} />}
                    <span className="mono ellipsis grow" style={{ fontSize: 12.5 }}>{s.path}</span>
                    <span className={cls} style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{label}</span>
                  </span>
                  <span className="row" style={{ gap: 8, fontSize: 11.5, paddingLeft: 21 }}>
                    <span className="faint ellipsis grow">{s.subject ?? s.url}</span>
                    {s.dirty > 0 && <span className="c-warn" title="Uncommitted files inside">●{s.dirty}</span>}
                    {s.upstreamBehind > 0 && <span className="c-acc mono" title={`New commits on ${s.upstream}`}>↓{s.upstreamBehind}</span>}
                    <span className="mono faint">{short(s.head ?? s.recorded)}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {list.length === 0 && (
            <Empty>
              No submodules in this project.
              <br />
              <button className="btn" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>
                <Icon name="plus" size={12} />
                Add a submodule
              </button>
            </Empty>
          )}
          {list.length > 0 && shown.length === 0 && <Empty>Every submodule is up to date.</Empty>}
        </div>
        <div className="master-tools" style={{ borderBottom: 0, borderTop: '1px solid var(--line)' }}>
          <span className="split-btn" style={{ display: 'flex' }}>
            <button className="btn btn-primary split-main grow" style={{ height: 48, fontSize: 13.5 }} disabled={!!busy} title="Clone missing submodules and check each out at the commit the project pins, nested ones included" onClick={() => updateAll(false)}>
              {busy === '*' ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
              Update all
            </button>
            <button className="btn btn-primary btn-icon split-more" style={{ height: 48, width: 48 }} aria-label="More bulk actions" title="More bulk actions" aria-haspopup="menu" disabled={!!busy} onClick={(e) => bulk.toggle(e, true)}>
              <Icon name="chevronDown" size={13} />
            </button>
          </span>
        </div>
      </section>
      <main className="detail">
        <div className="detail-inner">
          {cur ? (
            <Detail key={cur.path} s={cur} busy={busy === cur.path || busy === '*'} set={(f) => set(cur.path, f)} onRemove={() => setList((l) => l.filter((s) => s.path !== cur.path))} onRun={(remote) => run([cur.path], remote, remote ? `${cur.path} moved to the latest of ${cur.upstream ?? 'its remote'}` : cur.head ? `${cur.path} checked out at its pin` : `${cur.path} cloned`, `${remote ? 'Pull latest' : 'Update'} · ${cur.path}`)} />
          ) : (
            <EmptyState icon="box" title={list.length ? 'No submodule selected' : 'No submodules yet'}>{list.length ? 'Pick one from the list to see its state and update it.' : 'Submodules show up here once added.'}</EmptyState>
          )}
          {output && (
            <section className="col" style={{ gap: 8 }} aria-label="Command output">
              <div className="row">
                <span className="label">{output.title}</span>
                <span className="grow" />
                <button className="btn btn-ghost btn-sm" onClick={() => setOutput(undefined)}>Clear</button>
              </div>
              <pre className="pre" style={{ maxHeight: 280, overflow: 'auto' }}>{output.text}</pre>
            </section>
          )}
        </div>
      </main>
      {bulk.at && (
        <Menu
          {...bulk.at}
          alignRight
          label="Bulk submodule actions"
          onClose={bulk.close}
          items={[
            { id: 'update', label: 'Update all to their pins', icon: 'refresh', run: () => updateAll(false) },
            { id: 'remote', label: 'Pull latest for all', icon: 'stash', hint: 'then pin them', run: () => updateAll(true) },
            'sep',
            { id: 'sync', label: 'Sync all URLs', icon: 'swap', hint: 'from .gitmodules', run: () => { setList((l) => l.map((s) => ({ ...s, localUrl: undefined }))); flash('URLs synced'); } },
            { id: 'fetch', label: 'Check remotes for updates', icon: 'search', run: checkRemotes },
          ]}
        />
      )}
      {adding && (
        <AddModal
          taken={list.map((s) => s.path)}
          onAdded={(s) => {
            setList((l) => [...l, s]);
            setSel(s.path);
            setOutput({ title: `Added ${s.path}`, text: `Cloning into '${ROOT}/${s.path}'...\nremote: Enumerating objects: 214, done.\nremote: Total 214 (delta 61), reused 198 (delta 52)\nReceiving objects: 100% (214/214), 88.41 KiB | 2.1 MiB/s, done.\nResolving deltas: 100% (61/61), done.` });
            flash(`Added ${s.path}: commit it from the workspace`);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

function Detail({ s, busy, set, onRun, onRemove }: { s: Sub; busy: boolean; set: (f: (s: Sub) => Sub) => void; onRun: (remote: boolean) => void; onRemove: () => void }) {
  const { flash, go } = useDemo();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [label, cls] = status(s);
  const cloned = !!s.head;
  const pin = () => {
    set((x) => ({ ...x, recorded: x.head!, state: 'clean', ahead: 0, staged: true }));
    flash('New pin staged: commit it from the workspace');
  };
  const sync = () => {
    set((x) => ({ ...x, localUrl: undefined }));
    flash('URL synced');
  };
  return (
    <>
      <div className="col" style={{ gap: 6 }}>
        <div className="row wrap" style={{ fontSize: 12.5 }}>
          <span className={`pill ${cls}`}>{label}</span>
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <h1 className="mono grow" style={{ fontSize: 18 }}>{s.path}</h1>
          <button className="btn" title={s.url} onClick={() => flash(`Opens ${s.url.replace(/^git@github.com:/, 'github.com/').replace(/\.git$/, '')} in the browser`)}>
            <Icon name="external" size={12} />
            View repository
          </button>
        </div>
      </div>

      <Callouts s={s} busy={busy} onClone={() => onRun(false)} onRepin={pin} onReset={() => onRun(false)} onLatest={() => onRun(true)} onSync={sync} onCommit={() => go('workspace')} />

      <div className="kv">
        <div>
          <span>Repository</span>
          <span className="row" style={{ gap: 4, minWidth: 0 }}>
            <span className="mono ellipsis" title={s.url} style={{ fontSize: 12 }}>{s.url}</span>
            <button className="btn btn-ghost btn-sm btn-icon" aria-label="Copy URL" title="Copy URL" onClick={() => navigator.clipboard?.writeText(s.url).then(() => flash('Copied'))}>
              <Icon name="copy" size={11} />
            </button>
          </span>
        </div>
        <div>
          <span>Tracks</span>
          <span className="mono">{s.branch ?? <span className="muted" style={{ fontFamily: 'inherit' }}>Remote default{s.upstream ? ` (${s.upstream.replace(/^origin\//, '')})` : ''}</span>}</span>
        </div>
        <div>
          <span>Pinned at</span>
          <span className="mono" title={s.recorded}>{short(s.recorded)}{s.staged && <span className="c-acc" style={{ fontFamily: 'inherit', fontSize: 11.5 }}> · staged</span>}</span>
        </div>
        <div>
          <span>Checked out</span>
          <span className="mono" title={s.head}>
            {cloned ? short(s.head) : '—'}
            {cloned && <span className="muted" style={{ fontFamily: 'inherit', fontSize: 11.5 }}> · detached</span>}
          </span>
        </div>
        <div>
          <span>Remote</span>
          <span>{!cloned ? '—' : !s.upstream ? <span className="muted">No remote branch</span> : s.upstreamBehind > 0 ? <span className="c-acc">{plural(s.upstreamBehind, 'new commit')}</span> : <span className="c-add">Nothing new</span>}</span>
        </div>
        <div>
          <span>Working tree</span>
          <span className={s.dirty ? 'c-warn' : undefined}>{!cloned ? '—' : s.dirty ? plural(s.dirty, 'uncommitted file') : 'Clean'}</span>
        </div>
      </div>

      {cloned && s.subject && (
        <div className="card col" style={{ padding: '12px 16px', gap: 4 }}>
          <span className="label">Last commit checked out</span>
          <span>{s.subject}</span>
          <span className="faint" style={{ fontSize: 12 }}>{s.author} · {s.date}</span>
        </div>
      )}

      <div className="row wrap" style={{ gap: 6 }}>
        <button className="btn" disabled={busy} title={cloned ? 'Check out the commit the project pins' : 'Clone it and check out its pin'} onClick={() => onRun(false)}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
          {cloned ? 'Update' : 'Clone'}
        </button>
        <button className="btn" disabled={busy} title={`Check out the tip of ${s.upstream ?? 'the tracked branch'}; then pin it to keep it`} onClick={() => onRun(true)}>
          <Icon name="stash" size={12} />
          Pull latest
        </button>
        <button className="btn" disabled={busy || !cloned} title="Copy the URL from .gitmodules into the local clone" onClick={sync}>
          <Icon name="swap" size={12} />
          Sync URL
        </button>
        <button className="btn" disabled={busy || s.state !== 'moved'} title="Record the checked-out commit as the new pin (staged)" onClick={pin}>
          <Icon name="check" size={12} />
          Pin this commit
        </button>
        <button className="btn" onClick={() => setEditing(true)}>
          <Icon name="edit" size={12} />
          Edit
        </button>
        <button className="btn" disabled={!cloned} title="Work on it in its own tab" onClick={() => flash(`${s.path} opens as a project in its own tab`)}>
          <Icon name="external" size={12} />
          Open as project
        </button>
        <span className="grow" />
        <button className="btn btn-danger" onClick={() => setRemoving(true)}>
          <Icon name="trash" size={12} />
          Remove
        </button>
      </div>

      {editing && <EditModal s={s} onClose={() => setEditing(false)} onSave={(url, branch) => { set((x) => ({ ...x, url, branch: branch || undefined })); flash('Submodule updated: commit .gitmodules to share it'); }} />}
      {removing && (
        <Modal
          title="Remove submodule?"
          sub={<span className="mono">{s.path}</span>}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <button className="btn btn-md btn-danger" onClick={() => { onRemove(); flash(`Removed ${s.path}: commit the removal from the workspace`); }}>{s.dirty ? 'Remove, losing local changes' : 'Remove'}</button>
            </>
          }
        >
          <p style={{ margin: 0, lineHeight: 1.55 }}>
            Deletes the folder <span className="mono">{s.path}</span>, its local clone and its entry in <span className="mono">.gitmodules</span>. The removal is staged: commit it to share it. The repository at <span className="mono">{s.url}</span> is untouched.
          </p>
          {s.dirty > 0 && <div className="err-box">{plural(s.dirty, 'uncommitted file')} inside the submodule will be lost.</div>}
        </Modal>
      )}
    </>
  );
}

/** What needs doing on a submodule, each with the action that does it. */
function Callouts({ s, busy, onClone, onRepin, onReset, onLatest, onSync, onCommit }: { s: Sub; busy: boolean; onClone: () => void; onRepin: () => void; onReset: () => void; onLatest: () => void; onSync: () => void; onCommit: () => void }) {
  const notes: { key: string; tone: string; text: ReactNode; actions?: ReactNode }[] = [];
  const act = (label: string, run: () => void, primary = false) => (
    <button key={label} className={`btn btn-sm${primary ? ' btn-primary' : ''}`} disabled={busy} onClick={run}>{label}</button>
  );
  if (s.state === 'uninitialized') notes.push({ key: 'init', tone: 'muted', text: 'Declared but not cloned yet: its folder is empty.', actions: act('Clone', onClone, true) });
  if (s.state === 'moved')
    notes.push({
      key: 'moved',
      tone: 'c-warn',
      text: <>Checked out at <span className="mono">{short(s.head)}</span>, not at its pin <span className="mono">{short(s.recorded)}</span>{s.ahead ? ` (${plural(s.ahead, 'commit')} ahead)` : ''}.</>,
      actions: <>{act('Pin this commit', onRepin, true)}{act('Back to pin', onReset)}</>,
    });
  if (s.upstreamBehind > 0 && s.state !== 'moved') notes.push({ key: 'latest', tone: 'c-acc', text: <>{plural(s.upstreamBehind, 'new commit')} on <span className="mono">{s.upstream}</span>.</>, actions: act('Pull latest', onLatest, true) });
  if (s.localUrl)
    notes.push({
      key: 'url',
      tone: 'c-warn',
      text: <>The local clone fetches from <span className="mono">{s.localUrl}</span>, but <span className="mono">.gitmodules</span> says <span className="mono">{s.url}</span>.</>,
      actions: act('Sync URL', onSync, true),
    });
  if (s.staged && s.state === 'clean') notes.push({ key: 'staged', tone: 'c-acc', text: 'A new pin is staged. Commit it so everyone gets this version.', actions: act('Go commit', onCommit, true) });
  if (s.dirty > 0) notes.push({ key: 'dirty', tone: 'c-warn', text: <>{plural(s.dirty, 'uncommitted file')} inside. Commit or stash them in the submodule before updating it.</> });
  if (!notes.length) return null;
  return (
    <div className="col" style={{ gap: 8 }}>
      {notes.map((n) => (
        <div key={n.key} className={`card row wrap ${n.tone}`} style={{ padding: '10px 14px', gap: 10, borderLeft: '3px solid currentColor' }}>
          <span className="grow" style={{ color: 'var(--fg)', fontSize: 12.5, lineHeight: 1.5, minWidth: 200 }}>{n.text}</span>
          {n.actions && <span className="row" style={{ gap: 6 }}>{n.actions}</span>}
        </div>
      ))}
    </div>
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
      onAdded({ path: target, url: url.trim(), branch: branch.trim() || undefined, upstream: `origin/${branch.trim() || 'main'}`, recorded: head, head, state: 'clean', ahead: 0, upstreamBehind: 0, dirty: 0, staged: true, subject: 'Initial commit', author: 'Mei Lin', date: 'last week' });
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
          <input id="sm-path" className="input mono" placeholder={defaultPath(url) || 'libs/charts'} value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sm-branch">
            Branch to track
            <span className="faint">optional</span>
          </label>
          <input id="sm-branch" className="input mono" placeholder="Remote default" value={branch} onChange={(e) => setBranch(e.target.value)} />
          <span className="hint">“Pull latest” follows this branch. Leave it empty to follow the remote's default branch.</span>
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function EditModal({ s, onClose, onSave }: { s: Sub; onClose: () => void; onSave: (url: string, branch: string) => void }) {
  const [url, setUrl] = useState(s.url);
  const [branch, setBranch] = useState(s.branch ?? '');
  const changed = url.trim() !== s.url || branch.trim() !== (s.branch ?? '');
  return (
    <Modal
      title="Edit submodule"
      sub={<span className="mono">{s.path}</span>}
      onClose={onClose}
      footer={
        <>
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
      </div>
    </Modal>
  );
}
