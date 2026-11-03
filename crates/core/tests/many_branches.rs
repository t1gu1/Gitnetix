//! A repo with 500 branches: how long its branch views take, cold, warm and after refs move.
//! Run: cargo test --release -p gitnetix-core --test many_branches -- --ignored --nocapture
//! With `MANY_BRANCHES_REPO=<new dir>` it only builds the repo there, to open in the app.

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use gitnetix_core::{rpc, Gitnetix};
use serde_json::{json, Value};

/// Plain commits on main.
const MAIN: usize = 2000;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Open,
    Merged,
    Squashed,
}

struct Branch {
    name: String,
    kind: Kind,
    /// Main commit it forked from, and the one after which it landed.
    fork: usize,
    land: usize,
    commits: usize,
    local: bool,
    /// Origin is one commit behind the local branch.
    unpushed: bool,
}

/// The 500 branches: work in progress, merged by merge commit, squashed by a pull request; some only on origin.
fn branches() -> Vec<Branch> {
    let mut seed = 42u64;
    let mut rnd = |n: usize| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize % n
    };
    let mix = [(Kind::Open, 150, true), (Kind::Merged, 150, true), (Kind::Squashed, 120, true), (Kind::Open, 40, false), (Kind::Merged, 20, false), (Kind::Squashed, 20, false)];
    let mut out = Vec::new();
    for (kind, n, local) in mix {
        for _ in 0..n {
            let i = out.len();
            let fork = match kind {
                Kind::Open => MAIN - 400 + rnd(399),
                _ => rnd(MAIN - 50),
            };
            let prefix = ["feature", "fix", "chore"][i % 3];
            out.push(Branch { name: format!("{prefix}/ABC-{i}-change-{i}"), kind, fork, land: fork + 1 + rnd(40), commits: 1 + rnd(6), local, unpushed: local && kind == Kind::Open && i % 7 == 0 });
        }
    }
    out
}

/// `git fast-import` input, one mark per commit.
struct Stream {
    out: Vec<u8>,
    mark: usize,
    time: i64,
}

impl Stream {
    fn commit(&mut self, r: &str, from: Option<usize>, merge: Option<usize>, msg: &str, path: &str, body: &str) -> usize {
        self.mark += 1;
        self.time += 600;
        let (m, t) = (self.mark, self.time);
        write!(self.out, "commit {r}\nmark :{m}\nauthor Dev <dev@example.com> {t} +0000\ncommitter Dev <dev@example.com> {t} +0000\ndata {}\n{msg}\n", msg.len()).unwrap();
        if let Some(f) = from {
            writeln!(self.out, "from :{f}").unwrap();
        }
        if let Some(b) = merge {
            writeln!(self.out, "merge :{b}").unwrap();
        }
        write!(self.out, "M 100644 inline {path}\ndata {}\n{body}\n\n", body.len()).unwrap();
        m
    }
}

fn git(dir: &Path, args: &[&str], input: Option<&[u8]>) -> String {
    let mut child = Command::new("git").current_dir(dir).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(input.unwrap_or_default()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap()
}

/// Build the repo: main's history, each branch's commits and its landing, then the refs with reflogs and upstreams.
fn build(repo: &Path, list: &[Branch]) {
    std::fs::create_dir_all(repo).unwrap();
    git(repo, &["init", "-q", "-b", "main"], None);
    let mut s = Stream { out: Vec::new(), mark: 0, time: 1_700_000_000 };
    let mut main = None;
    // Per branch: the main commit it forked from, then its own commits' marks.
    let mut marks: Vec<Vec<usize>> = list.iter().map(|_| Vec::new()).collect();
    let body = |b: &Branch, n: usize| (0..n).map(|j| format!("{} line {j}\n", b.name)).collect::<String>();
    for slot in 0..MAIN {
        main = Some(s.commit("refs/heads/main", main, None, &format!("Main change {slot}"), &format!("core/{}.txt", slot % 40), &format!("{slot}\n")));
        for (i, b) in list.iter().enumerate() {
            let path = format!("work/{i}.txt");
            if b.fork == slot {
                marks[i].push(main.unwrap());
                for j in 0..b.commits {
                    let from = if j == 0 { main } else { None };
                    marks[i].push(s.commit(&format!("refs/sim/{i}"), from, None, &format!("ABC-{i}: step {j}"), &path, &body(b, j + 1)));
                }
            }
            if b.land == slot && b.kind != Kind::Open {
                let content = body(b, b.commits);
                let tip = *marks[i].last().unwrap();
                main = Some(match b.kind {
                    Kind::Merged => s.commit("refs/heads/main", main, Some(tip), &format!("Merge pull request #{i} from org/{}", b.name), &path, &content),
                    _ => s.commit("refs/heads/main", main, None, &format!("ABC-{i}: change {i} (#{i})"), &path, &content),
                });
            }
        }
    }
    let marks_file = repo.join(".git/sim-marks");
    git(repo, &["fast-import", "--quiet", &format!("--export-marks={}", marks_file.display())], Some(&s.out));
    let sha: HashMap<usize, String> = std::fs::read_to_string(&marks_file)
        .unwrap()
        .lines()
        .filter_map(|l| {
            let (m, sha) = l.split_once(' ')?;
            Some((m.trim_start_matches(':').parse().ok()?, sha.to_string()))
        })
        .collect();
    // Created at the fork, then moved to the tip: reflogs like `git switch -c` and commits leave.
    let main_sha = &sha[&main.unwrap()];
    let mut created = format!("create refs/remotes/origin/main {main_sha}\n");
    let mut moved = String::new();
    for (i, b) in list.iter().enumerate() {
        let tip = &sha[marks[i].last().unwrap()];
        let pushed = if b.unpushed { &sha[&marks[i][marks[i].len() - 2]] } else { tip };
        created += &format!("create refs/remotes/origin/{} {pushed}\ndelete refs/sim/{i}\n", b.name);
        if b.local {
            created += &format!("create refs/heads/{} {}\n", b.name, sha[&marks[i][0]]);
            moved += &format!("update refs/heads/{} {tip}\n", b.name);
        }
    }
    git(repo, &["update-ref", "--stdin", "-m", "branch: Created from main"], Some(created.as_bytes()));
    git(repo, &["update-ref", "--stdin", "-m", "commit: step"], Some(moved.as_bytes()));
    git(repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], None);
    let mut config = String::from("[remote \"origin\"]\n\turl = /nonexistent/origin.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n");
    for b in list.iter().filter(|b| b.local) {
        config += &format!("[branch \"{}\"]\n\tremote = origin\n\tmerge = refs/heads/{}\n", b.name, b.name);
    }
    std::fs::OpenOptions::new().append(true).open(repo.join(".git/config")).unwrap().write_all(config.as_bytes()).unwrap();
    git(repo, &["reset", "-q", "--hard"], None);
}

async fn call(k: &Gitnetix, m: &str, p: Value) -> Value {
    match rpc::call(k, m, p).await {
        Ok(v) => v,
        Err(e) => panic!("{m}: {e}"),
    }
}

/// One overview, timed, with what it rebuilt (from the Logs) when it said.
async fn timed(k: &Gitnetix, pid: &str, label: &str, quick: bool) -> Value {
    let seen = gitnetix_core::log::all().len();
    let started = Instant::now();
    let v = call(k, "workspace.overview", json!({ "projectId": pid, "quick": quick })).await;
    let ms = started.elapsed().as_millis();
    let said = gitnetix_core::log::all().into_iter().skip(seen).filter(|e| e.text.starts_with("Branches of")).map(|e| e.text).collect::<Vec<_>>().join("; ");
    println!("{label:<28} {ms:>6} ms  {said}");
    v
}

fn merged_names(v: &Value) -> Vec<String> {
    let mut names: Vec<String> = v["branches"].as_array().unwrap().iter().filter(|b| b["merged"] == true).map(|b| b["name"].as_str().unwrap().to_string()).collect();
    names.sort();
    names
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "benchmark: builds a 500-branch repo"]
async fn five_hundred_branches() {
    let list = branches();
    // Only build the repo, there, to open it in the app.
    if let Ok(dir) = std::env::var("MANY_BRANCHES_REPO") {
        return build(Path::new(&dir), &list);
    }
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let started = Instant::now();
    build(&repo, &list);
    println!("built repo: {} branches, {} commits on main, in {} ms", list.len(), git(&repo, &["rev-list", "--count", "main"], None).trim(), started.elapsed().as_millis());

    let home = tmp.path().join("home");
    let k = Gitnetix::open(&home).unwrap();
    let added = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await;
    let pid = added[0]["id"].as_str().unwrap().to_string();

    timed(&k, &pid, "first look (quick)", true).await;
    let cold = timed(&k, &pid, "first build", false).await;
    timed(&k, &pid, "again, nothing moved", false).await;

    // Right: every branch listed, landed ones merged and work in progress not.
    let mut want: Vec<String> = list.iter().filter(|b| b.kind != Kind::Open).map(|b| b.name.clone()).collect();
    want.sort();
    assert_eq!(cold["branches"].as_array().unwrap().len(), list.len() + 1);
    assert_eq!(merged_names(&cold), want);

    drop(k);
    let k = Gitnetix::open(&home).unwrap();
    timed(&k, &pid, "app restart, nothing moved", false).await;

    // A commit on one branch in progress.
    let one = &list.iter().find(|b| b.kind == Kind::Open && b.local).unwrap().name;
    let sha = git(&repo, &["commit-tree", &format!("{one}^{{tree}}"), "-p", one, "-m", "more"], None);
    git(&repo, &["update-ref", &format!("refs/heads/{one}"), sha.trim()], None);
    timed(&k, &pid, "one branch moved", false).await;

    // Pulls: main and origin/main gain a change, every branch is weighed again.
    for label in ["main moved (pull)", "main moved again"] {
        std::fs::write(repo.join("core/pulled.txt"), label).unwrap();
        git(&repo, &["add", "."], None);
        git(&repo, &["-c", "user.name=Dev", "-c", "user.email=dev@example.com", "commit", "-qm", "pulled"], None);
        git(&repo, &["update-ref", "refs/remotes/origin/main", "main"], None);
        let pulled = timed(&k, &pid, label, false).await;
        assert_eq!(merged_names(&pulled), want);
    }
}
