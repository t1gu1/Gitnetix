## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Branch view cache

- Branch views are saved per project in `~/.config/gitnetix/overview-cache/<id>.json`, keyed by the ref fingerprint and `VIEW_CACHE_VERSION` (`crates/core/src/app.rs`). Branches whose refs did not move reuse their saved view.
- When you change how a `BranchView` field is computed (`branch_view`, `plain_view`), bump `VIEW_CACHE_VERSION` in the same change. Otherwise tests pass but the running app keeps showing the old values.
- When the app shows stale branch state that the code says should have changed, check that branch in the cache JSON first.
