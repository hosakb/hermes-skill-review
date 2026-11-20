"""Backend for the skill-review desktop plugin: /api/plugins/skill-review/.

Lists, diffs, accepts and rejects staged writes (``<home>/pending/<subsystem>/<id>.json``) for the
two write-approval subsystems, ``skills`` and ``memory``, across every profile under the Hermes
root this process serves. Both go through the shared ``tools.write_approval`` store functions.
Skill diffs come from ``skill_pending_diff``; Hermes has no memory diff, so memory diffs are
built from the record and the profile's current entries with the memory store's own per-op logic.
Acceptance runs the same applier as ``/skills approve`` and ``/memory approve``.
Authentication is the gateway's own plugin API auth; this module adds none and opens no files
other than pending records, MEMORY.md and USER.md (read-only, for diffs).
"""

from __future__ import annotations

import difflib
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException

router = APIRouter()

SKILLS = "skills"
MEMORY = "memory"
SUBSYSTEMS = (SKILLS, MEMORY)
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_OP_HEADER = "## op {i}/{n}: "

# Accept and reject are serialised so two clicks (or a click racing a retry) cannot both apply one
# record. A concurrent chat `/skills approve` runs outside this lock; upstream has no cross-path lock.
_resolve_lock = threading.Lock()


# --- profile resolution ------------------------------------------------------------------------

def _profiles_mod():
    from hermes_cli import profiles
    return profiles


def _known_profiles() -> list[str]:
    """``default`` plus every live named profile under the Hermes root this process serves."""
    return _profiles_mod().list_profile_names()


def _resolve_profile(profile: str) -> Path:
    """Home of ``profile``; 400 for a malformed name, 404 for one that is not a live profile."""
    if profile != "default" and not _PROFILE_RE.match(profile):
        raise HTTPException(status_code=400, detail="invalid profile name")
    if profile not in _known_profiles():
        raise HTTPException(status_code=404, detail=f"unknown profile '{profile}'")
    return Path(_profiles_mod().get_profile_dir(profile))


def _check_subsystem(subsystem: str) -> str:
    if subsystem not in SUBSYSTEMS:
        raise HTTPException(status_code=400, detail="subsystem must be 'skills' or 'memory'")
    return subsystem


def _check_id(pending_id: str) -> str:
    if not _ID_RE.match(pending_id or ""):
        raise HTTPException(status_code=400, detail="invalid pending id")
    return pending_id


@contextmanager
def _profile_scope(home: Path) -> Iterator[None]:
    """Run the body with ``get_hermes_home()`` pointing at ``home``.

    No-op when ``home`` is already the current home. Otherwise the same binder the gateway uses for a
    secondary profile (``bind_profile_scope``), which moves the home contextvar for this request only
    and leaves process state alone.
    """
    from hermes_constants import get_hermes_home, hermes_home_key
    if hermes_home_key(home) == hermes_home_key(get_hermes_home()):
        yield
        return
    from agent.runtime_scope import bind_profile_scope
    with bind_profile_scope(home, hydrate_secrets=False):
        yield


# --- record shaping ----------------------------------------------------------------------------

def _ops(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if payload.get("action") == "batch":
        return [op for op in (payload.get("operations") or []) if isinstance(op, dict)]
    return [payload]


def _memory_label(target: Any) -> str:
    return "USER.md" if target == "user" else "MEMORY.md"


def _summarise(subsystem: str, profile: str, record: dict[str, Any]) -> dict[str, Any]:
    """List row for one record. ``subject`` is the skill name(s) or the memory file; no payload."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    ops = _ops(payload)
    if subsystem == MEMORY:
        subject = _memory_label(payload.get("target"))
    else:
        names: list[str] = []
        for op in ops:
            name = op.get("name") or ""
            if name and name not in names:
                names.append(name)
        subject = ", ".join(names) or "(unnamed)"
    return {
        "id": record.get("id", ""),
        "subsystem": subsystem,
        "profile": profile,
        "subject": subject,
        "action": payload.get("action", "") or "unknown",
        "op_count": len(ops),
        "origin": record.get("origin", "foreground"),
        "created_at": record.get("created_at", 0),
        "summary": record.get("summary", ""),
    }


def _gates() -> dict[str, bool]:
    from tools import write_approval as wa
    return {name: wa.write_approval_enabled(name) for name in SUBSYSTEMS}


def _sections(subsystem: str, record: dict[str, Any]) -> list[dict[str, str]]:
    return _memory_sections(record) if subsystem == MEMORY else _skill_sections(record)


def _skill_sections(record: dict[str, Any]) -> list[dict[str, str]]:
    """Split ``skill_pending_diff`` output into per-op sections with a render hint for the UI.

    ``kind`` is ``create`` (whole text is new content), ``delete`` (a removal note) or ``diff``
    (unified diff or an explanatory note). A single op is one section; a batch is split on the
    ``## op i/n:`` headers that ``_batch_pending_diff`` writes, looked up in order.
    """
    from tools import write_approval as wa
    text = wa.skill_pending_diff(record)
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    ops = _ops(payload)

    def kind_of(op: dict[str, Any]) -> str:
        action = op.get("action", "")
        if action == "create":
            return "create"
        if action in {"delete", "remove_file"}:
            return "delete"
        return "diff"

    if payload.get("action") != "batch":
        return [{"title": "", "kind": kind_of(payload), "text": text}]

    sections: list[dict[str, str]] = []
    rest, n = text, len(ops)
    for i, op in enumerate(ops, start=1):
        header = _OP_HEADER.format(i=i, n=n)
        if not rest.startswith(header):
            return [{"title": "", "kind": "diff", "text": text}]  # unexpected shape: show raw
        nxt = _OP_HEADER.format(i=i + 1, n=n)
        cut = rest.find("\n\n" + nxt) if i < n else -1
        chunk, rest = (rest, "") if cut < 0 else (rest[:cut], rest[cut + 2:])
        title, _, body = chunk[len(header):].partition("\n\n")
        sections.append({"title": title, "kind": kind_of(op), "text": body})
    return sections


def _entry_diff(label: str, before: str, after: str) -> str:
    """Unified diff of one memory entry. Entries carry no trailing newline, so add one to both sides
    or difflib would glue the removed and added lines together."""
    lines = difflib.unified_diff((before + "\n").splitlines(keepends=True), (after + "\n").splitlines(keepends=True),
                                 fromfile=f"a/{label}", tofile=f"b/{label}")
    return "".join(lines) or "(no textual change)"


def _memory_sections(record: dict[str, Any]) -> list[dict[str, str]]:
    """One section per memory op, replayed on an in-memory copy of the profile's current entries.

    The replay is ``MemoryStore._apply_batch_op``, the function approval runs, so a stale pinned
    entry, a repeated span or an unpinned legacy op shows up here as the same refusal approval would
    give. Nothing is written. Ops after a failing one are not shown, as approval aborts there.
    """
    from tools.memory_tool import destructive_ops, load_on_disk_store
    from tools.memory_tool_store import MemoryStore
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    target = payload.get("target", "memory")
    label = _memory_label(target)
    working = list(load_on_disk_store()._entries_for(target))
    unpinned = {id(op) for op in destructive_ops(payload) if not op.get("matched_entry")}
    verbs = {"add": "add to", "remove": "remove from"}
    sections: list[dict[str, str]] = []

    def note(title: str, text: str) -> None:
        sections.append({"title": title, "kind": "diff", "text": text})

    for i, op in enumerate(_ops(payload), start=1):
        act = op.get("action", "")
        content = op.get("content") or op.get("new_text") or ""
        title = f"{verbs.get(act, act + ' in')} {label}"
        if id(op) in unpinned:
            note(title, "(would fail: this write predates entry pinning, so approval refuses it. "
                        "Reject it and recreate the change.)")
            break
        already = act == "add" and content in working
        error, previous, _cls, patched = MemoryStore._apply_batch_op(
            working, act, content, op.get("old_text") or "", f"op {i}", op.get("matched_entry"))
        if error:
            note(title, f"(would fail: {error})")
            break
        if act == "add":
            if already:
                note(title, f"(already in {label}, so nothing changes)")
            else:
                sections.append({"title": title, "kind": "create", "text": content})
        elif act == "remove":
            sections.append({"title": title, "kind": "delete", "text": previous})
        else:  # patch, or a legacy whole-entry replace
            sections.append({"title": title, "kind": "diff",
                             "text": _entry_diff(label, previous, patched if act == "patch" else content)})
    return sections or [{"title": "", "kind": "diff", "text": "(empty write)"}]


def _apply(subsystem: str, record: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    """The applier behind ``/skills approve`` and ``/memory approve``. Memory gets a fresh on-disk
    store with the profile's configured limits, as the gateway does."""
    from hermes_cli.write_approval_commands import _apply_one
    store = None
    if subsystem == MEMORY:
        from tools.memory_tool import load_on_disk_store
        store = load_on_disk_store()
    return _apply_one(subsystem, record, store)


# --- routes ------------------------------------------------------------------------------------

@router.get("/pending")
def list_pending_all() -> dict[str, Any]:
    """Every pending write of both subsystems across all profiles, oldest first, with counts."""
    from tools import write_approval as wa
    items: list[dict[str, Any]] = []
    profiles: list[dict[str, Any]] = []
    for name in _known_profiles():
        found: list[dict[str, Any]] = []
        try:
            with _profile_scope(Path(_profiles_mod().get_profile_dir(name))):
                gates = _gates()
                for subsystem in SUBSYSTEMS:
                    found.extend(_summarise(subsystem, name, r) for r in wa.list_pending(subsystem))
        except Exception as exc:  # one broken profile must not hide the others
            profiles.append({"profile": name, "count": 0, "counts": dict.fromkeys(SUBSYSTEMS, 0),
                             "gates": dict.fromkeys(SUBSYSTEMS, False), "error": str(exc)})
            continue
        counts = {sub: sum(1 for i in found if i["subsystem"] == sub) for sub in SUBSYSTEMS}
        profiles.append({"profile": name, "count": len(found), "counts": counts, "gates": gates})
        items.extend(found)
    items.sort(key=lambda i: i["created_at"])
    totals = {sub: sum(1 for i in items if i["subsystem"] == sub) for sub in SUBSYSTEMS}
    return {"profiles": profiles, "items": items, "total": len(items), "totals": totals}


@router.get("/pending/{subsystem}/{profile}/{pending_id}/diff")
def pending_diff(subsystem: str, profile: str, pending_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(profile)
    with _profile_scope(home):
        record = wa.get_pending(subsystem, pending_id)
        if record is None:
            return {"status": "already_handled", "id": pending_id, "profile": profile, "subsystem": subsystem}
        sections = _sections(subsystem, record)
    return {"status": "ok", "item": _summarise(subsystem, profile, record), "sections": sections}


@router.post("/pending/{subsystem}/{profile}/{pending_id}/accept")
def accept(subsystem: str, profile: str, pending_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(profile)
    base = {"id": pending_id, "profile": profile, "subsystem": subsystem}
    with _resolve_lock, _profile_scope(home):
        record = wa.get_pending(subsystem, pending_id)
        if record is None:
            return {"status": "already_handled", **base}
        item = _summarise(subsystem, profile, record)
        ok, error, _result = _apply(subsystem, record)
        if not ok:
            # Same as `/skills approve` and `/memory approve`: a failed apply leaves the record staged.
            return {"status": "failed", **base, "item": item, "error": error or "apply failed"}
        wa.discard_pending(subsystem, pending_id)
    return {"status": "applied", **base, "item": item}


@router.post("/pending/{subsystem}/{profile}/{pending_id}/reject")
def reject(subsystem: str, profile: str, pending_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(profile)
    base = {"id": pending_id, "profile": profile, "subsystem": subsystem}
    with _resolve_lock, _profile_scope(home):
        record = wa.get_pending(subsystem, pending_id)
        item = _summarise(subsystem, profile, record) if record else None
        if not wa.discard_pending(subsystem, pending_id):
            return {"status": "already_handled", **base}
    return {"status": "rejected", **base, "item": item}
