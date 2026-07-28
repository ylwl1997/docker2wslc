# docker2wslc

Tooling for [**wslc**](https://wslcontainers.com) — the native Linux container runtime built into
the Windows Subsystem for Linux, which runs OCI containers on Windows 11 without Docker Desktop.

One rule table, four consumers. No network calls, no daemon, no telemetry.

| Package | Registry | What it does |
|---------|----------|--------------|
| [`docker2wslc`](packages/py) | [PyPI](https://pypi.org/project/docker2wslc/) | CLI + Python API: convert, compose, lint |
| [`docker2wslc`](packages/cli) | [npm](https://www.npmjs.com/package/docker2wslc) | Same CLI for Node, same output |
| [`wslc-mcp`](packages/mcp) | [npm](https://www.npmjs.com/package/wslc-mcp) | MCP server for Claude Code, Cursor, Windsurf |
| [`wslc-compatibility`](packages/vscode) | VS Code Marketplace | Inline diagnostics for Compose / devcontainer files |

## Quick start

```bash
# Python
pip install 'docker2wslc[yaml]'
docker2wslc convert docker run --gpus all -p 80:80 nginx

# Node
npx docker2wslc lint .

# AI agents
claude mcp add wslc -- npx -y wslc-mcp
```

```console
$ docker2wslc convert docker run --gpus all --restart always -p 8080:80 nginx
wslc run --device nvidia.com/gpu=all -p 8080:80 nginx

Migration notes
  WARN  Restart policies are not implemented in the wslc preview. Flag dropped — use a
        Windows scheduled task or a wrapper script for auto-restart.
  INFO  GPU access in wslc goes through the Container Device Interface. Use
        `--device nvidia.com/gpu=all` instead of `--gpus`.
```

## Exit codes

Meaningful, so `lint` works as a CI gate:

| Code | Meaning |
|------|---------|
| `0` | Fully compatible |
| `1` | Degraded — flags dropped or rewritten, still runnable |
| `2` | Unmigratable — Compose, Swarm, buildx, or a parse failure |

## The rule worth knowing

**CLI-driven tooling ports to wslc. API-driven tooling does not.**

wslc is daemonless: no `dockerd`, no socket, no Engine API. Anything that opens a Docker socket
cannot attach; anything that shells out to a binary works once pointed at `wslc`.

That explains why [VS Code Dev Containers works](https://wslcontainers.com/guides/vscode-dev-containers/)
(set `dev.containers.dockerPath` to `wslc`) while
[Testcontainers cannot](https://wslcontainers.com/guides/testcontainers/), no matter how you set
`DOCKER_HOST`.

## Architecture

[`rules.json`](rules.json) is the single source of truth — verb mappings, flag behaviour, Compose
and devcontainer key support, tool compatibility. Every package reads it, so the Python CLI, the
npm CLI, the MCP server and the VS Code extension cannot drift apart.

A parity test asserts the Python and JavaScript engines produce byte-identical output (command,
exit code and notes) across the full case matrix.

```
rules.json ──┬── packages/py      (PyPI)
             ├── packages/cli     (npm)
             ├── packages/mcp     (npm, MCP)
             └── packages/vscode  (Marketplace)
```

## Development

```bash
# Python
cd packages/py && python -m venv .venv && .venv/bin/pip install -e '.[yaml]' pytest
.venv/bin/python -m pytest tests/ -q

# Node CLI
cd packages/cli && npm install && npm test

# MCP server (real stdio JSON-RPC round trip)
cd packages/mcp && npm install && node test/e2e.mjs

# VS Code extension (headless, stubbed vscode API)
cd packages/vscode && npm install && node --test 'test/**/*.test.cjs'
```

`rules.json` lives at the repo root and is copied into each package at build time. Edit the root
copy, never a package copy.

## Accuracy

Rules target the **2026-07 wslc public preview**. wslc is a moving target — if a mapping is wrong,
[open an issue](https://github.com/ylwl1997/docker2wslc/issues) with the command you ran and the
actual `wslc` output. Corrections are the most useful contribution.

Not affiliated with Microsoft or Docker, Inc.

## Docs

Full guides at [wslcontainers.com](https://wslcontainers.com):
[install](https://wslcontainers.com/guides/install/) ·
[cheat sheet](https://wslcontainers.com/reference/cheatsheet/) ·
[vs Docker Desktop](https://wslcontainers.com/guides/vs-docker-desktop/) ·
[Compose migration](https://wslcontainers.com/guides/compose/) ·
[Dev Containers](https://wslcontainers.com/guides/vscode-dev-containers/) ·
[Testcontainers](https://wslcontainers.com/guides/testcontainers/)

MIT licensed.
