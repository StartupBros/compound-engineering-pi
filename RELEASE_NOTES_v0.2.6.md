## v0.2.6 — Compound Engineering 3.3.1 sync + MCP cleanup

### Upstream sync

- Refreshed the vendored Compound Engineering plugin snapshot to upstream `compound-engineering-v3.3.1`.
- Regenerated bundled Pi skills for the latest review workflow updates.
- Brought `ce-code-review` and `ce-doc-review` forward to upstream's bounded-parallel reviewer dispatch guidance.

### Pi runtime polish

- Removed the stale bundled Context7 MCPorter config now that upstream no longer ships MCP servers.
- Updated `sync:upstream` so future syncs delete stale bundled MCPorter config when upstream emits none.
- Restored full-output reporting controls for the compatibility `subagent` tool (`includeOutputs`, full single-agent output, final chain output).

### Validation

- `bun test` passes.
- `npm pack --dry-run` passes.
- `doctor_packages` still reports an unrelated local `pi-subagents` package import issue outside this repo.
