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

    for command, field, py_val, js_val in mismatches:
        print(f"MISMATCH {command!r} [{field}]\n  py: {py_val!r}\n  js: {js_val!r}")

    print(f"\n{len(commands)} cases, {len(mismatches)} mismatches")
    return 1 if mismatches else 0


if __name__ == "__main__":
    sys.exit(main())
