## v0.2.5 — Compound Engineering 3.3 sync + Pi runtime polish

### Upstream sync

- Refreshed the vendored Compound Engineering plugin snapshot to upstream `compound-engineering-v3.3.0`.
- Regenerated bundled Pi skills and agents from the latest upstream plugin.
- Preserved Pi-owned compatibility skills for legacy/local commands:
  - `onboarding`
  - `reproduce-bug`
  - `slfg`
  - `todo-resolve`
  - `todo-triage`

### Pi runtime polish

- Fixed the CE todo runtime helper import so Pi extension loading can resolve the internal workflow context module.
- Added package-integrity coverage for that runtime import path.

### Documentation

- Updated current docs to reference upstream Compound Engineering 3.3.x content.
- Updated package metadata/docs links to the StartupBros repository.

### Validation

- `bun test` passes.
- `doctor_packages` passes for `pi-compound-engineering`; one unrelated local `pi-subagents` package health failure remains outside this repo.
