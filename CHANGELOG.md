# Changelog

## 0.2.0

Correctness release. Every claim below was verified by executing `wslc` 2.9.4.0
on a Windows Server 2025 runner, not read from documentation.

### Fixed: the GPU rule was inverted (this is why you want to upgrade)

0.1.0 rewrote `--gpus all` into `--device nvidia.com/gpu=all`. That is backwards:
wslc has `--gpus` natively, and has **no `--device` flag at all**. The translator
was turning working commands into ones that fail with `Argument name was not
recognized for the current command`. `--gpus` is now kept verbatim, and `--device`
is dropped with a warning.

### Fixed: health checks are supported

`wslc run` implements `--health-cmd`, `--health-interval`, `--health-retries`,
`--health-timeout`, `--health-start-period` and `--no-healthcheck`. 0.1.0 reported
healthchecks as entirely missing. A Compose `healthcheck:` block now translates
flag-for-flag onto the generated `wslc run`. What is genuinely missing is a Compose
runtime that reads the block, and `depends_on` gating on health state.

### Fixed: memory units are case-sensitive

`-m 512m` is rejected by wslc with `Invalid memory argument value`; `512M` works.
Docker accepts both, so copied commands broke. `--memory`, `-m` and `--shm-size`
values are now uppercased automatically, including Compose `mem_limit` and
`shm_size`.

### Fixed: flags that do not exist are no longer emitted

`--cap-add`, `--cap-drop`, `--privileged`, `--security-opt`, `--expose` and
`--device` are dropped with a warning instead of passed through. The Compose
analyser no longer generates `--cap-add` or `--device` either.

### Fixed: `--network host` is refused, not ignored

wslc exits non-zero with `host mode networking is not supported`. It is reported
as an error, and such commands now exit 2 (unmigratable) rather than 1 (degraded),
matching the documented exit-code contract. `--network none` is valid.

### Fixed: missing subcommands

There is no `wslc restart` in any form, so `docker restart` no longer translates to
one. Same for `pause`, `unpause`, `top`, `wait`, `port`, `rename`, `diff`, `commit`,
`info`, `image history`, `image search`, and `system prune|df|info`. Prune is
per-noun: `wslc container|image|volume|network prune`.

`docker cp` requires the noun form (`wslc container cp`); there is no top-level
`wslc cp`. Conversely `ps`, `images`, `rm`, `rmi` and `create` **do** work
top-level, since `ls`/`ps` are registered aliases of `list` and `rm`/`delete` of
`remove` — those renames are stylistic, not breaking.

### Fixed: shell quoting in generated Compose commands

Values containing spaces (health commands, `environment` entries, `entrypoint`)
were emitted unquoted, so `--health-cmd pg_isready -U postgres` silently split into
the wrong arguments. All such values are now shell-quoted.

### Fixed: `stop_grace_period` compound durations

`1m30s` passed through unchanged instead of becoming `--stop-timeout 90`.

### Added

- Compose keys now translated: `shm_size`, `mem_limit`, `cpus`, `dns`, `ulimits`,
  `domainname`, `stop_signal`, `stop_grace_period`, `tmpfs`, `healthcheck`.
- Compose keys now correctly reported as unsupported: `network_mode`, `privileged`,
  `security_opt`, `expose`, `cap_add`, `cap_drop`, `devices`.
- Cross-language parity check extended to the Compose analyser, so the Python and
  JS engines cannot drift.

### Breaking

- Output changes for `--gpus`, `--device`, `--network host`, size units, and the
  dropped flags listed above. If you pinned expected output, re-record it.
- `--network host` and other `severity=error` findings now exit 2 instead of 1.
  CI gates keyed on exit 1 will see 2 for these.

### Release status

| Package | 0.2.0 |
| --- | --- |
| PyPI `docker2wslc` | published, verified by installing from pypi.org |
| npm `docker2wslc` | published, verified by installing from registry.npmjs.org |
| npm `wslc-mcp` | published, verified over a real stdio JSON-RPC round trip |
| VS Code `wslc-compatibility` | `.vsix` builds and passes tests; **never published** to the Marketplace (no publisher token). Install the `.vsix` manually. |

## 0.1.0

Initial release.
