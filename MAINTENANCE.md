# Maintaining `compound-engineering-pi`

This repo is the **Pi distribution/package layer** for Compound Engineering.

## Canonical source of truth

Primary Compound Engineering development happens in:
- `EveryInc/compound-engineering-plugin`

That repo is the source of truth for:
- plugin content
- workflow/skill evolution
- converter behavior
- provider-native target semantics
- install/sync logic that should work across targets

## What belongs in this repo

Keep Pi-specific work here:
- `extensions/compound-engineering-compat.ts`
- `extensions/workflow-commands.ts`
- `extensions/review-runtime.ts`
- `extensions/ce-todos.ts`
- `extensions/workflow-context.ts`
- Pi package docs
- bundled/generated Pi assets:
  - `skills/` generated from upstream, plus explicitly preserved Pi-owned compatibility skills
  - `agents/`
  - `prompts/` as the single published prompt-template source
  - `pi-resources/compound-engineering/mcporter.json`
  - vendored `plugins/compound-engineering/` snapshot
- release/refresh tooling such as `scripts/sync-upstream-pi.ts`

## Upstream-first rule

If a change affects any of these, make it in the plugin repo first:
- conversion behavior
- content transformation rules
- target semantics
- shared sync/install logic
- skill/prompt/source plugin content

Only make changes here first when they are truly Pi-package-specific, such as:
- package install UX
- Pi-only extension behavior
- Pi docs
- release bundling concerns

## Sync workflow

Refresh this repo from the upstream plugin checkout with:

```bash
bun run sync:upstream
```

Default source resolution:
1. `~/.cache/checkouts/github.com/EveryInc/compound-engineering-plugin`
2. `../compound-engineering-plugin`

Override if needed:

```bash
COMPOUND_PLUGIN_SOURCE=/path/to/compound-engineering-plugin bun run sync:upstream
```

What sync does:
1. runs the upstream-capable converter with `--to pi`
2. refreshes the vendored `plugins/compound-engineering/` snapshot
3. regenerates bundled Pi `skills/`
4. regenerates bundled Pi `agents/`
5. refreshes bundled `pi-resources/compound-engineering/mcporter.json` when upstream emits one
6. preserves package-owned Pi runtime extensions, `prompts/`, and local compatibility skills (`onboarding`, `reproduce-bug`, `slfg`, `todo-resolve`, `todo-triage`)

After syncing, regenerate local dogfood wrappers:

```bash
node scripts/generate-agent-wrappers.mjs
```

## Test scope

The local test suite should cover:
- Pi converter behavior
- Pi writer/sync behavior
- Pi-specific CLI compatibility smoke tests
- Claude plugin parsing relied on by Pi sync/generation
- package-owned Pi runtime extensions

Do not try to duplicate exhaustive cross-target converter coverage here; that belongs upstream.

## Safe release workflow

1. Make converter/content changes upstream first when possible
2. Sync into this repo with `bun run sync:upstream`
3. Re-apply or verify Pi-only compatibility changes
4. Run tests:

```bash
bun test
doctor_packages
npm pack --dry-run
```

5. Smoke test in Pi:

```text
/ce:brainstorm
/ce:plan
/ce:review
/ce:work
```

## Anti-goal

Do **not** let this repo become a second independently evolving plugin fork.

If unsure where a change belongs, default to:
- upstream plugin repo first
- this repo second
