//! Skills and custom commands an agent CLI offers, read from its own folders, for the `/` menu of the prompt boxes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// "project", "personal", or the Claude Code plugin it comes with.
    pub from: String,
}

/// What a skill name is typed after: Codex mentions skills with `$`, the other CLIs take `/`.
pub fn prefix(provider: &str) -> &'static str {
    if provider == "codex" { "$" } else { "/" }
}

/// The skills `provider`'s CLI finds for a session in `project`, the project's own first.
pub fn list(provider: &str, project: &Path) -> Vec<Skill> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    list_in(provider, project, &home, |k| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from))
}

fn list_in(provider: &str, project: &Path, home: &Path, env: impl Fn(&str) -> Option<PathBuf>) -> Vec<Skill> {
    let conf = |var: &str, dir: &str| env(var).unwrap_or_else(|| home.join(dir));
    let (p, h) = (|d: &str| project.join(d), |d: &str| home.join(d));
    let mut out = Vec::new();
    let skill_dirs = |dirs: &[PathBuf], from: &str, out: &mut Vec<Skill>| dirs.iter().for_each(|d| skills(d, from, "", out));
    match provider {
        "claude" => {
            let cfg = conf("CLAUDE_CONFIG_DIR", ".claude");
            for (root, from) in [(p(".claude"), "project"), (cfg.clone(), "personal")] {
                skills(&root.join("skills"), from, "", &mut out);
                commands(&root.join("commands"), from, "", &mut out);
            }
            for (name, dir) in claude_plugins(&cfg, project) {
                let pre = format!("{name}:");
                skills(&dir.join("skills"), &name, &pre, &mut out);
                commands(&dir.join("commands"), &name, &pre, &mut out);
            }
        }
        // Folders from learn.chatgpt.com/docs/build-skills (2026-11-20).
        // shortcut: skills turned off by `[[skills.config]] enabled = false` in ~/.codex/config.toml still show; read it once someone asks.
        "codex" => {
            skill_dirs(&[p(".agents/skills")], "project", &mut out);
            skill_dirs(&[h(".agents/skills")], "personal", &mut out);
            skill_dirs(&[PathBuf::from("/etc/codex/skills")], "admin", &mut out);
        }
        // Folders from docs.github.com, Copilot CLI "Adding agent skills" (2026-11-20).
        "copilot" => {
            skill_dirs(&[p(".github/skills"), p(".claude/skills"), p(".agents/skills")], "project", &mut out);
            skill_dirs(&[h(".copilot/skills"), h(".agents/skills")], "personal", &mut out);
        }
        // Gemini CLI and Antigravity, whichever of the two runs. Folders from geminicli.com/docs/cli/using-agent-skills
        // and antigravity.google/docs/skills (2026-11-20), `.agent` and `antigravity/` being Antigravity's older ones.
        "gemini" => {
            skill_dirs(&[p(".gemini/skills"), p(".agents/skills"), p(".agent/skills")], "project", &mut out);
            toml_commands(&p(".gemini/commands"), "project", &mut out);
            let personal = [".gemini/skills", ".agents/skills", ".gemini/config/skills", ".gemini/antigravity-cli/skills", ".gemini/antigravity/skills"];
            skill_dirs(&personal.map(h), "personal", &mut out);
            toml_commands(&h(".gemini/commands"), "personal", &mut out);
        }
        _ => {}
    }
    // The first of a name wins, as in the CLIs: a project's own skill hides a personal one.
    let mut seen = HashSet::new();
    out.retain(|s| seen.insert(s.name.clone()));
    out
}

/// Entries of `dir`, by name.
fn entries(dir: &Path) -> Vec<PathBuf> {
    let mut all: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    all.sort();
    all
}

/// `dir/<name>/SKILL.md` files; a skill hidden from the user (`user-invocable: false`) is left out.
fn skills(dir: &Path, from: &str, pre: &str, out: &mut Vec<Skill>) {
    for d in entries(dir) {
        let Ok(text) = std::fs::read_to_string(d.join("SKILL.md")) else { continue };
        let (keys, _) = front(&text);
        if keys.get("user-invocable").is_some_and(|v| v == "false") {
            continue;
        }
        let name = keys.get("name").filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| file_name(&d));
        out.push(Skill { name: format!("{pre}{name}"), description: keys.get("description").cloned().unwrap_or_default(), from: from.into() });
    }
}

/// Claude Code commands: `dir/**/<name>.md`, subfolders only sort them.
fn commands(dir: &Path, from: &str, pre: &str, out: &mut Vec<Skill>) {
    for f in entries(dir) {
        if f.is_dir() {
            commands(&f, from, pre, out);
            continue;
        }
        // `_name.md` is a note for the plugin's authors (Vercel's `_conventions.md`): Claude Code lists no such command.
        if f.extension().is_none_or(|e| e != "md") || stem(&f).starts_with('_') {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        let (keys, body) = front(&text);
        // Without a description Claude Code shows the first line.
        let first = || body.lines().map(|l| l.trim_start_matches('#').trim()).find(|l| !l.is_empty()).unwrap_or_default().to_string();
        let description = keys.get("description").filter(|d| !d.is_empty()).cloned().unwrap_or_else(first);
        out.push(Skill { name: format!("{pre}{}", stem(&f)), description, from: from.into() });
    }
}

/// Gemini CLI commands: `dir/**/<name>.toml`, a subfolder names `folder:name`.
fn toml_commands(dir: &Path, from: &str, out: &mut Vec<Skill>) {
    fn walk(dir: &Path, ns: &str, from: &str, out: &mut Vec<Skill>) {
        for f in entries(dir) {
            if f.is_dir() {
                walk(&f, &format!("{ns}{}:", file_name(&f)), from, out);
            } else if f.extension().is_some_and(|e| e == "toml") {
                // shortcut: reads a one-line `description = "…"` only; parse TOML if multi-line ones show up.
                let text = std::fs::read_to_string(&f).unwrap_or_default();
                let description = text
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("description")?.trim_start().strip_prefix('=').map(|v| v.trim().trim_matches(['"', '\'']).to_string()))
                    .unwrap_or_default();
                out.push(Skill { name: format!("{ns}{}", stem(&f)), description, from: from.into() });
            }
        }
    }
    walk(dir, "", from, out);
}

/// Install folders of the Claude Code plugins turned on, by plugin name.
fn claude_plugins(cfg: &Path, project: &Path) -> Vec<(String, PathBuf)> {
    let read = |p: PathBuf| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    // Later settings override earlier ones, as in Claude Code.
    let mut on: HashMap<String, bool> = HashMap::new();
    for f in [cfg.join("settings.json"), project.join(".claude/settings.json"), project.join(".claude/settings.local.json")] {
        if let Some(Value::Object(m)) = read(f).and_then(|v| v.get("enabledPlugins").cloned()) {
            on.extend(m.into_iter().filter_map(|(k, v)| Some((k, v.as_bool()?))));
        }
    }
    let Some(Value::Object(installed)) = read(cfg.join("plugins/installed_plugins.json")).and_then(|v| v.get("plugins").cloned()) else { return vec![] };
    let mut out: Vec<(String, PathBuf)> = installed
        .iter()
        .filter(|(k, _)| on.get(*k) == Some(&true))
        .filter_map(|(k, v)| {
            // A plugin installed for one project only counts there.
            let at = v.as_array()?.iter().find(|e| e.get("projectPath").and_then(Value::as_str).is_none_or(|p| Path::new(p) == project))?;
            Some((k.split('@').next()?.to_string(), PathBuf::from(at.get("installPath")?.as_str()?)))
        })
        .collect();
    out.sort();
    out
}

/// Top-level keys of a Markdown file's YAML frontmatter (`>` and `|` blocks joined on one line), and the body after it.
fn front(text: &str) -> (HashMap<String, String>, &str) {
    let mut keys: HashMap<String, String> = HashMap::new();
    let text = text.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else { return (keys, text) };
    let Some(end) = rest.find("\n---") else { return (keys, text) };
    let body = rest[end + 4..].split_once('\n').map_or("", |(_, b)| b);
    let mut last: Option<String> = None;
    for line in rest[..end].lines() {
        if line.starts_with([' ', '\t']) {
            // A line of the value above (a folded block or a nested map, kept only for the first).
            if let Some(v) = last.as_ref().and_then(|k| keys.get_mut(k)) {
                if !v.is_empty() {
                    v.push(' ');
                }
                v.push_str(line.trim());
            }
        } else if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            let v = if v.starts_with(['>', '|']) { "" } else { v.trim_matches(['"', '\'']) };
            keys.insert(k.trim().to_string(), v.to_string());
            last = Some(k.trim().to_string());
        }
    }
    (keys, body)
}

fn file_name(p: &Path) -> String {
    p.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

fn stem(p: &Path) -> String {
    p.file_stem().unwrap_or_default().to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(p: PathBuf, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn names(all: &[Skill]) -> Vec<(&str, &str, &str)> {
        all.iter().map(|s| (s.name.as_str(), s.description.as_str(), s.from.as_str())).collect()
    }

    #[test]
    fn claude_lists_project_personal_and_plugin_skills() {
        let (home, proj) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (h, p) = (home.path().join(".claude"), proj.path());
        put(p.join(".claude/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: >\n  Ship it\n  to prod.\n---\nbody");
        put(h.join("skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: personal one\n---\n");
        put(h.join("skills/quiet/SKILL.md"), "---\nname: quiet\nuser-invocable: false\n---\n");
        put(h.join("skills/bare/SKILL.md"), "no frontmatter");
        put(h.join("commands/git/review.md"), "# Review the diff\n\nsteps");
        put(h.join("commands/_notes.md"), "for authors");
        put(h.join("plugins/installed_plugins.json"), &format!(r#"{{"version":2,"plugins":{{"cave@m":[{{"scope":"user","installPath":"{0}"}}],"off@m":[{{"scope":"user","installPath":"{0}"}}],"elsewhere@m":[{{"scope":"project","projectPath":"/nope","installPath":"{0}"}}]}}}}"#, home.path().join("plug").display()));
        put(h.join("settings.json"), r#"{"enabledPlugins":{"cave@m":true,"off@m":true,"elsewhere@m":true}}"#);
        put(p.join(".claude/settings.json"), r#"{"enabledPlugins":{"off@m":false}}"#);
        put(home.path().join("plug/skills/cave/SKILL.md"), "---\nname: cave\ndescription: \"Talk short\"\n---\n");
        let all = list_in("claude", p, home.path(), |_| None);
        assert_eq!(
            names(&all),
            [("deploy", "Ship it to prod.", "project"), ("bare", "", "personal"), ("review", "Review the diff", "personal"), ("cave:cave", "Talk short", "cave")]
        );
    }

    #[test]
    fn each_cli_reads_its_own_folders() {
        let (home, proj) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        put(proj.path().join(".agents/skills/a/SKILL.md"), "---\nname: a\n---\n");
        put(home.path().join(".agents/skills/b/SKILL.md"), "---\nname: b\n---\n");
        put(home.path().join(".copilot/skills/c/SKILL.md"), "---\nname: c\n---\n");
        put(home.path().join(".gemini/config/skills/d/SKILL.md"), "---\nname: d\n---\n");
        put(home.path().join(".gemini/commands/git/commit.toml"), "description = \"Write a commit\"\nprompt = \"\"\"x\"\"\"");
        // Not read by any of them: Codex's old folder, Claude's personal one.
        put(home.path().join(".codex/skills/old/SKILL.md"), "---\nname: old\n---\n");
        put(home.path().join(".claude/skills/cl/SKILL.md"), "---\nname: cl\n---\n");
        let list = |cli: &str| names(&list_in(cli, proj.path(), home.path(), |_| None)).into_iter().map(|(n, _, f)| format!("{n} {f}")).collect::<Vec<_>>();
        assert_eq!(list("codex"), ["a project", "b personal"]);
        assert_eq!(list("copilot"), ["a project", "c personal", "b personal"]);
        assert_eq!(list("gemini"), ["a project", "b personal", "d personal", "git:commit personal"]);
    }
}
