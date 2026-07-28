"""docker2wslc command line interface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .compose import analyse
from .translate import RULES, translate

SITE = RULES["links"]["site"]

C = {
    "reset": "\033[0m", "dim": "\033[2m", "bold": "\033[1m",
    "red": "\033[31m", "yellow": "\033[33m", "cyan": "\033[36m", "green": "\033[32m",
}


def _paint(enabled: bool):
    if enabled:
        return lambda s, c: f"{C[c]}{s}{C['reset']}"
    return lambda s, c: s


def _read(source: str | None) -> str:
    if source in (None, "-"):
        return sys.stdin.read()
    return Path(source).read_text(encoding="utf-8")


SEV_COLOR = {"error": "red", "warn": "yellow", "info": "cyan"}


def cmd_convert(args: argparse.Namespace) -> int:
    text = " ".join(args.command) if args.command else _read(args.file)
    res = translate(text)
    if args.json:
        print(json.dumps(res.as_dict(), indent=2))
        return res.exit_code

    paint = _paint(not args.no_color and sys.stdout.isatty())
    print(res.output)
    if res.notes and not args.quiet:
        print(file=sys.stderr)
        print(paint("Migration notes", "bold"), file=sys.stderr)
        for note in res.notes:
            tag = paint(note.severity.upper().ljust(5), SEV_COLOR.get(note.severity, "dim"))
            print(f"  {tag} {note.text}", file=sys.stderr)
        if res.compose_hit:
            print(f"\n  See {RULES['links']['compose']}", file=sys.stderr)
    return res.exit_code


def cmd_compose(args: argparse.Namespace) -> int:
    report = analyse(_read(args.file))
    if args.json:
        print(json.dumps(report.as_dict(), indent=2))
        return report.exit_code

    paint = _paint(not args.no_color and sys.stdout.isatty())
    if report.parse_error:
        print(paint(f"error: {report.parse_error}", "red"), file=sys.stderr)
        return report.exit_code

    print(paint("# wslc has no Compose runtime. Equivalent commands:", "dim"))
    if report.prelude:
        print()
        for line in report.prelude:
            print(line)
    for svc in report.services:
        print()
        print(paint(f"# service: {svc.name}", "bold"))
        print(svc.command)
        for key, note in svc.partial:
            print(paint(f"  ! {key}: {note}", "yellow"), file=sys.stderr)
        for key, note in svc.missing:
            print(paint(f"  x {key}: {note}", "red"), file=sys.stderr)
        if svc.unknown:
            print(paint(f"  ? unrecognised keys: {', '.join(svc.unknown)}", "dim"), file=sys.stderr)
    print(f"\n{paint('Guide:', 'dim')} {RULES['links']['compose']}", file=sys.stderr)
    return report.exit_code


LINT_TARGETS = ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml")


def cmd_lint(args: argparse.Namespace) -> int:
    root = Path(args.path)
    paint = _paint(not args.no_color and sys.stdout.isatty())
    worst = 0
    found = False

    if root.is_file():
        candidates = [root]
    else:
        # rglob("*") does not descend into dot-directories, so the standard
        # .devcontainer/devcontainer.json location must be globbed explicitly.
        patterns = [f"**/{name}" for name in LINT_TARGETS]
        patterns += ["**/devcontainer.json", ".devcontainer/**/devcontainer.json"]
        seen: set[Path] = set()
        candidates = []
        for pattern in patterns:
            for path in root.glob(pattern):
                if not path.is_file():
                    continue
                if "node_modules" in path.parts or ".git" in path.parts:
                    continue
                resolved = path.resolve()
                if resolved in seen:
                    continue
                seen.add(resolved)
                candidates.append(path)
        candidates.sort()

    for path in candidates:
        found = True
        rel = path.relative_to(root) if root.is_dir() else path
        if path.name == "devcontainer.json":
            code = _lint_devcontainer(path, rel, paint)
        else:
            report = analyse(path.read_text(encoding="utf-8"))
            code = report.exit_code
            issues = [(k, n, "x") for s in report.services for k, n in s.missing]
            issues += [(k, n, "!") for s in report.services for k, n in s.partial]
            if issues:
                print(paint(str(rel), "bold"))
                for key, note, mark in issues:
                    col = "red" if mark == "x" else "yellow"
                    print(paint(f"  {mark} {key}: {note}", col))
        worst = max(worst, code)

    if not found:
        print("No compose or devcontainer files found.", file=sys.stderr)
        return 0
    if worst == 0:
        print(paint("All checked files are wslc-compatible.", "green"))
    return worst


def _lint_devcontainer(path: Path, rel: Path, paint) -> int:
    keys = RULES["devcontainer"]["keys"]
    try:
        raw = path.read_text(encoding="utf-8")
        # devcontainer.json permits // comments
        stripped = "\n".join(
            line for line in raw.splitlines() if not line.strip().startswith("//")
        )
        doc = json.loads(stripped)
    except Exception as exc:
        print(paint(f"{rel}: cannot parse ({exc})", "red"))
        return 2
    code = 0
    header = False
    for key in doc:
        spec = keys.get(key)
        if not spec or spec["status"] == "ok":
            continue
        if not header:
            print(paint(str(rel), "bold"))
            header = True
        if spec["status"] == "missing":
            print(paint(f"  x {key}: {spec.get('note','unsupported')}", "red"))
            code = 2
        else:
            print(paint(f"  ! {key}: {spec.get('note','differs')}", "yellow"))
            code = max(code, 1)
    return code


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="docker2wslc",
        description=f"Translate Docker commands and Compose files to wslc. Docs: {SITE}",
        epilog="Exit codes: 0 clean, 1 degraded, 2 unmigratable.",
    )
    p.add_argument("--version", action="version", version=f"docker2wslc {__version__}")
    p.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("convert", help="translate a docker command or script")
    c.add_argument("command", nargs="*", help="docker command (or use --file/stdin)")
    c.add_argument("-f", "--file", help="read commands from a file, - for stdin")
    c.add_argument("--json", action="store_true", help="machine-readable output")
    c.add_argument("-q", "--quiet", action="store_true", help="suppress migration notes")
    c.add_argument("--no-color", action="store_true", help=argparse.SUPPRESS)
    c.set_defaults(func=cmd_convert)

    m = sub.add_parser("compose", help="analyse a compose file for wslc migration")
    m.add_argument("file", nargs="?", default="docker-compose.yml")
    m.add_argument("--json", action="store_true", help="machine-readable output")
    m.add_argument("--no-color", action="store_true", help=argparse.SUPPRESS)
    m.set_defaults(func=cmd_compose)

    l = sub.add_parser("lint", help="scan a repo for wslc incompatibilities")
    l.add_argument("path", nargs="?", default=".")
    l.add_argument("--no-color", action="store_true", help=argparse.SUPPRESS)
    l.set_defaults(func=cmd_lint)
    return p


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)

    # `convert docker run --gpus all ...` — everything after the first `docker`/`podman`
    # token belongs to the command being translated, not to argparse. Without this,
    # argparse rejects `--gpus`/`--platform`/`-p` as unrecognised options.
    passthrough: list[str] = []
    for i, tok in enumerate(raw):
        if tok in ("docker", "podman", "sudo"):
            passthrough = raw[i:]
            raw = raw[:i]
            break

    parser = build_parser()
    args = parser.parse_args(raw)
    if passthrough:
        args.command = passthrough
    try:
        return args.func(args)
    except FileNotFoundError as exc:
        print(f"error: {exc.filename}: no such file", file=sys.stderr)
        return 2
    except BrokenPipeError:  # pragma: no cover
        return 0
    except KeyboardInterrupt:  # pragma: no cover
        return 130


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
