import { logoBody } from "../lib/logo";

const BODY = logoBody("currentColor");

/** Gitnetix's mark in the theme's accent, so it follows the theme. Also the website's. */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      style={{ flex: "none", color: "var(--accent)" }}
      dangerouslySetInnerHTML={{ __html: BODY }}
    />
  );
}
