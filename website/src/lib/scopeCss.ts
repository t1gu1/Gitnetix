/**
 * The app's stylesheet for the demo: every rule of src/styles/app.css scoped under `scope` (the demo's root), so the demo,
 * which copies the app's markup and class names, looks the way the app does with no copied rules to keep in step.
 * - `:root` and `body` become the demo's root. Rules about the page itself (`html`, `#root`, `body.resizing …`) are dropped.
 * - A leading condition on <html> (`[data-theme="light"]`, `[data-palette^=…]`, `:root[data-anim-off~=…]`) stays outside.
 * - The phone layout's media rules hold for the phone demo (`.hd-phone`) at any window width, the desktop ones for the others;
 *   the map's and release notes' narrow rules follow the demo's own width (its `hd` container), not the window's.
 * - @font-face (the shell's icon font, a file the site doesn't serve) is dropped.
 */
const DOC = /^(?::root|html)?(?:\[data-(?:theme|palette|anim-off|idle)[^\]]*\]|:not\(\[data-palette\]\))+/;
const PAGE = /^(?:html|body|#root)(?![\w-])/;

/** `s` split on its top-level commas: not the ones inside :is(…) or […]. */
function split(s: string) {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && !depth) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, s.slice(start)];
}

/** One selector under `scope`, or null for one about the page itself. */
function scoped(sel: string, scope: string) {
  const s = sel.trim().replace(/\s+/g, ' ');
  if (s === ':root' || s === 'body') return scope;
  const doc = DOC.exec(s)?.[0];
  if (doc) return `${doc} ${scope}${s.slice(doc.length)}`;
  return PAGE.test(s) ? null : `${scope} ${s}`;
}

export function scopeCss(css: string, scope = '.hd') {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  // Skips a quoted string, from its opening quote.
  const quoted = () => {
    const q = src[i];
    for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
  };
  // What comes before the next top-level `{`, `;` or `}`.
  const prelude = () => {
    const start = i;
    for (let depth = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'") quoted();
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (!depth && (c === '{' || c === ';' || c === '}')) break;
    }
    return src.slice(start, i).trim();
  };
  // A block's text after its `{`, nested blocks and all; leaves `i` past its `}`.
  const block = () => {
    const start = i;
    for (let depth = 1; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'") quoted();
      else if (c === '{') depth++;
      else if (c === '}' && !--depth) break;
    }
    return src.slice(start, i++).replace(/\s+/g, ' ').trim();
  };
  // The rules of a block list (the file, or an at-rule's inside) under `under`, until its closing `}`.
  const rules = (under: string): string => {
    let out = '';
    while (i < src.length) {
      const pre = prelude();
      const c = src[i++];
      if (c === '}' || c === undefined) break;
      if (c === ';') continue;
      if (/^@media\b/.test(pre)) {
        const q = pre.slice(6).trim();
        if (/max-width:\s*480px/.test(q) && /pointer:\s*coarse/.test(q)) out += rules(`${under}.hd-phone`);
        else if (/min-width:\s*901px/.test(q)) out += rules(`${under}:not(.hd-phone)`);
        // Release notes' narrower layouts: the demo window is never as wide as the app's four columns need.
        else if (q === '(max-width: 720px)' || q === '(max-width: 1439px)' || q === '(max-width: 1099px)') out += `@container hd ${q}{${rules(under)}}\n`;
        else out += `${pre}{${rules(under)}}\n`;
      } else if (/^@(supports|container|layer)\b/.test(pre)) out += `${pre}{${rules(under)}}\n`;
      else if (/^@font-face\b/.test(pre)) block();
      else if (pre.startsWith('@')) out += `${pre}{${block()}}\n`;
      else {
        const sels = split(pre).map((s) => s.trim());
        const body = block();
        if (sels.some((s) => s === 'html' || s === '#root')) continue;
        const list = sels.flatMap((s) => scoped(s, under) ?? []);
        if (list.length) out += `${list.join(',')}{${body}}\n`;
      }
    }
    return out;
  };
  return rules(scope);
}
