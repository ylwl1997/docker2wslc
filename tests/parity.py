#!/usr/bin/env python3
"""Assert the Python and JavaScript engines produce identical results.

Runs every case in cases.json through both implementations and compares the
translated command, the exit code and the note severities. Any divergence means
the two packages would give users different answers, so this fails the build.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((Path(__file__).parent / "cases.json").read_text(encoding="utf-8"))

sys.path.insert(0, str(ROOT / "packages" / "py" / "src"))
from docker2wslc import translate  # noqa: E402


def js_results(commands: list[str]) -> list[dict]:
    """Translate every command in one node process to keep this fast."""
    script = """
import { translate } from './packages/cli/src/translate.js';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
process.stdout.write(JSON.stringify(JSON.parse(raw).map((c) => {
  const r = translate(c);
  return {
    output: r.output,
    exit_code: r.exitCode,
    notes: r.notes.map((n) => `${n.severity}:${n.text}`),
  };
})));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, input=json.dumps(commands),
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        sys.exit(f"node failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


COMPOSE_FIXTURE = """
services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    environment:
      NGINX_HOST: localhost
      MOTD: hello world
    networks: [backend]
    depends_on: [db]
    restart: unless-stopped
    cap_add: [NET_ADMIN]
    devices: ["/dev/snd"]
    privileged: true
    expose: ["9000"]
  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [backend]
    mem_limit: 512m
    shm_size: 64m
    stop_grace_period: 1m30s
    stop_signal: SIGINT
    tmpfs: ["/tmp"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
  cache:
    image: redis:7
    healthcheck:
      disable: true
volumes: { pgdata: {} }
networks: { backend: {} }
"""


def js_compose() -> dict:
    """Analyse the compose fixture with the JS engine."""
    script = """
import { analyse } from './packages/cli/src/compose.js';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const r = analyse(raw);
process.stdout.write(JSON.stringify({
  exit_code: r.exitCode,
  prelude: r.prelude,
  services: r.services.map((s) => ({
    name: s.name,
    command: s.command,
    ok: s.ok,
    partial: s.partial.map((f) => f.key),
    missing: s.missing.map((f) => f.key),
    unknown: s.unknown,
  })),
}));
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=ROOT, input=COMPOSE_FIXTURE,
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        sys.exit(f"node compose failed:\n{proc.stderr}")
    return json.loads(proc.stdout)


def compose_mismatches() -> list[tuple]:
    """Compare the two compose analysers field by field."""
    from docker2wslc.compose import analyse

    js = js_compose()
    rep = analyse(COMPOSE_FIXTURE)
    py = {
        "exit_code": rep.exit_code,
        "prelude": list(rep.prelude),
        "services": [
            {
                "name": s.name,
                "command": s.command,
                "ok": list(s.ok),
                "partial": [k for k, _ in s.partial],
                "missing": [k for k, _ in s.missing],
                "unknown": list(s.unknown),
            }
            for s in rep.services
        ],
    }
    out = []
    if py["exit_code"] != js["exit_code"]:
        out.append(("compose", "exit_code", py["exit_code"], js["exit_code"]))
    if py["prelude"] != js["prelude"]:
        out.append(("compose", "prelude", py["prelude"], js["prelude"]))
    if len(py["services"]) != len(js["services"]):
        out.append(("compose", "service count", len(py["services"]), len(js["services"])))
        return out
    for p, j in zip(py["services"], js["services"]):
        for field in ("name", "command", "ok", "partial", "missing", "unknown"):
            if p[field] != j[field]:
                out.append((f"compose/{p['name']}", field, p[field], j[field]))
    return out


def main() -> int:
    commands = [c["command"] for c in CASES]
    js = js_results(commands)
    mismatches = []

    for command, js_res in zip(commands, js):
        py = translate(command)
        py_res = {
            "output": py.output,
            "exit_code": py.exit_code,
            "notes": [f"{n.severity}:{n.text}" for n in py.notes],
        }
        for field in ("output", "exit_code", "notes"):
            if py_res[field] != js_res[field]:
                mismatches.append((command, field, py_res[field], js_res[field]))

    mismatches.extend(compose_mismatches())

    for command, field, py_val, js_val in mismatches:
        print(f"MISMATCH {command!r} [{field}]\n  py: {py_val!r}\n  js: {js_val!r}")

    print(f"\n{len(commands)} command cases + 1 compose fixture, "
          f"{len(mismatches)} mismatches")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
