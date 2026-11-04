//! Usage limits that stop an agent's CLI before it finishes its task: which kind, and when they reset, read from what
//! the CLI says.

use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A usage limit an agent's run stopped at, and when the agent goes on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    /// What the CLI said, e.g. "You've hit your 5-hour limit · resets 3pm (America/Toronto)".
    pub message: String,
    /// The provider whose limit it is.
    #[serde(default)]
    pub provider: String,
    /// Out of credits or over a spend cap: adding credits lifts it before any reset.
    #[serde(default)]
    pub credits: bool,
    /// When it stopped the run, in ms since the Unix epoch.
    #[serde(default)]
    pub since: i64,
    /// When it resets, in ms since the epoch. None when the CLI did not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
    /// When the agent continues by itself, in ms since the epoch: a minute after the reset. None: it waits for you.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continue_at: Option<i64>,
}

/// How long after a reset the agent continues: the provider's clock may run a little behind this one.
pub const MARGIN_MS: i64 = 60_000;

// What CLIs say when a usage limit stops them: Claude Code ("You've hit your 5-hour limit · resets 3pm", "Credit balance is
// too low"), Codex ("You've hit your usage limit… try again in 2 hours"), Gemini ("You have exhausted your daily quota").
// Not "limit reached" alone: Claude Code says "Context limit reached" when a conversation outgrows the model.
static LIMIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)usage limit|you(?:'|’| ha)ve (?:hit|reached) your|exceeded your|limit reached\W+resets|out of (?:usage|extra usage|credits)|usage credits|credit balance|usage allocation|spend(?:ing)? (?:limit|cap)|shared budget|quota|resource.?exhausted|rate.?limit(?:ed|[ _](?:error|reached|exceeded))").unwrap()
});

// The limits only credits (or a raised cap) lift before they reset.
static CREDITS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)credit|billing|spend(?:ing)? (?:limit|cap)|budget|add funds|out of (?:usage|extra usage)|usage allocation|insufficient.?quota|current quota").unwrap()
});

// Claude Code before 1.0.50: "Claude AI usage limit reached|1760000000".
static EPOCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\|(\d{10}|\d{13})\b").unwrap());

// "resets 3pm", "resets Nov 5, 3pm", "try again at 3:05 PM", "Try again at Nov 5th, 2026 3:05 PM".
static AT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:resets?|try again|retry|available again)(?: (?:at|on))? (?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,? )?(?:(?P<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (?P<day>\d{1,2})(?:st|nd|rd|th)?,? (?:(?P<year>\d{4}),? )?(?:at )?)?(?P<h>\d{1,2})(?::(?P<min>\d{2}))?(?:[ \x{202F}]?(?P<ap>[ap])\.?m\b)?").unwrap()
});

// "try again in 2 hours 5 minutes", "retry after 3600s", "resets in 4h 12m".
static IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:resets?|try again|retry|wait)(?: after| in) (?P<d>(?:\d+(?:\.\d+)?\s?(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(?:,? (?:and )?)?)+)").unwrap()
});
static PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(\d+(?:\.\d+)?)\s?([dhms])").unwrap());

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Whether `text`, a CLI's error, says a usage limit stopped it: Some(true) when credits or a spend cap lift it.
pub fn kind(text: &str) -> Option<bool> {
    LIMIT.is_match(text).then(|| CREDITS.is_match(text))
}

/// When the limit `text` names resets, in ms since the Unix epoch, read at `now`. Times without a zone are this
/// computer's: the CLI runs on it.
pub fn resets_at(text: &str, now: DateTime<Local>) -> Option<i64> {
    if let Some(c) = EPOCH.captures(text) {
        let n: i64 = c[1].parse().ok()?;
        return Some(if c[1].len() == 10 { n * 1000 } else { n });
    }
    if let Some(c) = IN.captures(text) {
        let secs: f64 = PART
            .captures_iter(&c["d"])
            .filter_map(|p| {
                let n: f64 = p[1].parse().ok()?;
                Some(n * match p[2].to_ascii_lowercase().as_str() {
                    "d" => 86400.0,
                    "h" => 3600.0,
                    "m" => 60.0,
                    _ => 1.0,
                })
            })
            .sum();
        return (secs > 0.0).then(|| now.timestamp_millis() + (secs * 1000.0) as i64);
    }
    AT.captures_iter(text).find_map(|c| clock(&c, now)).map(|t| t.timestamp_millis())
}

/// The time a match of `AT` names: on its date, else the next time the clock shows it.
fn clock(c: &Captures, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let mut h: u32 = c["h"].parse().ok()?;
    let min: u32 = match c.name("min") {
        Some(m) => m.as_str().parse().ok()?,
        // "retry 3" is no time: a clock needs its minutes or am/pm.
        None if c.name("ap").is_none() => return None,
        None => 0,
    };
    if let Some(ap) = c.name("ap") {
        if !(1..=12).contains(&h) {
            return None;
        }
        h = h % 12 + if ap.as_str().eq_ignore_ascii_case("p") { 12 } else { 0 };
    }
    if h > 23 || min > 59 {
        return None;
    }
    let at = |d: NaiveDate| Local.from_local_datetime(&d.and_hms_opt(h, min, 0)?).earliest();
    let Some(m) = c.name("mon") else {
        // Past by more than a few minutes, it is tomorrow's: a few minutes past is a reset that just happened.
        let t = at(now.date_naive())?;
        return if t < now - Duration::minutes(5) { at(now.date_naive().succ_opt()?) } else { Some(t) };
    };
    let month = MONTHS.iter().position(|x| m.as_str()[..3].eq_ignore_ascii_case(x))? as u32 + 1;
    let day: u32 = c["day"].parse().ok()?;
    let year = match c.name("year") {
        Some(y) => y.as_str().parse().ok()?,
        None => now.year(),
    };
    let mut date = NaiveDate::from_ymd_opt(year, month, day)?;
    // A date without its year, well past, is next year's: "Jan 2" read on Dec 30.
    if c.name("year").is_none() && date < now.date_naive() - Duration::days(1) {
        date = date.with_year(year + 1)?;
    }
    at(date)
}

/// When the limit a Claude Code `rate_limit_info` describes resets, in ms since the epoch: the earlier of its plan
/// limit's and its usage credits' resets when both refuse, as the CLI's own message says.
pub fn info_resets_at(info: &Value) -> Option<i64> {
    let at = |k: &str| info[k].as_i64().filter(|s| *s > 0).map(|s| s * 1000);
    match (at("resetsAt"), at("overageResetsAt")) {
        (Some(a), Some(b)) if info["overageStatus"] == "rejected" => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Whether a Claude Code `assistant` event is the API refusing a request at a usage limit: Some(true) when credits lift it.
pub fn refusal(v: &Value) -> Option<bool> {
    if v["is_api_error_message"] != true && !v["error"].is_string() {
        return None;
    }
    match (v["error"].as_str(), v["api_error"].as_str()) {
        (Some("billing_error"), _) | (_, Some("model_requires_usage_credits" | "long_context_credits_required")) => Some(true),
        (Some("rate_limit"), _) | (_, Some("usage_limit_reached")) => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn limits_are_told_from_other_errors() {
        for (text, credits) in [
            ("You've hit your 5-hour limit · resets 3pm (America/Toronto)", false),
            ("You’ve hit your weekly limit · resets Nov 10, 9am", false),
            ("Claude AI usage limit reached|1760000000", false),
            ("5-hour limit reached ∙ resets 3pm", false),
            ("Credit balance is too low", true),
            ("You're out of usage credits · resets 3pm", true),
            ("Your org is out of usage · add funds to continue", true),
            ("You've hit your monthly spend limit. Switch to another model to continue.", true),
            ("ERROR: You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 5 minutes.", false),
            ("You exceeded your current quota, please check your plan and billing details.", true),
            ("You have exhausted your daily quota on this model.", false),
            ("API Error: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"}}", false),
        ] {
            assert_eq!(kind(text), Some(credits), "{text}");
        }
        for text in ["Context limit reached · /compact or /clear to continue", "Prompt is too long", "Not logged in · Please run /login", "error"] {
            assert_eq!(kind(text), None, "{text}");
        }
    }

    #[test]
    fn reset_times_are_read_as_the_cli_says_them() {
        let now = local(2026, 11, 4, 13, 20);
        let ms = |t: DateTime<Local>| Some(t.timestamp_millis());
        assert_eq!(resets_at("You've hit your 5-hour limit · resets 3pm (America/Toronto)", now), ms(local(2026, 11, 4, 15, 0)));
        assert_eq!(resets_at("resets 3:30pm", now), ms(local(2026, 11, 4, 15, 30)));
        // Past already: tomorrow's. Just past: the reset that happened.
        assert_eq!(resets_at("resets 9am", now), ms(local(2026, 11, 5, 9, 0)));
        assert_eq!(resets_at("resets 1:17pm", now), ms(local(2026, 11, 4, 13, 17)));
        assert_eq!(resets_at("You've hit your weekly limit · resets Nov 10, 9am (America/Toronto)", now), ms(local(2026, 11, 10, 9, 0)));
        assert_eq!(resets_at("resets Jan 2, 2027, 12am", now), ms(local(2027, 1, 2, 0, 0)));
        assert_eq!(resets_at("resets Jan 2, 3pm", local(2026, 12, 30, 10, 0)), ms(local(2027, 1, 2, 15, 0)));
        assert_eq!(resets_at("Try again at Nov 5th, 2026 3:05 PM.", now), ms(local(2026, 11, 5, 15, 5)));
        assert_eq!(resets_at("Please try again at 15:45.", now), ms(local(2026, 11, 4, 15, 45)));
        let later = |s: i64| Some(now.timestamp_millis() + s * 1000);
        assert_eq!(resets_at("or try again in 2 hours 5 minutes.", now), later(2 * 3600 + 5 * 60));
        assert_eq!(resets_at("Try again in 1 day, 3 hours and 10 minutes", now), later(86400 + 3 * 3600 + 600));
        assert_eq!(resets_at("Quota exceeded. Suggested retry after 3600s.", now), later(3600));
        assert_eq!(resets_at("Claude AI usage limit reached|1760000000", now), Some(1_760_000_000_000));
        // No time said: the agent waits for you.
        for text in ["Credit balance is too low", "try again later", "retry 3 times", "You've hit your usage limit."] {
            assert_eq!(resets_at(text, now), None, "{text}");
        }
    }

    #[test]
    fn claude_events_name_the_limit_and_its_reset() {
        let info = json!({ "status": "rejected", "resetsAt": 1_762_300_800, "rateLimitType": "five_hour" });
        assert_eq!(info_resets_at(&info), Some(1_762_300_800_000));
        // Out of usage credits too: the earlier reset lets it go on.
        let both = json!({ "status": "rejected", "resetsAt": 1_762_300_800, "overageStatus": "rejected", "overageResetsAt": 1_762_200_000 });
        assert_eq!(info_resets_at(&both), Some(1_762_200_000_000));
        assert_eq!(info_resets_at(&json!({ "status": "rejected" })), None);

        let refused = |error: &str, api: &str| json!({ "type": "assistant", "is_api_error_message": true, "error": error, "api_error": api });
        assert_eq!(refusal(&refused("rate_limit", "usage_limit_reached")), Some(false));
        assert_eq!(refusal(&refused("billing_error", "")), Some(true));
        assert_eq!(refusal(&refused("invalid_request", "model_requires_usage_credits")), Some(true));
        assert_eq!(refusal(&refused("server_error", "")), None);
        assert_eq!(refusal(&json!({ "type": "assistant", "message": { "content": [] } })), None);
    }
}
