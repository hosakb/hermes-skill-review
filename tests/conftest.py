"""Test fixtures: every test gets a throwaway Hermes root. The live ~/.hermes is never read or written."""

import importlib.util
import os
import sys
from pathlib import Path

import pytest

HERMES_SRC = os.environ.get("HERMES_AGENT_SRC", "/home/boh/.hermes/hermes-agent")
if HERMES_SRC not in sys.path:
    sys.path.insert(0, HERMES_SRC)

API_FILE = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A temp Hermes root with the default profile and two named profiles (dev, ops)."""
    home = tmp_path / "home"
    root = home / ".hermes"
    root.mkdir(parents=True)
    (root / "config.yaml").write_text("{}\n")
    for name in ("dev", "ops"):
        d = root / "profiles" / name
        d.mkdir(parents=True)
        (d / "config.yaml").write_text("skills:\n  write_approval: true\nmemory:\n  write_approval: true\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.delenv("HERMES_DATA_DIR_SUFFIX", raising=False)
    live = Path(os.path.expanduser("~")).resolve()
    assert str(root.resolve()).startswith(str(tmp_path.resolve())), "test root must be temporary"
    assert live == home.resolve()
    return root


@pytest.fixture
def api(root):
    spec = importlib.util.spec_from_file_location("skill_review_plugin_api_under_test", API_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def client(api):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/skill-review")
    return TestClient(app)


def home_of(root, profile):
    return root if profile == "default" else root / "profiles" / profile


@pytest.fixture
def stage(root):
    """stage(profile, payload, origin=...) writes a pending record into that profile's queue.

    The subsystem is inferred (memory payloads carry a ``target``, skill payloads never do) unless given.
    """
    from agent.runtime_scope import bind_profile_scope
    from tools import write_approval as wa

    def _stage(profile, payload, origin="foreground", subsystem=None, summary="test write"):
        subsystem = subsystem or ("memory" if payload.get("target") in ("memory", "user") else "skills")
        with bind_profile_scope(home_of(root, profile), hydrate_secrets=False):
            return wa.stage_write(subsystem, payload, summary=summary, origin=origin)

    return _stage


SKILL_MD = "---\nname: {name}\ndescription: {desc}\n---\n# {name}\n\nline one\nline two\n"


def skill_content(name="demo", desc="a demo"):
    return SKILL_MD.format(name=name, desc=desc)


def pending_file(root, profile, pending_id, subsystem="skills"):
    return home_of(root, profile) / "pending" / subsystem / f"{pending_id}.json"


def skill_file(root, profile, name):
    return home_of(root, profile) / "skills" / name / "SKILL.md"


def memory_file(root, profile, target="memory"):
    return home_of(root, profile) / "memories" / ("USER.md" if target == "user" else "MEMORY.md")


def write_memory(root, profile, entries, target="memory"):
    from tools.memory_tool_store import ENTRY_DELIMITER
    path = memory_file(root, profile, target)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(ENTRY_DELIMITER.join(entries))


def read_memory(root, profile, target="memory"):
    from tools.memory_tool_store import ENTRY_DELIMITER
    path = memory_file(root, profile, target)
    return [e for e in path.read_text().split(ENTRY_DELIMITER) if e.strip()] if path.exists() else []
