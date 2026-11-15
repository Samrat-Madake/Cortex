# Security Policy

This document covers two topics: how to report security vulnerabilities, and Cortex's trust boundary between local trusted use and public deployment.

## Reporting A Vulnerability

If you find a security vulnerability, do not open a public issue, public PR, or public discussion. Please disclose privately:

- Contact: `info@addx.ai`
- You may also use GitHub Security Advisories through the repository Security tab.

Please include the affected component/version, reproduction steps or PoC, impact assessment, and any suggested fix if available.

Response expectations:

- We will acknowledge receipt within 5 business days.
- After assessment, we will coordinate fix and disclosure timing with you and credit the reporter unless you prefer to remain anonymous.
- Please give us a reasonable remediation window before publishing details.

### Supported Versions

Security fixes target the latest code on the default `main` branch. Cortex is under active development and does not currently provide long-term support branches.

## Trust Boundary: Local Trusted Use vs Public Deployment

Cortex defaults to local, single-user, trusted use. Under that assumption, some permissive defaults are intentional usability tradeoffs rather than vulnerabilities: permissive CORS, local tool APIs, permissive video source parsing, and broad local event visibility.

These assumptions only hold for loopback, single-machine, self-use. If you expose the service to a LAN, the public internet, a public demo, or multi-user hosting, those same defaults become attack surfaces that must be closed first.

### Local Trusted Mode Assumptions

The runtime host, HTTP server, WebSockets, tool API, and Dashboard proxy assume the visitor is the person running Cortex on the local machine. In this mode, the following are intentional conveniences:

- permissive CORS for local frontend development;
- local Agent tool APIs such as `/api/tool/:toolName` and Dashboard tool proxy surfaces;
- permissive video `source` parsing, including local file paths and arbitrary `http(s)`/`rtsp` sources;
- unscoped event visibility in single-user mode.

### Risks When Exposed Beyond Loopback

If Cortex binds to a non-loopback address or runs in a public environment without the boundaries below, known attack surfaces include:

- **SSRF and arbitrary file reads:** user-controlled `source` can reach ffmpeg/go2rtc and may access cloud metadata, private networks, or local files.
- **Unauthenticated cross-tenant data operations:** an exposed mem service without auth could allow reset, read, or delete operations against other users' memories.
- **Client-controlled `user_id` through proxy:** Dashboard proxy routes must not let clients choose another user's scope.
- **Event injection:** `/api/memory-event` must not accept arbitrary network clients.
- **CSWSH and connection flood:** WebSockets need Origin checks, connection limits, and payload limits.
- **Cost DoS:** chat and inference routes need rate limiting.
- **Resource DoS:** large uploads, ffmpeg subprocesses, and file streams need size/concurrency/close handling.
- **Privacy leakage:** unscoped monitor events and persistent traces may contain summaries, transcripts, source URLs, keyframe paths, and prompt context.

### Required Boundaries Before Public Deployment

Before exposing Cortex to a LAN, public internet, public demo, or multi-user hosting, enable the following:

- **Loopback binding:** HTTP/WS host and managed child services should bind to `127.0.0.1` by default. Bind other interfaces only behind an explicit public/LAN mode.
- **Auth:** session or token checks must cover all mutation, proxy, chat, and webhook routes. Child services such as mem should use shared-token auth when exposed beyond loopback.
- **Server-derived identity:** isolation keys such as `user_id` must be derived from the server-side session, not accepted from request bodies. Dangerous operations such as `/reset` and bulk `DELETE` should be denied or admin-gated.
- **Source allowlist and SSRF protection:** validate schemes, resolve DNS, reject loopback/link-local/private ranges by default, and disable local file paths unless explicitly allowed. `CORTEX_ALLOW_PRIVATE_SOURCE` and `CORTEX_ALLOW_LOCAL_SOURCE` are escape hatches for trusted local/private deployments, not public demos.
- **Dashboard/tool public-mode gating:** when `DASHBOARD_MULTI_USER=true` or `CORTEX_PUBLIC_MODE=true`, validate WebSocket Origin, limit connections, rate-limit chat, and admin-gate CLI tool APIs.
- **Rate limiting:** apply per-session limits to chat, inference, and write-heavy routes.
- **WebSocket limits:** use Origin allowlists, connection caps, and `maxPayload`.
- **Default-deny event visibility:** non-loopback deployments must scope events by session.
- **Resource limits:** stream uploads to disk, enforce per-session upload count/size limits, kill ffmpeg on client disconnect, set timeouts and concurrency limits, and handle stream `error`/`close`.
- **Privacy review:** assess whether traces and `llm_calls` persist full prompt context; public deployments should minimize sensitive stored context and ensure no credential material is persisted.

### Public Deployment Checklist

- [ ] HTTP/WS host and child services bind only to loopback unless an explicit public flag is enabled.
- [ ] All mutation, proxy, chat, and webhook routes require session/token auth.
- [ ] `user_id` and related isolation keys are server-derived.
- [ ] Video `source` rejects `file:///...`, cloud metadata addresses, loopback, and private ranges unless explicitly allowed.
- [ ] Public/hosted environments do not enable `CORTEX_ALLOW_PRIVATE_SOURCE` or `CORTEX_ALLOW_LOCAL_SOURCE`; network egress rules also block private, loopback, link-local, and cloud metadata ranges.
- [ ] Chat, inference, and write routes have per-session rate limits.
- [ ] WebSockets enforce Origin allowlist and connection/payload limits.
- [ ] OpenAI-compatible chat rate limits match expected public capacity.
- [ ] CLI tool APIs require an admin token in public mode, and tokens are never exposed to browser clients.
- [ ] Event visibility defaults to deny and is scoped by session outside loopback.
- [ ] Upload, ffmpeg, and file-stream paths have size/concurrency limits and disconnect cleanup.
- [ ] Trace/prompt persistence privacy impact has been reviewed and credential material is not stored.
- [ ] Runbooks match actual code behavior for binding and auth.

These boundaries should be updated as hardening progresses. For public or multi-user deployments, also read the auth matrix in `docs/reference/http-api.md` and deployment configuration in `docs/user-guide/configuration.md`.
