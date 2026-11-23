import type { PrDetail, PrSummary } from "../api/types";

/** A pull request's status on the branch map: the colour and the label of its dot. */
export type PrTone = "ready" | "changes" | "fail" | "draft" | "pending";

export const PR_TONE_LABEL: Record<PrTone, string> = {
  ready: "Ready",
  changes: "Changes requested",
  fail: "Failing",
  draft: "Draft",
  pending: "Pending",
};

/** The status of `pr`. A conflict or a failed check comes first, then a request for changes, then a draft. Ready needs
 * one approval, every check to pass and no unresolved thread. Without the details, a draft shows as a draft and anything
 * else as pending. */
export function prTone(pr: PrSummary, detail?: PrDetail): PrTone {
  if (detail?.conflict || detail?.checks.some((c) => c.status === "fail")) return "fail";
  if (detail?.reviewers.some((r) => r.vote === "changes")) return "changes";
  if (pr.state === "draft") return "draft";
  if (
    detail &&
    detail.reviewers.some((r) => r.vote === "approve") &&
    detail.checks.every((c) => c.status === "pass") &&
    !detail.threads.some((t) => t.resolvable && !t.resolved)
  )
    return "ready";
  return "pending";
}
