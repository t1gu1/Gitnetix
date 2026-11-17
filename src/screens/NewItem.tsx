import { useEffect, useRef, useState } from "react";

import { useAction, useAiOn, useOverview, useProjectPrefs, useSuggestedVersion, useTagV } from "../api/hooks";
import { rpc } from "../api/transport";
import { RequestField, uploads, type Attachment } from "../components/AgentLog";
import { AgentPicker, MenuChoice, useAgentPick } from "../components/AgentPicker";
import { BranchTypesEditor, firstType, TypePicker, typeOfName, withType } from "../components/BranchTypes";
import { Icon } from "../components/Icon";
import { Modal, releaseTagLabel, Seg } from "../components/ui";
import { kindNoun, withPrefix, withTicket } from "../lib/kinds";
import { useNav, type NewItemDraft } from "../lib/nav";
import { revealBranch } from "./BranchTree";

export function NewItem({ draft, onClose }: { draft: NewItemDraft; onClose: () => void }) {
  const nav = useNav();
  const pid = nav.projectId!;
  const ov = useOverview(pid);
  const open = (ov.data?.releases ?? []).filter((r) => r.open);
  // Where it can branch off: open releases first, then the trunks (default and dev branches),
  // plus the work branch it was opened from ("Create a branch from here" on a feature).
  const bases = (ov.data?.branches ?? [])
    .filter((b) => b.exists && (b.role === "release" || b.role === "trunk" || b.name === draft.from))
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "release" ? -1 : b.role === "release" ? 1 : a.role === "trunk" ? -1 : 1));
  const firstBase = () =>
    (draft.release && open.find((r) => r.version === draft.release)?.branch) || draft.tag || draft.from || open[0]?.branch || ov.data?.defaultBranch || "";
  const { dialogs, setDialogs, branchTypes } = useProjectPrefs(pid);
  const tagV = useTagV(pid);
  // The type clicked (or the draft's) while listed, else the first; a prefix typed in the name wins over it.
  const [clicked, setPicked] = useState<string | undefined>(draft.kind);
  const picked = clicked && (clicked === "release" || branchTypes.list.some((t) => t.id === clicked)) ? clicked : firstType(branchTypes.list);
  const [relKind, setRelKind] = useState<"next" | "hotfix">("next");
  // Null until the user types their own; the suggestion shows meanwhile.
  const [typedVersion, setVersion] = useState<string | null>(null);
  const [desc, setDesc] = useState(draft.description ?? "");
  const [from, setFrom] = useState(firstBase);
  const [ticket, setTicket] = useState(draft.ticket ?? "");
  // An agent always gets its own worktree.
  const [where, setWhere] = useState<"switch" | "worktree">(dialogs.newWorktree || dialogs.newAgent ? "worktree" : "switch");
  const [agent, setAgent] = useState(dialogs.newAgent);
  const [pick, setPick] = useAgentPick(pid);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [name, setName] = useState("");
  const [named, setNamed] = useState<"ai" | "auto" | "you" | null>(null);
  const [naming, setNaming] = useState(false);
  const kind = picked === "release" ? "release" : typeOfName(branchTypes.list, name, picked);
  // The branch types editor, in place of the form until Done.
  const [editing, setEditing] = useState(false);
  // Minimized to a chip, the form stays as it was; opening a new branch again brings it back.
  const [min, setMin] = useState(false);
  useEffect(() => setMin(false), [draft]);

  useEffect(() => {
    if (!from && ov.data) setFrom(firstBase());
  }, [ov.data, from]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggested = useSuggestedVersion(pid, relKind, kind === "release" && typedVersion === null);
  const version = typedVersion ?? suggested.data?.version ?? "";

  // Ask AI for a branch name once the description settles. One call at a time, each a CLI run of seconds: what is typed meanwhile
  // is asked once it returns, so answers land in order. Spaces alone ask nothing; a name typed by hand meanwhile stays.
  const about = desc.trim().replace(/\s+/g, " ");
  const asked = useRef("");
  const typed = useRef(false);
  useEffect(() => {
    const ask = JSON.stringify([about, picked, ticket, pid]);
    if (!agent || named === "you" || naming || about.length < 6 || ask === asked.current) return;
    const t = setTimeout(async () => {
      asked.current = ask;
      setNaming(true);
      try {
        const r = await rpc<{ name: string; ai: boolean }>("items.suggestName", { projectId: pid, kind: picked, description: desc, ticket });
        if (typed.current) return;
        setName(r.name.replace(/\s/g, "-"));
        setNamed(r.ai ? "ai" : "auto");
      } catch {
        /* keep whatever is there */
      } finally {
        setNaming(false);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [agent, about, picked, ticket, pid, naming]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAction<{ branch: string; worktree?: string; agentSession?: string }>("items.create", {
    // Config: a prefix used for the first time joined the project's branch types.
    invalidate: [["overview", pid], ["agents"], ["worktrees"], ["config"]],
    success: (r) => `Created ${r.branch}${r.worktree ? ` in ${r.worktree}` : ""}${r.agentSession ? " · agent started" : ""}`,
  });
  const v = version.replace(/^v/, "");
  const createRelease = useAction("releases.create", { invalidate: [["overview", pid], ["projects"]], success: `Release ${tagV.label(v)} created` });
  const base = bases.find((b) => b.name === from);
  const fromTag = !!draft.tag && from === draft.tag;
  const rel = open.find((r) => r.branch === from);

  // A hook: called on every render, so above the release dialog's early return.
  const aiOn = useAiOn("branch");

  // Switching type rewrites the name's prefix (feature/x → fix/x).
  const pickKind = (k: string) => {
    setPicked(k);
    if (k !== "release") setName(withType(name, k));
  };

  if (min)
    return (
      <button className="btn start-chip" onClick={() => setMin(false)}>
        <Icon name="branch" size={13} />
        {kind === "release" ? "New release" : "New branch"}
      </button>
    );
  const headerActions = (
    <>
      <button className="btn btn-ghost btn-icon" aria-label="Edit branch types" data-tip="Edit branch types: order, pin, add" onClick={() => setEditing(true)}>
        <Icon name="edit" />
      </button>
      <button className="btn btn-ghost btn-icon" aria-label="Minimize" data-tip="Minimize · comes back from the chip in the corner" onClick={() => setMin(true)}>
        <Icon name="minus" />
      </button>
    </>
  );

  if (editing)
    return (
      <Modal
        title="Branch types"
        sub="What the Type buttons offer, in this order. A prefix typed in a branch name that is not listed joins them, after the pinned ones."
        onClose={() => setEditing(false)}
        footer={
          <button className="btn btn-primary btn-md" onClick={() => setEditing(false)}>
            Done
          </button>
        }
      >
        <BranchTypesEditor pid={pid} />
      </Modal>
    );

  if (kind === "release") {
    return (
      <Modal
        title="New release"
        sub={relKind === "next" ? "Branches off your default branch" : "Branches off the latest tag"}
        actions={headerActions}
        onClose={onClose}
        footer={
          <>
            <button
              className="btn btn-primary btn-md"
              disabled={!v || createRelease.isPending}
              onClick={() =>
                createRelease.mutate(
                  { projectId: pid, version: v, kind: relKind },
                  {
                    onSuccess: () => {
                      revealBranch(pid, `release/${v}`);
                      nav.selectBranch(`release/${v}`);
                      nav.go({ name: "workspace" });
                      onClose();
                    },
                  },
                )
              }
            >
              {createRelease.isPending && <span className="spinner" />}
              Create release/{v || "x.y.z"}
            </button>
          </>
        }
      >
        <TypePicker pid={pid} size="lg" value={kind} onChange={pickKind} />
        <Seg grid size="lg" label="Release type" value={relKind} onChange={setRelKind} options={[{ value: "next", label: "Next release" }, { value: "hotfix", label: "Hotfix" }]} />
        <div className="field">
          <label htmlFor="ni-version">Version</label>
          <input id="ni-version" className="input mono" placeholder="2.4.0" value={version} onChange={(e) => setVersion(e.target.value.trim())} autoFocus />
        </div>
      </Modal>
    );
  }

  const label = kindNoun(kind);
  const branch = withTicket(withPrefix(name, kind), ticket);
  // Switching brings the uncommitted changes along: with no name, AI names the branch after them.
  const wip = ov.data?.branches.find((b) => b.name === ov.data?.currentBranch)?.wip ?? 0;
  const nameFromWip = aiOn && !agent && where === "switch" && wip > 0;
  const ready = !!(base || fromTag) && (agent ? !!desc.trim() : !!name.trim() || nameFromWip) && !create.isPending;
  const submit = async () => {
    const up = agent ? await uploads(files) : undefined;
    // The next new branch starts where this one went.
    setDialogs({ newWorktree: where === "worktree", newAgent: agent });
    create.mutate(
      { projectId: pid, release: rel?.version ?? "", from: rel ? undefined : from, kind, description: agent ? desc : "", branchName: branch || undefined, ticket: ticket || undefined, where, startAgent: agent, files: up, ...(agent && pick) },
      {
        onSuccess: (r) => {
          revealBranch(pid, r.branch);
          nav.selectBranch(r.branch);
          nav.go({ name: "workspace" });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      title={rel ? `New in ${tagV.label(rel.version)}` : base ? `New branch off ${base.name}` : fromTag ? `New branch off ${draft.tag}` : "New feature or fix"}
      sub={
        base ? <>Branches off <span className="mono">{base.name}</span> and merges back into it</>
        : fromTag ? <>Branches off tag <span className="mono">{draft.tag}</span> and merges into <span className="mono">{ov.data?.defaultBranch}</span></>
        : "Pick where it starts"
      }
      actions={headerActions}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-primary btn-md" disabled={!ready} onClick={submit}>
            {create.isPending && <span className="spinner" />}
            Create {label}
          </button>
        </>
      }
    >
      <TypePicker pid={pid} size="lg" value={kind} onChange={pickKind} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="field">
          <label htmlFor="ni-rel">Branches off</label>
          <MenuChoice
            id="ni-rel"
            className="select menu-select"
            label="Branches off"
            search="Filter branches"
            value={from}
            options={[
              ...(draft.tag ? [{ value: draft.tag, label: `${draft.tag} (tag)` }] : []),
              ...bases.map((b) => {
                const r = open.find((x) => x.branch === b.name);
                return { value: b.name, label: r ? `${tagV.label(r.version)} — ${releaseTagLabel(r.tag)}` : b.name };
              }),
            ]}
            onChange={setFrom}
          />
        </div>
        <div className="field">
          <label htmlFor="ni-ticket">Ticket <span className="faint" style={{ fontWeight: 400 }}>optional</span></label>
          <input id="ni-ticket" className="input mono" placeholder="ATL-212" value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="ni-branch" style={{ justifyContent: "flex-start", alignItems: "center" }}>
          <span>Branch name</span>
          <span className="c-acc" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 400 }}>
            {naming ? <span className="spinner" /> : named === "ai" ? <><Icon name="sparkle" size={11} />Named by AI</> : named === "auto" ? "From description" : null}
          </span>
          {branch && branch !== name.trim() && (
            <span className="faint ellipsis" style={{ fontWeight: 400 }}>Creates <span className="mono">{branch}</span></span>
          )}
        </label>
        <input
          id="ni-branch"
          className="input mono"
          style={{ fontSize: 12.5 }}
          value={name}
          placeholder={nameFromWip ? "Leave empty to let AI name it from your changes" : `${kind}/…`}
          autoFocus
          onChange={(e) => {
            // Git names can't hold spaces: each one becomes a dash as you type.
            const v = e.target.value.replace(/\s/g, "-");
            setName(v);
            setNamed("you");
            typed.current = true;
          }}
        />
      </div>
      <fieldset className="col" style={{ margin: 0, padding: 0, border: 0, gap: 6 }}>
        <legend className="muted" style={{ padding: "0 0 6px", fontSize: 12, fontWeight: 500 }}>Where to work</legend>
        {(
          [
            ["switch", "Switch to the new branch", "Your uncommitted changes come along"],
            ["worktree", "Open in a new worktree", "Runs alongside your current branch — good for parallel AI work"],
          ] as const
        ).map(([v, t, s]) => (
          <button
            key={v}
            type="button"
            className="radio-card"
            aria-pressed={where === v}
            onClick={() => {
              setWhere(v);
              // An agent needs its own worktree, so switching drops it.
              if (v === "switch") setAgent(false);
            }}
          >
            <span className="radio-dot" />
            <span className="col" style={{ gap: 2 }}>
              <span style={{ fontWeight: 500 }}>{t}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s}</span>
            </span>
          </button>
        ))}
      </fieldset>
      <label className="check">
        <input
          type="checkbox"
          checked={agent}
          onChange={() => {
            // An agent always gets its own worktree.
            if (!agent) setWhere("worktree");
            setAgent(!agent);
          }}
        />
        <span>Start an AI agent on it right away</span>
      </label>
      {agent && (
        <>
          <div className="field">
            <span>Agent</span>
            <AgentPicker value={pick} onChange={setPick} />
          </div>
          <RequestField value={desc} onChange={setDesc} files={files} onFiles={setFiles} onSubmit={() => ready && submit()} />
        </>
      )}
    </Modal>
  );
}
