# docker2wslc

Translate Docker commands, Compose files and dev container configs to
[**wslc**](https://wslcontainers.com) — the native Linux container runtime built into the
Windows Subsystem for Linux, which runs containers on Windows 11 without Docker Desktop.

No network calls, no daemon, no telemetry. Pure rule-driven translation.

```bash
npm install -g docker2wslc
# or run without installing:
npx docker2wslc convert docker ps -a
```

## Convert a command

```console
$ docker2wslc convert docker run --gpus all --restart always -p 8080:80 nginx
wslc run --device nvidia.com/gpu=all -p 8080:80 nginx

Migration notes
  WARN  Restart policies are not implemented in the wslc preview. Flag dropped — use a
        Windows scheduled task or a wrapper script for auto-restart.
  INFO  GPU access in wslc goes through the Container Device Interface. Use
        `--device nvidia.com/gpu=all` instead of `--gpus`.
```

Commands come from arguments, a file, or stdin:

```bash
docker2wslc convert docker ps -a
docker2wslc convert --file deploy.sh
cat deploy.sh | docker2wslc convert
```

## Analyse a Compose file

wslc has **no Compose runtime**. This turns each service into an equivalent `wslc run`
and tells you exactly what cannot be carried over:

```console
$ docker2wslc compose docker-compose.yml
# wslc has no Compose runtime. Equivalent commands:

wslc volume create pgdata
wslc network create backend

# service: web
wslc run -d --name web -e NGINX_HOST=localhost -p 8080:80 --network backend nginx:alpine
  x depends_on: No dependency ordering. Start services in order yourself and add readiness waits.
  x restart: No restart policies in the wslc preview.

# service: db
wslc run -d --name db -v pgdata:/var/lib/postgresql/data postgres:16-alpine
  x healthcheck: wslc has no healthcheck support; depends_on conditions relying on it cannot work.
```

## Lint a repository

Scans for `docker-compose.y*ml`, `compose.y*ml` and `devcontainer.json`:

```bash
docker2wslc lint .
```

## Use in CI

Exit codes are meaningful, so this works as a gate:

| Code | Meaning |
|------|---------|
| `0` | Fully compatible |
| `1` | Degraded — flags dropped or rewritten, still runnable |
| `2` | Unmigratable — Compose, Swarm, buildx, or a parse failure |

```yaml
- run: npx docker2wslc lint .    # fails the job on exit 2
```

## JavaScript API

```js
import { translate } from 'docker2wslc';
import { analyse } from 'docker2wslc/compose';

const result = translate('docker run --platform linux/amd64 -it ubuntu bash');
console.log(result.output);    // wslc run -it ubuntu bash
console.log(result.exitCode);  // 1
result.notes.forEach((n) => console.log(n.severity, n.text));

const report = analyse(fs.readFileSync('docker-compose.yml', 'utf-8'));
```

`--json` on any subcommand gives the same structure for shell pipelines.

There is an identical [Python package](https://pypi.org/project/docker2wslc/) sharing the same
rule table, and a [`wslc-mcp`](https://www.npmjs.com/package/wslc-mcp) MCP server for AI agents.

## What wslc cannot do

Worth knowing before you migrate. These are runtime limitations, not gaps in this tool:

- **No Compose runtime** — translate services by hand, see the [migration guide](https://wslcontainers.com/guides/compose/)
- **No restart policies** — use a scheduled task
- **No `--platform`** — host architecture only
- **No healthchecks** — so `depends_on` conditions cannot work
- **No Docker socket or Engine API** — [Testcontainers, Portainer and act cannot attach](https://wslcontainers.com/guides/testcontainers/)
- **No buildx / bake** — single-platform `wslc build` only
- **GPU via CDI** — `--device nvidia.com/gpu=all`, not `--gpus all`

CLI-driven tooling ports to wslc. API-driven tooling does not. That single distinction
explains most migration surprises — including why
[VS Code Dev Containers *does* work](https://wslcontainers.com/guides/vscode-dev-containers/)
once you set `dev.containers.dockerPath` to `wslc`.

## Docs

- Interactive converter — <https://wslcontainers.com>
- Command cheat sheet — <https://wslcontainers.com/reference/cheatsheet/>
- Install guide — <https://wslcontainers.com/guides/install/>
- wslc vs Docker Desktop — <https://wslcontainers.com/guides/vs-docker-desktop/>

## Accuracy

Rules target the **2026-07 wslc public preview** and live in a single
[`rules.json`](https://github.com/ylwl1997/docker2wslc/blob/main/rules.json) shared by the
Python package, the npm CLI, the MCP server and the VS Code extension. wslc is a moving
target; if you hit a mapping that is wrong,
[open an issue](https://github.com/ylwl1997/docker2wslc/issues) with the command and the
actual `wslc` output.

MIT licensed.
