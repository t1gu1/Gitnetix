// Syntax colors from a worker (highlight.worker.ts), for diffs and code blocks.
import { Fragment, startTransition, useEffect, useState, type ReactNode } from "react";

import type { Hunk } from "../api/types";
import type { Token, Tokens } from "./highlight.worker";

// #rgb, #rgba, #rrggbb or #rrggbbaa; not inside a word or an `&#123;` entity.
const HEX = /((?<![\w&])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})\b)/i;

/** The text with a swatch of each hex colour before it. */
export function swatched(text: string): ReactNode {
  const parts = text.split(HEX);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 ? <Fragment key={i}><span className="swatch" style={{ background: p }} />{p}</Fragment> : p));
}

/** A line's text, in its syntax colors once they have come. */
export function code(text: string, toks: Token[] | null | undefined): ReactNode {
  if (!toks) return swatched(text);
  return toks.map(([s, cls], i) => (cls ? <span key={i} className={cls}>{swatched(s)}</span> : swatched(s)));
}

let worker: Worker | undefined;
let asked = 0;
const answers = new Map<number, (tokens: Tokens) => void>();

/** The hunks to draw and their syntax tokens, from a worker. A new file shows plain until they come; a new
 * version of the same file (a refresh, another mode) keeps the colored previous one meanwhile, so it doesn't flicker. */
export function useTokens(path: string, hunks: Hunk[]): { hunks: Hunk[]; tokens?: Tokens } {
  const [got, setGot] = useState<{ id: number; path: string; hunks: Hunk[]; tokens: Tokens }>();
  useEffect(() => {
    if (!worker) {
      worker = new Worker(new URL("../lib/highlight.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        answers.get(data.id)?.(data.tokens);
        answers.delete(data.id);
      };
    }
    const id = ++asked;
    // A late answer still moves the view forward, so steady edits can't stall it on an old version. A transition
    // draws the colors in slices, so a big file doesn't freeze while they land.
    answers.set(id, (tokens) => startTransition(() => setGot((g) => (g && g.id > id ? g : { id, path, hunks, tokens }))));
    worker.postMessage({ id, path, hunks });
  }, [path, hunks]);
  return got && (got.hunks === hunks || (got.path === path && got.tokens)) ? got : { hunks };
}
