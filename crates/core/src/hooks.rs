//! Terminal commands a project runs at moments Gitnetix makes happen (a branch created, a worktree removed…), set on
//! the project's Hooks page. Each line runs on its own in the user's login shell, with `GITNETIX_*` variables naming
//! what happened; its output goes to the Logs, and the moment's last run shows on the Hooks page.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::store::Project;

/// Each moment's id (a key of `Project::hooks`) and how the Logs name it. Keep in step with the UI's MOMENTS.
pub const MOMENTS: &[(&str, &str)] = &[
    ("branchCreated", "branch created"),
    ("branchSwitched", "branch switched"),
    ("branchMerged", "branch merged"),
    ("branchDeleted", "branch deleted"),
    ("worktreeCreated", "worktree created"),
    ("worktreeRemoved", "worktree removed"),
    ("releaseCreated", "release created"),
    ("releasePublished", "release published"),
];

/// A command running longer is stopped: a hook waited for (a worktree's removal) never holds the app forever.
const COMMAND_MAX: Duration = Duration::from_secs(600);
/// Each command's output kept for the Hooks page and the Logs: its end, where errors are.
const OUTPUT_MAX: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Hook {
    /// Command lines, run one after the other.
    pub commands: Vec<String>,
    /// The next commands still run after one fails. Else the hook stops there, and a worktree's removal is called off.
    pub keep_going: bool,
    /// Kept but not run.
    pub off: bool,
}

/// One command of a run: its line, what it printed (stdout then stderr, the end only), and its exit code (None: it
/// could not start or ran too long; `output` says which).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub command: String,
    pub output: String,
    pub code: Option<i32>,
}

impl Step {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

/// A moment's last run: when, for which branch, whether every command it ran passed, and each command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub at: String,
    pub branch: String,
    pub ok: bool,
    pub steps: Vec<Step>,
}

/// The `GITNETIX_*` variables of a run, without the prefix: ("BRANCH", "feat/login").
pub type Vars = Vec<(&'static str, String)>;

/// Last run of each (project id, moment) since the app started.
static RUNS: Mutex<Option<HashMap<(String, String), Run>>> = Mutex::new(None);

/// The project's last run of each moment since the app started, by moment.
pub fn runs(project_id: &str) -> BTreeMap<String, Run> {
    let runs = RUNS.lock().unwrap_or_else(|e| e.into_inner());
    runs.iter().flatten().filter(|((p, _), _)| p == project_id).map(|((_, m), r)| (m.clone(), r.clone())).collect()
}

/// `p`'s hook for `moment` when it is on and has a command.
pub fn live(p: &Project, moment: &str) -> Option<Hook> {
    p.hooks.get(moment).filter(|h| !h.off && h.commands.iter().any(|c| !c.trim().is_empty())).cloned()
}

/// Runs `p`'s hook for `moment` once per `each` (the variables of one branch), one run after the other, alongside
/// whatever called it: returns at once. Nothing when the hook is off or empty.
pub fn spawn(p: &Project, moment: &'static str, cwd: &Path, each: Vec<Vars>) {
    let Some(hook) = live(p, moment) else { return };
    let (id, name, cwd) = (p.id.clone(), p.name.clone(), cwd.to_path_buf());
    tokio::spawn(async move {
        for vars in each {
            run(&id, &name, moment, &hook, &cwd, &vars).await;
        }
    });
}

/// Runs `p`'s hook for `moment` and waits for it. Err (naming the command) when one failed and the hook stops on
/// failure; Ok when it passed, kept going, or there is none.
pub async fn wait(p: &Project, moment: &'static str, cwd: &Path, vars: Vars) -> crate::error::Result<()> {
    let Some(hook) = live(p, moment) else { return Ok(()) };
    let run = run(&p.id, &p.name, moment, &hook, cwd, &vars).await;
    match run.steps.iter().find(|s| !s.ok()) {
        Some(s) if !hook.keep_going => Err(crate::error::Error::Invalid(format!("The {} hook failed on `{}`: {}", label(moment), s.command, last_line(&s.output)))),
        _ => Ok(()),
    }
}

fn label(moment: &str) -> &str {
    MOMENTS.iter().find(|(m, _)| *m == moment).map_or(moment, |(_, l)| l)
}

fn last_line(s: &str) -> &str {
    s.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output").trim()
}

/// Runs each command of `hook` in `cwd`, logs each, and keeps the run as the moment's last.
async fn run(project_id: &str, project: &str, moment: &str, hook: &Hook, cwd: &Path, vars: &Vars) -> Run {
    // Read once, so the commands find what the user's profile puts on PATH.
    crate::project_commands::login_dirs().await;
    let branch = vars.iter().find(|(k, _)| *k == "BRANCH").map(|(_, v)| v.clone()).unwrap_or_default();
    let mut steps = Vec::new();
    for line in hook.commands.iter().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        let step = command(line, cwd, vars).await;
        let what = format!("{project}, {} hook{}: `{line}`", label(moment), if branch.is_empty() { String::new() } else { format!(" for {branch}") });
        let out = if step.output.trim().is_empty() { String::new() } else { format!("\n{}", step.output.trim_end()) };
        match step.code {
            Some(0) => crate::log::info(format!("{what} passed{out}")),
            Some(c) => crate::log::error(format!("{what} exited with {c}{out}")),
            None => crate::log::error(format!("{what} did not run{out}")),
        }
        let stop = !step.ok() && !hook.keep_going;
        steps.push(step);
        if stop {
            break;
        }
    }
    let run = Run { at: crate::store::now(), branch, ok: steps.iter().all(Step::ok), steps };
    RUNS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert((project_id.into(), moment.into()), run.clone());
    crate::log::emit(crate::events::Event::HookRan { project_id: project_id.into() });
    run
}

/// One command line through the user's shell, in `cwd`, with no input.
async fn command(line: &str, cwd: &Path, vars: &Vars) -> Step {
    let mut cmd = shell(line);
    cmd.current_dir(cwd).stdin(Stdio::null()).kill_on_drop(true);
    for (k, v) in vars {
        cmd.env(format!("GITNETIX_{k}"), v);
    }
    crate::shell::without_appimage(cmd.as_std_mut());
    crate::shell::with_login_path(cmd.as_std_mut());
    let (output, code) = match tokio::time::timeout(COMMAND_MAX, cmd.output()).await {
        Ok(Ok(out)) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            // A signal leaves no code: counted as a failure.
            (text, Some(out.status.code().unwrap_or(-1)))
        }
        Ok(Err(e)) => (format!("Could not start: {e}"), None),
        Err(_) => (format!("Stopped after {} minutes", COMMAND_MAX.as_secs() / 60), None),
    };
    Step { command: line.into(), output: tail(&output), code }
}

/// The user's login shell running `line`: the passwd entry decides, as for the terminal. cmd.exe on Windows.
fn shell(line: &str) -> tokio::process::Command {
    #[cfg(unix)]
    {
        let mut b = portable_pty::CommandBuilder::new_default_prog();
        b.env_remove("SHELL");
        let mut cmd = tokio::process::Command::new(b.get_shell());
        cmd.args(["-c", line]);
        cmd
    }
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
        // As Rust's docs advise for cmd.exe: /S strips the outer quotes and keeps the line as typed.
        cmd.args(["/D", "/S", "/C"]);
        std::os::windows::process::CommandExt::raw_arg(cmd.as_std_mut(), format!("\"{line}\""));
        cmd
    }
}

/// The end of `s`, at most [`OUTPUT_MAX`] bytes, cut on a character boundary.
fn tail(s: &str) -> String {
    if s.len() <= OUTPUT_MAX {
        return s.into();
    }
    let mut from = s.len() - OUTPUT_MAX;
    while !s.is_char_boundary(from) {
        from += 1;
    }
    format!("…{}", &s[from..])
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn project(moment: &str, commands: &[&str], keep_going: bool) -> Project {
        let hook = Hook { commands: commands.iter().map(|c| c.to_string()).collect(), keep_going, off: false };
        Project { id: format!("p-{moment}-{keep_going}"), name: "demo".into(), hooks: BTreeMap::from([(moment.to_string(), hook)]), ..Default::default() }
    }

    #[tokio::test]
    async fn each_line_runs_in_the_folder_with_the_moments_variables() {
        let dir = tempfile::tempdir().unwrap();
        let p = project("branchCreated", &["echo \"$GITNETIX_BRANCH\" > made.txt", "", "  pwd >> made.txt"], false);
        wait(&p, "branchCreated", dir.path(), vec![("BRANCH", "feat/x".into())]).await.unwrap();
        let made = std::fs::read_to_string(dir.path().join("made.txt")).unwrap();
        let here = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(made, format!("feat/x\n{}\n", here.display()));
        let run = &runs(&p.id)["branchCreated"];
        assert!(run.ok);
        assert_eq!(run.branch, "feat/x");
        assert_eq!(run.steps.len(), 2, "blank lines are skipped");
    }

    #[tokio::test]
    async fn a_failing_command_stops_the_rest_unless_the_hook_keeps_going() {
        let dir = tempfile::tempdir().unwrap();
        let stops = project("worktreeRemoved", &["echo nope >&2; exit 3", "touch after"], false);
        let err = wait(&stops, "worktreeRemoved", dir.path(), Vec::new()).await.unwrap_err().to_string();
        assert!(err.contains("exit 3") && err.contains("nope"), "{err}");
        assert!(!dir.path().join("after").exists());
        let run = &runs(&stops.id)["worktreeRemoved"];
        assert_eq!((run.ok, run.steps.len(), run.steps[0].code), (false, 1, Some(3)));

        let goes_on = project("worktreeRemoved", &["exit 3", "touch after"], true);
        wait(&goes_on, "worktreeRemoved", dir.path(), Vec::new()).await.unwrap();
        assert!(dir.path().join("after").exists());
        assert!(!runs(&goes_on.id)["worktreeRemoved"].ok);
    }

    #[tokio::test]
    async fn a_hook_turned_off_or_empty_does_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let mut p = project("branchDeleted", &["touch ran"], false);
        p.hooks.get_mut("branchDeleted").unwrap().off = true;
        wait(&p, "branchDeleted", dir.path(), Vec::new()).await.unwrap();
        let empty = project("branchDeleted", &["  "], false);
        wait(&empty, "branchDeleted", dir.path(), Vec::new()).await.unwrap();
        assert!(!dir.path().join("ran").exists());
        assert!(runs(&p.id).is_empty() && runs(&empty.id).is_empty());
    }

    #[test]
    fn long_output_keeps_its_end() {
        let s = format!("{}é{}", "a".repeat(OUTPUT_MAX), "b".repeat(10));
        let t = tail(&s);
        assert!(t.ends_with("bbbbbbbbbb") && t.len() <= OUTPUT_MAX + "…".len() + 1);
    }
}
