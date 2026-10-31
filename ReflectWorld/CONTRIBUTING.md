# Contributing Guide

Thank you for your interest in ReflectWorld. This guide explains how to contribute changes, from fork to PR merge.

ReflectWorld is a TypeScript monorepo using npm workspaces plus one Python child service under `services/mem`. Most commands below run from the repository root. Python-specific steps are called out explicitly.

This page covers contribution workflow only. For environment setup and local development, read [docs/contributing/development.md](docs/contributing/development.md). For testing policy and commands, read [docs/contributing/testing.md](docs/contributing/testing.md).

## Code Of Conduct

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Keep communication professional and respectful.

## Issues And Feature Requests

- Bugs: open an issue with reproduction steps, expected behavior, actual behavior, and environment details such as Node/Python versions and OS. A minimal reproduction is best.
- Features or large changes: open an issue or discussion before coding so direction can be aligned early. The larger the change, the more important this is.
- Security vulnerabilities: do not use public issues. Follow [SECURITY.md](SECURITY.md).

## Development Workflow

### 1. Fork And Clone

```bash
git clone git@github.com:<your-username>/ReflectWorld.git
cd ReflectWorld
git remote add upstream git@github.com:addxai/ReflectWorld.git
```

### 2. Create A Branch

Do not work directly on `main`. Start from the latest upstream main:

```bash
git fetch upstream
git checkout -b feat/<short-description> upstream/main
# or fix/<short-description>, docs/<short-description>, refactor/<short-description>
```

### 3. Install And Build

```bash
npm install
npm run build
cp .env.example .env
```

For a minimal Level 0 / VLM-only run, fill in the `VLM_*` settings.

When changing `services/mem`, use `uv` rather than a hand-managed `pip`/`venv` workflow:

```bash
cd services/mem
uv sync --extra dev
```

Prerequisites are Node `>=22`, Python `>=3.11`, and a recent `uv`. Full setup details are in [docs/contributing/development.md](docs/contributing/development.md).

### 4. Write Code

- Put shared contracts in `shared`, business logic in the owning package, and orchestration in `reflectworld`.
- `shared` must not depend on business packages. `cam` and `percept` should not directly import each other; they are wired by the orchestrator and share contracts through `shared`.
- Code comments, docstrings, and public documentation should be English. If a
  maintainer keeps a non-English draft for review, it should stay in a private
  or internal archive and must not be part of the public docs tree.
- Core libraries should not use `console.*` for logic tracing. CLI/script/demo user output is allowed.
- Do not leave placeholder `TODO`/`FIXME`/`HACK`, commented-out code blocks, or `_v2`/`_old`/`_backup` files.
- `packages/monitor` is deprecated; new UI work belongs in `dashboard`. Spatial/SLAM code is not part of the phase-one open-source tree.

## Pre-Submit Gates

These checks are mandatory before submitting a PR.

### TypeScript

```bash
npm run typecheck
npx vitest run
```

Run typecheck before tests. New or changed logic should have meaningful tests that assert concrete values, structures, or counts. Do not add tests that only assert existence.

### Python, Only When Changing `services/mem`

```bash
cd services/mem
uv run pytest
uv run ruff check src tests
```

### Quality Regression, When Changing Perception Or Memory Quality

If you change detection, ReID, memory merge, VLM prompts, or related quality paths, run the relevant eval checks:

```bash
npx tsx eval/video-runner/runner.ts
```

Dataset benchmarks are covered in [docs/contributing/testing.md](docs/contributing/testing.md).

### No Fake Data

Do not invent fake, random, or placeholder business data for tests. Use real samples and fixtures. The only allowed mocks are network boundaries for external third-party APIs such as VLM providers or remote Qdrant HTTP. Mock the I/O boundary, not the business data.

## Commits

- One commit should do one thing.
- Use imperative commit messages that explain what changed and why. Prefixes such as `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, and `chore:` are encouraged.
- Do not mix unrelated edits or generated artifacts such as `dist/` and `bundled-*` into the same commit.
- Keep history clean. Squash local typo/lint fixups before submitting when appropriate.

## Pull Requests

1. Sync upstream before pushing:

   ```bash
   git fetch upstream
   git rebase upstream/main
   git push origin feat/<short-description>
   ```

2. Open a PR from your branch to upstream `main`.

3. In the PR description, include:
   - what problem or feature this addresses, with issue links such as `Closes #123`;
   - important technical decisions and tradeoffs;
   - checks you ran locally, such as typecheck, vitest, pytest, and screenshots for UI changes.

4. PR requirements:
   - all gates above pass locally and in CI;
   - new or changed logic has meaningful tests;
   - no fake data, placeholders, personal paths, or secrets;
   - docs are updated when behavior changes.

5. Respond to review with focused follow-up commits or discussion. Avoid force-pushing over active review history unless maintainers ask for it.

6. Merge requires at least one maintainer approval and green CI.

## Documentation Rules

- Update existing docs rather than creating duplicates.
- Do not create `_tmp`, `_old`, `_backup`, `_v2`, or `_copy` files.
- Architecture, data-flow, and pipeline explanations should prefer Mermaid or ASCII diagrams when diagrams make the idea clearer.

Thank you for contributing. If the process is unclear, open a discussion or ask in an issue.
