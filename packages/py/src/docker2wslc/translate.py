"""Docker -> wslc command translation, driven by the shared rules.json."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from importlib.resources import files
from typing import Any

WINDOWS_PATH = re.compile(r"^[A-Za-z]:[\\/]")


def load_rules() -> dict[str, Any]:
    """Load the bundled rules.json (single source of truth across languages)."""
    data = files("docker2wslc").joinpath("rules.json").read_text(encoding="utf-8")
    return json.loads(data)


RULES = load_rules()

SEV_ORDER = {"info": 0, "warn": 1, "error": 2}


@dataclass
class Note:
    severity: str
    text: str

    def __str__(self) -> str:  # pragma: no cover - display helper
        return f"[{self.severity}] {self.text}"


@dataclass
class Result:
    """Outcome of translating one or more lines."""

    output: str = ""
    notes: list[Note] = field(default_factory=list)
    compose_hit: bool = False
    unsupported_hit: bool = False

    @property
    def exit_code(self) -> int:
        """0 clean, 1 degraded (flags dropped/rewritten), 2 unmigratable."""
        if self.unsupported_hit or self.compose_hit:
            return 2
        if any(n.severity in ("warn", "error") for n in self.notes):
            return 1
        return 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "output": self.output,
            "notes": [{"severity": n.severity, "text": n.text} for n in self.notes],
            "composeHit": self.compose_hit,
            "unsupportedHit": self.unsupported_hit,
            "exitCode": self.exit_code,
        }


def tokenize(line: str) -> list[str]:
    """Split a shell-ish line, keeping quoted spans intact (quotes preserved)."""
    out: list[str] = []
    cur = ""
    quote: str | None = None
    for ch in line:
        if quote:
            cur += ch
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            cur += ch
        elif ch.isspace():
            if cur:
                out.append(cur)
                cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _flag_spec(flag: str) -> tuple[str, dict[str, Any]] | tuple[None, None]:
    flags = RULES["flags"]
    if flag in flags:
        return flag, flags[flag]
    for canonical, spec in flags.items():
        if flag in spec.get("aliases", []):
            return canonical, spec
    return None, None


def _translate_args(args: list[str], notes: list[Note]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(args):
        arg = args[i]
        bare, _, inline = arg.partition("=")
        canonical, spec = _flag_spec(bare)

        if spec is None:
            out.append(arg)
            i += 1
            continue

        takes_value = spec.get("takesValue", False)
        has_inline = "=" in arg
        value = inline if has_inline else (args[i + 1] if i + 1 < len(args) else "")
        consumed = 1 if has_inline or not takes_value else 2

        action = spec["action"]

        if action == "conditional":
            branch = spec.get("whenValue", {}).get(value)
            if branch:
                if branch["action"] == "drop":
                    notes.append(Note(branch.get("severity", "info"), branch["note"]))
                    i += consumed
                    continue
            notes.append(Note(spec.get("severity", "info"), spec["note"]))
            out.append(f"{bare}={value}" if has_inline else bare)
            if not has_inline and takes_value and value:
                out.append(value)
            i += consumed
            continue

        if action == "drop":
            notes.append(Note(spec.get("severity", "warn"), spec["note"]))
            i += consumed
            continue

        if action == "rewrite":
            notes.append(Note(spec.get("severity", "info"), spec["note"]))
            out.extend(spec["replaceWith"].split())
            i += consumed
            continue

        # action == "keep"
        note_win = spec.get("noteWhenWindowsPath")
        if note_win and (WINDOWS_PATH.match(value) or value.startswith("/mnt/")):
            notes.append(Note(spec.get("severity", "info"), note_win))
        out.append(arg)
        if not has_inline and takes_value and value:
            out.append(value)
        i += consumed
    return out


def translate_line(raw: str) -> Result | None:
    """Translate a single line. Returns None for blank lines."""
    line = raw.strip()
    if not line:
        return None
    if line.startswith("#"):
        return Result(output=line)

    notes: list[Note] = []
    tokens = tokenize(line)

    if tokens and tokens[0] == "sudo":
        tokens.pop(0)
        notes.append(
            Note(
                "info",
                "Dropped sudo — wslc runs as your Windows user, no elevation needed "
                "for normal container operations.",
            )
        )

    if not tokens or tokens[0] not in ("docker", "podman"):
        return Result(
            output=f"# not a docker command: {line}",
            notes=[Note("info", "Only docker/podman commands are translated. Line left unchanged.")],
        )

    if tokens[0] == "podman":
        notes.append(
            Note("info", "Treated podman as Docker-compatible; flag coverage is nearly identical.")
        )
    tokens.pop(0)

    if not tokens:
        return Result(output="wslc", notes=notes)

    if tokens[0] in ("compose", "docker-compose"):
        compose = RULES["compose"]
        notes.append(Note("error", compose["note"]))
        return Result(
            output="# No native Compose runtime in wslc.", notes=notes, compose_hit=True
        )

    two = f"{tokens[0]} {tokens[1]}" if len(tokens) > 1 else ""
    if two and two in (RULES["renamed"].values()):
        rest = _translate_args(tokens[2:], notes)
        return Result(output=" ".join(["wslc", two, *rest]).strip(), notes=notes)

    verb = tokens[0]

    if verb in RULES["unsupported"]:
        notes.append(Note("error", RULES["unsupported"][verb]))
        return Result(
            output=f"# {verb}: not supported by wslc", notes=notes, unsupported_hit=True
        )

    if verb in RULES["renamed"]:
        mapped = RULES["renamed"][verb]
        flag_map = RULES["renamedFlags"].get(verb, {})
        rest: list[str] = []
        for arg in tokens[1:]:
            rest.append(flag_map.get(arg, arg))
        rest = _translate_args(rest, notes)
        notes.append(
            Note(
                "info",
                f"`docker {verb}` is grouped under a noun in wslc: `wslc {mapped}`. "
                f"Recent previews accept `wslc {verb}` as an alias, but the noun form is stable.",
            )
        )
        return Result(output=" ".join(["wslc", mapped, *rest]).strip(), notes=notes)

    if verb in RULES["identical"]:
        rest = _translate_args(tokens[1:], notes)
        return Result(output=" ".join(["wslc", verb, *rest]).strip(), notes=notes)

    notes.append(
        Note(
            "warn",
            f"Unknown docker subcommand `{verb}` — passed through unchanged. "
            "Verify against `wslc --help`.",
        )
    )
    rest = _translate_args(tokens[1:], notes)
    return Result(output=" ".join(["wslc", verb, *rest]).strip(), notes=notes)


def translate(text: str) -> Result:
    """Translate a multi-line script, de-duplicating notes."""
    lines: list[str] = []
    notes: list[Note] = []
    seen: set[str] = set()
    compose_hit = False
    unsupported_hit = False

    for raw in str(text).split("\n"):
        res = translate_line(raw)
        if res is None:
            lines.append("")
            continue
        lines.append(res.output)
        compose_hit = compose_hit or res.compose_hit
        unsupported_hit = unsupported_hit or res.unsupported_hit
        for note in res.notes:
            if note.text not in seen:
                seen.add(note.text)
                notes.append(note)

    joined = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    notes.sort(key=lambda n: -SEV_ORDER.get(n.severity, 0))
    return Result(
        output=joined,
        notes=notes,
        compose_hit=compose_hit,
        unsupported_hit=unsupported_hit,
    )
