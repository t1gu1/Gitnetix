//! The terminal's command menu: what each project tool found in a checkout
//! (package.json, Cargo, Docker, Make, LÖVE, .NET…) runs, typed from the checkout root.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;
use tokio::sync::OnceCell;

/// One project in the terminal's command menu: a `package.json`, a `Cargo.toml`, a compose file…
#[derive(Serialize, Debug, PartialEq)]
pub struct Scripts {
    /// A package's `name`, else its folder; for other tools, the tool, plus its folder when not the root.
    pub title: String,
    /// Each command's label and the command line that runs it from the checkout root.
    pub scripts: Vec<(String, String)>,
}

type Cmds = Vec<(String, String)>;

/// What `git ls-files` lists for [`project_commands`]. A plain pathspec's `*` crosses folders, so these match
/// at any depth and exact names are checked after; shell scripts only at the root and in `scripts/`, `bin/`, `tools/`.
pub const PATHSPECS: &[&str] = &[
    "*package.json", "*pnpm-lock.yaml", "*yarn.lock", "*bun.lock", "*bun.lockb", "*package-lock.json", "*deno.json",
    "*composer.json", "*artisan", "*pyproject.toml", "*requirements.txt", "*manage.py", "*uv.lock", "*poetry.lock",
    "*Cargo.toml", "*src/main.rs", "*go.mod", "*main.go", "*build.zig", "*Gemfile", "*bin/rails",
    "*gradlew", "*build.gradle", "*build.gradle.kts", "*pom.xml", "*mvnw",
    "*.sln", "*.slnx", "*.csproj", "*.fsproj", "*ProjectSettings/ProjectVersion.txt",
    "*CMakeLists.txt", "*meson.build", "*xmake.lua", "*Makefile", "*makefile", "*GNUmakefile", "*justfile", "*Justfile", "*.justfile",
    "*compose.yaml", "*compose.yml", "*Dockerfile", "*project.godot", "*.odin", "*main.lua", "*conf.lua", "*.rockspec",
    ":(glob)*.sh", ":(glob)scripts/*.sh", ":(glob)bin/*.sh", ":(glob)tools/*.sh",
];

/// Lockfile and the package manager it belongs to.
const LOCKFILES: [(&str, &str); 5] = [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lock", "bun"), ("bun.lockb", "bun"), ("package-lock.json", "npm")];

/// `files`: what `git ls-files` lists for [`PATHSPECS`]; `read`: a file's text; `exec`: whether a file is executable;
/// `name`: the project's. Outside `package.json`, a folder's tool is skipped when a folder above has the same one.
pub fn project_commands(files: &[&str], read: impl Fn(&str) -> Option<String>, exec: impl Fn(&str) -> bool, name: &str) -> Vec<Scripts> {
    let mut out = package_scripts(files, &read);
    let has = |f: String| files.contains(&f.as_str());
    let json = |f: &str| read(f).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_default();

    // shortcut: deno.jsonc (comments) is skipped, no JSONC parser; strip comments if it shows up.
    for (d, f) in tops(files, |f| name_of(f) == "deno.json") {
        let at = flag(d, "--config", f);
        let tasks = json(f)["tasks"].as_object().map(|t| t.keys().map(|k| (k.clone(), format!("deno task{at} {}", shell_word(k)))).collect());
        group(&mut out, "Deno", d, tasks.unwrap_or_default());
    }

    for (d, f) in tops(files, |f| name_of(f) == "composer.json") {
        let v = json(f);
        let at = flag(d, "-d", d);
        let mut s = vec![("install".to_string(), format!("composer{at} install"))];
        // pre-/post- scripts are Composer's event hooks.
        let scripts = v["scripts"].as_object().into_iter().flatten().map(|(k, _)| k).filter(|k| !k.starts_with("pre-") && !k.starts_with("post-"));
        s.extend(scripts.map(|k| (k.clone(), format!("composer{at} run {}", shell_word(k)))));
        group(&mut out, "Composer", d, s);
        if has(path(d, "artisan")) {
            let artisan = shell_word(&path(d, "artisan"));
            let mut s = each(&["serve", "migrate", "test", "tinker", "queue:work", "route:list", "optimize:clear"], |c| format!("php {artisan} {c}"));
            // shortcut: Sail at the root only, unsure it finds its compose file from elsewhere; check before adding.
            if d.is_empty() && v["require-dev"]["laravel/sail"].is_string() {
                s.extend(each(&["sail up", "sail down"], |c| format!("./vendor/bin/{c}")));
            }
            group(&mut out, "Laravel", d, s);
        }
    }

    for (d, _) in tops(files, |f| ["pyproject.toml", "requirements.txt", "manage.py"].contains(&name_of(f))) {
        let toml = read(&path(d, "pyproject.toml")).unwrap_or_default();
        let reqs = path(d, "requirements.txt");
        // uv and poetry run in `d` itself, plain Python from the root.
        let (install, run, local) = if has(path(d, "uv.lock")) {
            let at = flag(d, "--directory", d);
            (Some(("sync", format!("uv{at} sync"))), format!("uv{at} run "), true)
        } else if has(path(d, "poetry.lock")) {
            let at = flag(d, "-C", d);
            (Some(("install", format!("poetry{at} install"))), format!("poetry{at} run "), true)
        } else if has(reqs.clone()) {
            (Some(("install", format!("python3 -m pip install -r {}", shell_word(&reqs)))), String::new(), false)
        } else if !toml.is_empty() {
            (Some(("install", format!("python3 -m pip install -e {}", if d.is_empty() { ".".into() } else { shell_word(d) }))), String::new(), false)
        } else {
            (None, String::new(), false)
        };
        let mut s: Cmds = install.into_iter().map(|(l, c)| (l.to_string(), c)).collect();
        let py = if run.is_empty() { "python3".to_string() } else { format!("{run}python") };
        for (k, _) in toml_table(&toml, "project.scripts").into_iter().chain(toml_table(&toml, "tool.poetry.scripts")) {
            s.push((k.clone(), format!("{run}{}", shell_word(&k))));
        }
        if toml.contains("pytest") || read(&reqs).is_some_and(|t| t.contains("pytest")) {
            let at = if local || d.is_empty() { String::new() } else { format!(" {}", shell_word(d)) };
            s.push(("pytest".into(), format!("{py} -m pytest{at}")));
        }
        if has(path(d, "manage.py")) {
            let manage = shell_word(&if local { "manage.py".into() } else { path(d, "manage.py") });
            s.extend(each(&["runserver", "migrate", "makemigrations", "test", "shell"], |c| format!("{py} {manage} {c}")));
        }
        group(&mut out, "Python", d, s);
    }

    for (d, f) in tops(files, |f| name_of(f) == "Cargo.toml") {
        let at = flag(d, "--manifest-path", f);
        let mut s = each(&["build", "run", "test", "check", "clippy", "fmt"], |c| format!("cargo {c}{at}"));
        // A workspace's plain `cargo run` can't pick between its binaries.
        if read(f).is_some_and(|t| t.contains("[workspace]")) {
            for m in files.iter().filter_map(|m| m.strip_suffix("/src/main.rs")).filter(|m| *m != d && under(m, d)) {
                let toml = read(&path(m, "Cargo.toml")).unwrap_or_default();
                if let Some((_, n)) = toml_table(&toml, "package").into_iter().find(|(k, _)| k == "name") {
                    s.push((format!("run -p {n}"), format!("cargo run -p {}{at}", shell_word(&n))));
                }
            }
        }
        group(&mut out, "Cargo", d, s);
    }

    for (d, _) in tops(files, |f| name_of(f) == "go.mod") {
        let at = flag(d, "-C", d);
        let mut s = Vec::new();
        if has(path(d, "main.go")) {
            s.push(("run .".to_string(), format!("go run{at} .")));
        }
        let cmd = path(d, "cmd/");
        for c in files.iter().filter_map(|f| f.strip_suffix("/main.go")?.strip_prefix(cmd.as_str())).filter(|c| !c.contains('/')) {
            s.push((format!("run ./cmd/{c}"), format!("go run{at} {}", shell_word(&format!("./cmd/{c}")))));
        }
        s.extend(each(&["build", "test", "vet"], |c| format!("go {c}{at} ./...")));
        group(&mut out, "Go", d, s);
    }

    let step = Regex::new(r#"\.step\(\s*"([^"]+)""#).unwrap();
    for (d, f) in tops(files, |f| name_of(f) == "build.zig") {
        let at = flag(d, "--build-file", f);
        let steps: Vec<String> = read(f).map(|t| step.captures_iter(&t).map(|c| c[1].to_string()).collect()).unwrap_or_default();
        let mut s = vec![("build".to_string(), format!("zig build{at}"))];
        s.extend(steps.iter().map(|n| (format!("build {n}"), format!("zig build{at} {}", shell_word(n)))));
        group(&mut out, "Zig", d, s);
    }

    for (d, f) in tops(files, |f| name_of(f) == "Gemfile") {
        let mut s = vec![("install".to_string(), format!("bundle install{}", flag(d, "--gemfile", f)))];
        let rails = path(d, "bin/rails");
        if has(rails.clone()) {
            let rails = run_file(&rails, "ruby", &exec);
            s.extend(each(&["server", "console", "db:migrate", "test", "routes"], |c| format!("{rails} {c}")));
        }
        group(&mut out, "Ruby", d, s);
    }

    let application = Regex::new(r"(?m)(^|[^.\w])application\b").unwrap();
    for (d, _) in tops(files, |f| ["gradlew", "build.gradle", "build.gradle.kts"].contains(&name_of(f))) {
        let wrapper = path(d, "gradlew");
        let tool = if has(wrapper.clone()) { run_file(&wrapper, "sh", &exec) } else { "gradle".into() };
        let at = flag(d, "-p", d);
        // `run` only exists with the application plugin, often applied in a subproject.
        let app = files.iter().filter(|f| name_of(f).starts_with("build.gradle") && under(f, d)).any(|f| read(f).is_some_and(|t| application.is_match(&t)));
        let tasks: &[&str] = if app { &["build", "run", "test", "tasks"] } else { &["build", "test", "tasks"] };
        group(&mut out, "Gradle", d, each(tasks, |c| format!("{tool}{at} {c}")));
    }

    for (d, f) in tops(files, |f| name_of(f) == "pom.xml") {
        let wrapper = path(d, "mvnw");
        let tool = if has(wrapper.clone()) { run_file(&wrapper, "sh", &exec) } else { "mvn".into() };
        let at = flag(d, "-f", f);
        let mut goals = vec!["package", "test", "clean install"];
        if read(f).is_some_and(|t| t.contains("spring-boot")) {
            goals.push("spring-boot:run");
        }
        group(&mut out, "Maven", d, each(&goals, |c| format!("{tool}{at} {c}")));
    }

    // Unity generates its solution and projects; dotnet can't build them.
    let unity = files.iter().any(|f| f.ends_with("ProjectSettings/ProjectVersion.txt"));
    let dotnet = |f: &str| [".sln", ".slnx", ".csproj", ".fsproj"].iter().any(|e| f.ends_with(e));
    for (d, _) in tops(files, dotnet).into_iter().filter(|_| !unity) {
        let here: Vec<&str> = files.iter().copied().filter(|f| dir_of(f) == d && dotnet(f)).collect();
        // dotnet takes a folder holding one solution or project; with more it needs the file, a solution first.
        let target = match here.as_slice() {
            [_] if d.is_empty() => None,
            [_] => Some(d),
            _ => here.iter().find(|f| f.contains(".sln")).or(here.first()).copied(),
        };
        let at = target.map(|t| format!(" {}", shell_word(t))).unwrap_or_default();
        let mut s = each(&["build", "test", "restore", "format"], |c| format!("dotnet {c}{at}"));
        let runnable = |p: &str| read(p).is_some_and(|t| t.contains("Microsoft.NET.Sdk.Web") || t.contains("<OutputType>Exe") || t.contains("<OutputType>WinExe"));
        for p in files.iter().filter(|p| (p.ends_with(".csproj") || p.ends_with(".fsproj")) && under(p, d) && runnable(p)) {
            let stem = name_of(p).rsplit_once('.').map_or(*p, |(s, _)| s);
            s.extend(each(&["run", "watch"], |c| format!("dotnet {c} --project {}", shell_word(p))).into_iter().map(|(l, c)| (format!("{l} {stem}"), c)));
        }
        group(&mut out, ".NET", d, s);
    }

    for (d, _) in tops(files, |f| name_of(f) == "CMakeLists.txt") {
        // shortcut: CMakePresets.json at the root only, since build presets read the current folder; pass -S when nested ones matter.
        let presets = if d.is_empty() { json("CMakePresets.json") } else { serde_json::Value::Null };
        let names = |k: &str| -> Vec<String> {
            let visible = presets[k].as_array().into_iter().flatten().filter(|p| !p["hidden"].as_bool().unwrap_or(false));
            visible.filter_map(|p| p["name"].as_str().map(String::from)).collect()
        };
        let s = if presets.is_object() {
            let mut s: Cmds = names("configurePresets").into_iter().map(|n| (format!("preset {n}"), format!("cmake --preset {}", shell_word(&n)))).collect();
            s.extend(names("buildPresets").into_iter().map(|n| (format!("build {n}"), format!("cmake --build --preset {}", shell_word(&n)))));
            s.extend(names("testPresets").into_iter().map(|n| (format!("test {n}"), format!("ctest --preset {}", shell_word(&n)))));
            s
        } else {
            let (src, build) = if d.is_empty() { (".".into(), "build".into()) } else { (shell_word(d), shell_word(&path(d, "build"))) };
            vec![
                ("configure".into(), format!("cmake -S {src} -B {build}")),
                ("build".into(), format!("cmake --build {build}")),
                ("test".into(), format!("ctest --test-dir {build}")),
            ]
        };
        group(&mut out, "CMake", d, s);
    }

    for (d, _) in tops(files, |f| name_of(f) == "meson.build") {
        let build = shell_word(&path(d, "build"));
        let setup = if d.is_empty() { "meson setup build".into() } else { format!("meson setup {build} {}", shell_word(d)) };
        let s = vec![("setup".into(), setup), ("compile".into(), format!("meson compile -C {build}")), ("test".into(), format!("meson test -C {build}"))];
        group(&mut out, "Meson", d, s);
    }

    for (d, _) in tops(files, |f| name_of(f) == "xmake.lua") {
        let at = flag(d, "-P", d);
        group(&mut out, "xmake", d, each(&["build", "run", "test"], |c| format!("xmake {c}{at}")));
    }

    let target = Regex::new(r"(?m)^([A-Za-z0-9_][A-Za-z0-9_./-]*)[ \t]*:(?:[^:=]|$)").unwrap();
    for (d, f) in tops(files, |f| ["Makefile", "makefile", "GNUmakefile"].contains(&name_of(f))) {
        let at = flag(d, "-C", d);
        group(&mut out, "Make", d, names(read(f), &target).iter().map(|t| (t.clone(), format!("make{at} {}", shell_word(t)))).collect());
    }

    // Leading `_` is a private recipe; a `:=` after the name is a setting or a variable.
    let recipe = Regex::new(r"(?m)^@?([A-Za-z0-9][A-Za-z0-9_-]*)[^:\n]*:(?:[^=]|$)").unwrap();
    for (d, f) in tops(files, |f| ["justfile", "Justfile", ".justfile"].contains(&name_of(f))) {
        let at = flag(d, "-f", f);
        group(&mut out, "just", d, names(read(f), &recipe).iter().map(|r| (r.clone(), format!("just{at} {}", shell_word(r)))).collect());
    }

    let composes = tops(files, |f| ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"].contains(&name_of(f)));
    for &(d, f) in &composes {
        let at = flag(d, "-f", f);
        group(&mut out, "Docker Compose", d, each(&["up", "up -d", "up --build", "down", "logs -f", "ps"], |c| format!("docker compose{at} {c}")));
    }
    // A compose file above builds its Dockerfiles itself.
    for (d, _) in tops(files, |f| name_of(f) == "Dockerfile").into_iter().filter(|(d, _)| !composes.iter().any(|(c, _)| under(d, c))) {
        let base = if d.is_empty() { name } else { name_of(d) };
        let tag: String = base.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '-' }).collect();
        let ctx = if d.is_empty() { ".".into() } else { shell_word(d) };
        group(&mut out, "Docker", d, vec![("build".into(), format!("docker build -t {tag} {ctx}")), ("run".into(), format!("docker run --rm -it {tag}"))]);
    }

    for (d, _) in tops(files, |f| name_of(f) == "project.godot") {
        let at = if d.is_empty() { ".".into() } else { shell_word(d) };
        group(&mut out, "Godot", d, vec![("run".into(), format!("godot --path {at}")), ("editor".into(), format!("godot --path {at} -e"))]);
    }

    let love = |f: &str| match name_of(f) {
        "main.lua" => read(f).is_some_and(|t| ["love.load", "love.draw", "love.update"].iter().any(|c| t.contains(c))),
        "conf.lua" => read(f).is_some_and(|t| t.contains("love.conf")),
        _ => false,
    };
    let games = tops(files, love);
    for &(d, _) in &games {
        group(&mut out, "LÖVE", d, vec![("run".into(), format!("love {}", if d.is_empty() { ".".into() } else { shell_word(d) }))]);
    }
    for (d, f) in tops(files, |f| name_of(f) == "main.lua" && !games.iter().any(|(g, _)| under(f, g))) {
        group(&mut out, "Lua", d, vec![("run".into(), format!("lua {}", shell_word(f)))]);
    }
    // luarocks builds from the current folder.
    if files.iter().any(|f| !f.contains('/') && f.ends_with(".rockspec")) {
        group(&mut out, "LuaRocks", "", each(&["make", "test"], |c| format!("luarocks {c}")));
    }

    // Odin has no manifest: a folder is a package, a program when it declares `main`.
    let main = Regex::new(r"(?m)^main\s*::\s*proc\b").unwrap();
    let mut odin: BTreeMap<&str, Cmds> = BTreeMap::new();
    for (d, _) in tops(files, |f| f.ends_with(".odin") && read(f).is_some_and(|t| main.is_match(&t))) {
        let at = if d.is_empty() { ".".into() } else { shell_word(d) };
        odin.insert(d, each(&["run", "build", "check"], |c| format!("odin {c} {at}")));
    }
    for (d, _) in tops(files, |f| f.ends_with(".odin") && read(f).is_some_and(|t| t.contains("@(test)"))) {
        let at = if d.is_empty() { ".".into() } else { shell_word(d) };
        odin.entry(d).or_default().push(("test".into(), format!("odin test {at}")));
    }
    for (d, s) in odin {
        group(&mut out, "Odin", d, s);
    }

    let sh = files.iter().filter(|f| f.ends_with(".sh")).map(|f| (f.to_string(), run_file(f, "bash", &exec))).collect();
    group(&mut out, "Shell scripts", "", sh);
    out
}

/// Whether a command line's program is installed: on the PATH of the user's login shell, or one [`crate::ai::which`] knows.
/// A path (`./gradlew`) is the checkout's own, found when its project was.
pub async fn installed() -> impl Fn(&str) -> bool {
    static LOGIN: OnceCell<Vec<PathBuf>> = OnceCell::const_new();
    let dirs = LOGIN.get_or_init(login_path).await;
    move |cmd: &str| {
        let bin = cmd.split(' ').next().unwrap_or("");
        // shortcut: no PATHEXT lookup off Unix, so every command shows there; look for .exe/.cmd when Windows matters.
        cfg!(not(unix)) || bin.starts_with("./") || bin.starts_with("'./") || dirs.iter().any(|d| d.join(bin).is_file()) || crate::ai::which(bin).is_some()
    }
}

/// The PATH the user's interactive login shell sets up (nvm, pyenv, Homebrew…), which a desktop app's own lacks.
async fn login_path() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        let mut b = portable_pty::CommandBuilder::new_default_prog();
        // As the terminal does: the passwd entry decides, not a stale $SHELL.
        b.env_remove("SHELL");
        let mut cmd = tokio::process::Command::new(b.get_shell());
        // The marker skips whatever the profile prints first (a greeting, fastfetch…).
        cmd.args(["-i", "-l", "-c", "echo __gnx_path__; printenv PATH"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
        crate::shell::without_appimage(cmd.as_std_mut());
        if let Ok(Ok(out)) = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output()).await {
            if let Some((_, rest)) = String::from_utf8_lossy(&out.stdout).split_once("__gnx_path__\n") {
                return std::env::split_paths(rest.lines().next().unwrap_or("")).collect();
            }
        }
    }
    Vec::new()
}

/// Whether `f` has an execute bit; off Unix scripts go through their interpreter.
pub fn executable(f: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        let _ = f;
        false
    }
}

fn name_of(f: &str) -> &str {
    f.rsplit_once('/').map_or(f, |(_, n)| n)
}

fn dir_of(f: &str) -> &str {
    f.rsplit_once('/').map_or("", |(d, _)| d)
}

/// `f` in folder `d` ("" is the checkout root).
fn path(d: &str, f: &str) -> String {
    if d.is_empty() { f.into() } else { format!("{d}/{f}") }
}

/// Whether path `p` is folder `d` or inside it.
fn under(p: &str, d: &str) -> bool {
    d.is_empty() || p.strip_prefix(d).is_some_and(|r| r.is_empty() || r.starts_with('/'))
}

/// ` <flag> <value>`, which points a tool at folder `d`; nothing at the root.
fn flag(d: &str, flag: &str, value: &str) -> String {
    if d.is_empty() { String::new() } else { format!(" {flag} {}", shell_word(value)) }
}

/// Folders holding a file `is` accepts, each with its first such file, minus those inside another such folder.
fn tops<'a>(files: &[&'a str], is: impl Fn(&str) -> bool) -> Vec<(&'a str, &'a str)> {
    let mut hits: Vec<(&str, &str)> = files.iter().filter(|f| is(f)).map(|&f| (dir_of(f), f)).collect();
    hits.sort();
    hits.dedup_by_key(|h| h.0);
    hits.iter().filter(|(d, _)| !hits.iter().any(|(up, _)| up != d && under(d, up))).copied().collect()
}

/// A menu group titled by its tool, plus its folder when not the root; none without commands.
fn group(out: &mut Vec<Scripts>, tool: &str, d: &str, scripts: Cmds) {
    if !scripts.is_empty() {
        out.push(Scripts { title: if d.is_empty() { tool.into() } else { format!("{tool} · {d}") }, scripts });
    }
}

/// Each label and its command line.
fn each(labels: &[&str], cmd: impl Fn(&str) -> String) -> Cmds {
    labels.iter().map(|l| (l.to_string(), cmd(l))).collect()
}

/// The first capture of each `re` match in `text`, once each, in order.
fn names(text: Option<String>, re: &Regex) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in re.captures_iter(&text.unwrap_or_default()) {
        if !out.contains(&c[1].to_string()) {
            out.push(c[1].to_string());
        }
    }
    out
}

/// The keys and values of TOML table `[table]`, quotes trimmed.
// shortcut: read line by line, no TOML parser, so inline tables and multi-line values are missed; add the `toml` crate if they matter.
fn toml_table(text: &str, table: &str) -> Vec<(String, String)> {
    let mut on = false;
    let mut out = Vec::new();
    for l in text.lines().map(str::trim) {
        if l.starts_with('[') {
            on = l == format!("[{table}]");
        } else if let Some((k, v)) = l.split_once('=').filter(|_| on && !l.starts_with('#')) {
            out.push((k.trim().trim_matches('"').to_string(), v.trim().trim_matches('"').to_string()));
        }
    }
    out
}

/// `f` run as a program when executable, else through `interp`.
fn run_file(f: &str, interp: &str, exec: impl Fn(&str) -> bool) -> String {
    if exec(f) { shell_word(&format!("./{f}")) } else { format!("{interp} {}", shell_word(f)) }
}

/// `files`: the checkout's `package.json` and lockfile paths; `read`: a file's text.
fn package_scripts(files: &[&str], read: impl Fn(&str) -> Option<String>) -> Vec<Scripts> {
    let name = |f: &str| f.rsplit_once('/').map_or(f, |(_, n)| n).to_string();
    let dir = |f: &str| f.rsplit_once('/').map_or("", |(d, _)| d).to_string();
    // By folder, so the root ("") comes first.
    let pkgs: BTreeMap<String, serde_json::Value> = files
        .iter()
        .filter(|f| name(f) == "package.json")
        .filter_map(|f| Some((dir(f), serde_json::from_str(&read(f)?).ok()?)))
        .collect();
    // The nearest folder up from `d` that names one, by its `packageManager` field, else its lockfile.
    let manager = |d: &str| {
        let mut cur = Some(d);
        while let Some(c) = cur {
            let pm = pkgs.get(c).and_then(|v| v["packageManager"].as_str()).and_then(|s| s.split('@').next());
            if let Some(m) = ["npm", "pnpm", "yarn", "bun"].into_iter().find(|m| pm == Some(*m)) {
                return m;
            }
            let at = |f: &str| if c.is_empty() { f.to_string() } else { format!("{c}/{f}") };
            if let Some((_, m)) = LOCKFILES.iter().find(|(l, _)| files.contains(&at(l).as_str())) {
                return *m;
            }
            cur = (!c.is_empty()).then(|| c.rsplit_once('/').map_or("", |(up, _)| up));
        }
        "npm"
    };
    pkgs.iter()
        .filter_map(|(d, v)| {
            let scripts = v["scripts"].as_object().filter(|s| !s.is_empty())?;
            let pm = manager(d);
            let flag = match pm {
                "npm" => "--prefix",
                "pnpm" => "--dir",
                _ => "--cwd",
            };
            let at = if d.is_empty() { String::new() } else { format!(" {flag} {}", shell_word(d)) };
            let title = v["name"].as_str().filter(|n| !n.is_empty()).map(String::from);
            Some(Scripts {
                title: title.unwrap_or_else(|| if d.is_empty() { "Root".into() } else { d.clone() }),
                scripts: scripts.keys().map(|s| (s.clone(), format!("{pm}{at} run {}", shell_word(s)))).collect(),
            })
        })
        .collect()
}

/// `s` as one shell word: as is when plain, else single-quoted (the same in bash, zsh and fish).
fn shell_word(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@+=,".contains(c)) {
        s.into()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_scripts_group_by_package_with_its_manager() {
        let files = ["package.json", "pnpm-lock.yaml", "apps/web/package.json", "apps/docs/package.json", "tools/package.json", "tools/yarn.lock", "my app/package.json", "empty/package.json"];
        let read = |f: &str| {
            Some(
                match f {
                    "package.json" => r#"{ "name": "mono", "scripts": { "build": "tsc", "lint:fix": "eslint" } }"#,
                    "apps/web/package.json" => r#"{ "name": "web", "scripts": { "dev": "vite" } }"#,
                    "apps/docs/package.json" => r#"{ "packageManager": "bun@1.1.0", "scripts": { "dev": "astro" } }"#,
                    "tools/package.json" => r#"{ "scripts": { "it's": "x" } }"#,
                    "my app/package.json" => r#"{ "name": "", "packageManager": "npm@10", "scripts": { "start": "node ." } }"#,
                    "empty/package.json" => r#"{ "name": "empty" }"#,
                    _ => return None,
                }
                .to_string(),
            )
        };
        let got = package_scripts(&files, read);
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(
            got,
            vec![
                Scripts { title: "mono".into(), scripts: vec![pair("build", "pnpm run build"), pair("lint:fix", "pnpm run lint:fix")] },
                Scripts { title: "apps/docs".into(), scripts: vec![pair("dev", "bun --cwd apps/docs run dev")] },
                Scripts { title: "web".into(), scripts: vec![pair("dev", "pnpm --dir apps/web run dev")] },
                Scripts { title: "my app".into(), scripts: vec![pair("start", "npm --prefix 'my app' run start")] },
                Scripts { title: "tools".into(), scripts: vec![pair("it's", r"yarn --cwd tools run 'it'\''s'")] },
            ]
        );
        assert_eq!(package_scripts(&["package.json"], |_| Some(r#"{ "scripts": { "t": "x" } }"#.into()))[0].scripts[0].1, "npm run t");
    }

    #[test]
    fn project_commands_per_tool_from_the_topmost_folder() {
        let files = [
            "Cargo.toml", "crates/cli/Cargo.toml", "crates/cli/src/main.rs", "crates/lib/Cargo.toml",
            "Makefile", "docs/Makefile", "justfile",
            "ops/compose.yml", "ops/api/Dockerfile", "img/Dockerfile",
            "game/main.lua", "game/conf.lua", "tool/main.lua",
            "src/main.odin", "src/util_test.odin",
            "backend/composer.json", "backend/artisan",
            "py/pyproject.toml", "py/uv.lock", "py/manage.py",
            "dotnet/App.sln", "dotnet/Tools.sln", "dotnet/App/App.csproj", "dotnet/Lib/Lib.csproj",
            "deploy.sh", "scripts/setup.sh",
        ];
        let read = |f: &str| {
            Some(
                match f {
                    "Cargo.toml" => "[workspace]\nmembers = [\"crates/*\"]\n",
                    "crates/cli/Cargo.toml" => "[package]\nname = \"gnx-cli\"\nversion = \"1.0.0\"\n\n[dependencies]\nname = \"not this\"\n",
                    "Makefile" => "VAR := 1\n.PHONY: build\nbuild: deps\n\tcargo build\ntest:\n\tcargo test\nbuild:\n%.o: %.c\n",
                    "justfile" => "set shell := [\"bash\", \"-c\"]\nalias b := build\n\ndefault:\n  just --list\nbuild target=\"debug\":\n  echo {{target}}\n_hidden:\n  x\n@deploy env: build\n  y\n",
                    "game/main.lua" => "function love.draw() end",
                    "game/conf.lua" => "function love.conf(t) end",
                    "tool/main.lua" => "print('hi')",
                    "src/main.odin" => "package app\n\nmain :: proc() {}\n",
                    "src/util_test.odin" => "package app\n\n@(test)\nadds :: proc(t: ^testing.T) {}\n",
                    "backend/composer.json" => r#"{ "scripts": { "post-autoload-dump": "x", "dev": "y" }, "require-dev": { "laravel/sail": "^1" } }"#,
                    "py/pyproject.toml" => "[project]\nname = \"site\"\n\n[project.scripts]\nsite = \"site:main\"\n\n[dependency-groups]\ndev = [\"pytest\"]\n",
                    "dotnet/App/App.csproj" => "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>",
                    "dotnet/Lib/Lib.csproj" => "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>",
                    _ => return None,
                }
                .to_string(),
            )
        };
        let got = project_commands(&files, read, |f| f == "deploy.sh", "My App");
        let cmds = |t: &str| got.iter().find(|g| g.title == t).map(|g| g.scripts.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>());
        assert_eq!(cmds("Cargo").unwrap()[1..], ["cargo run", "cargo test", "cargo check", "cargo clippy", "cargo fmt", "cargo run -p gnx-cli"]);
        assert_eq!(cmds("Make").unwrap(), ["make build", "make test"]);
        assert_eq!(cmds("just").unwrap(), ["just default", "just build", "just deploy"]);
        assert_eq!(cmds("Docker Compose · ops").unwrap()[0], "docker compose -f ops/compose.yml up");
        assert_eq!(cmds("Docker · img").unwrap(), ["docker build -t img img", "docker run --rm -it img"]);
        assert_eq!(cmds("LÖVE · game").unwrap(), ["love game"]);
        assert_eq!(cmds("Lua · tool").unwrap(), ["lua tool/main.lua"]);
        assert_eq!(cmds("Odin · src").unwrap(), ["odin run src", "odin build src", "odin check src", "odin test src"]);
        assert_eq!(cmds("Composer · backend").unwrap(), ["composer -d backend install", "composer -d backend run dev"]);
        assert_eq!(cmds("Laravel · backend").unwrap()[0], "php backend/artisan serve");
        assert_eq!(
            cmds("Python · py").unwrap(),
            [
                "uv --directory py sync", "uv --directory py run site", "uv --directory py run python -m pytest",
                "uv --directory py run python manage.py runserver", "uv --directory py run python manage.py migrate",
                "uv --directory py run python manage.py makemigrations", "uv --directory py run python manage.py test", "uv --directory py run python manage.py shell",
            ]
        );
        assert_eq!(cmds(".NET · dotnet").unwrap()[0], "dotnet build dotnet/App.sln");
        assert_eq!(cmds(".NET · dotnet").unwrap()[4..], ["dotnet run --project dotnet/App/App.csproj", "dotnet watch --project dotnet/App/App.csproj"]);
        assert_eq!(cmds("Shell scripts").unwrap(), ["./deploy.sh", "bash scripts/setup.sh"]);
        // Inside a folder with the same tool, or built by a compose file above.
        assert!(cmds("Make · docs").is_none() && cmds("Docker · ops/api").is_none() && cmds("Cargo · crates/cli").is_none());
        // Sail only at the root.
        assert!(!cmds("Laravel · backend").unwrap().iter().any(|c| c.contains("sail")));
    }

    #[test]
    fn root_projects_take_no_folder_flag() {
        let files = ["Cargo.toml", "Dockerfile", "main.lua", "App.csproj", "CMakeLists.txt", "x.rockspec"];
        let read = |f: &str| Some(if f == "main.lua" { "function love.load() end".into() } else { String::new() });
        let got = project_commands(&files, read, |_| false, "My App");
        let first = |t: &str| got.iter().find(|g| g.title == t).map(|g| g.scripts[0].1.clone());
        assert_eq!(first("Cargo").as_deref(), Some("cargo build"));
        assert_eq!(first("Docker").as_deref(), Some("docker build -t my-app ."));
        assert_eq!(first("LÖVE").as_deref(), Some("love ."));
        assert_eq!(first(".NET").as_deref(), Some("dotnet build"));
        assert_eq!(first("CMake").as_deref(), Some("cmake -S . -B build"));
        assert_eq!(first("LuaRocks").as_deref(), Some("luarocks make"));
        assert!(first("Lua").is_none(), "a LÖVE game's main.lua is not a plain Lua script");
    }

    #[tokio::test]
    async fn installed_keeps_checkout_paths_and_known_programs() {
        let found = installed().await;
        assert!(found("./gradlew build") && found("'./my dir/x.sh'"));
        assert!(found("sh -c x"));
        assert!(!found("gnx-no-such-program run"));
        #[cfg(unix)]
        assert!(!login_path().await.is_empty(), "the login shell's PATH is read");
    }
}
