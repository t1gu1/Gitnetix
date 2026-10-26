import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { isLocal, openExternal, rpc, subscribe } from "../api/transport";
import type { GitnetixEvent, Scripts, ShellSnapshot } from "../api/types";
import { useStored } from "../lib/stored";
import { ansi, resolveTheme } from "../lib/themes";
import { ContextMenu } from "./ContextMenu";
import { Icon } from "./Icon";

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
// WebKitGTK without its DMA-BUF renderer (main.rs turns it off) copies each WebGL frame back through the CPU: typing lags.
const WEBGL = !(isLocal && /Linux/.test(navigator.userAgent));
const FIND: ISearchOptions = {
  decorations: { matchBackground: "#f0a43a33", activeMatchBackground: "#f0a43a99", matchOverviewRuler: "#f0a43a66", activeMatchColorOverviewRuler: "#f0a43a" },
};

// An installed Nerd Font wins; otherwise JetBrains Mono, with the bundled Nerd Font symbols for icons.
const FONT = '"JetBrainsMono Nerd Font", "JetBrainsMono NF", "JetBrains Mono", "Symbols Nerd Font Mono", monospace';
// The glyph cache is drawn once, so the fonts must be there before the terminal opens.
const fontsReady = () => Promise.all([document.fonts.load('12px "JetBrains Mono"'), document.fonts.load('12px "Symbols Nerd Font Mono"', "")]).catch(() => {});

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"];

function theme(): ITheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const t = resolveTheme(root.dataset.palette ?? "", root.dataset.theme === "light" ? "light" : "dark");
  const colors = Object.fromEntries(ansi(t).map((c, i) => [ANSI[i], c]));
  return { ...colors, background: v("--term"), foreground: v("--fg"), cursor: v("--accent"), cursorAccent: v("--term"), selectionBackground: v("--accent") + (t.light ? "66" : "44") };
}

function bytes(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A checkout's terminal: the login shell running in `path` (no `path`: the checkout is gone). */
export default function ShellPane({ projectId, path }: { projectId: string; path?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>(null);
  const searchRef = useRef<SearchAddon>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ i: number; n: number }>();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const scripts = useQuery({ queryKey: ["shellScripts", projectId, path], queryFn: () => rpc<Scripts[]>("shell.scripts", { projectId, path }), enabled: !!path });
  const pkgs = scripts.data ?? [];
  // Titles of the command sections hidden in this project, whatever the checkout.
  const [hidden, setHidden] = useStored<string[]>(`gnx.commands.hidden.${projectId}`, []);
  const shown = pkgs.filter((p) => !hidden.includes(p.title));
  const off = pkgs.filter((p) => hidden.includes(p.title));
  const typeScript = (cmd: string) => {
    const term = termRef.current;
    if (!term) return;
    // Ctrl+E then Ctrl+U clears the whole line in bash, zsh and fish (Ctrl+U alone keeps what follows the cursor). No Enter: the user runs it.
    term.input("\x05\x15" + cmd);
    // After the menu hands focus back to whatever had it.
    requestAnimationFrame(() => term.focus());
  };
  useEffect(() => {
    const el = host.current;
    if (!el || !path) return;
    let dead = false;
    let cwd: string | undefined;
    // Output bytes written so far; events up to it are already shown.
    let end = -1;
    let exited = false;
    let opening = false;
    let early: Extract<GitnetixEvent, { type: "shellData" }>[] = [];
    const term = new Terminal({ fontFamily: FONT, fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, scrollback: 10_000, theme: theme(), allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_, uri) => openExternal(uri)));
    const search = new SearchAddon();
    term.loadAddon(search);
    search.onDidChangeResults(({ resultIndex, resultCount }) => setHits({ i: resultIndex, n: resultCount }));
    termRef.current = term;
    searchRef.current = search;
    term.attachCustomKeyEventHandler((e) => {
      // Cmd on macOS; elsewhere Ctrl+Shift, since Ctrl+C, V and F belong to the shell.
      if (e.type !== "keydown" || !(MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey)) return true;
      const k = e.key.toLowerCase();
      if (k === "c" && term.hasSelection()) {
        e.preventDefault();
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      // Left to the browser, whose paste event xterm turns into input (bracketed paste included).
      if (k === "v") return false;
      if (k === "f") {
        e.preventDefault();
        setFinding(true);
        return false;
      }
      return true;
    });

    const show = (data: string, upTo: number) => {
      if (upTo <= end) return;
      const b = bytes(data);
      const start = upTo - b.length;
      if (start > end) return void open(); // events were dropped: start over from the backlog
      term.write(b.subarray(end - start));
      end = upTo;
    };
    const open = () => {
      if (opening || dead) return;
      opening = true;
      early = [];
      end = -1;
      rpc<ShellSnapshot>("shell.open", { projectId, path, cols: term.cols, rows: term.rows })
        .then((s) => {
          if (dead) return;
          cwd = s.cwd;
          exited = false;
          term.reset();
          term.write(bytes(s.data));
          end = s.end;
          for (const e of early) if (e.cwd === cwd) show(e.data, e.end);
          early = [];
        })
        .catch((e) => term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`))
        .finally(() => (opening = false));
    };
    const unsub = subscribe((e) => {
      if (e.type === "shellData") {
        if (end < 0) early.push(e);
        else if (e.cwd === cwd) show(e.data, e.end);
      } else if (e.type === "shellExit" && e.cwd === cwd && !exited) {
        exited = true;
        term.write("\r\n\x1b[2m[Shell exited. Press any key to start a new one.]\x1b[0m\r\n");
      }
    });

    // One write in flight at a time, so keystrokes arrive in order; what is typed meanwhile goes in the next.
    let queued = "";
    let sending = false;
    const pump = async () => {
      sending = true;
      while (queued && cwd && !dead) {
        const data = queued;
        queued = "";
        await rpc("shell.write", { path: cwd, data }).catch(() => {});
      }
      sending = false;
    };
    term.onData((d) => {
      if (exited) return open();
      queued += d;
      if (!sending) pump();
    });
    term.onResize(({ cols, rows }) => cwd && rpc("shell.resize", { path: cwd, cols, rows }).catch(() => {}));

    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => el.clientHeight && fit.fit());
    });
    const mo = new MutationObserver(() => (term.options.theme = theme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });

    fontsReady().then(() => {
      if (dead) return;
      term.open(el);
      try {
        if (WEBGL) {
          const gl = new WebglAddon();
          gl.onContextLoss(() => gl.dispose());
          term.loadAddon(gl);
        }
      } catch {
        /* no WebGL: xterm's DOM renderer */
      }
      fit.fit();
      ro.observe(el);
      term.focus();
      open();
    });
    return () => {
      dead = true;
      unsub();
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
      term.dispose();
      termRef.current = searchRef.current = null;
    };
  }, [projectId, path]);

  const find = (back = false, incremental = false) => {
    const s = searchRef.current;
    if (!s || !query) return setHits(undefined);
    if (back) s.findPrevious(query, FIND);
    else s.findNext(query, { ...FIND, incremental });
  };
  useEffect(() => {
    if (finding) find(false, true);
    // Only typing searches again; Enter steps through the matches.
  }, [query, finding]);
  const closeFind = () => {
    setFinding(false);
    searchRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    termRef.current?.focus();
  };

  if (!path) return <div className="ag-empty" style={{ fontFamily: "var(--sans)" }}>Directory removed.</div>;
  return (
    <div className="shell-pane">
      <div ref={host} style={{ height: "100%" }} />
      {pkgs.length > 0 && (
        <button
          type="button"
          className="btn btn-sm btn-icon shell-scripts"
          aria-haspopup="menu"
          aria-label="Project commands"
          data-tip="Project commands"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 2 });
            scripts.refetch();
          }}
        >
          <Icon name="play" size={12} />
        </button>
      )}
      {menu && (
        <ContextMenu
          {...menu}
          columns
          label="Project commands"
          onClose={() => setMenu(undefined)}
          items={[
            ...shown.flatMap((p, i) => [
              ...(i ? ["sep" as const] : []),
              ...(pkgs.length > 1
                ? [
                    {
                      heading: (
                        <span className="ctx-head-row">
                          <span className="grow ellipsis">{p.title}</span>
                          <button type="button" className="act" aria-label={`Hide ${p.title}`} data-tip="Hide in this project" onClick={() => setHidden([...hidden, p.title])}>
                            <Icon name="close" size={10} />
                          </button>
                        </span>
                      ),
                    },
                  ]
                : []),
              ...p.scripts.map(([name, cmd]) => ({ id: `${i}:${name}`, label: name, icon: null, run: () => typeScript(cmd) })),
            ]),
            ...(off.length
              ? [
                  ...(shown.length ? ["sep" as const] : []),
                  // Folds the list below into this pill; tabIndex lets a tap focus it, which opens it.
                  {
                    heading: (
                      <span className="pill faint ctx-fold" tabIndex={-1}>
                        {off.length} hidden
                      </span>
                    ),
                  },
                  ...off.map((p) => ({ id: `show:${p.title}`, label: p.title, icon: "plus", hint: "Show", keep: true, run: () => setHidden(hidden.filter((t) => t !== p.title)) })),
                ]
              : []),
          ]}
        />
      )}
      {finding && (
        <div className="shell-find" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), closeFind())}>
          <input
            className="input"
            autoFocus
            aria-label="Find in terminal"
            placeholder="Find"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => e.key === "Enter" && find(e.shiftKey)}
          />
          <span className="faint" style={{ minWidth: 44, fontSize: 11.5, textAlign: "center" }}>
            {query && hits ? (hits.n ? `${hits.i + 1}/${hits.n}` : "0/0") : ""}
          </span>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Previous match" data-tip="Previous (Shift+Enter)" onClick={() => find(true)}>
            <Icon name="chevronUp" size={12} />
          </button>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Next match" data-tip="Next (Enter)" onClick={() => find()}>
            <Icon name="chevronDown" size={12} />
          </button>
          <button type="button" className="btn btn-sm btn-icon" aria-label="Close find" onClick={closeFind}>
            <Icon name="close" size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
