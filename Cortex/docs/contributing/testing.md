# Testing Guide

> How Cortex is tested, which commands to run, and one non-negotiable
> rule: use real data.

Cortex follows a test pyramid. TypeScript uses Vitest, Python
`services/mem` uses pytest, and offline quality regression uses `eval/`.

---

## 1. Test Pyramid

```text
        /\
       /  \        L3 E2E
      /----\       few, slow, no internal mocks
     /      \      L2 Integration
    /--------\     real local infrastructure
   /          \    L1 Unit
  /------------\   many, fast, external I/O mocked only
```

| Layer | Isolation | What can be mocked | What it verifies |
|---|---|---|---|
| **L1 Unit** | In-process pure or near-pure logic | External I/O only: network, filesystem, DB, third-party APIs | Business logic itself, such as identity decisions from given evidence |
| **L2 Integration** | Real local infrastructure | No internal module mocks; use local Qdrant/mem when needed | Service/module wiring and contract round trips |
| **L3 E2E** | Full chain | No internal mocks | Real input video/segment through memory and Dashboard events |

Rules:

- Do not skip layers. Make L1 pass before L2, then L3.
- Assertions must be meaningful. Do not use `assert True`, `result is not None`,
  or `toBeDefined()` without checking concrete values, structure, or counts.
- L1 may mock external I/O boundaries only. Core logic must run for real.

### Naming Convention

We do not encode layers in filenames such as `*.l1.test.ts`.

- **TypeScript**: tests live under `packages/<pkg>/src/__tests__/` and use the
  object-under-test name, such as `pipeline.test.ts`. Integration tests use
  `.integration.test.ts`.
- **Python**: tests live under `services/mem/tests/test_*.py`; shared fixtures
  live in `conftest.py`.

Vitest collects `packages/*/src/**/*.test.ts` and `tests/**/*.test.ts`.

---

## 2. Running Tests

### TypeScript

```bash
npm run typecheck
npx vitest run
npx vitest run packages/percept
npx vitest run packages/percept/src/__tests__/identity-resolver.test.ts
npm run test:watch
```

`npm run test` is equivalent to `vitest run`. Run typecheck before tests. The
typecheck command also covers `eval/` through `tsconfig.eval.json`.

### Python Memory Service

```bash
cd services/mem
uv sync --extra dev
uv run pytest
uv run pytest tests/test_reid.py -v
uv run ruff check src tests
```

`pyproject.toml` sets `asyncio_mode = "auto"`, so async tests do not need
individual `@pytest.mark.asyncio`.

Tests marked `qdrant` require a writable Qdrant instance. They probe the
configured endpoint once and skip with a clear reason when it is unavailable.
The default is `localhost:6333`; override it with `QDRANT_TEST_URL`, or with
`CORTEX_TEST_QDRANT_HOST` and `CORTEX_TEST_QDRANT_PORT`. Use a
dedicated test instance rather than a shared development database.

---

## 3. No-Mock-Data Rule

> Do not invent fake, random, or placeholder data for tests. Use real data.

This matters because identities, memories, and detections are evidence. A green
test on fabricated data can encode the wrong behavior.

How to apply it:

1. **Use real samples and fixtures**. Reuse existing videos, ground truth, and
   golden data from fixture directories such as `eval/video-runner/fixtures/`,
   `eval/benchmark/fixtures/`, and `services/mem/tests/`. If data is missing,
   ask maintainers for a real sample instead of fabricating JSON.
2. **Use real local infrastructure for L2/L3**. When a test needs Qdrant or the
   memory service, run a real local instance.
3. **Only external third-party HTTP may be mocked** in L1/L2, such as VLM calls
   or remote Qdrant HTTP. The mock is the network boundary, not the business
   data. Inputs passed into logic must still have real shapes and semantics.
4. **No internal mocks in L3**. E2E means real video in, real chain, real memory
   out.

Ask one question when considering a mock: are you mocking external network I/O,
or are you replacing data/logic that should be real? The former can be allowed
in L1/L2; the latter is not allowed.

---

## 4. Benchmarks and Offline Quality Evaluation

`eval/` contains reproducible evaluation and validation entry points. Unit tests
verify logic; eval verifies quality.

```text
eval/
├── benchmark/     dataset benchmark framework, lmms-eval integration, offline video QA
└── video-runner/  product-chain E2E video validation
```

Dataset benchmark:

```bash
npm run benchmark:setup
bash eval/benchmark/pipeline/run.sh --dataset <dataset.json> --videos <video_id>
```

`eval/benchmark/pipeline/` provides frame extraction, segment processing,
memory dump/rehydrate, and Agent QA. With the same snapshot and dataset, the
offline quality path should produce comparable results.

Product-level E2E video validation:

```bash
npx tsx eval/video-runner/runner.ts
```

`video-runner` feeds real test videos through the product chain, asserts
end-to-end behavior, and writes reports. Fixtures live under
`eval/video-runner/fixtures/`.

---

## 5. PR Test Checklist

1. `npm run typecheck` passes, including `eval/`.
2. `npx vitest run` is green. New or changed logic has L1 coverage with
   meaningful assertions.
3. If `services/mem` changed, `cd services/mem && uv run pytest` and
   `uv run ruff check` are green.
4. If perception or memory quality changed, run the relevant `eval/` benchmark
   and confirm no quality regression.
5. No fake test data. New fixtures are real samples; mocks are only external
   VLM/Qdrant HTTP boundaries where appropriate.
