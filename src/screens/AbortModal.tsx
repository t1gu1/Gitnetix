import { useState } from "react";

import { useAction } from "../api/hooks";
import type { InProgress } from "../api/types";
import { Confirm } from "../components/ui";

/**
 * Confirms aborting the rebase, merge, cherry-pick or revert `branch`'s checkout is stopped in. `base`: where a rebase goes.
 * A rebase AI is carrying through stops first.
 */
export function AbortModal({ pid, branch, op: opened, base, onBack, onDone }: { pid: string; branch: string; op?: InProgress | null; base?: string; onBack: () => void; onDone: () => void }) {
  // The one it opened on: once aborted, the refreshed overview has none left before this closes.
  const [op] = useState(opened);
  const abort = useAction("workspace.abort", { invalidate: [["overview", pid], ["files", pid], ["diff", pid], ["commits", pid]], success: `Aborted the ${op} of ${branch}` });
  if (!op) return null;
  return (
    <Confirm
      title={`Abort ${op}`}
      sub={op === "rebase" && base ? <>Rebasing <span className="mono">{branch}</span> onto <span className="mono">{base}</span></> : <span className="mono">{branch}</span>}
      action={`Abort ${op}`}
      busy={abort.isPending}
      onBack={onBack}
      onConfirm={() => abort.mutate({ projectId: pid, branch }, { onSuccess: onDone })}
    >
      <span className="mono">{branch}</span> goes back to where it was before the {op}
      {op === "rebase" && ", with the uncommitted changes it had then"}. Every conflict resolved so far is lost.
    </Confirm>
  );
}
