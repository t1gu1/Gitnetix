import { useEffect, useState } from "react";

import { useConfig } from "../api/hooks";
import { useStoredFlag } from "../lib/stored";

/** Profile setting, edited with the profile: show authors' Gravatar pictures instead of initials. */
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

/** What an avatar `size` px wide shows: two initials from 22px, else the first alone, so its letters keep the 11px text floor
 * (a dot too small for 11px takes the largest size that fits). */
function face(name: string, size: number) {
  const two = size >= 22;
  return { text: [...initials(name)].slice(0, two ? 2 : 1).join(""), fontSize: two ? Math.max(11, Math.round(size * 0.42)) : Math.min(11, size - 3) };
}

/** `email`'s Gravatar picture, `size` px wide: null without an email, until its hash is known, or once `failed` (none set). */
export function useGravatar(email: string | undefined, size: number) {
  const [src, setSrc] = useState<string | null>(null);
  // No crypto.subtle outside a secure context: no picture.
  const want = !!email && !!globalThis.crypto?.subtle;
  useEffect(() => {
    setSrc(null);
    if (!want) return;
    let live = true;
    gravatarHash(email!).then((h) => live && setSrc(`https://gravatar.com/avatar/${h}?s=${size * 2}&d=404`), () => {});
    return () => {
      live = false;
    };
  }, [want, email, size]);
  return [src, () => setSrc(null)] as const;
}

/**
 * Small round picture of a person: their Gravatar when turned on in the profile (your own: your profile's photo or Gravatar),
 * else their initials on a neutral disc. Full name in the tooltip; `decorative` when the name shows beside it anyway.
 */
export function Avatar({ name, email, size = 16, decorative }: { name: string; email?: string; size?: number; decorative?: boolean }) {
  const [gravatar] = useStoredFlag(GRAVATAR_KEY);
  const cfg = useConfig().data;
  // Your own commits wear your profile's photo or Gravatar.
  const mine = !!email && email.trim().toLowerCase() === cfg?.profiles[0]?.email?.trim().toLowerCase();
  const look = (mine && cfg?.userProfiles?.find((p) => p.id === cfg.activeProfile)?.avatar) || "";
  const [src, failed] = useGravatar(look.startsWith("gravatar:") ? look.slice(9) : gravatar ? email : undefined, size);
  const pic = look.startsWith("data:image/") ? look : src;
  if (!name) return null;
  const f = face(name, size);
  return (
    <span
      className="user-avatar"
      {...(decorative ? { "aria-hidden": true } : { "data-tip": name, "aria-label": name, role: "img" })}
      style={{ width: size, height: size, fontSize: f.fontSize }}
    >
      {pic ? <img src={pic} alt="" width={size} height={size} onError={failed} /> : f.text}
    </span>
  );
}
