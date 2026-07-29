# wslc Compatibility

Inline diagnostics for `docker-compose.yml` and `devcontainer.json` files, flagging
the keys that will **not** work under `wslc` — the native WSL container runtime that
ships with Windows 11 (`wsl --install-container-runtime`).

Every rule in this extension was verified by executing `wslc 2.9.4.0` on Windows
Server 2025 and reading the actual output. Nothing is inferred from documentation.

## What it flags

- Compose keys wslc has no equivalent for: `build`, `depends_on` health gating,
  `cap_add`, `cap_drop`, `devices`, `privileged`, `security_opt`, `expose`,
  `network_mode: host`, `deploy`, `profiles`
- `devcontainer.json` features that rely on Docker Compose or `runArgs` flags
  wslc rejects
- Values wslc parses differently — for example `mem_limit: 512m` must be `512M`,
  because wslc answers lowercase units with `Invalid memory argument value`

## What it deliberately does not flag

`healthcheck:` is **supported**. `wslc run` has `--health-cmd`, `--health-interval`,
`--health-retries`, `--health-start-period`, `--health-timeout` and `--no-healthcheck`.
Only the Compose *runtime* that reads a `healthcheck:` block, and `depends_on`
gating on health state, are missing.

`--gpus` is **supported** and native. It is `--device` that wslc lacks.

## Companion tools

| Tool | Install |
| --- | --- |
| CLI | `npx docker2wslc convert docker run …` |
| Python | `pip install docker2wslc` |
| MCP server | `npx wslc-mcp` |

Reference: <https://wslcontainers.com>

## License

MIT
