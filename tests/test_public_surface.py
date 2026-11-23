"""The plugin's runtime code uses only Hermes's public plugin surface (catalog rule 9).

These tests read the source; they import nothing from the plugin.
"""

import ast
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = [ROOT / "__init__.py", *sorted((ROOT / "dashboard").glob("*.py"))]
HERMES = ("tools", "hermes_cli", "agent", "gateway", "hermes_constants", "plugins", "utils", "hermes_state",
          "run_agent", "cli")
PLUGIN_API_JSON = Path(os.environ.get("HERMES_AGENT_SRC", "/home/boh/.hermes/hermes-agent")) / "hermes_cli" / "data" / "plugin_api.json"


def _imports():
    """``(file, line, module, name)`` for every import of a Hermes module in the runtime code."""
    out = []
    for path in RUNTIME:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                out += [(path.name, node.lineno, a.name, "") for a in node.names if a.name.split(".")[0] in HERMES]
            elif isinstance(node, ast.ImportFrom) and not node.level and node.module.split(".")[0] in HERMES:
                out += [(path.name, node.lineno, node.module, a.name) for a in node.names]
    return out


def test_runtime_code_is_found():
    assert (ROOT / "dashboard" / "plugin_api.py") in RUNTIME
    assert _imports(), "the scan found no Hermes import at all, so it is not reading the code"


def test_no_private_name_is_imported_from_tools_hermes_cli_or_agent():
    private = [f"{f}:{line} {module}{'.' + name if name else ''}" for f, line, module, name in _imports()
               if any(part.startswith("_") for part in module.split(".")) or name.startswith("_")]
    assert private == []


def test_no_private_attribute_of_a_hermes_module_is_used():
    """``mod._helper`` or ``Class._method`` on anything bound by a Hermes import."""
    found = []
    for path in RUNTIME:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        bound = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and not node.level and node.module.split(".")[0] in HERMES:
                bound |= {a.asname or a.name for a in node.names}
            elif isinstance(node, ast.Import):
                bound |= {(a.asname or a.name).split(".")[0] for a in node.names if a.name.split(".")[0] in HERMES}
        for node in ast.walk(tree):
            if (isinstance(node, ast.Attribute) and node.attr.startswith("_") and not node.attr.startswith("__")
                    and isinstance(node.value, ast.Name) and node.value.id in bound):
                found.append(f"{path.name}:{node.lineno} {node.value.id}.{node.attr}")
    assert found == []


@pytest.mark.skipif(not PLUGIN_API_JSON.is_file(), reason="no plugin_api.json in HERMES_AGENT_SRC")
def test_every_hermes_import_is_on_the_published_plugin_api():
    groups = json.loads(PLUGIN_API_JSON.read_text(encoding="utf-8"))["groups"]
    public = {entry for group in groups for entry in group["entries"]}
    outside = [f"{f}:{line} {module}{':' + name if name else ''}" for f, line, module, name in _imports()
               if not (f"{module}:{name}" in public or (module in public and not name.startswith("_")))]
    assert outside == []


def test_the_plugin_never_names_core_queue_files():
    """No path into <home>/pending, no claim or record suffixes: the queue is the API's alone."""
    for path in RUNTIME:
        source = path.read_text(encoding="utf-8")
        for needle in ('/ "pending"', "'pending' /", '"pending" /', ".claimed", ".json.claim", "atomic_json_write",
                       "_replaying_background_write", "_apply_one", "_apply_batch_op", "_fold_patch",
                       "contextvars", "ContextVar", "bind_profile_scope", "setattr(", "sys.modules"):
            assert needle not in source, (path.name, needle)


def test_the_plugin_never_logs():
    """Arguments and previews can hold memory text, so the runtime code has no logger at all."""
    for path in RUNTIME:
        source = path.read_text(encoding="utf-8")
        for needle in ("import logging", "getLogger", "print("):
            assert needle not in source, (path.name, needle)
