//! Activity, release cadence and AI usage computed from git history.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Serialize;

use crate::error::Result;
use crate::git::{Commit, Git};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseStat {
    pub version: String,
    pub shipped: String,
    pub features: u32,
    pub fixes: u32,
    pub lead_days: i64,
    pub ai_pct: u32,
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

pub struct Input<'a> {
    pub repos: Vec<(Git, &'a [String])>,
    pub range_days: i64,
}

pub async fn compute(input: Input<'_>) -> Result<Analytics> {
    let n = input.range_days.max(7);
    let today = Utc::now().date_naive();
    let start = today - Duration::days(n - 1);
    let prev_start = start - Duration::days(n);
    let since = format!("--since={}", (prev_start - Duration::days(1)).format("%Y-%m-%d"));

    let mut commits: Vec<(Commit, bool)> = Vec::new();
    // (tag, date, index into `input.repos` / `ai_sets`)
    let mut tag_dates: Vec<(String, DateTime<Utc>, usize)> = Vec::new();
    let ai_sets: Vec<HashSet<String>> = input.repos.iter().map(|(_, ai)| ai.iter().cloned().collect()).collect();
    let mut merges_now = 0u32;
    let mut merges_prev = 0u32;

    for (repo, (git, _)) in input.repos.iter().enumerate() {
        let ai = &ai_sets[repo];
        let refs: Vec<&str> = vec!["log", "--all", "--no-merges", &since, "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e"];
        let raw = git.run(&refs).await.unwrap_or_default();
        for rec in raw.split('\x1e') {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(6, '\x1f').collect();
            if f.len() == 6 {
                let c = Commit { sha: f[0].into(), author: f[1].into(), email: f[2].into(), date: f[3].into(), subject: f[4].into(), body: f[5].into() };
                let is_ai = ai.contains(&c.sha);
                commits.push((c, is_ai));
            }
        }
        let default = git.default_branch().await.unwrap_or_else(|_| "main".into());
        let merges = git.run(&["log", "--merges", "--format=%aI", &since, &default]).await.unwrap_or_default();
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
    let mut days = Vec::new();
    let mut d = start;
    while d <= today {
        let list = by_day.get(&d).cloned().unwrap_or_default();
        let mut per: BTreeMap<String, u32> = BTreeMap::new();
        for c in &list {
            *per.entry(c.author.clone()).or_default() += 1;
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
        let (git, ai) = (&input.repos[*repo].0, &ai_sets[*repo]);
        let range = match &prev {
            Some(p) => format!("{p}..{name}"),
            None => name.clone(),
        };
        let list = git.log(&range, Some(2000)).await.unwrap_or_default();
        let features = list.iter().filter(|c| c.subject.starts_with("feat")).count() as u32;
        let fixes = list.iter().filter(|c| c.subject.starts_with("fix")).count() as u32;
        let first = list.iter().filter_map(|c| parse_date(&c.date)).min().unwrap_or(*date);
        let ai_n = list.iter().filter(|c| ai.contains(&c.sha)).count();
        stats.push((
            ReleaseStat {
                version: name.clone(),
                shipped: date.format("%b %-d, %Y").to_string(),
                features,
                fixes,
                lead_days: (*date - first).num_days().max(0),
                ai_pct: if list.is_empty() { 0 } else { (ai_n * 100 / list.len()) as u32 },
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

    let ai_share = |from: NaiveDate, to: NaiveDate| {
        let list: Vec<&(Commit, bool)> = commits.iter().filter(|(c, _)| parse_date(&c.date).is_some_and(|d| in_range(&d, from, to))).collect();
        if list.is_empty() {
            None
        } else {
            Some((list.iter().filter(|(_, ai)| *ai).count() * 100 / list.len()) as i64)
        }
    };
    let ai_now = ai_share(start, today);
    let ai_prev = ai_share(prev_start, start - Duration::days(1));

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
                _ => "No release to compare".into(),
            },
        },
        Kpi {
            label: "Merges into main".into(),
            value: merges_now.to_string(),
            delta: format!("{} {period}", signed(merges_now as i64 - merges_prev as i64, "")),
        },
        Kpi {
            label: "AI-written commit messages".into(),
            value: ai_now.map(|p| format!("{p}%")).unwrap_or_else(|| "—".into()),
            delta: match (ai_now, ai_prev) {
                (Some(a), Some(b)) => format!("{} {period}", signed(a - b, " pts")),
                _ => "Tracked from commits made in Gitnetix".into(),
            },
        },
    ];

    let releases = stats.into_iter().rev().take(8).map(|s| s.0).collect::<Vec<_>>().into_iter().rev().collect();
    Ok(Analytics { range_days: n, kpis, days, releases })
}
