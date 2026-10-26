// Syntax highlighting off the main thread: a diff shows plain at once and takes its colors from here.
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";

import type { Hunk } from "../api/types";

/** A run of a line's text and its class, "" when plain. */
export type Token = [text: string, cls: string];
/** Each hunk line's tokens (null: too big to color), or null when the language is unknown. */
export type Tokens = (Token[] | null)[][] | null;

// Few classes, so neighbouring runs merge into few spans; app.css colors them from the theme.
const highlighter = tagHighlighter([
  { tag: t.keyword, class: "sx-k" },
  { tag: [t.string, t.regexp, t.escape, t.monospace], class: "sx-s" },
  { tag: [t.number, t.bool, t.atom, t.null, t.unit, t.color, t.constant(t.name)], class: "sx-n" },
  { tag: t.comment, class: "sx-c" },
  { tag: t.meta, class: "sx-m" },
  { tag: [t.typeName, t.className, t.namespace], class: "sx-t" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "sx-f" },
  { tag: t.propertyName, class: "sx-p" },
  { tag: [t.heading, t.strong], class: "sx-h" },
  { tag: t.emphasis, class: "sx-e" },
  { tag: [t.link, t.url], class: "sx-l" },
]);

// Longer lines (minified code) stay plain: thousands of spans on one line cost more to draw than they help.
const MAX_LINE = 2000;
// shortcut: a hunk side over 1 MB stays plain (bounds worker memory and spans to draw); color by visible chunk if huge files need it.
const MAX_TEXT = 1_000_000;

onmessage = async ({ data: { id, path, hunks } }: MessageEvent<{ id: number; path: string; hunks: Hunk[] }>) => {
  const lang = LanguageDescription.matchFilename(languages, path.slice(path.lastIndexOf("/") + 1));
  const parser = (await lang?.load().catch(() => null))?.language.parser;
  // Each side of a hunk is parsed as one text, so comments and strings spanning lines color right.
  const side = (h: Hunk, skip: string) => {
    const text = h.lines.filter((l) => l.kind !== skip).map((l) => l.text).join("\n");
    if (text.length > MAX_TEXT) return [];
    const lines: Token[][] = [[]];
    const put = (s: string, cls: string) => {
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last?.[1] === cls) last[0] += s;
      else line.push([s, cls]);
    };
    highlightCode(text, parser!.parse(text), highlighter, put, () => lines.push([]));
    return lines;
  };
  let tokens: Tokens = null;
  try {
    if (parser)
      tokens = hunks.map((h) => {
        // A plain file (no removals) has one side: parse it once.
        const old = h.lines.some((l) => l.kind === "-") ? side(h, "+") : [];
        const cur = side(h, "-");
        let o = 0;
        let n = 0;
        return h.lines.map((l) => {
          const toks = l.kind === "-" ? old[o++] : cur[n++];
          if (l.kind === " ") o++;
          return toks && l.text.length <= MAX_LINE ? toks : null;
        });
      });
  } catch {
    /* plain then: the diff waits for this answer to show a new version */
  }
  postMessage({ id, tokens });
};
