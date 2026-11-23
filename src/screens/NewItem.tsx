import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAction, useAiOn, useOverview, useProjectPrefs, useSuggestedVersion, useTagV } from "../api/hooks";
import { rpc } from "../api/transport";
import { RequestField, uploads, type Attachment } from "../components/AgentLog";
import { AgentPicker, MenuChoice, useAgentPick } from "../components/AgentPicker";
import { BranchTypesEditor, firstType, TypePicker, typeOfName, withType } from "../components/BranchTypes";
import { Icon } from "../components/Icon";
import { EnterHint, Modal, releaseTagLabel, Route, Seg } from "../components/ui";
import { kindNoun, withPrefix, withTicket } from "../lib/kinds";
import { flyIntoChip, type DialogShot } from "../lib/motion";
import { useNav, type NewItemDraft } from "../lib/nav";
import { revealBranch } from "./BranchMap";

/** `min`: minimized to its chip in the corner, the form kept as it was; the chip brings it back. Escape or a click outside minimizes it once
 *  something is typed, and closes it while nothing is. */
export function NewItem({ draft, min, onMinimize, onClose }: { draft: NewItemDraft; min: boolean; onMinimize: (min: boolean) => void; onClose: () => void }) {
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
    draft.at?.sha ||
    (draft.release && open.find((r) => r.version === draft.release)?.branch) || draft.tag || draft.from || open[0]?.branch || ov.data?.defaultBranch || "";
  const { dialogs, setDialogs, branchTypes } = useProjectPrefs(pid);
  const tagV = useTagV(pid);
  // The type clicked (or the draft's) while listed, else the first; a prefix typed in the name wins over it.
  const [clicked, setPicked] = useState<string | undefined>(draft.kind);
  // The type clicked here, which AI names keep; until then AI picks the type with the name.
  const chosen = useRef<string | undefined>(undefined);
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
  // Minimizing closes the dialog into its chip, which then slides to the corner.
  const box = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const shot = useRef<DialogShot | null>(null);
  const minimize = () => {
    if (box.current) shot.current = { rect: box.current.getBoundingClientRect(), copy: box.current.cloneNode(true) as HTMLElement };
    onMinimize(true);
  };
  // Filled: a field differs from what the dialog opened with (a ticket's key and title, say), or files are attached.
  const filled =
    !!name.trim() || ticket.trim() !== (draft.ticket ?? "").trim() || desc.trim() !== (draft.description ?? "").trim() || !!typedVersion?.trim() || files.length > 0;
  const dismiss = () => (filled ? minimize() : onClose());
  useLayoutEffect(() => {
    if (min && shot.current && chip.current) flyIntoChip(shot.current, chip.current);
    shot.current = null;
  }, [min]);

  useEffect(() => {
    if (!from && ov.data) setFrom(firstBase());
  }, [ov.data, from]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggested = useSuggestedVersion(pid, relKind, kind === "release" && typedVersion === null);
  const version = typedVersion ?? suggested.data?.version ?? "";

  // Ask AI for a branch name once the description settles. One call at a time, each a CLI run of seconds: what is typed meanwhile
  // is asked once it returns, so answers land in order. Spaces alone ask nothing; a name typed by hand meanwhile stays,
  // and so does a type clicked meanwhile.
  const about = desc.trim().replace(/\s+/g, " ");
  const asked = useRef("");
  const typed = useRef(false);
  useEffect(() => {
    const ask = JSON.stringify([about, ticket, pid]);
    if (!agent || named === "you" || naming || about.length < 6 || ask === asked.current) return;
    const t = setTimeout(async () => {
      asked.current = ask;
      setNaming(true);
      try {
        const r = await rpc<{ name: string; ai: boolean }>("items.suggestName", { projectId: pid, kind: chosen.current, description: desc, ticket });
        if (typed.current) return;
        const n = r.name.replace(/\s/g, "-");
        setName(chosen.current ? withType(n, chosen.current) : n);
        setNamed(r.ai ? "ai" : "auto");
      } catch {
        /* keep whatever is there */
      } finally {
        setNaming(false);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, [agent, about, ticket, pid, naming]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAction<{ branch: string; worktree?: string; agentSession?: string }>("items.create", {
    // Config: a prefix used for the first time joined the project's branch types.
    invalidate: [["overview", pid], ["agents"], ["worktrees"], ["config"]],
    success: (r) => `Created ${r.branch}${r.worktree ? ` in ${r.worktree}` : ""}${r.agentSession ? " · agent started" : ""}`,
  });
  const v = version.replace(/^v/, "");
  const createRelease = useAction("releases.create", { invalidate: [["overview", pid], ["projects"]], success: `Release ${tagV.label(v)} created` });
  const base = bases.find((b) => b.name === from);
  const fromTag = !!draft.tag && from === draft.tag;
  const at = draft.at && from === draft.at.sha ? draft.at : undefined;
  // Where it starts, as the route names it; none until picked.
  const start = base?.name ?? (at ? at.sha.slice(0, 7) : fromTag ? draft.tag : undefined);
  // Started at a commit, it still merges into the branch the commit was picked on.
  const into = at ? draft.from : from;
  const rel = open.find((r) => r.branch === into);

  // A hook: called on every render, so above the release dialog's early return.
  const aiOn = useAiOn("branch");

  // Switching type rewrites the name's prefix (feature/x → fix/x).
  const pickKind = (k: string) => {
    setPicked(k);
    if (k === "release") return;
    chosen.current = k;
    setName(withType(name, k));
  };

  const label = kindNoun(kind);
  const branch = withTicket(withPrefix(name, kind), ticket);
  // Where a hotfix starts: the highest version that shipped.
  const latestTag = (ov.data?.releases ?? [])
    .filter((r) => r.tagName)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]?.tagName;
  if (min) {
    const what = kind === "release" ? "New release" : "New branch";
    // The name it will create, once there is one: what tells the chips apart.
    const named = kind === "release" ? v && `release/${v}` : branch;
    return (
      <button ref={chip} className="btn start-chip" data-tip={named ? `${what} ${named}` : undefined} onClick={() => onMinimize(false)}>
        <Icon name="branch" size={13} />
        {named ? (
          <span className="start-chip-text">
            <small>{what}</small>
            <span className="mono">{named}</span>
          </span>
        ) : (
          what
        )}
      </button>
    );
  }
  const headerActions = (
    <>
      <button className="btn btn-ghost btn-icon" aria-label="Edit branch types" data-tip="Edit branch types: order, pin, add" onClick={() => setEditing(true)}>
        <Icon name="edit" />
      </button>
      <button className="btn btn-ghost btn-icon" aria-label="Minimize" data-tip="Minimize · comes back from the chip in the corner" onClick={minimize}>
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
        ref={box}
        title="New release"
        route={<Route from={relKind === "next" ? ov.data?.defaultBranch : latestTag ?? "latest tag"} to={`release/${v || "x.y.z"}`} make wait />}
        actions={headerActions}
        onClose={onClose}
        onDismiss={dismiss}
        hint={<EnterHint verb="create" />}
        footer={
          <>
            <button className="btn btn-md" onClick={onClose}>
              Back
            </button>
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
        <div className="m-row">
          <span>Type</span>
          <TypePicker pid={pid} value={kind} onChange={pickKind} />
        </div>
        <div className="m-row">
          <span>Release</span>
          <Seg grid label="Release type" value={relKind} onChange={setRelKind} options={[{ value: "next", label: "Next release" }, { value: "hotfix", label: "Hotfix" }]} />
          <span className="m-note">{relKind === "next" ? "Branches off your default branch." : "Branches off the latest tag, to patch what shipped."}</span>
        </div>
        <div className="field">
          <label htmlFor="ni-version">Version</label>
          <input id="ni-version" className="input mono" placeholder="2.4.0" value={version} onChange={(e) => setVersion(e.target.value.trim())} autoFocus />
        </div>
      </Modal>
    );
  }

  // Switching brings the uncommitted changes along: with no name, AI names the branch after them.
  const wip = ov.data?.branches.find((b) => b.name === ov.data?.currentBranch)?.wip ?? 0;
  const nameFromWip = aiOn && !agent && where === "switch" && wip > 0;
  const ready = !!start && (agent ? !!desc.trim() : !!name.trim() || nameFromWip) && !create.isPending;
  const submit = async () => {
    const up = agent ? await uploads(files) : undefined;
    // The next new branch starts where this one went.
    setDialogs({ newWorktree: where === "worktree", newAgent: agent });
    create.mutate(
      // No name and no type clicked: AI picks the type when it names the branch.
      { projectId: pid, release: rel?.version ?? "", from: rel ? undefined : into, at: at?.sha, shipped: !!at?.shipped, kind: branch || chosen.current ? kind : "", description: agent ? desc : "", branchName: branch || undefined, ticket: ticket || undefined, where, startAgent: agent, files: up, ...(agent && pick) },
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
      title={`New ${label}`}
      sub={at ? <><span className="mono">{start}</span> {at.subject}</> : start ? undefined : "Pick where it starts"}
      route={
        start && (
          <Route from={start} to={branch || `${kind}/…`} label={agent ? "new worktree · agent" : where === "worktree" ? "new worktree" : "switch to it"} make wait />
        )
      }
      ref={box}
      // Wider with an agent, for its request box.
      width={agent ? 760 : undefined}
      actions={headerActions}
      onClose={onClose}
      onDismiss={dismiss}
      // With an agent, the prompt's own line says it: Ctrl/⌘+Enter there starts it.
      hint={agent ? undefined : <EnterHint verb="create" />}
      footer={
        <>
          <button className="btn btn-md" onClick={onClose}>
            Back
          </button>
          <button className="btn btn-primary btn-md" disabled={!ready} onClick={submit}>
            {create.isPending && <span className="spinner" />}
            Create {label}
            {agent && " and start agent"}
          </button>
        </>
      }
    >
      <div className="m-row">
        <span>Type</span>
        <TypePicker pid={pid} value={kind} onChange={pickKind} />
      </div>
      <div className="field">
        <label htmlFor="ni-branch">
          Name
          {(naming || named === "ai" || named === "auto") && (
            <span className="c-acc row" style={{ gap: 5 }}>
              {naming ? <span className="spinner" /> : named === "ai" ? <><Icon name="sparkle" size={11} />By AI</> : "From the task"}
            </span>
          )}
        </label>
        <input
          id="ni-branch"
          className="input mono"
          style={{ fontSize: 12.5 }}
          value={name}
          placeholder={nameFromWip ? "Empty: AI names it from your changes" : `${kind}/…`}
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
      <div className="field">
        <label htmlFor="ni-rel">Branches off</label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          <MenuChoice
            id="ni-rel"
            className="select menu-select"
            label="Branches off"
            search="Filter branches"
            value={from}
            options={[
              ...(draft.at ? [{ value: draft.at.sha, label: `${draft.at.sha.slice(0, 7)} (commit)` }] : []),
              ...(draft.tag ? [{ value: draft.tag, label: `${draft.tag} (tag)` }] : []),
              ...bases.map((b) => {
                const r = open.find((x) => x.branch === b.name);
                return { value: b.name, label: r ? `${tagV.label(r.version)} — ${releaseTagLabel(r.tag)}` : b.name };
              }),
            ]}
            onChange={setFrom}
          />
          <input id="ni-ticket" className="input mono" aria-label="Ticket" placeholder="Ticket, optional" value={ticket} onChange={(e) => setTicket(e.target.value)} />
        </div>
      </div>
      <div className="m-row">
        <span>Work in</span>
        <Seg
          grid
          label="Where to work"
          value={where}
          onChange={(v) => {
            setWhere(v);
            // An agent needs its own worktree, so switching drops it.
            if (v === "switch") setAgent(false);
          }}
          options={[{ value: "switch", label: "This checkout" }, { value: "worktree", label: "New worktree" }]}
        />
        <span className="m-note">{where === "switch" ? "Switches to the new branch. Your uncommitted changes come along." : "Runs beside your current branch: good for parallel AI work."}</span>
      </div>
      <div className="m-row">
        <span>
          Agent<span className="faint">optional</span>
        </span>
        <div className="row" style={{ gap: 12, justifyContent: "space-between", flexWrap: "wrap" }}>
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
            <span>Start one right away</span>
          </label>
          {agent && <AgentPicker value={pick} onChange={setPick} />}
        </div>
        {agent && <RequestField value={desc} onChange={setDesc} files={files} onFiles={setFiles} onSubmit={() => ready && submit()} projectId={pid} provider={pick.provider} />}
      </div>
    </Modal>
  );
}
