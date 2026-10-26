//! Activity, release cadence and AI usage computed from git history.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Serialize;

use crate::error::Result;
use crate::git::{pr_source, Commit, Git, PR_ANY_GREP};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kpi {
    pub label: String,
    pub value: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub date: String,
    pub weekend: bool,
    pub total: u32,
    /// (author, commits), busiest first.
    pub authors: Vec<(String, u32)>,
    pub subjects: Vec<String>,
}

/// A commit of one day, for the day's details.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCommit {
    pub sha: String,
    pub author: String,
    pub subject: String,
    /// Branch it was made on; empty when no branch holds it any more.
    pub branch: String,
    pub project: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStat {
    pub project: String,
    pub version: String,
    pub shipped: String,
    pub features: u32,
    pub fixes: u32,
    pub lead_days: i64,
    /// Whole hours from the first commit to the tag, for finer charts.
    pub lead_hours: i64,
    pub ai_pct: u32,
    pub feature_titles: Vec<String>,
    pub fix_titles: Vec<String>,
    /// Branches merged in since the previous tag, newest first.
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analytics {
    pub range_days: i64,
    pub kpis: Vec<Kpi>,
    pub days: Vec<Day>,
    pub releases: Vec<ReleaseStat>,
}

fn parse_date(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|d| d.with_timezone(&Utc))
}

fn median(mut v: Vec<i64>) -> Option<i64> {
    if v.is_empty() {
        return None;
    }
    v.sort();
    Some(v[v.len() / 2])
}

fn signed(n: i64, unit: &str) -> String {
    match n.cmp(&0) {
        std::cmp::Ordering::Greater => format!("+{n}{unit}"),
        std::cmp::Ordering::Less => format!("−{}{unit}", -n),
        std::cmp::Ordering::Equal => "Same".to_string(),
    }
}

/// Label of each (lowercased email, name) commits were authored under. Identities sharing an email or a
/// name are one person, labelled with all their names: "T1Gu1 / Guillaume Huard Hughes".
fn author_names(commits: &[(Commit, bool)]) -> HashMap<(String, String), String> {
    let mut seen = HashSet::new();
    let mut people: Vec<Vec<(String, String)>> = Vec::new();
    for (c, _) in commits {
        let id = (c.email.to_lowercase(), c.author.clone());
        if !seen.insert(id.clone()) {
            continue;
        }
        let same = |o: &(String, String)| (!id.0.is_empty() && o.0 == id.0) || (!id.1.is_empty() && o.1 == id.1);
        let (same, rest): (Vec<_>, Vec<_>) = people.into_iter().partition(|p| p.iter().any(same));
        let mut person: Vec<_> = same.into_iter().flatten().collect();
        person.push(id);
        people = rest;
        people.push(person);
    }
    let mut out = HashMap::new();
    for person in people {
        let mut names: Vec<&str> = Vec::new();
        for (_, n) in &person {
            if !n.is_empty() && !names.contains(&n.as_str()) {
                names.push(n);
            }
        }
        let label = names.join(" / ");
        out.extend(person.into_iter().map(|id| (id, label.clone())));
    }
    out
}

/// Branch a merge commit took in: `Merge branch 'x' into y`, `Merge remote-tracking branch 'origin/x'`,
/// `Merge pull request #12 from owner/x`.
fn merged_branch(subject: &str) -> Option<&str> {
    let name = match subject.strip_prefix("Merge pull request #") {
        Some(rest) => rest.split_once(" from ")?.1.split_once('/')?.1.trim(),
        None => subject.strip_prefix("Merge branch '").or_else(|| subject.strip_prefix("Merge remote-tracking branch '"))?.split_once('\'')?.0,
    };
    Some(name.strip_prefix("origin/").unwrap_or(name))
}

/// Non-merge commits on any ref, committed since `day` (YYYY-MM-DD).
async fn log_since(git: &Git, day: &str) -> Vec<Commit> {
    let since = format!("--since={day}");
    let raw = git.run(&["log", "--all", "--no-merges", &since, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e"]).await.unwrap_or_default();
    raw.split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(6, '\x1f').collect();
            (f.len() == 6).then(|| Commit { sha: f[0].into(), author: f[1].into(), email: f[2].into(), date: f[3].into(), subject: f[4].into(), body: f[5].into(), tags: Vec::new(), local: false, origin: false, unpulled: false })
        })
        .collect()
}

/// Branch each of `shas` (committed since `day`) was made on. Commits on the default branch's own
/// line name it; others the closest branch holding them, or the branch the merge that took them in names.
async fn branches_of(git: &Git, shas: &[&str], day: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
    let since = format!("--since={day}");
    // `git name-rev` would credit these to any branch forked after them.
    for rev in [default.clone(), format!("origin/{default}")] {
        for sha in git.run(&["rev-list", "--first-parent", &since, &rev, "--"]).await.unwrap_or_default().lines() {
            if shas.contains(&sha) {
                out.insert(sha.to_string(), default.clone());
            }
        }
    }
    let rest: Vec<&str> = shas.iter().copied().filter(|s| !out.contains_key(*s)).collect();
    if rest.is_empty() {
        return out;
    }
    let named = git.run(&[&["name-rev", "--refs=refs/heads/*", "--refs=refs/remotes/origin/*", "--exclude=refs/remotes/origin/HEAD"][..], &rest].concat()).await.unwrap_or_default();
    let mut merges: HashMap<String, Option<String>> = HashMap::new();
    for l in named.lines() {
        let Some((sha, name)) = l.split_once(' ') else { continue };
        if name == "undefined" {
            continue;
        }
        // `feat/y~1^2~1` came in through the merge `feat/y~1`, whose subject names the branch.
        let via = match name.rfind('^') {
            Some(i) => {
                let merge = &name[..i];
                if !merges.contains_key(merge) {
                    let subject = git.run(&["log", "-1", "--format=%s", merge, "--"]).await.unwrap_or_default();
                    merges.insert(merge.to_string(), merged_branch(subject.trim()).map(String::from));
                }
                merges[merge].clone()
            }
            None => None,
        };
        let tip = name.split(['~', '^']).next().unwrap_or(name);
        let tip = tip.strip_prefix("remotes/").unwrap_or(tip);
        out.insert(sha.to_string(), via.unwrap_or_else(|| tip.strip_prefix("origin/").unwrap_or(tip).to_string()));
    }
    out
}

/// Every commit authored on `date` (UTC, as the activity chart counts them), with the branch each was made on.
pub async fn day(repos: Vec<(String, Git)>, date: NaiveDate) -> Vec<DayCommit> {
    let since = (date - Duration::days(1)).format("%Y-%m-%d").to_string();
    let mut out = Vec::new();
    for (project, git) in &repos {
        // Committed no earlier than authored, so this holds every commit authored that day.
        let all: Vec<(Commit, bool)> = log_since(git, &since).await.into_iter().map(|c| (c, false)).collect();
        let names = author_names(&all);
        let list: Vec<&Commit> = all.iter().map(|(c, _)| c).filter(|c| parse_date(&c.date).is_some_and(|d| d.date_naive() == date)).collect();
        let shas: Vec<&str> = list.iter().map(|c| c.sha.as_str()).collect();
        let mut branches = branches_of(git, &shas, &since).await;
        out.extend(list.into_iter().map(|c| DayCommit {
            sha: c.sha.clone(),
            author: names[&(c.email.to_lowercase(), c.author.clone())].clone(),
            subject: c.subject.clone(),
            branch: branches.remove(&c.sha).unwrap_or_default(),
            project: project.clone(),
        }));
    }
    out
}

pub struct Input<'a> {
    /// (project name, its repository, its AI-written commits)
    pub repos: Vec<(String, Git, &'a [String])>,
    pub range_days: i64,
}

pub async fn compute(input: Input<'_>) -> Result<Analytics> {
    let n = input.range_days.max(7);
    let today = Utc::now().date_naive();
    let start = today - Duration::days(n - 1);
    let prev_start = start - Duration::days(n);
    let since_day = (prev_start - Duration::days(1)).format("%Y-%m-%d").to_string();
    let since = format!("--since={since_day}");

    let mut commits: Vec<(Commit, bool)> = Vec::new();
    // (tag, date, index into `input.repos` / `ai_sets`)
    let mut tag_dates: Vec<(String, DateTime<Utc>, usize)> = Vec::new();
    let ai_sets: Vec<HashSet<String>> = input.repos.iter().map(|(_, _, ai)| ai.iter().cloned().collect()).collect();
    let mut defaults: Vec<String> = Vec::new();
    let mut merges_now = 0u32;
    let mut merges_prev = 0u32;

    for (repo, (_, git, _)) in input.repos.iter().enumerate() {
        let ai = &ai_sets[repo];
        for c in log_since(git, &since_day).await {
            let is_ai = ai.contains(&c.sha);
            commits.push((c, is_ai));
        }
        let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
        // Merges into main and into release branches; one log walk counts each merge once.
        // Pull requests squashed in (`Merged PR 12: …`) count as merges too.
        let targets = [&since, default.as_str(), "--branches=release/*", "--remotes=origin/release/*"];
        let mut merges = git.run(&[&["log", "--merges", "--format=%aI"][..], &targets].concat()).await.unwrap_or_default();
        merges += &git.run(&[&["log", "--no-merges", "-E", PR_ANY_GREP, "--format=%aI"][..], &targets].concat()).await.unwrap_or_default();
        for l in merges.lines() {
            if let Some(d) = parse_date(l.trim()) {
                let day = d.date_naive();
                if day >= start {
                    merges_now += 1;
                } else if day >= prev_start {
                    merges_prev += 1;
                }
            }
        }
        defaults.push(default);
        for t in git.tags().await.unwrap_or_default() {
            if let Some(d) = parse_date(&t.date) {
                tag_dates.push((t.name, d, repo));
            }
        }
    }

    // ---- daily activity ----
    let mut by_day: BTreeMap<NaiveDate, Vec<&Commit>> = BTreeMap::new();
    for (c, _) in &commits {
        if let Some(d) = parse_date(&c.date) {
            by_day.entry(d.date_naive()).or_default().push(c);
        }
    }
    let names = author_names(&commits);
    let mut days = Vec::new();
    let mut d = start;
    while d <= today {
        let list = by_day.get(&d).cloned().unwrap_or_default();
        let mut per: BTreeMap<String, u32> = BTreeMap::new();
        for c in &list {
            *per.entry(names[&(c.email.to_lowercase(), c.author.clone())].clone()).or_default() += 1;
        }
        let mut authors: Vec<(String, u32)> = per.into_iter().collect();
        authors.sort_by_key(|a| std::cmp::Reverse(a.1));
        use chrono::Datelike;
        let wd = d.weekday().number_from_monday();
        days.push(Day {
            date: d.format("%Y-%m-%d").to_string(),
            weekend: wd >= 6,
            total: list.len() as u32,
            authors,
            subjects: list.iter().take(3).map(|c| c.subject.clone()).collect(),
        });
        d += Duration::days(1);
    }

    // ---- releases (tags) ----
    tag_dates.sort_by_key(|t| t.1);
    // Only tags in the two compared periods and the last 8 shown are used.
    let keep_from = tag_dates.len().saturating_sub(8);
    let mut prev_tag: HashMap<usize, &str> = HashMap::new();
    let mut stats: Vec<(ReleaseStat, DateTime<Utc>)> = Vec::new();
    for (i, (name, date, repo)) in tag_dates.iter().enumerate() {
        let prev = prev_tag.insert(*repo, name);
        if i < keep_from && date.date_naive() < prev_start {
            continue;
        }
        let (project, git, _) = &input.repos[*repo];
        let ai = &ai_sets[*repo];
        let range = match &prev {
            Some(p) => format!("{p}..{name}"),
            None => name.clone(),
        };
        let list = git.log(&range, Some(2000)).await.unwrap_or_default();
        let titles = |kind: &str| list.iter().filter(|c| c.subject.starts_with(kind)).map(|c| c.subject.clone()).collect::<Vec<_>>();
        let (feature_titles, fix_titles) = (titles("feat"), titles("fix"));
        let mut branches: Vec<String> = Vec::new();
        for b in list.iter().filter_map(|c| merged_branch(&c.subject).or_else(|| pr_source(&c.subject))) {
            // Syncing the default branch into a feature is no branch shipped.
            if b != defaults[*repo] && !branches.iter().any(|x| x == b) {
                branches.push(b.to_string());
            }
        }
        let first = list.iter().filter_map(|c| parse_date(&c.date)).min().unwrap_or(*date);
        let ai_n = list.iter().filter(|c| ai.contains(&c.sha)).count();
        stats.push((
            ReleaseStat {
                project: project.clone(),
                version: name.clone(),
                shipped: date.format("%b %-d, %Y").to_string(),
                features: feature_titles.len() as u32,
                fixes: fix_titles.len() as u32,
                lead_days: (*date - first).num_days().max(0),
                lead_hours: (*date - first).num_hours().max(0),
                ai_pct: if list.is_empty() { 0 } else { (ai_n * 100 / list.len()) as u32 },
                feature_titles,
                fix_titles,
                branches,
            },
            *date,
        ));
    }

    let in_range = |d: &DateTime<Utc>, from: NaiveDate, to: NaiveDate| {
        let x = d.date_naive();
        x >= from && x <= to
    };
    let shipped_now: Vec<&(ReleaseStat, DateTime<Utc>)> = stats.iter().filter(|s| in_range(&s.1, start, today)).collect();
    let shipped_prev: Vec<&(ReleaseStat, DateTime<Utc>)> =
        stats.iter().filter(|s| in_range(&s.1, prev_start, start - Duration::days(1))).collect();
    let lead_now = median(shipped_now.iter().map(|s| s.0.lead_days).collect());
    let lead_prev = median(shipped_prev.iter().map(|s| s.0.lead_days).collect());

    let count_commits = |from: NaiveDate, to: NaiveDate| commits.iter().filter(|(c, _)| parse_date(&c.date).is_some_and(|d| in_range(&d, from, to))).count() as i64;
    let commits_now = count_commits(start, today);
    let commits_prev = count_commits(prev_start, start - Duration::days(1));

    let period = format!("vs previous {n} days");
    let kpis = vec![
        Kpi {
            label: "Releases shipped".into(),
            value: shipped_now.len().to_string(),
            delta: format!("{} {period}", signed(shipped_now.len() as i64 - shipped_prev.len() as i64, "")),
        },
        Kpi {
            label: "Median lead time".into(),
            value: lead_now.map(|d| format!("{d} d")).unwrap_or_else(|| "—".into()),
            delta: match (lead_now, lead_prev) {
                (Some(a), Some(b)) => format!("{} {period}", signed(a - b, " d")),
                (None, _) => format!("No release in last {n} days"),
                (Some(_), None) => format!("No release to compare in previous {n} days"),
            },
        },
        Kpi {
            label: "Merges into main and releases".into(),
            value: merges_now.to_string(),
            delta: format!("{} {period}", signed(merges_now as i64 - merges_prev as i64, "")),
        },
        Kpi {
            label: "Total commits".into(),
            value: commits_now.to_string(),
            delta: format!("{} {period}", signed(commits_now - commits_prev, "")),
        },
    ];

    let releases = stats.into_iter().rev().take(8).map(|s| s.0).collect::<Vec<_>>().into_iter().rev().collect();
    Ok(Analytics { range_days: n, kpis, days, releases })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(author: &str, email: &str) -> (Commit, bool) {
        let c = Commit { sha: String::new(), author: author.into(), email: email.into(), date: String::new(), subject: String::new(), body: String::new(), tags: Vec::new(), local: false, origin: false, unpulled: false };
        (c, false)
    }

    #[test]
    fn authors_grouped_by_email_or_name() {
        let commits = [
            commit("T1Gu1", "g@x.com"),
            commit("Guillaume", "G@x.com"),
            commit("T1Gu1", "g@x.com"),
            commit("Guillaume", "g@work.com"),
            commit("Gui", "g@work.com"),
            commit("Bot", ""),
            commit("Ann", ""),
            commit("A", "a@y.com"),
            commit("B", "b@y.com"),
            commit("A", "b@y.com"),
        ];
        let names = author_names(&commits);
        let label = |email: &str, name: &str| names[&(email.to_string(), name.to_string())].as_str();
        assert_eq!(names.len(), 9);
        for (email, name) in [("g@x.com", "T1Gu1"), ("g@x.com", "Guillaume"), ("g@work.com", "Guillaume"), ("g@work.com", "Gui")] {
            assert_eq!(label(email, name), "T1Gu1 / Guillaume / Gui");
        }
        // No email in common, so not merged.
        assert_eq!(label("", "Bot"), "Bot");
        assert_eq!(label("", "Ann"), "Ann");
        // "A <b@y.com>" ties two people into one.
        assert_eq!(label("a@y.com", "A"), "A / B");
        assert_eq!(label("b@y.com", "B"), "A / B");
    }

    #[test]
    fn merged_branch_names() {
        assert_eq!(merged_branch("Merge branch 'feat/x'"), Some("feat/x"));
        assert_eq!(merged_branch("Merge branch 'feat/x' into release/1.2"), Some("feat/x"));
        assert_eq!(merged_branch("Merge remote-tracking branch 'origin/fix/y'"), Some("fix/y"));
        assert_eq!(merged_branch("Merge pull request #12 from acme/feat/z"), Some("feat/z"));
        assert_eq!(merged_branch("feat: merge branch support"), None);
    }

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let ok = std::process::Command::new("git").current_dir(dir).args(["-c", "user.name=A", "-c", "user.email=a@x", "-c", "commit.gpgsign=false"]).args(args).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    #[tokio::test]
    async fn branch_each_commit_was_made_on() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        sh(dir, &["init", "-q", "-b", "main"]);
        let commit = |m: &str| sh(dir, &["commit", "-q", "--allow-empty", "-m", m]);
        commit("base");
        commit("main direct");
        sh(dir, &["switch", "-qc", "feat/x"]);
        commit("feat: x");
        sh(dir, &["switch", "-q", "main"]);
        sh(dir, &["merge", "-q", "--no-ff", "feat/x", "-m", "Merge branch 'feat/x'"]);
        sh(dir, &["branch", "-qD", "feat/x"]);
        commit("Merged PR 12: fix/z");
        sh(dir, &["switch", "-qc", "feat/y"]);
        commit("feat: y");

        let today = Utc::now().date_naive();
        let got = day(vec![("atlas".into(), Git::new(dir))], today).await;
        let branch = |s: &str| got.iter().find(|c| c.subject == s).map(|c| c.branch.as_str());
        // feat/y forked after it, still made on main.
        assert_eq!(branch("main direct"), Some("main"));
        assert_eq!(branch("Merged PR 12: fix/z"), Some("main"));
        // Deleted once merged: named by its merge.
        assert_eq!(branch("feat: x"), Some("feat/x"));
        assert_eq!(branch("feat: y"), Some("feat/y"));
        assert!(got.iter().all(|c| c.project == "atlas" && c.author == "A"));
    }
}
