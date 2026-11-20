import { useState } from "react";

import { useAction, useAiOn, useOverview, usePendingBranches, useProjectPrefs, useSuggestedVersion, useTagV, withV } from "../api/hooks";
import type { BranchView, PublishResult, ReleaseView } from "../api/types";
import { Modal, Seg } from "../components/ui";

type Bump = "major" | "minor" | "patch" | "custom";

/** A version git can tag (the leading "v" already stripped): a digit first, then letters, digits, dots and dashes, no "..", not ending in "." or ".lock". The backend checks the same. */
const publishable = (version: string) => /^[0-9][0-9A-Za-z.-]*$/.test(version) && !version.includes("..") && !version.endsWith(".") && !version.endsWith(".lock");

/** A tag name typed in full (Custom): the backend's rule, a branch name's characters, not starting with a dash or a dot, no "..", not ending in ".", "/" or ".lock". */
const tagName = (t: string) => /^[A-Za-z0-9_][A-Za-z0-9/_.-]*$/.test(t) && !t.includes("..") && !/(\.|\/|\.lock)$/.test(t);

/** What the action reads as: it updates the changelog only when the project has one. */
export const publishName = (hasChangelog: boolean) => (hasChangelog ? "Create tag & Update changelog" : "Create tag");

/** Releases a branch where it stands: CHANGELOG.md dated, its tip tagged, both pushed to origin. No other branch moves. */
export function PublishModal({ pid, view, onClose }: { pid: string; view: BranchView; onClose: () => void }) {
  const ov = useOverview(pid).data;
  const prefs = useProjectPrefs(pid).dialogs;
  const tagV = useTagV(pid);
  const b = view.name;
  // A release branch goes out as its own version; any other picks the next one.
  const fixed = view.role === "release" && view.release ? view.release : null;
  const [bump, setBump] = useState<Bump>("minor");
  // Custom: the tag's full name, as typed; the other tabs fill it from the next version.
  const [custom, setCustom] = useState("");
  const isCustom = !fixed && bump === "custom";
  const suggested = useSuggestedVersion(pid, bump === "custom" ? "minor" : bump, !fixed && !isCustom);
  // A custom tag dates the changelog under its name, without a "v" before a digit (the backend does the same).
  const version = isCustom ? custom.replace(/^v(?=\d)/, "") : (fixed ?? suggested.data?.version ?? "").replace(/^v/, "");
  const valid = isCustom ? tagName(custom) : publishable(version);
  const tag = isCustom ? custom : tagV.label(version || "x.y.z");
  const hasChangelog = !!ov?.hasChangelog;
  // Same gate as "Update changelog" in the branch menu.
  const canChangelog = useAiOn("release") && hasChangelog;
  const [updateLog, setUpdateLog] = useState(prefs.shipChangelog);
  // Planned on another release branch: its tag is that branch's to create.
  // Looks merged into this branch (nothing of its own left over it, and the branch moved past it): publishing
  // here releases it. The backend makes sure its commits really came in through a merge.
  const mergedHere = (r: ReleaseView) => {
    const v = ov?.branches.find((x) => x.name === r.branch);
    return v?.parent === b && v.ahead === 0 && v.behind > 0;
  };
  const planned = version ? ov?.releases.find((r) => r.open && r.branch !== b && r.version.replace(/^v/i, "") === version && !mergedHere(r)) : undefined;
  // The AI changelog step runs inside the publish, after its checks: a refused publish leaves no changelog commit behind.
  const publish = useAction<PublishResult, { projectId: string; branch: string; version: string; v: boolean; tag?: string; aiChangelog: boolean }>("branches.publish", {
    invalidate: [["overview", pid], ["commits", pid], ["projects"]],
    success: (r) =>
      r.pushed
        ? `${r.changelog ? "Updated the changelog, created" : "Created"} ${r.tag} and pushed it with ${b}`
        : `${r.changelog ? "Updated the changelog and created" : "Created"} ${r.tag}. It stays local: this project has no origin`,
  });
  // One started from another dialog on this branch, still running.
  const running = usePendingBranches("branches.publish", pid).includes(b) && !publish.isPending;
  // A release branch's base gets the release only by merging it.
  const base = view.role === "release" ? view.parent || ov?.defaultBranch : undefined;
  // Planned for this release, not in it yet: publishing now goes without them. Gone ones have nothing left to merge.
  const rel = view.role === "release" ? ov?.releases.find((r) => r.open && r.branch === b) : undefined;
  const unmerged = rel ? (ov?.branches.filter((x) => x.release === rel.version && x.name !== b && x.exists && !x.merged) ?? []) : [];
  const badVersion =
    version &&
    !valid && (
      <span className="hint c-del">
        {isCustom ? "Not a tag name git takes: letters, digits, dots, dashes, underscores or slashes, not starting with a dash." : "Not a version git can tag: a digit first, then letters, digits, dots or dashes, like 1.3.0."}
      </span>
    );
  // The "v" choice, saved for the project: shown above the tag it shapes; a custom tag is taken as written.
  const prefix = !isCustom && (
    <div className="field">
      <span className="flabel">Prefix</span>
      <Seg
        grid
        label="Prefix"
        value={tagV.v ? "v" : "plain"}
        onChange={(k) => tagV.setV(k === "v")}
        options={[
          { value: "v", label: <span className="mono">{withV(true, version || "x.y.z")}</span> },
          { value: "plain", label: <span className="mono">{withV(false, version || "x.y.z")}</span> },
        ]}
      />
    </div>
  );
  return (
    <Modal
      title={publishName(hasChangelog)}
      sub={<span className="mono">{b}</span>}
      // Stays open while publishing, so its outcome shows here and it can't be started twice.
      onClose={() => !publish.isPending && onClose()}
      footer={
        <button
          className="btn btn-primary btn-md"
          disabled={!valid || !!planned || publish.isPending || running}
          onClick={() => publish.mutate({ projectId: pid, branch: b, version, v: tagV.v, tag: isCustom ? custom : undefined, aiChangelog: canChangelog && updateLog }, { onSuccess: onClose })}
        >
          {publish.isPending && <span className="spinner" />}
          {publish.isPending ? (hasChangelog ? "Updating changelog & creating tag…" : "Creating tag…") : version ? `Create tag ${tag}` : "Create tag"}
        </button>
      }
    >
      {fixed ? (
        <>
          <div className="field">
            <span className="flabel">Version</span>
            <span className="mono">{fixed}</span>
            {badVersion}
          </div>
          {prefix}
        </>
      ) : (
        <>
          <Seg
            grid
            label="Version"
            value={bump}
            onChange={(k) => {
              // Custom starts from the tag shown, ready to edit.
              if (k === "custom" && !isCustom) setCustom(version ? tag : "");
              setBump(k);
            }}
            options={[{ value: "major", label: "Major" }, { value: "minor", label: "Minor" }, { value: "patch", label: "Patch" }, { value: "custom", label: "Custom" }]}
          />
          {prefix}
          <div className="field">
            <label htmlFor="pub-tag">Tag</label>
            <input
              id="pub-tag"
              className="input mono"
              placeholder={tagV.label("1.3.0")}
              value={isCustom ? custom : version ? tag : ""}
              // Typing goes to Custom: the tag is then exactly what is written.
              onChange={(e) => {
                setCustom(e.target.value.trim());
                setBump("custom");
              }}
              autoFocus
            />
            {badVersion}
          </div>
        </>
      )}
      <p style={{ margin: 0, lineHeight: 1.55 }}>
        {hasChangelog && <>The Unreleased section of CHANGELOG.md becomes {version || "the version"}, dated today, committed on <span className="mono">{b}</span>. </>}
        The tag <span className="mono">{tag}</span> is created on the tip of <span className="mono">{b}</span>
        {ov?.remote ? <>, then {b} and the tag are pushed to origin together.</> : <>. With no origin, both stay local.</>}
        {base && <> <span className="mono">{base}</span> stays where it is: merge {b} into it to bring the release there.</>}
      </p>
      {unmerged.length > 0 && (
        <div className="note-box">
          Make sure these are merged into <span className="mono">{b}</span>: {unmerged.map((x) => x.name).join(", ")}.
        </div>
      )}
      {planned && (
        <div className="note-box">
          {tagV.label(planned.version)} is planned for <span className="mono">{planned.branch}</span>: create its tag from there, merge it into <span className="mono">{b}</span> first, or pick another version.
        </div>
      )}
      {canChangelog && (
        <label className="check">
          <input type="checkbox" checked={updateLog} onChange={() => setUpdateLog(!updateLog)} />
          <span>First let AI add what {b} changes to the changelog</span>
        </label>
      )}
    </Modal>
  );
}
