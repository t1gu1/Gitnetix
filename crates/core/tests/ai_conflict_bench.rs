//! How long the machine's real AI takes to settle conflicts, and whether it gets them right. Cases AI-13 to AI-21 of
//! `list-of-test.md`: branches whose changes overlap, mixed by a rebase (one AI round per commit) or a merge (one
//! round for all), with AI on. Each case then runs the mixed code with `python3`, so a resolution that reads well but
//! breaks the code fails. Ignored by default: they spend AI usage, about 2 minutes in all. Run them with
//!
//!     cargo test -p gitnetix-core --test ai_conflict_bench -- --ignored --nocapture
//!
//! Each case prints one `bench {...}` line: the steps that stopped on conflicts and their seconds, the AI calls and
//! theirs, retries, second passes, files settled without AI, the wall time and what went wrong. The numbers come from
//! the engine's log, which is one per process, so the cases take turns whatever `--test-threads` says. The most AI calls
//! running at once is there too: a step's files all go to AI together, up to 6.
//!
//! `GITNETIX_TEST_AI` picks the provider (`claude` by default). `GITNETIX_TEST_AI_MODEL` and `GITNETIX_TEST_AI_EFFORT`
//! set the conflict task's model and effort, else the app's default route runs. `GITNETIX_TEST_CONFLICT_STYLE` sets
//! the markers git writes: `merge` (git's default, used otherwise) or `zdiff3`, which shows the base lines too.

use std::path::Path;
use std::process::Command;
use std::sync::LazyLock;
use std::time::Instant;

use gitnetix_core::{log, rpc, Gitnetix};
use serde_json::{json, Value};

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git").current_dir(dir).args(args).output().unwrap().status.success()
}

fn sh(dir: &Path, args: &[&str]) {
    assert!(git(dir, args), "git {args:?}");
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").current_dir(dir).args(args).output().unwrap().stdout;
    String::from_utf8(out).unwrap().trim_end().to_string()
}

type Files = Vec<(String, String)>;

fn file(name: &str, body: String) -> (String, String) {
    (name.to_string(), body)
}

fn commit(dir: &Path, files: &Files, message: &str) {
    for (f, body) in files {
        std::fs::write(dir.join(f), body).unwrap();
    }
    sh(dir, &["add", "-A"]);
    sh(dir, &["commit", "-qm", message]);
}

/// A repo on main holding `files`, with the conflict markers the run asks for.
fn init(dir: &Path, files: Files) {
    std::fs::create_dir_all(dir).unwrap();
    sh(dir, &["init", "-q", "-b", "main"]);
    let style = std::env::var("GITNETIX_TEST_CONFLICT_STYLE").unwrap_or_else(|_| "merge".into());
    for (k, v) in [("user.email", "t@example.com"), ("user.name", "Test"), ("commit.gpgsign", "false"), ("core.autocrlf", "false"), ("merge.conflictStyle", &style)] {
        sh(dir, &["config", k, v]);
    }
    commit(dir, &files, "chore: init");
}

/// feat/x from the first commit with `branch`'s commits, then main moves on with one commit of its own.
fn fork(dir: &Path, branch: Vec<(&str, Files)>, main: Files) {
    sh(dir, &["switch", "-qc", "feat/x"]);
    for (message, files) in &branch {
        commit(dir, files, message);
    }
    sh(dir, &["switch", "-q", "main"]);
    commit(dir, &main, "refactor: main moves on");
}

/// One way of mixing two branches whose changes overlap.
struct Case {
    id: &'static str,
    what: &'static str,
    /// "rebase": feat/x onto main, one commit at a time. "merge": feat/x into main, in one go.
    how: &'static str,
    /// Conflicted files at each stop git makes. A rebase keeps one commit per stop.
    stops: Vec<usize>,
    /// AI has to be asked; false when every conflict needs no choice.
    ai: bool,
    /// Makes main and feat/x in an empty folder.
    build: fn(&Path),
    /// Python run in the repo once mixed, failing on the first fact that does not hold.
    check: String,
}

// ---------- easy: main renames settings, the branch changes their values ----------

/// (name, main's new name, value at the start, feat/x's value)
const SETTINGS: [(&str, &str, &str, &str); 5] = [
    ("TIMEOUT", "TIMEOUT_SECONDS", "30", "45"),
    ("RETRIES", "MAX_RETRIES", "3", "5"),
    ("CACHE_TTL", "CACHE_TTL_SECONDS", "300", "600"),
    ("PAGE_SIZE", "DEFAULT_PAGE_SIZE", "50", "100"),
    ("LOG_LEVEL", "LOG_LEVEL_NAME", "\"info\"", "\"debug\""),
];

/// settings.py with main's names when `renamed`, feat/x's values for the first `changed` settings, then `rest`.
fn settings(renamed: bool, changed: usize, rest: &str) -> String {
    let mut s = "\"\"\"Settings the service reads at start.\"\"\"\n".to_string();
    for (i, (old, new, start, set)) in SETTINGS.iter().enumerate() {
        let section = ["network", "retries", "cache", "pages", "logs"][i];
        s += &format!("\n# --- {section} ---\n{} = {}\n", if renamed { new } else { old }, if i < changed { set } else { start });
    }
    s + rest
}

/// What settings.py must hold: main's names only, with feat/x's value for the first `changed` settings.
fn settings_check(changed: usize) -> String {
    let mut c = "import settings as s\n".to_string();
    for (i, (old, new, start, set)) in SETTINGS.iter().enumerate() {
        let want = if i < changed { set } else { start };
        c += &format!("assert getattr(s, '{new}', None) == {want}, '{new} is ' + repr(getattr(s, '{new}', None)) + ', not {want}'\n");
        c += &format!("assert not hasattr(s, '{old}'), 'the old name {old} is back'\n");
    }
    c
}

/// 3,000 feature flags nobody touches, after the settings: a file big enough to show what its size costs.
fn flags() -> String {
    let lines: String = (1..=3000).map(|i| format!("FLAG_{i:04} = {}  # rollout of experiment {i}\n", if i % 3 == 0 { "True" } else { "False" })).collect();
    format!("\n# --- rollout flags ---\n{lines}")
}

const SERVICES: [&str; 6] = ["billing", "search", "mailer", "accounts", "uploads", "reports"];

/// A service's client settings: its timeout named TIMEOUT, or TIMEOUT_SECONDS once main renamed it.
fn service(name: &str, renamed: bool, timeout: usize) -> String {
    format!("\"\"\"Client for the {name} service.\"\"\"\n\nBASE_URL = \"https://{name}.internal\"\n{} = {timeout}\n", if renamed { "TIMEOUT_SECONDS" } else { "TIMEOUT" })
}

/// Each service's deploy settings, alike but for its name and image: its timeout key main renames, the branch's value.
fn deploy(renamed: bool, timeout: u32) -> String {
    let key = if renamed { "timeout_seconds" } else { "timeout" };
    let blocks: String = SERVICES.iter().map(|s| format!("    \"{s}\": {{\n        \"image\": \"{s}:1.4\",\n        \"replicas\": 2,\n        \"{key}\": {timeout},\n    }},\n")).collect();
    format!("\"\"\"Deploy settings of each service.\"\"\"\n\nDEPLOY = {{\n{blocks}}}\n")
}

// ---------- hard: main moves the cart to integer cents, the branch adds features in dollars ----------

/// The cart before main's refactor: lines are (sku, qty, price) tuples, money in float dollars.
const CART: &str = r#""""Shopping cart: items, coupons, shipping and the total to pay."""

TAX_RATE = 0.15

PRICES = {
{catalog}}


# --- adding items ---


def add_item(cart, sku, qty=1):
    """Add qty of sku to the cart."""
    if sku not in PRICES:
        raise KeyError(sku)
    cart.append((sku, qty, PRICES[sku]))
    return cart


# --- removing items ---


def remove_item(cart, sku):
    """Remove every line of sku from the cart."""
    return [line for line in cart if line[0] != sku]


# --- coupons ---


def apply_coupon(subtotal, code):
    """The subtotal once the coupon code is taken off it."""
    if code == "HALF":
        return subtotal * 0.5
    return subtotal


# --- shipping ---


def shipping_cost(cart):
    """Flat shipping for any cart with something in it."""
    if not cart:
        return 0.0
    return 5.0


# --- total ---


def checkout_total(cart, code=None):
    """What the customer pays: items, coupon, shipping, then tax."""
    subtotal = sum(qty * price for _, qty, price in cart)
    subtotal = apply_coupon(subtotal, code)
    total = subtotal + shipping_cost(cart)
    return round(total * (1 + TAX_RATE), 2)
"#;

/// The cart on main: a dict of sku to Line, money in integer cents, functions renamed to say so.
const CART_MAIN: &str = r#""""Shopping cart: items, coupons, shipping and the total to pay. Money is in integer cents."""

from dataclasses import dataclass

TAX_RATE_PERCENT = 15

PRICES_CENTS = {
{catalog}}


@dataclass
class Line:
    sku: str
    qty: int
    unit_cents: int

    @property
    def cents(self):
        return self.qty * self.unit_cents


def new_cart():
    """An empty cart: each sku to its Line."""
    return {}


# --- adding items ---


def add_item(cart, sku, qty=1):
    """Add qty of sku to the cart."""
    if sku not in PRICES_CENTS:
        raise KeyError(f"unknown sku {sku}")
    cart[sku] = Line(sku, qty, PRICES_CENTS[sku])
    return cart


# --- removing items ---


def remove_item(cart, sku):
    """Remove sku from the cart."""
    cart.pop(sku, None)
    return cart


# --- coupons ---


def coupon_discount(subtotal_cents, code):
    """Cents the coupon code takes off the subtotal."""
    if code == "HALF":
        return subtotal_cents // 2
    return 0


# --- shipping ---


def shipping_cents(cart):
    """Flat shipping for any cart with something in it."""
    if not cart:
        return 0
    return 500


# --- total ---


def subtotal_cents(cart):
    """What the items cost, in cents."""
    return sum(line.cents for line in cart.values())


def checkout_total_cents(cart, code=None):
    """What the customer pays, in cents: items, coupon, shipping, then tax rounded half up."""
    subtotal = subtotal_cents(cart)
    subtotal -= coupon_discount(subtotal, code)
    total = subtotal + shipping_cents(cart)
    return (total * (100 + TAX_RATE_PERCENT) + 50) // 100
"#;

/// feat/x's commits on the old cart: (message, lines it changes, what they become). Each one changes a line main
/// rewrote too, so none is settled without AI, and each has to be written again in cents to work.
const FEATURES: [(&str, &str, &str); 5] = [
    (
        "feat: add to the line a sku already has",
        "    \"\"\"Add qty of sku to the cart.\"\"\"\n    if sku not in PRICES:\n        raise KeyError(sku)\n    cart.append",
        "    \"\"\"Add qty of sku to the cart, on its line when it has one already.\"\"\"\n    if sku not in PRICES:\n        raise KeyError(sku)\n    if qty < 1:\n        raise ValueError(\"qty must be at least 1\")\n    for i, (s, q, price) in enumerate(cart):\n        if s == sku:\n            cart[i] = (s, q + qty, price)\n            return cart\n    cart.append",
    ),
    (
        "feat: remove part of a quantity",
        "def remove_item(cart, sku):\n    \"\"\"Remove every line of sku from the cart.\"\"\"\n    return [line for line in cart if line[0] != sku]\n",
        "def remove_item(cart, sku, qty=None):\n    \"\"\"Remove qty of sku from the cart, all of it when qty is None.\"\"\"\n    out = []\n    for s, q, price in cart:\n        if s != sku:\n            out.append((s, q, price))\n        elif qty is not None and q > qty:\n            out.append((s, q - qty, price))\n    return out\n",
    ),
    (
        "feat: TENOFF coupon, 10.00 off from 50.00",
        "    \"\"\"The subtotal once the coupon code is taken off it.\"\"\"\n    if code == \"HALF\":\n        return subtotal * 0.5\n",
        "    \"\"\"The subtotal once the coupon code is taken off it: HALF halves it, TENOFF takes 10.00 off from 50.00.\"\"\"\n    if code == \"HALF\":\n        return subtotal * 0.5\n    if code == \"TENOFF\" and subtotal >= 50.0:\n        return subtotal - 10.0\n",
    ),
    (
        "feat: free shipping from 40.00 of items",
        "    \"\"\"Flat shipping for any cart with something in it.\"\"\"\n    if not cart:\n        return 0.0\n",
        "    \"\"\"Flat shipping for any cart with something in it, free from 40.00 of items.\"\"\"\n    if not cart:\n        return 0.0\n    if sum(qty * price for _, qty, price in cart) >= 40.0:\n        return 0.0\n",
    ),
    (
        "feat: tax exempt customers pay no tax",
        "def checkout_total(cart, code=None):\n    \"\"\"What the customer pays: items, coupon, shipping, then tax.\"\"\"\n",
        "def checkout_total(cart, code=None, tax_exempt=False):\n    \"\"\"What the customer pays: items, coupon, shipping, then tax unless tax_exempt.\"\"\"\n",
    ),
];

/// Cents of each item on the price list: four fruits, then 150 numbered skus.
fn price_list() -> Vec<(String, u32)> {
    let mut items: Vec<(String, u32)> = [("apple", 50), ("pear", 75), ("melon", 300), ("kiwi", 40)].iter().map(|(s, c)| (s.to_string(), *c)).collect();
    items.extend((1..=150).map(|i| (format!("sku-{i:04}"), 100 + i * 37 % 900)));
    items
}

/// cart.py: main's when `main`, else the old one with the first `features` of feat/x in it.
fn cart(main: bool, features: usize) -> String {
    let catalog: String = price_list().iter().map(|(sku, c)| if main { format!("    \"{sku}\": {c},\n") } else { format!("    \"{sku}\": {}.{:02},\n", c / 100, c % 100) }).collect();
    if main {
        return CART_MAIN.replace("{catalog}", &catalog);
    }
    let mut s = CART.replace("{catalog}", &catalog);
    for (_, old, new) in &FEATURES[..features] {
        assert_eq!(s.matches(old).count(), 1, "{old}");
        s = s.replacen(old, new, 1);
    }
    s
}

/// What the mixed cart must do: main's cents API, with each of feat/x's five features working in it.
fn cart_check() -> String {
    let (sku, cents) = price_list().pop().unwrap();
    format!(
        r#"import cart as m

def refused(error, *args):
    try:
        m.add_item(m.new_cart(), *args)
    except error:
        return True
    return False

c = m.new_cart()
m.add_item(c, "apple", 2)
m.add_item(c, "apple", 3)
assert c["apple"].qty == 5, "adding a sku twice puts both on its one line"
assert refused(ValueError, "pear", 0), "qty 0 is accepted"
assert refused(KeyError, "nope"), "an unknown sku is accepted"
c = m.remove_item(c, "apple", 2)
assert c["apple"].qty == 3, "removing part of a quantity"
c = m.remove_item(c, "apple")
assert "apple" not in c, "removing all of a sku"
assert m.coupon_discount(1000, "HALF") == 500, "HALF halves"
assert m.coupon_discount(6000, "TENOFF") == 1000, "TENOFF takes 1000 cents off 6000"
assert m.coupon_discount(5000, "TENOFF") == 1000, "TENOFF from 5000 cents"
assert m.coupon_discount(4000, "TENOFF") == 0, "TENOFF below 5000 cents"
assert m.shipping_cents(m.add_item(m.new_cart(), "melon", 14)) == 0, "free shipping from 4000 cents"
small = m.add_item(m.new_cart(), "kiwi")
assert m.shipping_cents(small) == 500, "flat shipping"
assert m.checkout_total_cents(small) == 621, "total with tax, in cents"
assert m.checkout_total_cents(small, tax_exempt=True) == 540, "tax exempt pays no tax"
assert m.PRICES_CENTS["{sku}"] == {cents}, "the price list in cents"
for gone in ("PRICES", "TAX_RATE", "apply_coupon", "shipping_cost", "checkout_total"):
    assert not hasattr(m, gone), gone + ", which main removed, is back"
"#
    )
}

/// feat/x's commits on settings.py: the first `n` settings changed, one per commit.
fn tuned(n: usize) -> Vec<(&'static str, Files)> {
    let messages = ["feat: longer timeout", "feat: more retries", "feat: longer cache", "feat: bigger pages", "feat: debug logs"];
    (1..=n).map(|i| (messages[i - 1], vec![file("settings.py", settings(false, i, ""))])).collect()
}

/// feat/x's commits on cart.py, one feature each.
fn featured() -> Vec<(&'static str, Files)> {
    (1..=5).map(|i| (FEATURES[i - 1].0, vec![file("cart.py", cart(false, i))])).collect()
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            id: "AI-13",
            what: "1 commit, 1 easy conflict: main renames a setting, the branch changes its value",
            how: "rebase",
            stops: vec![1],
            ai: true,
            build: |d| {
                init(d, vec![file("settings.py", settings(false, 0, ""))]);
                fork(d, tuned(1), vec![file("settings.py", settings(true, 0, ""))]);
            },
            check: settings_check(1),
        },
        Case {
            id: "AI-14",
            what: "1 commit, 1 easy conflict that needs no choice: each side changes the line next to the other's",
            how: "rebase",
            stops: vec![1],
            ai: false,
            build: |d| {
                let limits = |body: u32, headers: u32| format!("\"\"\"Request limits.\"\"\"\n\nMAX_BODY_KB = {body}\nMAX_HEADERS = {headers}\n");
                init(d, vec![file("limits.py", limits(512, 64))]);
                fork(d, vec![("feat: more headers", vec![file("limits.py", limits(512, 100))])], vec![file("limits.py", limits(1024, 64))]);
            },
            check: "import limits as l\nassert (l.MAX_BODY_KB, l.MAX_HEADERS) == (1024, 100), (l.MAX_BODY_KB, l.MAX_HEADERS)\n".into(),
        },
        Case {
            id: "AI-15",
            what: "1 commit, 1 big hard conflict: main moves the cart to cents, the branch adds 5 features in dollars",
            how: "rebase",
            stops: vec![1],
            ai: true,
            build: |d| {
                init(d, vec![file("cart.py", cart(false, 0))]);
                fork(d, vec![("feat: five cart features", vec![file("cart.py", cart(false, 5))])], vec![file("cart.py", cart(true, 0))]);
            },
            check: cart_check(),
        },
        Case {
            id: "AI-16",
            what: "5 commits, 1 easy conflict in each: AI-13 for every setting, 5 steps",
            how: "rebase",
            stops: vec![1; 5],
            ai: true,
            build: |d| {
                init(d, vec![file("settings.py", settings(false, 0, ""))]);
                fork(d, tuned(5), vec![file("settings.py", settings(true, 0, ""))]);
            },
            check: settings_check(5),
        },
        Case {
            id: "AI-17",
            what: "5 commits, 1 hard conflict in each: AI-15 one feature at a time, 5 steps",
            how: "rebase",
            stops: vec![1; 5],
            ai: true,
            build: |d| {
                init(d, vec![file("cart.py", cart(false, 0))]);
                fork(d, featured(), vec![file("cart.py", cart(true, 0))]);
            },
            check: cart_check(),
        },
        Case {
            id: "AI-18",
            what: "AI-16's branch merged into main: its 5 conflicts in one go",
            how: "merge",
            stops: vec![1],
            ai: true,
            build: |d| {
                init(d, vec![file("settings.py", settings(false, 0, ""))]);
                fork(d, tuned(5), vec![file("settings.py", settings(true, 0, ""))]);
            },
            check: settings_check(5),
        },
        Case {
            id: "AI-19",
            what: "1 commit, 6 files with 1 easy conflict each, all asked at once",
            how: "rebase",
            stops: vec![6],
            ai: true,
            build: |d| {
                let all = |renamed: bool, timeout: fn(usize) -> usize| SERVICES.iter().enumerate().map(|(i, s)| file(&format!("{s}.py"), service(s, renamed, timeout(i)))).collect::<Files>();
                init(d, all(false, |_| 30));
                fork(d, vec![("feat: tune each service's timeout", all(false, |i| 41 + i))], all(true, |_| 30));
            },
            check: SERVICES.iter().enumerate().map(|(i, s)| format!("import {s}\nassert getattr({s}, 'TIMEOUT_SECONDS', None) == {}, '{s}: ' + repr(vars({s}).get('TIMEOUT_SECONDS'))\nassert not hasattr({s}, 'TIMEOUT'), '{s}: the old name is back'\n", 41 + i)).collect(),
        },
        Case {
            id: "AI-20",
            what: "AI-13 in a 3,000-line file: what the file's size costs",
            how: "rebase",
            stops: vec![1],
            ai: true,
            build: |d| {
                init(d, vec![file("settings.py", settings(false, 0, &flags()))]);
                fork(d, vec![("feat: longer timeout", vec![file("settings.py", settings(false, 1, &flags()))])], vec![file("settings.py", settings(true, 0, &flags()))]);
            },
            check: settings_check(1) + "assert sum(n.startswith('FLAG_') for n in dir(s)) == 3000 and s.FLAG_3000 is True, 'the flags changed'\n",
        },
        Case {
            id: "AI-21",
            what: "1 commit, 6 conflicts in one file that read the same: each edit has to show which one it is",
            how: "rebase",
            stops: vec![1],
            ai: true,
            build: |d| {
                init(d, vec![file("deploy.py", deploy(false, 30))]);
                fork(d, vec![("feat: longer timeouts", vec![file("deploy.py", deploy(false, 60))])], vec![file("deploy.py", deploy(true, 30))]);
            },
            check: format!("import deploy as d\nassert sorted(d.DEPLOY) == sorted({SERVICES:?}), sorted(d.DEPLOY)\nfor name, s in d.DEPLOY.items():\n    assert s.get('timeout_seconds') == 60 and 'timeout' not in s, name + ': ' + repr(s)\n"),
        },
    ]
}

/// Python `code` run in `dir`: the facts the mixed code must hold. Err names the first one that does not.
fn python(dir: &Path, code: &str) -> Result<(), String> {
    // -B: no __pycache__ left in the repo.
    let out = Command::new("python3").current_dir(dir).args(["-B", "-c", code]).output().map_err(|e| format!("python3: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("python3 failed").trim().to_string())
}

/// What a run spent, read from the engine's log lines (`ask_fixes`, `complete`, `propose_resolution`, `ask_until`).
#[derive(Default)]
struct Spent {
    /// Each stop on conflicts: when AI started on it (ms since the epoch) and its files.
    steps: Vec<(i64, usize)>,
    /// Seconds of each AI call, answered or failed, in the order they ended.
    calls: Vec<f64>,
    failed: usize,
    /// Answers that could not be used, and calls that failed, asked again.
    retries: usize,
    second_pass: usize,
    without_ai: usize,
    /// The most AI calls running at the same time.
    at_once: usize,
}

fn spent(entries: &[log::Entry]) -> Spent {
    let ms = |at: &str| chrono::DateTime::parse_from_rfc3339(at).map_or(0, |t| t.timestamp_millis());
    let secs = |s: &str| s.split('s').next().and_then(|n| n.trim().parse::<f64>().ok()).unwrap_or(0.0);
    let mut sp = Spent::default();
    let mut running = 0;
    for e in entries {
        let t = e.text.as_str();
        if let Some(files) = t.strip_prefix("Will attempt to resolve conflicts with AI in ") {
            sp.steps.push((ms(&e.at), files.rsplit("): ").next().unwrap_or("").split(", ").count()));
        } else if t.starts_with("Will attempt to ask AI for conflict ") {
            running += 1;
            sp.at_once = sp.at_once.max(running);
        } else if let Some(s) = t.strip_prefix("AI answered conflict in ") {
            sp.calls.push(secs(s));
            running = running.saturating_sub(1);
        } else if let Some(s) = t.strip_prefix("AI failed conflict after ") {
            sp.calls.push(secs(s));
            sp.failed += 1;
            running = running.saturating_sub(1);
        } else if t.contains("(try ") && (t.contains("could not be applied") || t.contains("could not be used") || t.contains("did not answer")) {
            sp.retries += 1;
        } else if t.starts_with("Second pass with AI on ") {
            sp.second_pass += 1;
        } else if t.contains(" without AI: none of its conflicts needed a choice") {
            sp.without_ai += 1;
        }
    }
    sp
}

async fn call(k: &Gitnetix, method: &str, params: Value) -> Value {
    rpc::call(k, method, params).await.unwrap_or_else(|e| panic!("{method}: {e}"))
}

/// The engine's log is one per process: a case's numbers hold only while no other case runs.
static TURN: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Builds case `id`, mixes its branches with AI on, then prints what it cost and fails on what went wrong.
async fn bench(id: &str) {
    let _turn = TURN.lock().await;
    let case = cases().into_iter().find(|c| c.id == id).unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("shop");
    (case.build)(&repo);
    let k = Gitnetix::open(&tmp.path().join("home")).unwrap();
    let provider = std::env::var("GITNETIX_TEST_AI").unwrap_or_else(|_| "claude".into());
    call(&k, "ai.saveProvider", json!({ "id": provider, "method": "cli" })).await;
    call(&k, "ai.setDefault", json!({ "id": provider })).await;
    let route = |c: &Value, key: &str| c["routing"]["conflict"][key].as_str().filter(|v| !v.is_empty()).map(String::from).unwrap_or_else(|| c["providers"].as_array().into_iter().flatten().find(|p| p["info"]["id"] == provider.as_str()).and_then(|p| p["conf"][key].as_str()).unwrap_or("").to_string());
    let catalog = call(&k, "ai.catalog", json!({})).await;
    let model = std::env::var("GITNETIX_TEST_AI_MODEL").unwrap_or_else(|_| route(&catalog, "model"));
    let effort = std::env::var("GITNETIX_TEST_AI_EFFORT").unwrap_or_else(|_| route(&catalog, "effort"));
    call(&k, "ai.setRoute", json!({ "task": "conflict", "provider": provider, "model": model, "effort": effort })).await;
    let pid = call(&k, "projects.add", json!({ "paths": [repo.to_string_lossy()] })).await[0]["id"].as_str().unwrap().to_string();
    // The CLI's model list, read before a first AI call and again once an hour: timed apart from the case.
    let t = Instant::now();
    call(&k, "ai.models", json!({ "id": provider })).await;
    let warm = t.elapsed().as_secs_f64();

    log::clear();
    let t = Instant::now();
    let out = if case.how == "rebase" {
        sh(&repo, &["switch", "-q", "feat/x"]);
        rpc::call(&k, "workspace.rebase", json!({ "projectId": pid, "branch": "feat/x", "resolve": true })).await
    } else {
        rpc::call(&k, "branches.merge", json!({ "projectId": pid, "branch": "feat/x", "into": "main" })).await
    };
    let wall = t.elapsed().as_secs_f64();
    let end = chrono::Utc::now().timestamp_millis();
    let sp = spent(&log::all());

    let mut failures = Vec::new();
    match &out {
        Err(e) => failures.push(format!("{} refused: {e}", case.how)),
        Ok(r) if case.how == "rebase" => {
            if (&r["conflicts"], &r["errors"], &r["aborted"]) != (&json!([]), &json!([]), &json!(false)) {
                failures.push(format!("rebase stopped: conflicts {} errors {}", r["conflicts"], r["errors"]));
            }
            let kept = git_out(&repo, &["rev-list", "--count", "main..feat/x"]);
            if !git(&repo, &["merge-base", "--is-ancestor", "main", "feat/x"]) || kept != case.stops.len().to_string() {
                failures.push(format!("feat/x is not its {} commits on main: {kept} past main", case.stops.len()));
            }
        }
        Ok(_) if !git(&repo, &["merge-base", "--is-ancestor", "feat/x", "main"]) => failures.push("feat/x is not merged into main".into()),
        Ok(_) => {}
    }
    let status = git_out(&repo, &["status", "--porcelain"]);
    if !status.is_empty() {
        failures.push(format!("left in the checkout: {status}"));
    }
    let marked = git_out(&repo, &["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>)"]);
    if !marked.is_empty() {
        failures.push(format!("conflict markers left in {marked}"));
    }
    if sp.steps.len() != case.stops.len() {
        failures.push(format!("stopped on conflicts {} times, planned {}", sp.steps.len(), case.stops.len()));
    }
    // A step's files all go to AI together, up to the 6 `ask_fixes` runs at once.
    let widest = case.stops.iter().copied().max().unwrap_or(0).min(6);
    if case.ai && sp.at_once != widest {
        failures.push(format!("at most {} AI calls ran at once, planned {widest}", sp.at_once));
    }
    if case.ai != !sp.calls.is_empty() {
        failures.push(if case.ai { "AI was never asked".into() } else { format!("AI was asked {} times", sp.calls.len()) });
    }
    if let Err(e) = python(&repo, &case.check) {
        failures.push(format!("the mixed code fails: {e}"));
    }

    if !failures.is_empty() {
        failures.push(format!("repo kept in {}", tmp.keep().display()));
    }
    let starts: Vec<i64> = sp.steps.iter().map(|s| s.0).chain([end]).collect();
    // + 0.0: an empty sum is -0.0.
    let round = |x: f64| (x * 10.0).round() / 10.0 + 0.0;
    let line = json!({
        "case": case.id,
        "what": case.what,
        "how": case.how,
        "ai": format!("{provider} {model} {effort}"),
        "style": std::env::var("GITNETIX_TEST_CONFLICT_STYLE").unwrap_or_else(|_| "merge".into()),
        "ok": failures.is_empty(),
        "wall_s": round(wall),
        "steps": sp.steps.len(),
        "step_s": starts.windows(2).map(|w| round((w[1] - w[0]) as f64 / 1000.0)).collect::<Vec<_>>(),
        "files": sp.steps.iter().map(|s| s.1).sum::<usize>(),
        "calls": sp.calls.len(),
        "call_s": sp.calls,
        "ai_s": round(sp.calls.iter().sum()),
        "failed_calls": sp.failed,
        "retries": sp.retries,
        "second_pass": sp.second_pass,
        "without_ai": sp.without_ai,
        "at_once": sp.at_once,
        "warm_s": round(warm),
        "failures": failures,
    });
    println!("bench {line}");
    assert!(failures.is_empty(), "{id}: {failures:#?}");
}

/// AI-13 to AI-21 stop on conflicts where they are planned to, in plain git, so their numbers mean what they say.
#[test]
fn ai13_to_ai21_cases_conflict_where_planned() {
    for case in cases() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("shop");
        (case.build)(&repo);
        let conflicted = || git_out(&repo, &["diff", "--name-only", "--diff-filter=U"]).lines().count();
        let mut stops = Vec::new();
        if case.how == "rebase" {
            sh(&repo, &["switch", "-q", "feat/x"]);
            let mut done = git(&repo, &["rebase", "main"]);
            while !done && stops.len() < 10 {
                stops.push(conflicted());
                // main's side, as a right answer keeps it: the next commits then conflict where they would.
                sh(&repo, &["checkout", "--ours", "--", "."]);
                sh(&repo, &["add", "-A"]);
                done = git(&repo, &["-c", "core.editor=true", "rebase", "--continue"]);
            }
        } else if !git(&repo, &["merge", "--no-edit", "feat/x"]) {
            stops.push(conflicted());
        }
        assert_eq!(stops, case.stops, "{}: {}", case.id, case.what);
    }
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai13_one_easy_conflict() {
    bench("AI-13").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai14_one_easy_conflict_settled_without_ai() {
    bench("AI-14").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai15_one_big_hard_conflict() {
    bench("AI-15").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai16_five_commits_with_an_easy_conflict_each() {
    bench("AI-16").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai17_five_commits_with_a_hard_conflict_each() {
    bench("AI-17").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai18_five_easy_conflicts_merged_in_one_go() {
    bench("AI-18").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai19_six_conflicted_files_in_one_step() {
    bench("AI-19").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai20_one_easy_conflict_in_a_big_file() {
    bench("AI-20").await;
}

#[tokio::test]
#[ignore = "uses the machine's real AI"]
async fn ai21_six_conflicts_that_read_the_same() {
    bench("AI-21").await;
}
