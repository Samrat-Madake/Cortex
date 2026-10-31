# ReflectWorld Documentation

> **ReflectWorld** is a local-first visual perception and persistent memory
> platform. It gives agents eyes and memory.

This directory is the documentation hub for the project. The documentation
tracks the current source tree; historical planning artifacts are not shipped
with the public repository.

## Quick Navigation

| Goal | Go to |
|---|---|
| Understand the system architecture | [architecture/overview.md](./architecture/overview.md) |
| Install, start, and configure ReflectWorld | [user-guide/](./user-guide/) |
| Look up HTTP APIs or configuration keys | [reference/](./reference/) |
| Contribute code or open a PR | [contributing/](./contributing/) |

## user-guide/ - Running ReflectWorld

- [quickstart.md](./user-guide/quickstart.md) - first standalone run from `.env` to Dashboard chat
- [installation.md](./user-guide/installation.md) - prerequisites, setup, runtime directories, Level 0 vs Level 1
- [configuration.md](./user-guide/configuration.md) - practical configuration for standalone and OpenClaw plugin modes
- [dashboard.md](./user-guide/dashboard.md) - source management, live view, segment cards, entities, memory, and chat

## architecture/ - System Overview

- [overview.md](./architecture/overview.md) - public architecture shape, package map,
  segment flow, memory model, identity model, and runtime boundaries.

## reference/ - Contracts And Public Interfaces

- [cli.md](./reference/cli.md) - `@reflectworld/reflectworld` CLI commands and options
- [configuration.md](./reference/configuration.md) - complete configuration contract and env mapping
- [http-api.md](./reference/http-api.md) - Dashboard, host, tool, memory, and media HTTP APIs

## contributing/ - Contributor Documentation

Contributor docs cover the practical workflow for local development and tests.

- [development.md](./contributing/development.md) - local setup, monorepo layout, services, and Dashboard dev
- [testing.md](./contributing/testing.md) - test pyramid, typecheck, vitest, pytest, benchmarks, and no-mock-data rules
