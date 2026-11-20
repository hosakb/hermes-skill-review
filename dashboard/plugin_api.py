"""Backend for the skill-review desktop plugin: /api/plugins/skill-review/.

Lists, diffs, accepts and rejects staged skill writes (``<home>/pending/skills/<id>.json``)
for every profile under the Hermes root this process serves. Diffs come from
``tools.write_approval.skill_pending_diff`` and acceptance runs the same applier as
``/skills approve``. Only the skills queue is touched; the memory queue is never read.
Authentication is the gateway's own plugin API auth; this module adds none and opens no files
other than pending records.
"""

from __future__ import annotations

import re
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from fastapi import APIRouter, HTTPException

router = APIRouter()

SKILLS = "skills"
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


def _summarise(profile: str, record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    ops = _ops(payload)
    names: list[str] = []
    for op in ops:
        name = op.get("name") or ""
        if name and name not in names:
            names.append(name)
    return {
        "id": record.get("id", ""),
        "profile": profile,
        "skill": ", ".join(names) or "(unnamed)",
        "action": payload.get("action", "") or "unknown",
        "op_count": len(ops),
        "origin": record.get("origin", "foreground"),
        "created_at": record.get("created_at", 0),
        "summary": record.get("summary", ""),
    }


def _gate_enabled() -> bool:
    from tools import write_approval as wa
    return wa.write_approval_enabled(wa.SKILLS)


def _sections(record: dict[str, Any], text: str) -> list[dict[str, str]]:
    """Split ``skill_pending_diff`` output into per-op sections with a render hint for the UI.

    ``kind`` is ``create`` (whole text is new content), ``delete`` (a removal note) or ``diff``
    (unified diff or an explanatory note). A single op is one section; a batch is split on the
    ``## op i/n:`` headers that ``_batch_pending_diff`` writes, looked up in order.
    """
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


# --- routes ------------------------------------------------------------------------------------

@router.get("/pending")
def list_pending_all() -> dict[str, Any]:
    """Every pending skill write across all profiles, oldest first, plus per-profile counts."""
    from tools import write_approval as wa
    items: list[dict[str, Any]] = []
    profiles: list[dict[str, Any]] = []
    for name in _known_profiles():
        try:
            with _profile_scope(Path(_profiles_mod().get_profile_dir(name))):
                records = wa.list_pending(SKILLS)
                gate = _gate_enabled()
        except Exception as exc:  # one broken profile must not hide the others
            profiles.append({"profile": name, "count": 0, "gate": False, "error": str(exc)})
            continue
        profiles.append({"profile": name, "count": len(records), "gate": gate})
        items.extend(_summarise(name, r) for r in records)
    items.sort(key=lambda i: i["created_at"])
    return {"profiles": profiles, "items": items, "total": len(items)}


@router.get("/pending/{profile}/{pending_id}/diff")
def pending_diff(profile: str, pending_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_id(pending_id)
    home = _resolve_profile(profile)
    with _profile_scope(home):
        record = wa.get_pending(SKILLS, pending_id)
        if record is None:
            return {"status": "already_handled", "id": pending_id, "profile": profile}
        text = wa.skill_pending_diff(record)
    return {"status": "ok", "item": _summarise(profile, record), "sections": _sections(record, text)}


@router.post("/pending/{profile}/{pending_id}/accept")
def accept(profile: str, pending_id: str) -> dict[str, Any]:
    from hermes_cli.write_approval_commands import _apply_one
    from tools import write_approval as wa
    _check_id(pending_id)
    home = _resolve_profile(profile)
    with _resolve_lock, _profile_scope(home):
        record = wa.get_pending(SKILLS, pending_id)
        if record is None:
            return {"status": "already_handled", "id": pending_id, "profile": profile}
        item = _summarise(profile, record)
        ok, error, _result = _apply_one(SKILLS, record, None)
        if not ok:
            # Same as `/skills approve`: a failed apply leaves the record staged.
            return {"status": "failed", "id": pending_id, "profile": profile, "item": item,
                    "error": error or "apply failed"}
        wa.discard_pending(SKILLS, pending_id)
    return {"status": "applied", "id": pending_id, "profile": profile, "item": item}


@router.post("/pending/{profile}/{pending_id}/reject")
def reject(profile: str, pending_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_id(pending_id)
    home = _resolve_profile(profile)
    with _resolve_lock, _profile_scope(home):
        record = wa.get_pending(SKILLS, pending_id)
        item = _summarise(profile, record) if record else None
        if not wa.discard_pending(SKILLS, pending_id):
            return {"status": "already_handled", "id": pending_id, "profile": profile}
    return {"status": "rejected", "id": pending_id, "profile": profile, "item": item}
