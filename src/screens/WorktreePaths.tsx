import { useState, type ReactNode } from "react";

import { useAction, useConfig, useProjectPrefs } from "../api/hooks";
import type { Config, Project } from "../api/types";
import { Icon } from "../components/Icon";
import { SheetBox, SheetLabel, SheetLink, SheetRow } from "../components/Sheet";
import { plural } from "../lib/format";
import { useNav } from "../lib/nav";
import { copyToClipboard } from "../lib/toast";

/* The files copied or linked into new worktrees: for every project (App › Worktrees) and for the open one. */

const COPIED = "Git leaves ignored files out of a new worktree. These are copied from the main checkout into it when the project has them: a knowledge graph, .env, local settings.";
const LINKED = "Linked, not copied: the worktree reads and writes the main checkout's own, so it takes no space and changes show in both. For big folders shared by every branch. On Windows, folders need Developer Mode on. A path in both lists is linked.";

/** The paths every project gets, under a project's own: faint, changed in App › Worktrees. */
type Inherited = { paths: string[]; tip: string; edit?: () => void; editLabel: string };

/**
 * A box of paths from the project root, one per row: removed from its row, added from the field under them (a pasted list adds each line).
 * Only Add saves, so a half-typed path never reaches the next worktree. `group` names the project's own paths when `inherited` follows them.
 */
function PathBox({ title, tip, sub, paths, onSave, group, inherited, linked }: { title: string; tip: string; sub: string; paths: string[]; onSave: (paths: string[]) => void; group?: string; inherited?: Inherited; linked?: boolean }) {
  const [typed, setTyped] = useState("");
  // A linked path, or what a copied one names: a folder ends with "/".
  const icon = (p: string) => <Icon name={linked ? "link" : p.endsWith("/") ? "folder" : "file"} size={12} />;
  const path = typed.trim();
  const listed = paths.includes(path);
  const add = (lines: string[]) => {
    const next = [...new Set([...paths, ...lines.map((l) => l.trim()).filter(Boolean)])];
    if (next.length !== paths.length) onSave(next);
    setTyped("");
  };
  const list: ReactNode = paths.length ? (
    paths.map((p) => (
      <div key={p} className="wtp-row">
        {icon(p)}
        <span className="mono ellipsis grow">{p}</span>
        <button className="btn btn-ghost btn-icon btn-sm wtp-x" aria-label={`Remove ${p}`} data-tip="Remove" onClick={() => onSave(paths.filter((x) => x !== p))}>
          <Icon name="trash" size={12} />
        </button>
      </div>
    ))
  ) : (
    <p className="hint wtp-none">None yet.</p>
  );
  return (
    <section className="sheet-box" aria-label={title}>
      <header className="sheet-h">
        <h2 className="wtp-help" data-tip={tip} tabIndex={0}>{title}</h2>
        <span className="hint">{sub}</span>
        {paths.length > 0 && (
          <span className="sheet-aside">
            <button className="btn btn-ghost btn-sm" onClick={() => copyToClipboard(paths.join("\n"))}>
              <Icon name="copy" size={12} />
              Copy list
            </button>
          </span>
        )}
      </header>
      <div className="sheet-col">
        <p className="hint sheet-lab-tip">{tip}</p>
        {group && <SheetLabel>{group}</SheetLabel>}
        {list}
        <form
          className="wtp-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (path && !listed) add([path]);
          }}
        >
          <input
            className="input mono grow"
            aria-label={`Add a path to ${title}`}
            placeholder="A path from the project root"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onPaste={(e) => {
              // A text field drops the line breaks of a pasted list: each line is a path.
              const text = e.clipboardData.getData("text");
              if (!text.includes("\n")) return;
              e.preventDefault();
              add(text.split(/\r?\n/));
            }}
          />
          <button className="btn btn-sm" disabled={!path || listed}>
            <Icon name="plus" size={12} />
            Add
          </button>
        </form>
        {path && listed && <p className="hint">{path} is in the list.</p>}
        {inherited && inherited.paths.length > 0 && (
          <>
            <div className="wtp-lab">
              <SheetLabel>Every project</SheetLabel>
              {inherited.edit && (
                <button className="sheet-val" onClick={inherited.edit}>
                  {inherited.editLabel}
                  <Icon name="chevronRight" size={12} />
                </button>
              )}
            </div>
            {inherited.paths.map((p) => (
              <div key={p} className="wtp-row wtp-inherited" data-tip={inherited.tip}>
                {icon(p)}
                <span className="mono ellipsis grow">{p}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

/** What a project adds to the lists every project gets: "2 copied · 1 linked". */
const ownCount = (p: Project) => [p.worktreeFiles?.length && `${p.worktreeFiles.length} copied`, p.worktreeLinks?.length && `${p.worktreeLinks.length} linked`].filter(Boolean).join(" · ");

/** App › Worktrees: the paths copied and linked into every project's new worktrees, then what each project adds to them. `open` opens the open project's own page. */
export function WorktreesSection({ cfg, open }: { cfg: Config; open?: (id: string) => void }) {
  const save = useAction("worktrees.setFiles", { invalidate: [["config"]] });
  const nav = useNav();
  return (
    <>
      <div className="wtp-grid">
        <PathBox title="Copied" tip={COPIED} sub={plural(cfg.worktreeFiles.length, "path")} paths={cfg.worktreeFiles} onSave={(files) => save.mutate({ files })} />
        <PathBox title="Linked" tip={LINKED} sub={plural(cfg.worktreeLinks.length, "path")} paths={cfg.worktreeLinks} onSave={(links) => save.mutate({ links })} linked />
      </div>
      {cfg.projects.length > 0 && (
        <SheetBox title="Each project's own" sub="added to the lists above">
          <div className="sheet-col">
            {cfg.projects.map((p) => {
              const own = ownCount(p);
              return open && p.id === nav.projectId ? (
                <SheetLink key={p.id} label={p.name} value={own || "None"} none={!own} onClick={() => open("projectFiles")} />
              ) : (
                <SheetRow key={p.id} label={p.name}>
                  <span className={`sheet-v${own ? "" : " none"}`}>{own || "None"}</span>
                </SheetRow>
              );
            })}
          </div>
        </SheetBox>
      )}
    </>
  );
}

/** The open project's own worktree files, over the ones every project gets. `open` opens App › Worktrees to change those. */
export function ProjectFilesPage({ project: p, open }: { project: Project; open?: (id: string) => void }) {
  const prefs = useProjectPrefs(p.id);
  const c = useConfig().data;
  const cfg = { files: c?.worktreeFiles ?? [], links: c?.worktreeLinks ?? [] };
  const edit = open && (() => open("worktrees"));
  const sub = (own: number, all: number) => (!all ? plural(own, "path") : own ? `${own} + ${all} from every project` : `${all} from every project`);
  return (
    <div className="wtp-grid">
      <PathBox
        title="Copied"
        tip={COPIED}
        sub={sub(prefs.worktreeFiles.length, cfg.files.length)}
        paths={prefs.worktreeFiles}
        onSave={prefs.setWorktreeFiles}
        group={p.name}
        inherited={{ paths: cfg.files, tip: "From App › Worktrees: copied into every project's new worktrees. Linked instead when the Linked list has it too.", edit, editLabel: "Edit in App › Worktrees" }}
      />
      <PathBox
        title="Linked"
        tip={LINKED}
        linked
        sub={sub(prefs.worktreeLinks.length, cfg.links.length)}
        paths={prefs.worktreeLinks}
        onSave={prefs.setWorktreeLinks}
        group={p.name}
        inherited={{ paths: cfg.links, tip: "From App › Worktrees: linked into every project's new worktrees.", edit, editLabel: "Edit" }}
      />
    </div>
  );
}
