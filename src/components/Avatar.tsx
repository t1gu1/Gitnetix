import { useEffect, useState, type CSSProperties } from "react";

import { useStoredFlag } from "../lib/stored";

/** Settings key: show Gravatar pictures instead of initials. */
export const GRAVATAR_KEY = "gnx.avatar.gravatar";

const hashes = new Map<string, Promise<string>>();

/** Gravatar's SHA-256 of the trimmed, lowercased email. */
function gravatarHash(email: string) {
  const key = email.trim().toLowerCase();
  let h = hashes.get(key);
  if (!h) {
    h = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(key))
      .then((b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join(""));
    hashes.set(key, h);
  }
  return h;
}

/** First letters of the first and last names, or the first two letters of a single name. */
function initials(name: string) {
  const words = name.trim().split(/\s+/);
  const two = words.length > 1 ? [...words[0]][0] + [...words[words.length - 1]][0] : [...words[0]].slice(0, 2).join("");
  return two.toUpperCase();
}

/** Same name, same color. */
function hue(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/** Small round picture of a commit author: their initials, or their Gravatar when turned on in the settings. Full name in the tooltip. */
export function Avatar({ name, email, size = 16 }: { name: string; email?: string; size?: number }) {
  const [gravatar] = useStoredFlag(GRAVATAR_KEY);
  const [src, setSrc] = useState<string | null>(null);
  // No crypto.subtle outside a secure context: initials only.
  const want = gravatar && !!email && !!globalThis.crypto?.subtle;
  useEffect(() => {
    setSrc(null);
    if (!want) return;
    let live = true;
    gravatarHash(email!).then((h) => live && setSrc(`https://gravatar.com/avatar/${h}?s=${size * 2}&d=404`), () => {});
    return () => {
      live = false;
    };
  }, [want, email, size]);
  if (!name) return null;
  return (
    <span
      className="user-avatar"
      data-tip={name}
      aria-label={name}
      role="img"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45), "--avatar-hue": hue(name) } as CSSProperties}
    >
      {src ? <img src={src} alt="" width={size} height={size} onError={() => setSrc(null)} /> : initials(name)}
    </span>
  );
}
