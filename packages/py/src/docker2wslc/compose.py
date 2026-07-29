"""Compose migration analyser: docker-compose.yml -> wslc run equivalents."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .translate import RULES

COMPOSE_KEYS: dict[str, dict[str, Any]] = RULES["compose"]["keys"]


@dataclass
class ServiceReport:
    name: str
    command: str = ""
    ok: list[str] = field(default_factory=list)
    partial: list[tuple[str, str]] = field(default_factory=list)
    missing: list[tuple[str, str]] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)


@dataclass
class ComposeReport:
    services: list[ServiceReport] = field(default_factory=list)
    prelude: list[str] = field(default_factory=list)
    parse_error: str | None = None

    @property
    def exit_code(self) -> int:
        if self.parse_error:
            return 2
        if any(s.missing for s in self.services):
            return 2
        if any(s.partial for s in self.services):
            return 1
        return 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "parseError": self.parse_error,
            "prelude": self.prelude,
            "services": [
                {
                    "name": s.name,
                    "command": s.command,
                    "ok": s.ok,
                    "partial": [{"key": k, "note": n} for k, n in s.partial],
                    "missing": [{"key": k, "note": n} for k, n in s.missing],
                    "unknown": s.unknown,
                }
                for s in self.services
            ],
            "exitCode": self.exit_code,
        }


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, dict):
        return [f"{k}={v}" for k, v in value.items()]
    return [str(value)]


def _upper_size(value: Any) -> str:
    """wslc rejects lowercase size units: 512m -> Invalid memory argument value."""
    return re.sub(
        r"^(\d+(?:\.\d+)?)\s*([kmgtKMGT])(b?|B?)$",
        lambda m: m.group(1) + m.group(2).upper() + m.group(3).upper(),
        str(value),
    )


_UNIT_SECONDS = {"h": 3600, "m": 60, "s": 1, "ms": 0.001, "us": 0.000001}


def _stop_seconds(value: Any) -> str:
    """--stop-timeout takes plain seconds; stop_grace_period is a Go duration.

    Compose allows compound forms like `1m30s`, so a single-unit regex is not
    enough -- `1m30s` must become 90, not pass through unchanged.
    """
    raw = str(value).strip()
    if re.fullmatch(r"\d+", raw):
        return raw
    parts = re.findall(r"(\d+(?:\.\d+)?)(ms|us|h|m|s)", raw)
    if not parts or "".join(n + u for n, u in parts) != raw:
        return raw
    total = sum(float(n) * _UNIT_SECONDS[u] for n, u in parts)
    return str(round(total))


def _shell_quote(value: Any) -> str:
    """Args are joined into one shell line, so whitespace must be quoted."""
    s = str(value)
    if s == "":
        return "''"
    if not re.search(r"""[\s"'$`\\|&;<>()*?!#~\[\]{}]""", s):
        return s
    return "'" + s.replace("'", "'\\''") + "'"


def _health_cmd(test: Any) -> str:
    """Compose test: is a string, or a list led by CMD / CMD-SHELL / NONE."""
    if not isinstance(test, list):
        return str(test)
    parts = [str(p) for p in test]
    head = (parts[0] if parts else "").upper()
    if head in ("CMD-SHELL", "CMD"):
        return " ".join(parts[1:])
    if head == "NONE":
        return ""
    return " ".join(parts)


def _build_run(name: str, svc: dict[str, Any]) -> str:
    args: list[str] = ["wslc", "run", "-d", "--name", svc.get("container_name") or name]

    for env in _as_list(svc.get("environment")):
        args += ["-e", _shell_quote(env)]
    for env_file in _as_list(svc.get("env_file")):
        args += ["--env-file", env_file]
    for port in _as_list(svc.get("ports")):
        args += ["-p", port.strip('"')]
    for vol in _as_list(svc.get("volumes")):
        args += ["-v", vol]
    for net in _as_list(svc.get("networks")):
        args += ["--network", net]
    # cap_add / cap_drop / devices / privileged / security_opt / expose are
    # deliberately NOT emitted: wslc 2.9.4 has no such flags, so emitting them
    # yields "Argument name was not recognized". They surface as findings.
    for label in _as_list(svc.get("labels")):
        args += ["--label", _shell_quote(label)]
    for tmp in _as_list(svc.get("tmpfs")):
        args += ["--tmpfs", tmp]
    for dns in _as_list(svc.get("dns")):
        args += ["--dns", str(dns)]
    for ulimit in _as_list(svc.get("ulimits")):
        args += ["--ulimit", _shell_quote(ulimit)]

    if svc.get("working_dir"):
        args += ["-w", str(svc["working_dir"])]
    if svc.get("user"):
        args += ["-u", str(svc["user"])]
    if svc.get("hostname"):
        args += ["--hostname", str(svc["hostname"])]
    if svc.get("domainname"):
        args += ["--domainname", str(svc["domainname"])]
    if svc.get("shm_size"):
        args += ["--shm-size", _upper_size(svc["shm_size"])]
    if svc.get("mem_limit"):
        args += ["-m", _upper_size(svc["mem_limit"])]
    if svc.get("cpus"):
        args += ["--cpus", str(svc["cpus"])]
    if svc.get("stop_signal"):
        args += ["--stop-signal", str(svc["stop_signal"])]
    if svc.get("stop_grace_period"):
        args += ["--stop-timeout", _stop_seconds(svc["stop_grace_period"])]
    # healthcheck maps flag-for-flag onto wslc run --health-* (verified 2.9.4.0).
    hc = svc.get("healthcheck")
    if isinstance(hc, dict):
        if hc.get("disable") in (True, "true"):
            args.append("--no-healthcheck")
        else:
            if hc.get("test"):
                args += ["--health-cmd", _shell_quote(_health_cmd(hc["test"]))]
            if hc.get("interval"):
                args += ["--health-interval", str(hc["interval"])]
            if hc.get("retries"):
                args += ["--health-retries", str(hc["retries"])]
            if hc.get("timeout"):
                args += ["--health-timeout", str(hc["timeout"])]
            if hc.get("start_period"):
                args += ["--health-start-period", str(hc["start_period"])]
    if svc.get("entrypoint"):
        ep = svc["entrypoint"]
        args += ["--entrypoint", _shell_quote(ep if isinstance(ep, str) else " ".join(ep))]
    if svc.get("stdin_open"):
        args.append("-i")
    if svc.get("tty"):
        args.append("-t")

    image = svc.get("image")
    if not image and svc.get("build"):
        image = f"{name}:local"
    args.append(str(image or "<image>"))

    cmd = svc.get("command")
    if cmd:
        args += cmd.split() if isinstance(cmd, str) else [str(c) for c in cmd]

    return " ".join(args)


def analyse(text: str) -> ComposeReport:
    """Analyse a compose file. Requires PyYAML; reports cleanly if absent."""
    report = ComposeReport()
    try:
        import yaml
    except ImportError:  # pragma: no cover
        report.parse_error = "PyYAML is required: pip install 'docker2wslc[yaml]'"
        return report

    try:
        doc = yaml.safe_load(text) or {}
    except Exception as exc:
        report.parse_error = f"YAML parse error: {exc}"
        return report

    if not isinstance(doc, dict):
        report.parse_error = "Compose file did not parse to a mapping."
        return report

    for vol in (doc.get("volumes") or {}):
        report.prelude.append(f"wslc volume create {vol}")
    for net in (doc.get("networks") or {}):
        report.prelude.append(f"wslc network create {net}")

    services = doc.get("services") or {}
    if not isinstance(services, dict):
        report.parse_error = "`services` is not a mapping."
        return report

    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        sr = ServiceReport(name=str(name))
        for key in svc:
            spec = COMPOSE_KEYS.get(str(key))
            if spec is None:
                sr.unknown.append(str(key))
            elif spec["status"] == "ok":
                sr.ok.append(str(key))
            elif spec["status"] == "partial":
                sr.partial.append((str(key), spec.get("note", "")))
            else:
                sr.missing.append((str(key), spec.get("note", "")))
        sr.command = _build_run(str(name), svc)
        report.services.append(sr)

    # depends_on ordering hint
    ordered = [s.name for s in report.services]
    if any("depends_on" in dict(s.missing) for s in report.services):
        report.prelude.append(f"# start order matters: {' -> '.join(ordered)}")

    return report
