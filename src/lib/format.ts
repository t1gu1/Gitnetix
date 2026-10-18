export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function ago(iso: string) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
