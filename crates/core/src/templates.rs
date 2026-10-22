//! Prompt templates: how AI writes commits, branch names, PRs, release notes,
//! resolves conflicts and runs as an agent.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    /// commit | branch | pr | release | changelog | conflict | agent
    pub kind: String,
    pub name: String,
    /// "all" or a project id.
    pub scope: String,
    pub is_default: bool,
    pub body: String,
    pub rules: Vec<Rule>,
    /// Overrides task routing ("" / None = use AI setup).
    pub model: Option<String>,
}

impl Default for Template {
    fn default() -> Self {
        Template {
            id: String::new(),
            kind: "commit".into(),
            name: String::new(),
            scope: "all".into(),
            is_default: false,
            body: String::new(),
            rules: Vec::new(),
            model: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// Stable key, also usable as {key} in the body.
    pub key: String,
    pub label: String,
    /// "check" or "number"
    pub kind: String,
    pub value: serde_json::Value,
}

pub const KINDS: &[(&str, &str)] = &[
    ("commit", "Commit messages"),
    ("branch", "Branch names"),
    ("pr", "PR title & description"),
    ("release", "Release notes"),
    ("changelog", "Changelog entries"),
    ("conflict", "Conflict resolution"),
    ("agent", "Free-form agent"),
];

/// Variables each kind can use, with a hint for the editor.
pub fn variables(kind: &str) -> Vec<(&'static str, &'static str)> {
    let mut v: Vec<(&str, &str)> = match kind {
        "commit" => vec![("{diff}", "Staged diff"), ("{files}", "Changed file list"), ("{branch}", "Current branch"), ("{ticket}", "Linked ticket key"), ("{maxLength}", "Subject length rule")],
        "branch" => vec![("{description}", "What the user typed"), ("{type}", "feat or fix"), ("{ticket}", "Linked ticket key")],
        "pr" => vec![("{diff}", "Branch diff"), ("{commits}", "Commit list"), ("{branch}", "Head branch"), ("{base}", "Base branch"), ("{ticket}", "Linked ticket")],
        "release" => vec![("{commits}", "Commits in range"), ("{tickets}", "Linked tickets"), ("{from}", "Start ref"), ("{to}", "End ref")],
        "changelog" => vec![("{commits}", "Commits the branch adds"), ("{unreleased}", "Current Unreleased section"), ("{released}", "Entries already moved under the release version"), ("{branch}", "Branch"), ("{base}", "Base branch")],
        "conflict" => vec![("{conflict}", "Conflicting file"), ("{ours}", "Our branch"), ("{theirs}", "Their branch"), ("{path}", "File path")],
        "agent" => vec![("{request}", "User request"), ("{branch}", "Current branch"), ("{worktree}", "Worktree path")],
        _ => vec![],
    };
    v.push(("{language}", "Language picked when generating"));
    v
}

/// Fill `{var}` placeholders. Rules are exposed as `{ruleKey}` too.
/// Unknown placeholders are left as they are.
pub fn render(t: &Template, vars: &BTreeMap<String, String>, language: &str) -> String {
    let mut all = vars.clone();
    for r in &t.rules {
        let v = match &r.value {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        all.entry(r.key.clone()).or_insert(v);
    }
    all.insert("language".into(), language_name(language).into());
    let mut out = t.body.clone();
    for (k, v) in &all {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    if !t.body.contains("{language}") {
        out.push_str(&format!("\n\nWrite the result in {}.", language_name(language)));
    }
    out.push_str("\n\nReply with the result only: no preamble, no code fences, no explanation.");
    out
}

pub fn rule_num(t: &Template, key: &str) -> Option<i64> {
    t.rules.iter().find(|r| r.key == key).and_then(|r| r.value.as_i64())
}

pub fn language_name(code: &str) -> &str {
    match code {
        "fr" => "French",
        "en" => "English",
        "de" => "German",
        "es" => "Spanish",
        "it" => "Italian",
        "pt" => "Portuguese",
        other => other,
    }
}

fn rule(key: &str, label: &str, kind: &str, value: serde_json::Value) -> Rule {
    Rule { key: key.into(), label: label.into(), kind: kind.into(), value }
}

pub fn default_templates() -> Vec<Template> {
    use serde_json::json;
    vec![
        Template {
            id: "commit-conv".into(),
            kind: "commit".into(),
            name: "Conventional commits".into(),
            is_default: true,
            rules: vec![
                rule("maxLength", "Subject max length", "number", json!(72)),
                rule("includeTicket", "Include ticket key", "check", json!(true)),
                rule("bodyOver3", "Add a body when more than 3 files change", "check", json!(true)),
            ],
            body: "Write a commit message for the staged changes on {branch}.\n\nFormat: Conventional Commits, type(scope): subject\n- Subject in the imperative, at most {maxLength} characters, no period\n- Add a short body only when more than 3 files change\n- End with \"Refs {ticket}\" when a ticket is linked\n\nChanged files:\n{files}\n\nDiff:\n{diff}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "commit-short".into(),
            kind: "commit".into(),
            name: "Short imperative".into(),
            rules: vec![rule("maxLength", "Subject max length", "number", json!(50))],
            body: "Write a one-line commit message in the imperative, at most {maxLength} characters.\n\nDiff:\n{diff}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "branch".into(),
            kind: "branch".into(),
            name: "type/short-slug".into(),
            is_default: true,
            rules: vec![
                rule("maxWords", "Max slug words", "number", json!(4)),
            ],
            body: "Name a git branch for this work.\n\nFormat: {type}/[slug]\n- slug: 2 to {maxWords} lowercase English words joined by hyphens, ASCII only\n- no ticket key unless asked\n\nWork description:\n{description}".into(),
            ..Default::default()
        },
        Template {
            id: "pr-std".into(),
            kind: "pr".into(),
            name: "Standard PR".into(),
            is_default: true,
            rules: vec![
                rule("linkTicket", "Link the ticket", "check", json!(true)),
                rule("howToTest", "Add a “How to test” section", "check", json!(true)),
                rule("breakingFirst", "Mention breaking changes first", "check", json!(true)),
            ],
            body: "Write a pull request title and description for {branch} → {base}.\n\nFirst line: the title, Conventional Commits style.\nThen a blank line, then the description in Markdown with these sections:\n## Summary — 1 or 2 sentences, user-facing\n## Changes — bullet list, most important first\n## How to test — numbered steps\n\nLink {ticket} at the end.\n\nCommits:\n{commits}\n\nDiff:\n{diff}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "rn-customer".into(),
            kind: "release".into(),
            name: "Customer-facing".into(),
            is_default: true,
            rules: vec![
                rule("groupByType", "Group by type", "check", json!(true)),
                rule("ticketLinks", "Include ticket links", "check", json!(true)),
                rule("contributors", "Mention contributors", "check", json!(false)),
            ],
            body: "Write release notes for users, from {from} to {to}.\n\n- Markdown. Start with a level-2 heading with the version.\n- Plain language, no internal jargon or file names\n- Sections: New, Fixed, Under the hood (skip empty ones)\n- One line per change, ticket key in parentheses\n\nCommits:\n{commits}\n\nTickets:\n{tickets}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "rn-internal".into(),
            kind: "release".into(),
            name: "Internal changelog".into(),
            rules: vec![rule("prNumbers", "Include PR numbers", "check", json!(true))],
            body: "List every change from {from} to {to} for the team, in Markdown.\nOne line per change: conventional type, short summary, PR number when known.\n\nCommits:\n{commits}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "rn-github".into(),
            kind: "release".into(),
            name: "GitHub release".into(),
            rules: vec![],
            body: "Write GitHub release notes from {from} to {to} in Markdown.\nSections: What's new, Bug fixes, Other changes. One bullet per change.\n\nCommits:\n{commits}\n\nTickets:\n{tickets}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "changelog".into(),
            kind: "changelog".into(),
            name: "Keep a Changelog".into(),
            is_default: true,
            rules: vec![],
            body: "Update the Unreleased section of a Keep a Changelog file with the changes {branch} brings over {base}.\n\n- Return the complete new body of the section, without the \"## [Unreleased]\" heading.\n- Keep every existing entry word for word; add one line per user-facing change that is not listed yet, here or under the release's version.\n- Group under ### Added, ### Changed, ### Fixed, ### Removed, in that order, skipping empty ones.\n- Match the tone and length of the existing entries.\n- Leave out refactors, tests, CI and formatting unless users would notice them.\n- When nothing new is worth listing, return the current section unchanged.\n\nCurrent Unreleased section:\n{unreleased}\n\nAlready listed under this release's version (do not add these again):\n{released}\n\nCommits:\n{commits}\n\nWrite the result in {language}.".into(),
            ..Default::default()
        },
        Template {
            id: "conflict".into(),
            kind: "conflict".into(),
            name: "Prefer release branch".into(),
            is_default: true,
            rules: vec![
                rule("askFirst", "Ask before applying", "check", json!(true)),
                rule("runTests", "Run tests after resolving", "check", json!(true)),
            ],
            body: "Resolve the merge conflicts in {path} between {ours} and {theirs}.\n\n- Keep the structure from {theirs} (the release branch)\n- Re-apply the intent of the change from {ours} on top\n- Never drop a change silently\n\nReturn the COMPLETE resolved file content, with no conflict markers left.\n\nFile with conflict markers:\n{conflict}".into(),
            ..Default::default()
        },
        Template {
            id: "agent".into(),
            kind: "agent".into(),
            name: "Safe git agent".into(),
            is_default: true,
            rules: vec![
                rule("planFirst", "Show the plan before running", "check", json!(true)),
                rule("noForcePush", "Never force-push to main or release/*", "check", json!(true)),
                rule("rewriteUnpushed", "Allow history rewrite on unpushed branches", "check", json!(true)),
            ],
            body: "You work for the user in {worktree} on branch {branch}.\n\nBefore acting, state the plan and the exact commands.\nNever force-push to main or release/* branches.\nStop and ask if the request is ambiguous.\n\nRequest:\n{request}".into(),
            ..Default::default()
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_vars_and_rules() {
        let t = default_templates().into_iter().find(|t| t.id == "commit-conv").unwrap();
        let mut v = BTreeMap::new();
        v.insert("branch".into(), "feat/x".into());
        v.insert("diff".into(), "+a".into());
        let out = render(&t, &v, "fr");
        assert!(out.contains("feat/x"));
        assert!(out.contains("at most 72 characters"));
        assert!(out.contains("Write the result in French."));
        assert!(out.contains("{files}")); // not provided → left alone
    }
}
