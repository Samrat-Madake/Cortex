# Cortex Video Runner

`eval/video-runner/` is for product-style E2E checks of the Cortex/OpenClaw flow.
It is separate from dataset benchmarks under `eval/benchmark/`.

Typical usage:

```bash
cd /path/to/Cortex

CORTEX_E2E_VIDEO=/path/to/authorized-test-video.mp4 npx tsx eval/video-runner/runner.ts
CORTEX_E2E_VIDEO=/path/to/authorized-test-video.mp4 npx tsx eval/video-runner/runner.ts --preflight-only
CORTEX_E2E_VIDEO=/path/to/authorized-test-video.mp4 npx tsx eval/video-runner/runner.ts --services=reuse
```

Fixtures and reports live under:

```text
eval/video-runner/fixtures/videos/
eval/video-runner/fixtures/e2e-report.md
```

Test videos are not bundled by default. Provide an authorized local video with
`CORTEX_E2E_VIDEO`, or place a project-approved public fixture under
`eval/video-runner/fixtures/videos/` and point the variable at it.

Common environment variables:

```bash
CORTEX_E2E_VIDEO=/path/to/authorized-test-video.mp4
E2E_MEM_PORT=28219
E2E_DASHBOARD_PORT=3213
GO2RTC_URL=http://localhost:1984
QDRANT_URL=http://localhost:6333
```
