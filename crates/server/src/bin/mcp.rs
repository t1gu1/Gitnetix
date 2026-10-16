//! MCP server (stdio) exposing every Gitnetix action as a tool.
//!
//! It forwards tool calls to the running app's companion API, so agents see
//! the same projects, releases and live agent sessions as the window.
//!
//! Claude Code: `claude mcp add gitnetix -- gitnetix-mcp`

use std::io::{BufRead, Write};

use gitnetix_core::rpc::METHODS;
use gitnetix_core::store::{data_dir, Config};
use serde_json::{json, Value};

fn tool_name(method: &str) -> String {
    method.replace('.', "_")
}

fn method_name(tool: &str) -> Option<&'static str> {
    METHODS.iter().map(|(m, _, _)| *m).find(|m| tool_name(m) == tool)
}

fn tools() -> Value {
    let list: Vec<Value> = METHODS
        .iter()
        .map(|(m, d, p)| {
            let desc = if p.is_empty() { d.to_string() } else { format!("{d}. Params: {p}") };
            json!({ "name": tool_name(m), "description": desc, "inputSchema": { "type": "object", "additionalProperties": true } })
        })
        .collect();
    json!({ "tools": list })
}

fn load_config() -> anyhow::Result<Config> {
    let raw = std::fs::read_to_string(data_dir().join("config.json"))
        .map_err(|_| anyhow::anyhow!("Gitnetix config not found. Open the app once first."))?;
    Ok(serde_json::from_str(&raw)?)
}

async fn forward(http: &reqwest::Client, method: &str, params: Value) -> Result<Value, String> {
    let cfg = load_config().map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{}/rpc", cfg.server.port);
    let res = http
        .post(url)
        .bearer_auth(&cfg.server.token)
        .json(&json!({ "method": method, "params": params }))
        .send()
        .await
        .map_err(|_| "Gitnetix is not running (or its companion API is off in Settings).".to_string())?;
    let ok = res.status().is_success();
    let v: Value = res.json().await.map_err(|e| e.to_string())?;
    if ok {
        Ok(v)
    } else {
        Err(v["message"].as_str().unwrap_or("error").to_string())
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let http = reqwest::Client::new();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg.get("id").cloned();
        let method = msg["method"].as_str().unwrap_or("");
        let result: Result<Value, (i64, String)> = match method {
            "initialize" => Ok(json!({
                "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "gitnetix", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Gitnetix manages release-centric Git work: releases (release/x.y.z branches), features and fixes inside them, worktrees, AI agents, PRs and tickets. Call projects_list first to get a projectId."
            })),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(tools()),
            "tools/call" => {
                let name = msg["params"]["name"].as_str().unwrap_or("");
                let args = msg["params"]["arguments"].clone();
                match method_name(name) {
                    None => Err((-32602, format!("unknown tool {name}"))),
                    Some(m) => Ok(match forward(&http, m, args).await {
                        Ok(v) => json!({ "content": [{ "type": "text", "text": serde_json::to_string_pretty(&v)? }] }),
                        Err(e) => json!({ "content": [{ "type": "text", "text": e }], "isError": true }),
                    }),
                }
            }
            _ if id.is_none() => continue, // notifications
            other => Err((-32601, format!("method not found: {other}"))),
        };
        let Some(id) = id else { continue };
        let reply = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        };
        writeln!(out, "{reply}")?;
        out.flush()?;
    }
    Ok(())
}
