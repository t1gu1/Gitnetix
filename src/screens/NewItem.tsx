import { useEffect, useRef, useState } from "react";

import { useAction, useAiOn, useOverview, useProjectPrefs, useSuggestedVersion } from "../api/hooks";
import { rpc } from "../api/transport";
import { RequestField, uploads, type Attachment } from "../components/AgentLog";
import { AgentPicker, MenuChoice, useAgentPick } from "../components/AgentPicker";
import { Icon } from "../components/Icon";
import { Modal, releaseTagLabel, Seg } from "../components/ui";
import { KINDS, kindNoun, kindOfBranch, withPrefix, withTicket, type Kind } from "../lib/kinds";
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
  const [kind, setKind] = useState<Kind | "release">(draft.kind ?? "feat");
  const [relKind, setRelKind] = useState<"next" | "hotfix">("next");
  // Null until the user types their own; the suggestion shows meanwhile.
  const [typedVersion, setVersion] = useState<string | null>(null);
  const [desc, setDesc] = useState(draft.description ?? "");
  const [from, setFrom] = useState(firstBase);
  const [ticket, setTicket] = useState(draft.ticket ?? "");
  const { dialogs, setDialogs } = useProjectPrefs(pid);
  // An agent always gets its own worktree.
  const [where, setWhere] = useState<"switch" | "worktree">(dialogs.newWorktree || dialogs.newAgent ? "worktree" : "switch");
  const [agent, setAgent] = useState(dialogs.newAgent);
  const [pick, setPick] = useAgentPick(pid);
  const [files, setFiles] = useState<Attachment[]>([]);
  const [name, setName] = useState("");
  const [named, setNamed] = useState<"ai" | "auto" | "you" | null>(null);
  const [naming, setNaming] = useState(false);
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
    const ask = JSON.stringify([about, kind, ticket, pid]);
    if (!agent || named === "you" || naming || about.length < 6 || ask === asked.current) return;
    const t = setTimeout(async () => {
      asked.current = ask;
      setNaming(true);
      try {
        const r = await rpc<{ name: string; ai: boolean }>("items.suggestName", { projectId: pid, kind, description: desc, ticket });
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
  }, [agent, about, kind, ticket, pid, naming]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useAction<{ branch: string; worktree?: string; agentSession?: string }>("items.create", {
    invalidate: [["overview", pid], ["agents"], ["worktrees"]],
    success: (r) => `Created ${r.branch}${r.worktree ? ` in ${r.worktree}` : ""}${r.agentSession ? " · agent started" : ""}`,
  });
  const v = version.replace(/^v/, "");
  const createRelease = useAction("releases.create", { invalidate: [["overview", pid], ["projects"]], success: `Release v${v} created` });
  const base = bases.find((b) => b.name === from);
  const fromTag = !!draft.tag && from === draft.tag;
  const rel = open.find((r) => r.branch === from);
  // Release takes Build's slot so the types stay two rows of six; a typed `build/` prefix still works.
  const types = [...KINDS.filter((k) => k.id !== "build").map((k) => ({ value: k.id as Kind | "release", label: k.label })), { value: "release" as const, label: "Release" }];

  // A hook: called on every render, so above the release dialog's early return.
  const aiOn = useAiOn("branch");

  // Switching type rewrites a known type prefix (feature/x → fix/x); a custom prefix is left alone.
  const pickKind = (k: Kind | "release") => {
    setKind(k);
    if (k !== "release" && kindOfBranch(name)) setName(`${k}/${name.slice(name.indexOf("/") + 1)}`);
  };

  if (min)
    return (
      <button className="btn start-chip" onClick={() => setMin(false)}>
        <Icon name="branch" size={13} />
        {kind === "release" ? "New release" : "New branch"}
      </button>
    );
  const minimize = (
    <button className="btn btn-ghost btn-icon" aria-label="Minimize" data-tip="Minimize · comes back from the chip in the corner" onClick={() => setMin(true)}>
      <Icon name="minus" />
    </button>
  );

  if (kind === "release") {
    return (
      <Modal
        title="New release"
        sub={relKind === "next" ? "Branches off your default branch" : "Branches off the latest tag"}
        actions={minimize}
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
        <Seg grid cols={6} size="lg" label="Type" value={kind} onChange={pickKind} options={types} />
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
      title={rel ? `New in v${rel.version}` : base ? `New branch off ${base.name}` : fromTag ? `New branch off ${draft.tag}` : "New feature or fix"}
      sub={
        base ? <>Branches off <span className="mono">{base.name}</span> and merges back into it</>
        : fromTag ? <>Branches off tag <span className="mono">{draft.tag}</span> and merges into <span className="mono">{ov.data?.defaultBranch}</span></>
        : "Pick where it starts"
      }
      actions={minimize}
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
      <Seg grid cols={6} size="lg" label="Type" value={kind} onChange={pickKind} options={types} />
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
                return { value: b.name, label: r ? `v${r.version} — ${releaseTagLabel(r.tag)}` : b.name };
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
            const k = kindOfBranch(v);
            if (k) setKind(k);
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
