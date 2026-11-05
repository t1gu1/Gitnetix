//! Sprint stats from Jira tickets (velocity, burndown, hours left over, completion per person, time from start
//! to done), and tickets done per week from any tracker.

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::Serialize;

use crate::tickets::{DoneTicket, Sprint, SprintIssue};

/// An amount of work, counted three ways.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Work {
    pub tickets: f64,
    pub points: f64,
    /// Original estimate, in hours.
    pub hours: f64,
}

impl Work {
    fn of(i: &SprintIssue) -> Work {
        Work { tickets: 1.0, points: i.points.unwrap_or(0.0), hours: i.estimate.unwrap_or(0.0) }
    }

    /// `num / den` of it, multiplied first so whole shares stay exact.
    fn part(self, num: f64, den: f64) -> Work {
        Work { tickets: self.tickets * num / den, points: self.points * num / den, hours: self.hours * num / den }
    }
}

impl std::ops::AddAssign for Work {
    fn add_assign(&mut self, o: Work) {
        self.tickets += o.tickets;
        self.points += o.points;
        self.hours += o.hours;
    }
}

impl std::ops::Sub for Work {
    type Output = Work;
    fn sub(self, o: Work) -> Work {
        Work { tickets: self.tickets - o.tickets, points: self.points - o.points, hours: self.hours - o.hours }
    }
}

impl std::iter::Sum for Work {
    fn sum<I: Iterator<Item = Work>>(it: I) -> Work {
        let mut w = Work::default();
        for x in it {
            w += x;
        }
        w
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub committed: Work,
    pub completed: Work,
    /// Remaining estimate of their tickets not completed, in hours.
    pub left_hours: f64,
    pub bugs_fixed: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindStat {
    /// Story, Bug, Task…
    pub name: String,
    pub committed: Work,
    pub completed: Work,
}

/// One day of a burndown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BurnDay {
    /// YYYY-MM-DD, UTC.
    pub date: String,
    pub weekend: bool,
    /// Work not done yet at the end of the day, and all the work in the sprint then; None on days still to come.
    pub remaining: Option<Work>,
    pub scope: Option<Work>,
    /// Work left if the work there at the start burned evenly over the working days.
    pub ideal: Work,
    /// Keys of the tickets completed that day.
    pub done: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SprintTicket {
    pub key: String,
    pub title: String,
    pub url: String,
    pub kind: String,
    pub bug: bool,
    pub assignee: String,
    pub status: &'static str,
    pub status_label: String,
    /// Completed in this sprint.
    pub completed: bool,
    /// Dropped in this sprint ("Annulé"): out of its numbers.
    pub cancelled: bool,
    /// Came from an earlier sprint.
    pub carried: bool,
    /// Not completed and went on to a later sprint.
    pub moved: bool,
    /// Created after the sprint started.
    pub added: bool,
    pub points: Option<f64>,
    pub estimate: Option<f64>,
    pub remaining: Option<f64>,
    /// Day it was completed, YYYY-MM-DD.
    pub done_at: Option<String>,
    /// When work on it started: its first move to an in-progress, review or ready status (RFC 3339).
    pub started_at: Option<String>,
    /// Hours from that start to done, for a ticket completed here; hours since it, for one still open.
    pub cycle_hours: Option<f64>,
    pub age_hours: Option<f64>,
    /// Hours spent in each status after the start, by status (progress, review, ready, todo when sent back).
    pub stages: BTreeMap<&'static str, f64>,
    /// Commits and branches about it, in the projects its Jira connection shows in; filled in by the app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<TicketCode>,
}

/// The code a ticket got: commits naming it, and the commits of branches named after it.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCode {
    /// Newest first.
    pub commits: Vec<TicketCommit>,
    pub branches: Vec<TicketBranch>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCommit {
    pub sha: String,
    /// Author date, RFC 3339.
    pub date: String,
    pub author: String,
    pub subject: String,
    /// The branch it came through; empty when only its message names the ticket.
    pub branch: String,
    pub project: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketBranch {
    pub name: String,
    pub project: String,
    pub project_id: String,
    /// Still there; false for one deleted once merged.
    pub live: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SprintStat {
    pub id: u64,
    pub name: String,
    /// active | closed
    pub state: String,
    pub goal: String,
    /// YYYY-MM-DD, UTC: start, planned end and the day it closed.
    pub start: String,
    pub end: String,
    pub complete: Option<String>,
    /// Working days (Monday to Friday) in it, and those begun so far.
    pub workdays: u32,
    pub workdays_done: u32,
    pub committed: Work,
    /// The sprint's velocity.
    pub completed: Work,
    /// Work there from the start, work created after it started, and work that came from an earlier sprint.
    pub scope_start: Work,
    pub added: Work,
    pub carried: Work,
    /// Original and remaining estimate of the tickets not completed, in hours.
    pub left_estimate: f64,
    pub left_remaining: f64,
    pub bugs: u32,
    pub bugs_fixed: u32,
    /// Tickets dropped in it ("Annulé", "Won't Do"), left out of its numbers.
    pub cancelled: u32,
    /// Tickets with no story points, with no estimate, with no one assigned.
    pub no_points: u32,
    pub no_estimate: u32,
    pub unassigned: u32,
    /// Tickets per status now: todo, progress, review, ready, done.
    pub status: BTreeMap<&'static str, u32>,
    /// Hours from start to done that half, and 85%, of the tickets completed here took at most.
    pub cycle_median: Option<f64>,
    pub cycle_p85: Option<f64>,
    /// Most completed first.
    pub people: Vec<Person>,
    /// Most committed first.
    pub kinds: Vec<KindStat>,
    pub burndown: Vec<BurnDay>,
    pub tickets: Vec<SprintTicket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    /// `<connection id>:<board id>`.
    pub id: String,
    pub name: String,
    /// The Jira site it is on.
    pub site: String,
    /// Oldest first.
    pub sprints: Vec<SprintStat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// Jira connections shown in the chosen projects.
    pub connections: usize,
    /// The one with a sprint running and the most tickets first.
    pub boards: Vec<Board>,
    /// Some ticket has story points; some has an estimate.
    pub points: bool,
    pub hours: bool,
    /// Connections that failed while others answered.
    pub errors: Vec<String>,
    pub synced_at: String,
    /// Everyone tickets are assigned to, whoever is picked ("Unassigned" too): the people to pick from.
    pub assignees: Vec<String>,
}

/// Whether `i`, a ticket of sprint `s`, was completed in it: done with `s` its last sprint and, when `s` is
/// closed, done by the time it closed (finished later, outside any sprint, it was left over).
fn completed_in(i: &SprintIssue, s: &Sprint) -> bool {
    if !i.done || i.sprints.last() != Some(&s.id) {
        return false;
    }
    match (s.state.as_str(), i.done_at, s.complete.or(s.end)) {
        ("closed", Some(at), Some(closed)) => at <= closed + Duration::hours(12),
        _ => true,
    }
}

fn workday(d: NaiveDate) -> bool {
    d.weekday().number_from_monday() <= 5
}

fn day(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// Stats of sprint `s` from its tickets, as of `now`. Days are UTC ones, as on the commit charts. A ticket dropped
/// in it ("Annulé") is scope taken out the day it was dropped: in no figure, though still listed.
fn sprint_stat(s: &Sprint, every: &[&SprintIssue], now: DateTime<Utc>) -> SprintStat {
    let dropped_here = |i: &SprintIssue| i.cancelled && i.sprints.last() == Some(&s.id);
    let list: Vec<&SprintIssue> = every.iter().copied().filter(|i| !dropped_here(i)).collect();
    let gone: Vec<&SprintIssue> = every.iter().copied().filter(|i| dropped_here(i)).collect();
    let today = now.date_naive();
    let start = s.start.map_or(today, |d| d.date_naive());
    let planned = s.end.map_or(start, |d| d.date_naive());
    // A closed sprint ends the day it closed; an open one past its end is still running.
    let last = match (s.state.as_str(), s.complete) {
        ("closed", Some(c)) => c.date_naive(),
        ("closed", None) => planned,
        _ => planned.max(today),
    }
    .clamp(start, start + Duration::days(90));
    let days: Vec<NaiveDate> = (0..=(last - start).num_days()).map(|k| start + Duration::days(k)).collect();
    let workdays = days.iter().filter(|d| workday(**d)).count() as u32;
    // Started in Jira for a later hour: none of its days has begun yet.
    let begun = s.start.is_none_or(|t| t <= now);
    let workdays_done = if s.state == "closed" { workdays } else if !begun { 0 } else { days.iter().filter(|d| **d <= today && workday(**d)).count() as u32 };

    let completed: Vec<bool> = list.iter().map(|i| completed_in(i, s)).collect();
    // Created after the start. A ticket added once the sprint ran but created before leaves no trace without its history.
    let added = |i: &SprintIssue| i.created.is_some_and(|c| c.date_naive() > start);
    // The day it counts as done, inside the sprint.
    let done_day = |i: &SprintIssue| i.done_at.map_or(last, |t| t.date_naive()).clamp(start, last);

    let mut st = SprintStat {
        id: s.id,
        name: s.name.clone(),
        state: s.state.clone(),
        goal: s.goal.clone(),
        start: day(start),
        end: day(planned),
        complete: s.complete.filter(|_| s.state == "closed").map(|c| day(c.date_naive())),
        workdays,
        workdays_done,
        committed: Work::default(),
        completed: Work::default(),
        scope_start: Work::default(),
        added: Work::default(),
        carried: Work::default(),
        left_estimate: 0.0,
        left_remaining: 0.0,
        bugs: 0,
        bugs_fixed: 0,
        cancelled: 0,
        no_points: 0,
        no_estimate: 0,
        unassigned: 0,
        status: BTreeMap::new(),
        cycle_median: None,
        cycle_p85: None,
        people: Vec::new(),
        kinds: Vec::new(),
        burndown: Vec::new(),
        tickets: Vec::new(),
    };
    let mut people: BTreeMap<&str, Person> = BTreeMap::new();
    let mut kinds: BTreeMap<&str, KindStat> = BTreeMap::new();
    for (i, &done) in list.iter().zip(&completed) {
        let w = Work::of(i);
        st.committed += w;
        if added(i) {
            st.added += w;
        } else {
            st.scope_start += w;
        }
        if i.sprints.first() != Some(&s.id) {
            st.carried += w;
        }
        let p = people.entry(&i.assignee).or_insert_with(|| Person { name: i.assignee.clone(), ..Default::default() });
        p.committed += w;
        let k = kinds.entry(&i.kind).or_insert_with(|| KindStat { name: i.kind.clone(), committed: Work::default(), completed: Work::default() });
        k.committed += w;
        if done {
            st.completed += w;
            p.completed += w;
            k.completed += w;
            if i.bug {
                st.bugs_fixed += 1;
                p.bugs_fixed += 1;
            }
        } else {
            st.left_estimate += i.estimate.unwrap_or(0.0);
            st.left_remaining += i.remaining.unwrap_or(0.0);
            p.left_hours += i.remaining.unwrap_or(0.0);
        }
        st.bugs += u32::from(i.bug);
        st.no_points += u32::from(i.points.is_none());
        st.no_estimate += u32::from(i.estimate.is_none());
        st.unassigned += u32::from(i.assignee == "Unassigned");
        *st.status.entry(i.status).or_default() += 1;
    }
    st.people = people.into_values().collect();
    st.people.sort_by(|a, b| b.completed.tickets.total_cmp(&a.completed.tickets).then(b.committed.tickets.total_cmp(&a.committed.tickets)).then_with(|| a.name.cmp(&b.name)));
    st.kinds = kinds.into_values().collect();
    st.kinds.sort_by(|a, b| b.committed.tickets.total_cmp(&a.committed.tickets));

    let total = f64::from(workdays.max(1));
    let mut over = 0.0;
    st.burndown = days
        .iter()
        .map(|&d| {
            over += f64::from(u8::from(workday(d)));
            let future = d > today;
            let scope: Work = list
                .iter()
                .chain(gone.iter().filter(|i| done_day(i) > d))
                .filter(|i| !added(i) || i.created.is_some_and(|c| c.date_naive() <= d))
                .map(|i| Work::of(i))
                .sum();
            let gone: Work = list.iter().zip(&completed).filter(|(i, done)| **done && done_day(i) <= d).map(|(i, _)| Work::of(i)).sum();
            BurnDay {
                date: day(d),
                weekend: !workday(d),
                remaining: (!future).then(|| scope - gone),
                scope: (!future).then_some(scope),
                ideal: st.scope_start.part(total - over, total),
                done: list.iter().zip(&completed).filter(|(i, done)| **done && done_day(i) == d).map(|(i, _)| i.key.clone()).collect(),
            }
        })
        .collect();
    st.cancelled = gone.len() as u32;
    // Dropped ones were there from the start too, unless created later.
    st.scope_start += gone.iter().filter(|i| !added(i)).map(|i| Work::of(i)).sum::<Work>();
    st.tickets = list
        .iter()
        .zip(&completed)
        .map(|(i, &done)| (*i, done))
        .chain(gone.iter().map(|i| (*i, false)))
        .map(|(i, done)| {
            let f = flow(i, now);
            SprintTicket {
            key: i.key.clone(),
            title: i.title.clone(),
            url: i.url.clone(),
            kind: i.kind.clone(),
            bug: i.bug,
            assignee: i.assignee.clone(),
            status: i.status,
            status_label: i.status_label.clone(),
            completed: done,
            cancelled: dropped_here(i),
            carried: i.sprints.first() != Some(&s.id),
            moved: !done && !i.cancelled && i.sprints.last() != Some(&s.id),
            added: added(i),
            points: i.points,
            estimate: i.estimate,
            remaining: i.remaining,
            done_at: i.done_at.filter(|_| done).map(|t| day(t.date_naive())),
            started_at: f.start.map(|t| t.to_rfc3339()),
            cycle_hours: f.cycle.filter(|_| done),
            age_hours: f.age.filter(|_| !i.done),
            stages: f.stages,
            code: None,
        }})
        .collect();
    let mut cycles: Vec<f64> = st.tickets.iter().filter_map(|t| t.cycle_hours).collect();
    cycles.sort_by(f64::total_cmp);
    st.cycle_median = rank(&cycles, 0.5);
    st.cycle_p85 = rank(&cycles, 0.85);
    st
}

/// The value at least `share` of the sorted `v` are at or below (nearest rank).
fn rank(v: &[f64], share: f64) -> Option<f64> {
    (!v.is_empty()).then(|| v[((v.len() as f64 * share).ceil() as usize).clamp(1, v.len()) - 1])
}

/// How a ticket moved: when work started, hours from then to done (or to `now` while open), and hours in each status since.
struct Flow {
    start: Option<DateTime<Utc>>,
    cycle: Option<f64>,
    age: Option<f64>,
    stages: BTreeMap<&'static str, f64>,
}

fn hours(d: Duration) -> f64 {
    d.num_seconds().max(0) as f64 / 3600.0
}

fn flow(i: &SprintIssue, now: DateTime<Utc>) -> Flow {
    let start = i.history.iter().find(|h| matches!(h.to, "progress" | "review" | "ready")).map(|h| h.at);
    let end = if i.done { i.done_at.unwrap_or(now) } else { now };
    let mut stages: BTreeMap<&'static str, f64> = BTreeMap::new();
    if let Some(start) = start {
        let moves: Vec<_> = i.history.iter().filter(|h| h.at >= start && h.at <= end).collect();
        for (k, h) in moves.iter().enumerate() {
            let until = moves.get(k + 1).map_or(end, |n| n.at);
            // Done is no stage of the work: a ticket reopened later left it again.
            if h.to != "done" && until > h.at {
                *stages.entry(h.to).or_default() += hours(until - h.at);
            }
        }
    }
    Flow { start, cycle: start.filter(|s| i.done && *s <= end).map(|s| hours(end - s)), age: start.filter(|_| !i.done).map(|s| hours(now - s)), stages }
}

/// The boards of one Jira connection with the stats of their sprints as of `now`. `names`: the board names Jira gave.
pub fn boards(conn: &str, site: &str, sprints: &[Sprint], issues: &[SprintIssue], names: &HashMap<u64, String>, now: DateTime<Utc>) -> Vec<Board> {
    let mut by_board: BTreeMap<u64, Vec<&Sprint>> = BTreeMap::new();
    for s in sprints {
        by_board.entry(s.board).or_default().push(s);
    }
    by_board
        .into_iter()
        .map(|(id, mut list)| {
            list.sort_by_key(|s| s.start);
            let stats = list.iter().map(|s| sprint_stat(s, &issues.iter().filter(|i| i.sprints.contains(&s.id)).collect::<Vec<_>>(), now)).collect();
            Board { id: format!("{conn}:{id}"), name: names.get(&id).cloned().unwrap_or_else(|| board_name(&list, id)), site: site.into(), sprints: stats }
        })
        .collect()
}

/// Every connection's boards, the one running a sprint with the most tickets first. `assignees`: everyone, picked or not.
pub fn report(connections: usize, mut boards: Vec<Board>, errors: Vec<String>, mut assignees: Vec<String>) -> Report {
    let rank = |b: &Board| {
        let last = b.sprints.last();
        (last.is_some_and(|s| s.state == "active"), last.map_or(0, |s| s.committed.tickets as u64))
    };
    boards.sort_by_key(|b| std::cmp::Reverse(rank(b)));
    let any = |f: fn(&Work) -> f64| boards.iter().flat_map(|b| &b.sprints).any(|s| f(&s.committed) > 0.0);
    let (points, hours) = (any(|w| w.points), any(|w| w.hours));
    assignees.sort_by_key(|n| (n == "Unassigned", n.to_lowercase()));
    assignees.dedup();
    Report { connections, boards, points, hours, errors, synced_at: crate::store::now(), assignees }
}

/// One week of the weekly view.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekStat {
    /// Its Monday, YYYY-MM-DD.
    pub start: String,
    pub done: u32,
    pub points: f64,
    /// Tickets done per person, most first.
    pub people: Vec<(String, u32)>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneRow {
    #[serde(flatten)]
    pub ticket: DoneTicket,
    /// Monday of the week it was done in.
    pub week: String,
    /// Hours from created to done.
    pub lead_hours: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyReport {
    /// Trackers shown in the chosen projects: jira, trello, asana.
    pub sources: Vec<String>,
    /// Oldest first; the last is this week, still running.
    pub weeks: Vec<WeekStat>,
    /// Newest first.
    pub tickets: Vec<DoneRow>,
    /// Some ticket has story points.
    pub points: bool,
    pub errors: Vec<String>,
    pub synced_at: String,
}

fn monday(d: NaiveDate) -> NaiveDate {
    d - Duration::days(i64::from(d.weekday().num_days_from_monday()))
}

/// Monday 00:00 UTC of the first of the last `weeks` weeks, this one included.
pub fn weeks_start(now: DateTime<Utc>, weeks: usize) -> DateTime<Utc> {
    let first = monday(now.date_naive()) - Duration::weeks(weeks.max(1) as i64 - 1);
    first.and_hms_opt(0, 0, 0).expect("midnight").and_utc()
}

/// The weekly view of `tickets` (one per tracker and key) over the last `weeks` weeks as of `now`.
pub fn weekly(sources: Vec<String>, tickets: Vec<DoneTicket>, errors: Vec<String>, weeks: usize, now: DateTime<Utc>) -> WeeklyReport {
    let first = weeks_start(now, weeks).date_naive();
    let mut rows: Vec<DoneRow> = Vec::new();
    for t in tickets {
        let d = t.done_at.date_naive();
        if d < first || d > now.date_naive() || rows.iter().any(|r| r.ticket.source == t.source && r.ticket.key == t.key) {
            continue;
        }
        rows.push(DoneRow { week: day(monday(d)), lead_hours: t.created.filter(|c| *c <= t.done_at).map(|c| hours(t.done_at - c)), ticket: t });
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.ticket.done_at));
    let weeks = (0..weeks.max(1) as i64)
        .map(|k| {
            let start = day(first + Duration::weeks(k));
            let mine: Vec<&DoneRow> = rows.iter().filter(|r| r.week == start).collect();
            let mut people: BTreeMap<&str, u32> = BTreeMap::new();
            for r in &mine {
                *people.entry(&r.ticket.assignee).or_default() += 1;
            }
            let mut people: Vec<(String, u32)> = people.into_iter().map(|(n, c)| (n.to_string(), c)).collect();
            people.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            WeekStat { start, done: mine.len() as u32, points: mine.iter().filter_map(|r| r.ticket.points).sum(), people }
        })
        .collect();
    let points = rows.iter().any(|r| r.ticket.points.is_some_and(|p| p > 0.0));
    WeeklyReport { sources, weeks, tickets: rows, points, errors, synced_at: crate::store::now() }
}

fn common_prefix<'a>(a: &'a str, b: &str) -> &'a str {
    let n = a.char_indices().zip(b.chars()).find(|((_, x), y)| x != y).map_or(a.len().min(b.len()), |((i, _), _)| i);
    &a[..n]
}

/// A board's name from its sprints' when Jira did not give it: the words they share before their numbers ("MNC Sprint").
fn board_name(sprints: &[&Sprint], id: u64) -> String {
    let Some(first) = sprints.first().map(|s| s.name.as_str()) else { return format!("Board {id}") };
    let mut prefix = sprints.iter().fold(first, |p, s| common_prefix(p, &s.name));
    // Cut back to whole words, then drop the sprint numbers ("24", "S24", "2026.3") and dashes.
    if !first[prefix.len()..].is_empty() && !first[prefix.len()..].starts_with(char::is_whitespace) {
        prefix = &prefix[..prefix.rfind(char::is_whitespace).unwrap_or(0)];
    }
    let mut words: Vec<&str> = prefix.split_whitespace().collect();
    while words.last().is_some_and(|w| w.chars().any(|c| c.is_ascii_digit()) || !w.chars().any(char::is_alphanumeric)) {
        words.pop();
    }
    if words.is_empty() { format!("Board {id}") } else { words.join(" ") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn sprint(id: u64, state: &str, start: &str, end: &str, complete: Option<&str>) -> Sprint {
        Sprint { id, name: format!("MNC Sprint {id}"), state: state.into(), board: 4, goal: String::new(), start: Some(at(start)), end: Some(at(end)), complete: complete.map(at) }
    }

    fn issue(key: &str, sprints: &[u64], points: f64, done_at: Option<&str>) -> SprintIssue {
        SprintIssue {
            key: key.into(),
            kind: "Story".into(),
            assignee: "Ana".into(),
            status: if done_at.is_some() { "done" } else { "todo" },
            done: done_at.is_some(),
            done_at: done_at.map(at),
            created: Some(at("2026-09-01T00:00:00Z")),
            points: Some(points),
            estimate: Some(points * 4.0),
            remaining: Some(points * 2.0),
            sprints: sprints.to_vec(),
            ..Default::default()
        }
    }

    #[test]
    fn completed_in_its_last_sprint_before_it_closed() {
        let s11 = sprint(11, "closed", "2026-09-21T13:00:00Z", "2026-10-05T13:00:00Z", Some("2026-10-05T14:00:00Z"));
        let s12 = sprint(12, "active", "2026-10-05T15:00:00Z", "2026-10-19T13:00:00Z", None);
        let a = issue("A", &[11], 1.0, Some("2026-10-01T10:00:00Z"));
        let carried = issue("B", &[11, 12], 1.0, Some("2026-10-08T10:00:00Z"));
        let late = issue("C", &[11], 1.0, Some("2026-10-20T10:00:00Z"));
        let open = issue("D", &[12], 1.0, None);
        assert!(completed_in(&a, &s11));
        assert!(!completed_in(&carried, &s11) && completed_in(&carried, &s12));
        // Done two weeks after the sprint closed, outside any sprint: left over.
        assert!(!completed_in(&late, &s11));
        assert!(!completed_in(&open, &s12));
    }

    #[test]
    fn active_sprint_stats() {
        // Two weeks from Monday Oct 5, looked at on the first Friday evening.
        let s = sprint(12, "active", "2026-10-05T13:00:00Z", "2026-10-16T13:00:00Z", None);
        let a = issue("A", &[12], 3.0, Some("2026-10-06T10:00:00Z"));
        let b = issue("B", &[11, 12], 5.0, Some("2026-10-08T10:00:00Z"));
        let c = SprintIssue { bug: true, ..issue("C", &[12], 2.0, None) };
        let d = SprintIssue { assignee: "Bo".into(), created: Some(at("2026-10-07T09:00:00Z")), ..issue("D", &[12], 1.0, None) };
        let st = sprint_stat(&s, &[&a, &b, &c, &d], at("2026-10-09T18:00:00Z"));
        assert_eq!(st.committed, Work { tickets: 4.0, points: 11.0, hours: 44.0 });
        assert_eq!(st.completed, Work { tickets: 2.0, points: 8.0, hours: 32.0 });
        assert_eq!((st.scope_start.points, st.added.points, st.carried.points), (10.0, 1.0, 5.0));
        assert_eq!((st.left_estimate, st.left_remaining), (12.0, 6.0));
        assert_eq!((st.bugs, st.bugs_fixed, st.workdays, st.workdays_done), (1, 0, 10, 5));
        assert_eq!((st.status["done"], st.status["todo"]), (2, 2));
        let people: Vec<(&str, f64, f64, f64)> = st.people.iter().map(|p| (p.name.as_str(), p.committed.tickets, p.completed.tickets, p.left_hours)).collect();
        assert_eq!(people, [("Ana", 3.0, 2.0, 4.0), ("Bo", 1.0, 0.0, 2.0)]);

        let burn: Vec<(&str, Option<f64>, f64)> = st.burndown.iter().map(|d| (d.date.as_str(), d.remaining.map(|w| w.points), d.ideal.points)).collect();
        assert_eq!(burn.len(), 12);
        // D joins the scope the day it was created; the weekend keeps the ideal line flat.
        assert_eq!(&burn[..7], [("2026-10-05", Some(10.0), 9.0), ("2026-10-06", Some(7.0), 8.0), ("2026-10-07", Some(8.0), 7.0), ("2026-10-08", Some(3.0), 6.0), ("2026-10-09", Some(3.0), 5.0), ("2026-10-10", None, 5.0), ("2026-10-11", None, 5.0)]);
        assert_eq!(burn[11], ("2026-10-16", None, 0.0));
        assert_eq!(st.burndown[3].done, ["B"]);
        let row = |k: &str| st.tickets.iter().find(|t| t.key == k).unwrap();
        assert!(row("B").carried && row("D").added && !row("C").moved);
        assert_eq!(row("A").done_at.as_deref(), Some("2026-10-06"));
    }

    #[test]
    fn dropped_tickets_leave_the_numbers() {
        let s = sprint(12, "active", "2026-10-05T13:00:00Z", "2026-10-16T13:00:00Z", None);
        let kept = issue("A", &[12], 3.0, Some("2026-10-06T10:00:00Z"));
        let dropped = SprintIssue { cancelled: true, bug: true, ..issue("B", &[12], 5.0, Some("2026-10-07T10:00:00Z")) };
        // Dropped in a later sprint: here it was just not completed.
        let later = SprintIssue { cancelled: true, ..issue("C", &[11, 12], 2.0, Some("2026-10-07T10:00:00Z")) };
        let earlier = sprint(11, "closed", "2026-09-21T13:00:00Z", "2026-10-05T13:00:00Z", Some("2026-10-05T14:00:00Z"));
        let st = sprint_stat(&s, &[&kept, &dropped], at("2026-10-09T18:00:00Z"));
        assert_eq!((st.committed.points, st.completed.points, st.cancelled, st.bugs_fixed, st.scope_start.points), (3.0, 3.0, 1, 0, 8.0));
        // The scope drops the day it was dropped.
        let scope: Vec<f64> = st.burndown.iter().take(3).map(|d| d.scope.unwrap().points).collect();
        assert_eq!(scope, [8.0, 8.0, 3.0]);
        assert!(st.tickets.iter().any(|t| t.key == "B" && t.cancelled && !t.completed));
        let old = sprint_stat(&earlier, &[&later], at("2026-10-09T18:00:00Z"));
        assert_eq!((old.committed.points, old.completed.points, old.cancelled), (2.0, 0.0, 0));
    }

    #[test]
    fn closed_sprint_ends_the_day_it_closed() {
        let s = sprint(11, "closed", "2026-09-21T13:00:00Z", "2026-10-05T13:00:00Z", Some("2026-10-06T09:00:00Z"));
        let done = issue("A", &[11], 3.0, Some("2026-09-30T10:00:00Z"));
        let moved = issue("B", &[11, 12], 2.0, None);
        let st = sprint_stat(&s, &[&done, &moved], at("2026-10-20T12:00:00Z"));
        assert_eq!((st.completed.points, st.workdays, st.workdays_done), (3.0, 12, 12));
        assert_eq!((st.end.as_str(), st.complete.as_deref()), ("2026-10-05", Some("2026-10-06")));
        let last = st.burndown.last().unwrap();
        assert_eq!((last.date.as_str(), last.remaining.map(|w| w.points), last.ideal.points), ("2026-10-06", Some(2.0), 0.0));
        assert!(st.tickets.iter().any(|t| t.key == "B" && t.moved && !t.completed));
    }

    #[test]
    fn time_from_start_to_done_and_in_each_status() {
        use crate::tickets::StatusChange;
        let t0 = at("2026-10-05T09:00:00Z");
        let mv = |h: i64, to: &'static str| StatusChange { at: t0 + Duration::hours(h), to };
        // Sent back from review once, then through ready to done.
        let done = SprintIssue { history: vec![mv(-48, "todo"), mv(0, "progress"), mv(24, "review"), mv(30, "progress"), mv(40, "ready"), mv(48, "done")], ..issue("A", &[12], 3.0, Some("2026-10-07T09:00:00Z")) };
        let f = flow(&done, at("2026-10-20T00:00:00Z"));
        assert_eq!((f.start, f.cycle, f.age), (Some(t0), Some(48.0), None));
        assert_eq!(f.stages, BTreeMap::from([("progress", 34.0), ("review", 6.0), ("ready", 8.0)]));
        let open = SprintIssue { history: vec![mv(0, "progress")], ..issue("B", &[12], 1.0, None) };
        let f = flow(&open, t0 + Duration::hours(10));
        assert_eq!((f.cycle, f.age), (None, Some(10.0)));
        // Straight from to do to done: no start, so no time to measure.
        let jumped = SprintIssue { history: vec![mv(5, "done")], ..issue("C", &[12], 1.0, Some("2026-10-05T14:00:00Z")) };
        assert_eq!(flow(&jumped, t0).cycle, None);
        let v: Vec<f64> = (1..=10).map(f64::from).collect();
        assert_eq!((rank(&v, 0.5), rank(&v, 0.85), rank(&[], 0.5)), (Some(5.0), Some(9.0), None));
    }

    #[test]
    fn tickets_done_per_week() {
        let done = |key: &str, source: &str, who: &str, at_: &str| DoneTicket {
            key: key.into(),
            title: String::new(),
            url: String::new(),
            source: source.into(),
            place: String::new(),
            kind: "Task".into(),
            assignee: who.into(),
            done_at: at(at_),
            created: Some(at(at_) - Duration::hours(48)),
            points: None,
        };
        // Wednesday Nov 4: three weeks back from this one start Monday Oct 19.
        let now = at("2026-11-04T18:00:00Z");
        assert_eq!(weeks_start(now, 3).to_rfc3339(), "2026-10-19T00:00:00+00:00");
        let list = vec![
            done("A-1", "jira", "Ana", "2026-10-20T10:00:00Z"),
            done("A-2", "jira", "Bo", "2026-10-28T10:00:00Z"),
            done("A-3", "jira", "Ana", "2026-11-03T10:00:00Z"),
            done("A-4", "jira", "Ana", "2026-11-02T10:00:00Z"),
            done("A-3", "jira", "Ana", "2026-11-03T10:00:00Z"),
            done("A-3", "asana", "Ana", "2026-11-03T11:00:00Z"),
            done("A-0", "jira", "Ana", "2026-10-18T23:00:00Z"),
        ];
        let r = weekly(vec!["jira".into()], list, Vec::new(), 3, now);
        let weeks: Vec<(&str, u32)> = r.weeks.iter().map(|w| (w.start.as_str(), w.done)).collect();
        assert_eq!(weeks, [("2026-10-19", 1), ("2026-10-26", 1), ("2026-11-02", 3)]);
        assert_eq!(r.weeks[2].people, [("Ana".to_string(), 3)]);
        assert_eq!((r.tickets.len(), r.tickets[0].ticket.source.as_str(), r.tickets[0].lead_hours), (5, "asana", Some(48.0)));
    }

    #[test]
    fn boards_are_named_from_their_sprints() {
        let s = |name: &str| Sprint { id: 1, name: name.into(), state: "closed".into(), board: 4, goal: String::new(), start: None, end: None, complete: None };
        let (a, b, c, d) = (s("MNC Sprint 23"), s("MNC Sprint 24"), s("Équipe A - S1"), s("2026.3"));
        assert_eq!(board_name(&[&a, &b], 4), "MNC Sprint");
        assert_eq!(board_name(&[&c], 4), "Équipe A");
        assert_eq!(board_name(&[&d], 4), "Board 4");
        assert_eq!(board_name(&[&a, &c], 4), "Board 4");
    }

    #[test]
    fn running_boards_come_first() {
        let now = at("2026-10-09T18:00:00Z");
        let closed = sprint(1, "closed", "2026-09-21T13:00:00Z", "2026-10-05T13:00:00Z", Some("2026-10-05T14:00:00Z"));
        let active = Sprint { board: 9, ..sprint(2, "active", "2026-10-05T13:00:00Z", "2026-10-16T13:00:00Z", None) };
        let issues = [issue("A", &[1], 2.0, Some("2026-09-30T10:00:00Z")), issue("B", &[2], 0.0, None)];
        let r = report(1, boards("c", "x.atlassian.net", &[closed, active], &issues, &HashMap::from([(9, "Web".to_string())]), now), Vec::new(), Vec::new());
        let got: Vec<(&str, &str)> = r.boards.iter().map(|b| (b.id.as_str(), b.name.as_str())).collect();
        assert_eq!(got, [("c:9", "Web"), ("c:4", "MNC Sprint")]);
        assert!(r.points && r.hours);
    }
}
