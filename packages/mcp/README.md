# wslc-mcp

MCP server that teaches AI coding agents how [**wslc**](https://wslcontainers.com) works — the
native Linux container runtime in the Windows Subsystem for Linux, which runs containers on
Windows 11 without Docker Desktop.

Models are consistently wrong about wslc because it is new and its limits are non-obvious. This
server gives them ground truth: real command translation, Compose migration analysis, and the
tool-compatibility rule that explains most migration surprises.

## Install

Claude Code:

```bash
claude mcp add wslc -- npx -y wslc-mcp
```

Cursor / Windsurf / Zed — add to your MCP config:

```json
{
  "mcpServers": {
    "wslc": {
      "command": "npx",
      "args": ["-y", "wslc-mcp"]
    }
  }
}
```

No API key, no network calls, no telemetry. Translation is entirely local and rule-driven.

## Tools

| Tool | Use it for |
|------|-----------|
| `convert_docker_command` | Translate a docker command to wslc, with notes on dropped or rewritten flags |
| `analyze_compose` | Turn a `docker-compose.yml` into `wslc run` commands and list what cannot migrate |
| `check_tool_compatibility` | "Does Testcontainers / Portainer / act work with wslc?" |
| `check_devcontainer` | Validate `devcontainer.json` and get the required VS Code setting |
| `get_wslc_limitations` | What you give up moving off Docker Desktop |

## Example

> **You:** convert `docker run --gpus all --restart always -p 80:80 nginx` for wslc

```
wslc run --device nvidia.com/gpu=all -p 80:80 nginx

Migration notes:
- [warn] Restart policies are not implemented in the wslc preview. Flag dropped — use a
  Windows scheduled task or a wrapper script for auto-restart.
- [info] GPU access in wslc goes through the Container Device Interface. Use
  `--device nvidia.com/gpu=all` instead of `--gpus`.

Verdict: degraded (flags changed)
```

## The rule worth knowing

**CLI-driven tooling ports to wslc. API-driven tooling does not.**

wslc is daemonless: no `dockerd`, no socket, no Engine API. So anything that opens a Docker
socket cannot attach, while anything that shells out to a binary works fine once you point it
at `wslc`.

That single distinction explains why
[VS Code Dev Containers works](https://wslcontainers.com/guides/vscode-dev-containers/) (it
invokes a CLI — set `dev.containers.dockerPath` to `wslc`) while
[Testcontainers cannot](https://wslcontainers.com/guides/testcontainers/) (it opens a socket).
No amount of `DOCKER_HOST` configuration changes that.

## Related

- `docker2wslc` on [npm](https://www.npmjs.com/package/docker2wslc) and
  [PyPI](https://pypi.org/project/docker2wslc/) — the same engine as a CLI
- Interactive converter — <https://wslcontainers.com>
- Command cheat sheet — <https://wslcontainers.com/reference/cheatsheet/>

## Accuracy

Rules target the **2026-07 wslc public preview** and live in a single
[`rules.json`](https://github.com/ylwl1997/docker2wslc/blob/main/rules.json) shared with the
CLI packages and the VS Code extension. wslc is a moving target — if a mapping is wrong,
[open an issue](https://github.com/ylwl1997/docker2wslc/issues) with the command and the actual
`wslc` output.

MIT licensed.
