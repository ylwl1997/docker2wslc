"""docker2wslc — translate Docker commands and Compose files to wslc.

wslc is the native Linux container runtime in the Windows Subsystem for Linux.
Docs and an interactive converter: https://wslcontainers.com
"""

__version__ = "0.2.0"

from .compose import ComposeReport, analyse
from .translate import Note, Result, load_rules, translate, translate_line

__all__ = [
    "__version__",
    "translate",
    "translate_line",
    "analyse",
    "load_rules",
    "Result",
    "Note",
    "ComposeReport",
]
