//! Conflicts settled without AI, in milliseconds. A conflicted file's three index versions (the base, the checkout's
//! side and the side brought in) are merged again line by line, with two rules git leaves to the user: changes to
//! lines next to each other are all kept, and lines both sides added at the same place are kept one after the other,
//! the checkout's first. A conflict where both sides changed the same lines is AI's, and so is the rest of its file.

use std::collections::HashSet;

/// Conflict marker size asked of `git merge-file`. A file can show git's 7 as text (a page about conflicts); no line
/// starts with 32 by chance.
pub const MARKER: usize = 32;

/// A change to a conflict's base lines: `base[start..end]` became the lines.
type Change<'a> = (usize, usize, Vec<&'a str>);

/// A line `git merge-file --diff3` took as both sides have it, or one of its conflicts.
enum Part<'a> {
    Line(&'a str),
    Conflict { head: Vec<&'a str>, base: Vec<&'a str>, incoming: Vec<&'a str> },
}

/// Conflicted file `work` with every conflict settled, or None when one needs AI. `conflicts`: its conflicts, each from
/// its `<<<<<<<` line to its `>>>>>>>` line (markers shown as text left out). `merged`: its index versions merged by
/// `git merge-file -p --diff3 --marker-size=MARKER` (the checkout's, the base, the incoming). `work` must still be what
/// git wrote: each of its sides is checked against `merged`'s, so a hand edit is never lost.
pub fn resolve(work: &[&str], conflicts: &[(usize, usize)], merged: &str) -> Option<Vec<String>> {
    let parts = parse(merged)?;
    if sides(work, conflicts)? != merged_sides(&parts) {
        return None;
    }
    // Lines the file holds outside what the sides changed: two additions that both hold one may still add different things.
    let known: HashSet<&str> = parts
        .iter()
        .flat_map(|part| match part {
            Part::Line(l) => std::slice::from_ref(l),
            Part::Conflict { base, .. } => base.as_slice(),
        })
        .map(|l| l.trim())
        .collect();
    let mut out = Vec::new();
    for part in &parts {
        match part {
            Part::Line(l) => out.push(l.to_string()),
            Part::Conflict { head, base, incoming } => out.extend(merge(base, head, incoming, &known)?.into_iter().map(String::from)),
        }
    }
    Some(out)
}

/// `merged`'s lines and conflicts. None when its markers don't pair up.
fn parse(merged: &str) -> Option<Vec<Part<'_>>> {
    // `c` MARKER times, then the end of the line or a space and a label.
    let marker = |l: &str, c: u8| l.as_bytes().get(..MARKER).is_some_and(|m| m.iter().all(|&b| b == c)) && l.as_bytes().get(MARKER).is_none_or(|&b| b == b' ');
    let mut parts = Vec::new();
    let mut sides: [Vec<&str>; 3] = Default::default();
    // In a conflict: in its head (0), base (1) or incoming (2) lines.
    let mut at = None;
    for l in merged.lines() {
        match (at, b"<|=>".iter().position(|&c| marker(l, c))) {
            (None, Some(0)) => at = Some(0),
            (Some(0), Some(1)) => at = Some(1),
            (Some(1), Some(2)) => at = Some(2),
            (Some(2), Some(3)) => {
                let [head, base, incoming] = std::mem::take(&mut sides);
                parts.push(Part::Conflict { head, base, incoming });
                at = None;
            }
            (_, Some(_)) => return None,
            (None, None) => parts.push(Part::Line(l)),
            (Some(side), None) => sides[side].push(l),
        }
    }
    at.is_none().then_some(parts)
}

/// What each side of `merged` holds: its lines with every conflict swapped for its head lines, then for its incoming lines.
fn merged_sides<'a>(parts: &[Part<'a>]) -> (Vec<&'a str>, Vec<&'a str>) {
    let (mut head, mut incoming) = (Vec::new(), Vec::new());
    for part in parts {
        match part {
            Part::Line(l) => {
                head.push(*l);
                incoming.push(*l);
            }
            Part::Conflict { head: h, incoming: i, .. } => {
                head.extend(h);
                incoming.extend(i);
            }
        }
    }
    (head, incoming)
}

/// What each side of `work` holds, the same way. None when a conflict has no `=======` line.
fn sides<'a>(work: &[&'a str], conflicts: &[(usize, usize)]) -> Option<(Vec<&'a str>, Vec<&'a str>)> {
    let (mut head, mut incoming) = (Vec::new(), Vec::new());
    let mut at = 0;
    for &(start, end) in conflicts {
        if start < at || end < start + 2 || end > work.len() {
            return None;
        }
        head.extend(&work[at..start]);
        incoming.extend(&work[at..start]);
        let body = &work[start + 1..end - 1];
        let mid = body.iter().position(|l| l.trim_end() == "=======")?;
        // A file in git's diff3 style holds the base lines too, from a `|||||||` line.
        let base = body[..mid].iter().position(|l| l.starts_with("|||||||")).unwrap_or(mid);
        head.extend(&body[..base]);
        incoming.extend(&body[mid + 1..]);
        at = end;
    }
    head.extend(&work[at..]);
    incoming.extend(&work[at..]);
    Some((head, incoming))
}

/// What takes a conflict's place when the two sides changed different base lines: every change of both. A change both
/// made counts once. Lines both added at the same place go one after the other, the head's first, when [`can_follow`]
/// allows. None when the two changed the same lines.
fn merge<'a>(base: &[&'a str], head: &[&'a str], incoming: &[&'a str], known: &HashSet<&str>) -> Option<Vec<&'a str>> {
    let (h, i) = (changes(base, head)?, changes(base, incoming)?);
    let mut kept: Vec<&Change> = h.iter().collect();
    for c in &i {
        if h.contains(c) {
            continue;
        }
        for d in &h {
            let both_add = c.0 == c.1 && d.0 == d.1 && c.0 == d.0;
            let clash = if both_add { !can_follow(&d.2, &c.2, known) } else { overlap(c, d) };
            if clash {
                return None;
            }
        }
        kept.push(c);
    }
    // In base order. At one place lines added go before lines changed, and the stable sort keeps the head's first.
    kept.sort_by_key(|c| (c.0, c.0 != c.1));
    let mut out = Vec::new();
    let mut at = 0;
    for (start, end, lines) in kept {
        if *start < at {
            return None;
        }
        out.extend(&base[at..*start]);
        out.extend(lines);
        at = *end;
    }
    out.extend(&base[at..]);
    Some(out)
}

/// Changes `a` and `b` touch the same base lines, or one adds lines between lines the other changed.
fn overlap(a: &Change, b: &Change) -> bool {
    let within = |x: &Change, y: &Change| x.0 == x.1 && y.0 < x.0 && x.0 < y.1;
    a.0.max(b.0) < a.1.min(b.1) || within(a, b) || within(b, a)
}

/// The changes that turn `base` into `side`, in order, from the longest run of lines they have in common. None when
/// the lines left between their common start and end are too many to compare.
fn changes<'a>(base: &[&'a str], side: &[&'a str]) -> Option<Vec<Change<'a>>> {
    let pre = base.iter().zip(side).take_while(|(a, b)| a == b).count();
    let post = base[pre..].iter().rev().zip(side[pre..].iter().rev()).take_while(|(a, b)| a == b).count();
    let (b, s) = (&base[pre..base.len() - post], &side[pre..side.len() - post]);
    // shortcut: a quadratic table, so a conflict over a million line pairs goes to AI; use Myers' diff if those come up.
    if b.len().saturating_mul(s.len()) > 1_000_000 {
        return None;
    }
    let w = s.len() + 1;
    // lcs[i * w + j]: how many lines b[i..] and s[j..] have in common, in order.
    let mut lcs = vec![0u32; (b.len() + 1) * w];
    for i in (0..b.len()).rev() {
        for j in (0..s.len()).rev() {
            lcs[i * w + j] = if b[i] == s[j] { lcs[(i + 1) * w + j + 1] + 1 } else { lcs[(i + 1) * w + j].max(lcs[i * w + j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    // Where the change being read starts, in b and in s.
    let mut open = None;
    while i < b.len() || j < s.len() {
        if i < b.len() && j < s.len() && b[i] == s[j] {
            if let Some((bi, sj)) = open.take() {
                out.push((pre + bi, pre + i, s[sj..j].to_vec()));
            }
            (i, j) = (i + 1, j + 1);
        } else {
            open.get_or_insert((i, j));
            if i < b.len() && (j == s.len() || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
                i += 1;
            } else {
                j += 1;
            }
        }
    }
    if let Some((bi, sj)) = open {
        out.push((pre + bi, pre + b.len(), s[sj..].to_vec()));
    }
    Some(out)
}

/// Lines `a` and `b`, added at the same place by each side, can go one after the other: no line is in both unless the
/// file already holds it (both adding a new line means both add the same thing), and their top lines declare
/// different names.
fn can_follow(a: &[&str], b: &[&str], known: &HashSet<&str>) -> bool {
    let fresh = |l: &str| l.chars().any(char::is_alphanumeric) && !known.contains(l.trim());
    let shared = a.iter().any(|l| fresh(l) && b.iter().any(|m| m.trim() == l.trim()));
    !shared && names(a).is_disjoint(&names(b))
}

/// What the least indented of `lines` declare, roughly: their text up to `=`, `(` or a lone `:` (a path's `::` goes
/// on), or a table row's first cell. Comments, attributes and decorators declare nothing.
fn names(lines: &[&str]) -> HashSet<String> {
    let indent = |l: &str| l.len() - l.trim_start().len();
    let filled = || lines.iter().filter(|l| !l.trim().is_empty());
    let top = filled().map(|l| indent(l)).min().unwrap_or(0);
    filled().filter(|l| indent(l) == top).filter_map(|l| name(l.trim())).collect()
}

fn name(line: &str) -> Option<String> {
    if ["//", "/*", "*", "<!--", "#[", "#!", "@", "--"].iter().any(|p| line.starts_with(p)) {
        return None;
    }
    let key = match line.strip_prefix('|') {
        Some(row) => row.split('|').next().unwrap_or_default(),
        None => {
            let b = line.as_bytes();
            let lone_colon = |i: usize| b[i] == b':' && b.get(i + 1) != Some(&b':') && (i == 0 || b[i - 1] != b':');
            &line[..(0..b.len()).find(|&i| b[i] == b'=' || b[i] == b'(' || lone_colon(i)).unwrap_or(b.len())]
        }
    };
    let key = key.trim();
    key.chars().any(char::is_alphanumeric).then(|| key.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// The file as git leaves it after merging `head` and `incoming` from `base` (`style`: options standing for the
    /// user's `merge.conflictStyle`), and the `--diff3` merge [`resolve`] reads.
    fn conflicted(style: &[&str], base: &str, head: &str, incoming: &str) -> (String, String) {
        let dir = tempfile::tempdir().unwrap();
        let files = [("head", head), ("base", base), ("incoming", incoming)].map(|(name, body)| {
            let path = dir.path().join(name);
            std::fs::write(&path, body).unwrap();
            path
        });
        let merge = |args: &[&str]| {
            let out = Command::new("git").args(["merge-file", "-p", "-q", "--diff-algorithm=histogram"]).args(args).args(&files).output().unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        let work = merge(style);
        assert!(work.contains("<<<<<<<"), "git merged it without a conflict, the case is wrong:\n{work}");
        (work, merge(&["--diff3", &format!("--marker-size={MARKER}")]))
    }

    /// `work`'s conflicts, from `<<<<<<<` to `>>>>>>>`.
    fn regions(work: &[&str]) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut start = 0;
        for (i, l) in work.iter().enumerate() {
            if l.starts_with("<<<<<<<") {
                start = i;
            } else if l.starts_with(">>>>>>>") {
                out.push((start, i + 1));
            }
        }
        out
    }

    fn settled(work: &str, merged: &str) -> Option<String> {
        let lines: Vec<&str> = work.lines().collect();
        resolve(&lines, &regions(&lines), merged).map(|out| out.join("\n") + "\n")
    }

    /// `work` passes the check against `merged`: a None from [`settled`] then comes from the rules.
    fn passes(work: &str, merged: &str) {
        let lines: Vec<&str> = work.lines().collect();
        assert_eq!(sides(&lines, &regions(&lines)), Some(merged_sides(&parse(merged).unwrap())), "fails the check:\n{work}\n{merged}");
    }

    /// [`settled`] on git's merge of the three.
    fn settle(base: &str, head: &str, incoming: &str) -> Option<String> {
        let (work, merged) = conflicted(&[], base, head, incoming);
        passes(&work, &merged);
        settled(&work, &merged)
    }

    #[test]
    fn keeps_changes_to_lines_next_to_each_other() {
        assert_eq!(settle("a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n").as_deref(), Some("A\nB\nc\n"));
    }

    #[test]
    fn keeps_a_deletion_next_to_a_change() {
        assert_eq!(settle("a\nb\nc\n", "b\nc\n", "a\nB\nc\n").as_deref(), Some("B\nc\n"));
    }

    #[test]
    fn puts_lines_added_before_a_changed_line_before_it() {
        assert_eq!(settle("a\nb\n", "a\nnew\nb\n", "a\nB\n").as_deref(), Some("a\nnew\nB\n"));
    }

    #[test]
    fn puts_lines_added_after_a_changed_line_after_it() {
        assert_eq!(settle("a\nb\n", "a\nb\nnew\n", "a\nB\n").as_deref(), Some("a\nB\nnew\n"));
    }

    #[test]
    fn keeps_both_additions_at_one_place_the_heads_first() {
        let base = "[dependencies]\nserde = \"1\"\n";
        let (head, incoming) = (format!("{base}tokio = \"1\"\n"), format!("{base}regex = \"1\"\n"));
        assert_eq!(settle(base, &head, &incoming), Some(format!("{base}tokio = \"1\"\nregex = \"1\"\n")));
    }

    #[test]
    fn keeps_additions_and_changes_spread_over_one_conflict() {
        // git takes the edits to `a` and `b`, two lines apart from the additions at the end, for one conflict.
        let (work, merged) = conflicted(&[], "a\nb\nc\n", "A\nb\nc\nm1\n", "a\nB\nc\nx1\n");
        assert_eq!(work.matches("<<<<<<<").count(), 1, "{work}");
        assert_eq!(settled(&work, &merged).as_deref(), Some("A\nB\nc\nm1\nx1\n"));
    }

    #[test]
    fn takes_the_change_when_the_other_side_only_changed_line_endings() {
        assert_eq!(settle("alpha\nbeta\ngamma\n", "alpha\r\nbeta\r\ngamma\r\n", "alpha\nBETA\ngamma\n").as_deref(), Some("alpha\nBETA\ngamma\n"));
    }

    #[test]
    fn keeps_a_change_both_sides_made_once_whatever_their_line_endings() {
        assert_eq!(settle("a\nb\n", "A\r\nb\r\n", "A\nb\n").as_deref(), Some("A\nb\n"));
    }

    #[test]
    fn keeps_tests_both_sides_appended_when_the_lines_they_share_are_already_in_the_file() {
        let test = |name: &str| format!("\n#[test]\nfn {name}() {{\n    let env = setup();\n    assert!(env.ok());\n}}\n");
        let base = format!("use super::*;\n{}", test("first"));
        let (head, incoming) = (format!("{base}{}", test("second")), format!("{base}{}", test("third")));
        assert_eq!(settle(&base, &head, &incoming), Some(format!("{base}{}{}", test("second"), test("third"))));
    }

    #[test]
    fn keeps_table_rows_both_sides_added_unless_they_share_an_id() {
        let base = "| ID | Case |\n| --- | --- |\n| AI-01 | one |\n";
        let row = |r: &str| format!("{base}{r}\n");
        assert_eq!(settle(base, &row("| AI-02 | two |"), &row("| AI-03 | three |")), Some(format!("{base}| AI-02 | two |\n| AI-03 | three |\n")));
        assert_eq!(settle(base, &row("| AI-02 | two |"), &row("| AI-02 | deux |")), None);
    }

    #[test]
    fn keeps_functions_of_different_names_both_sides_added() {
        let base = "def a():\n    return 1\n";
        let (head, incoming) = (format!("{base}\ndef b():\n    return 2\n"), format!("{base}\ndef c():\n    return 3\n"));
        assert_eq!(settle(base, &head, &incoming), Some(format!("{base}\ndef b():\n    return 2\n\ndef c():\n    return 3\n")));
    }

    #[test]
    fn leaves_a_line_both_sides_changed_to_ai() {
        assert_eq!(settle("const TIMEOUT = 30;\n", "const REQUEST_TIMEOUT = 30;\n", "const TIMEOUT = 45;\n"), None);
    }

    #[test]
    fn leaves_a_line_one_side_deleted_and_the_other_changed_to_ai() {
        assert_eq!(settle("a\nb\nc\n", "a\nc\n", "a\nB\nc\n"), None);
    }

    #[test]
    fn leaves_lines_added_inside_a_block_the_other_side_rewrote_to_ai() {
        assert_eq!(settle("a\nb\nc\nd\n", "a\nwhole new block\nd\n", "a\nb\nnew\nc\nd\n"), None);
    }

    #[test]
    fn leaves_additions_that_declare_one_name_to_ai() {
        let base = "pub const RETRIES: u32 = 3;\n";
        assert_eq!(settle(base, &format!("{base}pub const TIMEOUT: u32 = 30;\n"), &format!("{base}pub const TIMEOUT: u32 = 45;\n")), None);
        let base = "def a():\n    return 1\n";
        assert_eq!(settle(base, &format!("{base}\ndef helper(x):\n    return x + 1\n"), &format!("{base}\ndef helper(x, y):\n    return x + y\n")), None);
        let base = "PORT=80\n";
        assert_eq!(settle(base, &format!("{base}HOST=a\n"), &format!("{base}HOST=b\n")), None);
    }

    #[test]
    fn leaves_additions_that_share_a_new_line_to_ai() {
        // Both import std::io: kept twice it would not build.
        let base = "use std::fs;\n\nfn main() {}\n";
        assert_eq!(settle(base, "use std::fs;\nuse std::io;\nuse std::path::Path;\n\nfn main() {}\n", "use std::fs;\nuse std::io;\nuse std::env;\n\nfn main() {}\n"), None);
        // Both open "### Fixed" under Unreleased: AI puts the entries under one heading.
        let section = |entry: &str| format!("## [Unreleased]\n\n### Fixed\n- {entry}\n\n## [1.0.0]\n");
        assert_eq!(settle("## [Unreleased]\n\n## [1.0.0]\n", &section("Crash on start"), &section("Typo in the menu")), None);
    }

    #[test]
    fn settles_a_file_only_when_every_conflict_in_it_settles() {
        let base = "a\nb\n1\n2\n3\n4\n5\nx\n";
        let (work, merged) = conflicted(&[], base, "A\nb\n1\n2\n3\n4\n5\nX\n", "a\nB\n1\n2\n3\n4\n5\nx2\n");
        assert_eq!(work.matches("<<<<<<<").count(), 2, "{work}");
        passes(&work, &merged);
        assert_eq!(settled(&work, &merged), None);
        let (work, merged) = conflicted(&[], base, "A\nb\n1\n2\n3\n4\n5\nx\nh\n", "a\nB\n1\n2\n3\n4\n5\nx\ni\n");
        assert_eq!(work.matches("<<<<<<<").count(), 2, "{work}");
        assert_eq!(settled(&work, &merged).as_deref(), Some("A\nB\n1\n2\n3\n4\n5\nx\nh\ni\n"));
    }

    #[test]
    fn reads_a_file_in_the_diff3_styles() {
        for style in ["--diff3", "--zdiff3"] {
            let (work, merged) = conflicted(&[style], "a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n");
            assert!(work.contains("|||||||"), "{work}");
            assert_eq!(settled(&work, &merged).as_deref(), Some("A\nB\nc\n"), "{style}");
        }
    }

    #[test]
    fn leaves_a_file_changed_by_hand_since_git_wrote_it() {
        let base = "a\nb\n1\n2\n3\n4\n5\nx\n";
        let (work, merged) = conflicted(&[], base, "A\nb\n1\n2\n3\n4\n5\nx\nh\n", "a\nB\n1\n2\n3\n4\n5\nx\ni\n");
        assert!(settled(&work, &merged).is_some());
        // A line outside the conflicts edited.
        assert_eq!(settled(&work.replacen("\n3\n", "\nthree\n", 1), &merged), None);
        // The first conflict settled by hand, the second left.
        let first = work.find("<<<<<<<").unwrap();
        let end = work[first..].find(">>>>>>>").map(|i| first + i).unwrap();
        let end = end + work[end..].find('\n').unwrap() + 1;
        let by_hand = format!("{}A\nb\n{}", &work[..first], &work[end..]);
        assert_eq!(by_hand.matches("<<<<<<<").count(), 1);
        assert_eq!(settled(&by_hand, &merged), None);
    }

    #[test]
    fn leaves_a_merge_whose_markers_dont_pair_up() {
        let (work, merged) = conflicted(&[], "a\nb\nc\n", "A\nb\nc\n", "a\nB\nc\n");
        assert_eq!(settled(&work, &merged.replacen(&"=".repeat(MARKER), "", 1)), None);
        assert_eq!(settled(&work, &format!("{merged}{}\n", "<".repeat(MARKER))), None);
    }

    #[test]
    fn leaves_a_conflict_too_big_to_compare_to_ai() {
        let base: Vec<String> = (0..1100).map(|i| format!("line {i}")).collect();
        let side: Vec<String> = (0..1100).map(|i| if i % 2 == 0 { format!("even {i}") } else { format!("odd {i}") }).collect();
        let (base, side): (Vec<&str>, Vec<&str>) = (base.iter().map(String::as_str).collect(), side.iter().map(String::as_str).collect());
        assert!(changes(&base, &side).is_none());
        assert!(changes(&base[..900], &side[..900]).is_some());
    }

    #[test]
    fn reads_what_lines_declare() {
        let n = |l: &str| name(l);
        assert_eq!(n("pub const TIMEOUT: u32 = 30;").as_deref(), Some("pub const TIMEOUT"));
        assert_eq!(n("async fn br30_rebase() {").as_deref(), Some("async fn br30_rebase"));
        assert_eq!(n("use std::io::{self, Read};").as_deref(), Some("use std::io::{self, Read};"));
        assert_eq!(n("\"name\": \"gitnetix\",").as_deref(), Some("\"name\""));
        assert_eq!(n("| AI-08 | Both sides | x |").as_deref(), Some("AI-08"));
        for nothing in ["#[tokio::test]", "@pytest.fixture", "// a note", "/// docs", "}", "| --- | --- |", "-->", "* item"] {
            assert_eq!(n(nothing), None, "{nothing}");
        }
    }
}
