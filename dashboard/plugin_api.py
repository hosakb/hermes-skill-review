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

import base64
import difflib
import hashlib
import json
import os
import posixpath
import re
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

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
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(profile)
    base = {"id": pending_id, "profile": profile, "subsystem": subsystem}
    with _resolve_lock, _profile_scope(home), _queue_lock(subsystem):
        outcome = _claim_and_resolve(subsystem, pending_id, op_fingerprint=None, apply=True)
    if outcome["status"] == "already_handled":
        return {"status": "already_handled", **base}
    if outcome["status"] == "failed":
        # Same as `/skills approve` and `/memory approve`: a failed apply leaves the record staged.
        return {"status": "failed", **base, "item": outcome["item"], "error": outcome["error"] or "apply failed"}
    return {"status": "applied", **base, "item": outcome["item"]}


@router.post("/pending/{subsystem}/{profile}/{pending_id}/reject")
def reject(subsystem: str, profile: str, pending_id: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(profile)
    base = {"id": pending_id, "profile": profile, "subsystem": subsystem}
    with _resolve_lock, _profile_scope(home), _queue_lock(subsystem):
        outcome = _claim_and_resolve(subsystem, pending_id, op_fingerprint=None, apply=False)
    if outcome["status"] == "already_handled":
        return {"status": "already_handled", **base}
    return {"status": "rejected", **base, "item": outcome["item"]}


# =================================================================================================
# Contract v1: one composite diff per (profile, file); every staged op is its own block.
#
# Accepting one op replays it alone through Hermes's own applier (`_apply_one`), as a one-op
# batch built from the staged record, so every guard stays in force: memory pins (the batch
# path's `matched_entry`), the content scans, Skills Guard (the record's `origin` rides along),
# per-skill locks and rollback. Hermes's own batch replay applies a skill batch op by op through
# the same single-op path (`tools/skill_manager_batch.py`), and `MemoryStore.apply_batch` with one
# op is the memory tool's advertised single-op shape.
#
# Race safety: all resolves of one profile's queue run under one cross-process file lock (three
# Hermes processes mount this plugin), and a record is claimed by an atomic rename before it is
# applied, so a concurrent chat `/skills approve` or `/memory approve` finds nothing to approve.
# A failed apply renames it back untouched; a successful one rewrites it without that op (Hermes's
# `atomic_json_write`), or drops it when that was the last op.
# =================================================================================================

_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16}$")
_BLOCK_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-([0-9a-f]{10})$")
_KINDS = {"all": SUBSYSTEMS, SKILLS: (SKILLS,), MEMORY: (MEMORY,)}
_WHOLE_FILE_SKILL_ACTIONS = {"create", "edit", "write_file", "remove_file", "delete"}
_CLAIM_SUFFIX = ".claim"


def _file_key(profile: str, subsystem: str, file: str) -> str:
    """Opaque, URL-safe, 16 characters; derived from the triple and never parsed back."""
    digest = hashlib.sha256(f"{profile}\0{subsystem}\0{file}".encode("utf-8", "surrogatepass")).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode("ascii")


def _check_key(key: str) -> str:
    if not _KEY_RE.match(key or ""):
        raise HTTPException(status_code=400, detail="invalid file key")
    return key


def _parse_block_id(block_id: str) -> tuple[str, str]:
    m = _BLOCK_RE.match(block_id or "")
    if not m or not _ID_RE.match(m.group(1)):
        raise HTTPException(status_code=400, detail="invalid block id")
    return m.group(1), m.group(2)


def _fingerprint(op: dict[str, Any]) -> str:
    raw = json.dumps(op, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(raw.encode("utf-8", "surrogatepass")).hexdigest()[:10]


# --- queue lock and claims ---------------------------------------------------------------------

def _queue_dir(subsystem: str) -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home()) / "pending" / subsystem


@contextmanager
def _queue_lock(subsystem: str) -> Iterator[None]:
    """Cross-process exclusive lock over one profile's pending queue (Hermes's own lock helper).
    It also restores a claim a crashed resolve left behind, since nobody else can hold one now."""
    from tools.skill_usage import skill_file_lock
    folder = _queue_dir(subsystem)
    folder.mkdir(parents=True, exist_ok=True)
    with skill_file_lock(folder / ".skill-review.lock"):
        for claim in folder.glob(f"*.json{_CLAIM_SUFFIX}"):
            original = claim.with_name(claim.name[: -len(_CLAIM_SUFFIX)])
            if not original.exists():
                os.replace(claim, original)
        yield


def _record_ops(subsystem: str, record: dict[str, Any]) -> list[tuple[int, dict[str, Any], str]]:
    """``(op_index, op, file label)`` for every op of a record, single-op or batch."""
    payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
    out = []
    for index, op in enumerate(_ops(payload)):
        if subsystem == MEMORY:
            label = _memory_label(payload.get("target"))
        else:
            name = op.get("name") or payload.get("name") or ""
            label = f"{name}/{_skill_rel(op)}"
        out.append((index, op, label))
    return out


def _skill_rel(op: dict[str, Any]) -> str:
    """The file an op writes, relative to its skill. Display only: files are read only through
    Hermes's own path validator."""
    action = op.get("action", "")
    fp = (op.get("file_path") or "").strip()
    if action in {"create", "edit", "delete"} or (action == "patch" and op.get("content")) or not fp:
        return "SKILL.md"
    parts = Path(fp).parts
    if parts and parts[-1] == "SKILL.md" and len(parts) in (1, 2):
        return "SKILL.md"
    return posixpath.normpath(fp.lstrip("/"))


def _single_op_record(subsystem: str, record: dict[str, Any], index: int) -> dict[str, Any]:
    """The record as Hermes would stage that op alone: same id, origin and metadata."""
    payload = record["payload"]
    if payload.get("action") != "batch":
        return record
    op = payload["operations"][index]
    if subsystem == MEMORY:
        single = {"action": "batch", "target": payload.get("target"), "operations": [op]}
    else:
        single = {"action": "batch", "operations": [{**op, "name": op.get("name") or payload.get("name")}]}
    return {**record, "payload": single}


def _without_op(record: dict[str, Any], index: int) -> Optional[dict[str, Any]]:
    """The record with one op dropped, or None when nothing would be left."""
    payload = record["payload"]
    if payload.get("action") != "batch":
        return None
    remaining = [op for i, op in enumerate(payload["operations"]) if i != index]
    return {**record, "payload": {**payload, "operations": remaining}} if remaining else None


def _claim_and_resolve(subsystem: str, record_id: str, *, op_fingerprint: Optional[str], apply: bool,
                       expected_key: Optional[str] = None, profile: str = "") -> dict[str, Any]:
    """Resolve one op (``op_fingerprint``) or the whole record (None). Caller holds the queue lock
    inside the profile scope. Returns ``{status, error, item}``."""
    from tools import write_approval as wa
    from utils import atomic_json_write
    path = _queue_dir(subsystem) / f"{record_id}.json"
    record = wa.get_pending(subsystem, record_id)
    if record is None:
        return {"status": "already_handled", "error": None, "item": None}
    item = _summarise(subsystem, profile, record)
    index = None
    if op_fingerprint is not None:
        found = [(i, label) for i, op, label in _record_ops(subsystem, record) if _fingerprint(op) == op_fingerprint]
        if not found:
            return {"status": "already_handled", "error": None, "item": item}
        index, label = found[0]
        if expected_key is not None and _file_key(profile, subsystem, label) != expected_key:
            return {"status": "failed", "error": "that change belongs to another file", "item": item}
    claim = path.with_name(path.name + _CLAIM_SUFFIX)
    try:
        os.rename(path, claim)
    except FileNotFoundError:
        return {"status": "already_handled", "error": None, "item": item}
    try:
        # The claimed bytes are the only truth: another resolver may have rewritten the record
        # between our read and the rename, so locate the op again in exactly what we now own.
        record = json.loads(claim.read_text(encoding="utf-8-sig"))
        if op_fingerprint is not None:
            again = [i for i, op, _label in _record_ops(subsystem, record) if _fingerprint(op) == op_fingerprint]
            if not again:
                os.replace(claim, path)
                return {"status": "already_handled", "error": None, "item": item}
            index = again[0]
        if apply:
            target = record if index is None else _single_op_record(subsystem, record, index)
            ok, error, _result = _apply(subsystem, target)
            if not ok:
                os.replace(claim, path)  # untouched: the bytes we claimed go back
                return {"status": "failed", "error": error or "apply failed", "item": item}
        rest = None if index is None else _without_op(record, index)
        if rest is not None:
            atomic_json_write(path, rest)
        claim.unlink()
    except BaseException:
        if claim.exists() and not path.exists():
            os.replace(claim, path)
        raise
    return {"status": "applied" if apply else "rejected", "error": None, "item": item}


# --- evaluation --------------------------------------------------------------------------------

def _numbered(lines: list[str], start: int) -> list[dict[str, Any]]:
    return [{"no": start + i + 1, "text": text} for i, text in enumerate(lines)]


def _change(cur: list[str], new: list[str]) -> tuple[int, int, list[dict], list[dict]]:
    """``(old_start, old_end, removed, added)``: the span between the first and last changed line."""
    ops = [o for o in difflib.SequenceMatcher(None, cur, new, autojunk=False).get_opcodes() if o[0] != "equal"]
    if not ops:
        return len(cur), len(cur), [], []
    i1, i2, j1, j2 = ops[0][1], ops[-1][2], ops[0][3], ops[-1][4]
    return i1, i2, _numbered(cur[i1:i2], i1), _numbered(new[j1:j2], j1)


def _memory_blocks(entry: dict[str, Any]) -> tuple[Optional[list[str]], list[dict[str, Any]]]:
    from tools.memory_tool import load_on_disk_store
    from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore
    target = "user" if entry["file"] == "USER.md" else "memory"
    store = load_on_disk_store()
    entries = list(store._entries_for(target))
    cur = ENTRY_DELIMITER.join(entries).split("\n") if entries else []
    blocks = []
    for record, index, op in entry["ops"]:
        action = op.get("action", "")
        content = op.get("content") or op.get("new_text") or ""
        old_text = op.get("old_text") or ""
        if action != "patch":
            content, old_text = content.strip(), old_text.strip()
        block = _block_base(MEMORY, record, index, op, f"{action} {'in' if action != 'add' else 'to'} {entry['file']}: "
                                                         f"{(content or old_text)[:120]}")
        block.update(range=(len(cur), len(cur)), whole=False, anchor=op.get("matched_entry"))
        if action in {"replace", "remove", "patch"} and not op.get("matched_entry"):
            block.update(stale="This write predates entry pinning, so Hermes refuses to apply it. Reject it "
                               "and recreate the change.")
            blocks.append(block)
            continue
        # Hermes's own dry run of exactly this op. The store counts failed attempts per turn and
        # refuses everything after a few; each op is its own question, so start every run fresh.
        store.reset_consolidation_failures()
        check = store.resolve_batch_entries(target, [op])
        if not check.get("success"):
            block.update(stale=str(check.get("error") or "Hermes would refuse this change."))
            if op.get("matched_entry") in entries:
                at = _entry_line(entries, op["matched_entry"], ENTRY_DELIMITER)
                block.update(range=at, removed=_numbered(cur[at[0]:at[1]], at[0]))
            blocks.append(block)
            continue
        working = list(entries)
        error, *_ = MemoryStore._apply_batch_op(working, action, content, old_text, "op", op.get("matched_entry"))
        new = ENTRY_DELIMITER.join(working).split("\n") if working else []
        i1, i2, removed, added = _change(cur, new)
        block.update(range=(i1, i2), removed=removed, added=added)
        if error:
            block.update(stale=error)
        elif not removed and not added:
            block.update(note=f"Already in {entry['file']}; accepting changes nothing.")
        blocks.append(block)
    return cur, blocks


def _entry_line(entries: list[str], entry: str, delimiter: str) -> tuple[int, int]:
    """Line span of one entry in the joined file text: earlier entries' lines plus one delimiter line each."""
    idx = entries.index(entry)
    start = sum(len(e.split("\n")) for e in entries[:idx]) + idx * (len(delimiter.split("\n")) - 2)
    return start, start + len(entry.split("\n"))


def _skill_blocks(entry: dict[str, Any]) -> tuple[Optional[list[str]], list[dict[str, Any]]]:
    from tools import write_approval as wa
    from tools import skill_manager_tool as smt
    name, rel = entry["name"], entry["rel"]
    found, path_error, current = None, None, None
    name_error = smt._validate_name(Path(name).name) if name else "missing skill name"
    if not name_error:
        found = smt._find_skill(name)
    if found:
        if rel == "SKILL.md":
            target = Path(found["path"]) / "SKILL.md"
        else:
            target, err = smt._resolve_supporting_file(Path(found["path"]), rel)
            path_error = (err or {}).get("error") if err else None
        if target is not None and not path_error and target.is_file():
            current = target.read_text(encoding="utf-8-sig")
    cur = current.splitlines() if current is not None else []
    blocks = []
    for record, index, op in entry["ops"]:
        action = op.get("action", "")
        gist = wa.skill_gist(action, name, content=op.get("content") or "", file_path=op.get("file_path") or "",
                             old_string=op.get("old_string") or "", new_string=op.get("new_string") or "")
        block = _block_base(SKILLS, record, index, op, gist)
        whole = action in _WHOLE_FILE_SKILL_ACTIONS or (action == "patch" and bool(op.get("content")))
        block.update(range=(0, len(cur)), whole=whole, anchor=None)
        new, stale = _skill_after(op, action, name_error, found, path_error, current, rel, smt, wa)
        if stale:
            block.update(stale=stale)
            blocks.append(block)
            continue
        if new is None:  # delete / remove_file: everything goes
            block.update(range=(0, len(cur)), removed=_numbered(cur, 0))
        else:
            i1, i2, removed, added = _change(cur, new.splitlines())
            block.update(range=(0, len(cur)) if whole else (i1, i2), removed=removed, added=added)
            if not removed and not added:
                block.update(note="No textual change.")
        blocks.append(block)
    return (cur if current is not None else None), blocks


def _skill_after(op, action, name_error, found, path_error, current, rel, smt, wa):
    """``(text after this op alone, None)`` or ``(None, stale reason)``; None text means removal."""
    if name_error:
        return None, name_error
    if action == "create":
        if found:
            return None, "A skill with this name already exists."
        return op.get("content") or "", _content_errors(smt, op.get("content") or "", "SKILL.md")
    if not found:
        return None, "The skill no longer exists."
    if path_error:
        return None, path_error
    fp = op.get("file_path")
    if fp and rel != "SKILL.md" and (err := smt._validate_file_path(fp)):
        return None, err
    if action == "delete":
        return None, None
    if action == "remove_file":
        return (None, None) if current is not None else (None, "The file no longer exists.")
    if action == "write_file":
        text = op.get("file_content") or ""
        return text, _content_errors(smt, text, rel) if rel == "SKILL.md" else None
    if action == "edit" or (action == "patch" and op.get("content")):
        return op.get("content") or "", _content_errors(smt, op.get("content") or "", "SKILL.md")
    if action == "patch":
        if current is None:
            return None, "The file no longer exists."
        folded, error = wa._fold_patch(current, op.get("old_string") or "", op.get("new_string") or "",
                                       op.get("replace_all"))
        if error:
            return None, f"The text this patch replaces is no longer found: {error}"
        return folded, _content_errors(smt, folded, rel) if rel == "SKILL.md" else None
    return None, f"Unknown action '{action}'."


def _content_errors(smt, content: str, label: str) -> Optional[str]:
    return smt._validate_content_size(content, label=label) or smt._validate_frontmatter(content)


def _block_base(subsystem, record, index, op, summary) -> dict[str, Any]:
    return {"id": f"{record.get('id', '')}-{_fingerprint(op)}", "record_id": record.get("id", ""),
            "op_index": index, "staged_at": record.get("created_at", 0) or 0,
            "origin": record.get("origin", "foreground"), "summary": summary, "removed": [], "added": [],
            "stale": None, "note": None}


def _overlaps(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a["whole"] or b["whole"]:
        return True
    if a["anchor"] is not None and a["anchor"] == b["anchor"]:
        return True
    (a1, a2), (b1, b2) = a["range"], b["range"]
    if a1 < b2 and b1 < a2:
        return True
    return (a1 == a2 and b1 < a1 < b2) or (b1 == b2 and a1 < b1 < a2)


def _finish(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Assign state / conflicts_with in staged order, then return contract-shaped blocks."""
    ordered = sorted(blocks, key=lambda b: (b["staged_at"], b["record_id"], b["op_index"]))
    live: list[dict[str, Any]] = []
    for b in ordered:
        if b["stale"]:
            b["state"], b["conflicts_with"] = "stale", None
            continue
        clash = next((earlier for earlier in live if _overlaps(earlier, b)), None)
        b["state"], b["conflicts_with"] = ("conflict", clash["id"]) if clash else ("pending", None)
        live.append(b)
    return ordered


def _public(b: dict[str, Any]) -> dict[str, Any]:
    return {"id": b["id"], "record_id": b["record_id"], "op_index": b["op_index"], "state": b["state"],
            "staged_at": b["staged_at"], "origin": b["origin"], "summary": b["summary"],
            "reason": b["stale"] or (f"Overlaps an earlier change ({b['conflicts_with']})." if b["conflicts_with"]
                                     else b["note"]),
            "conflicts_with": b["conflicts_with"], "can_accept": b["stale"] is None,
            "removed": b["removed"], "added": b["added"]}


def _file_entries(subsystem: str, profile: str) -> dict[str, dict[str, Any]]:
    """Current profile scope: key -> {file, ops: [(record, index, op)], name/rel for skills}."""
    from tools import write_approval as wa
    out: dict[str, dict[str, Any]] = {}
    for record in wa.list_pending(subsystem):
        if not _ID_RE.match(str(record.get("id", ""))):
            continue
        for index, op, label in _record_ops(subsystem, record):
            key = _file_key(profile, subsystem, label)
            entry = out.setdefault(key, {"key": key, "file": label, "ops": []})
            if subsystem == SKILLS:
                payload = record.get("payload") or {}
                entry.setdefault("name", op.get("name") or payload.get("name") or "")
                entry.setdefault("rel", _skill_rel(op))
            entry["ops"].append((record, index, op))
    return out


def _evaluate(subsystem: str, entry: dict[str, Any]) -> tuple[Optional[list[str]], list[dict[str, Any]]]:
    cur, blocks = (_memory_blocks if subsystem == MEMORY else _skill_blocks)(entry)
    return cur, _finish(blocks)


def _file_info(profile: str, subsystem: str, entry: dict[str, Any], blocks: list[dict[str, Any]]) -> dict[str, Any]:
    states = [b["state"] for b in blocks]
    return {"key": entry["key"], "profile": profile, "subsystem": subsystem, "file": entry["file"],
            "counts": {"total": len(blocks), "pending": states.count("pending"), "stale": states.count("stale"),
                       "conflict": states.count("conflict")},
            "latest_staged_at": max((b["staged_at"] for b in blocks), default=0)}


def _segments(cur: Optional[list[str]], blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Current text as context, each block where it applies; a clashing block follows the one it
    clashes with (they share a start line, staged order breaks the tie)."""
    segments: list[dict[str, Any]] = []
    pos = 0
    for b in sorted(blocks, key=lambda b: (b["range"][0], b["staged_at"], b["record_id"], b["op_index"])):
        start, end = b["range"]
        if cur is not None and start > pos:
            segments.append({"type": "context", "lines": _numbered(cur[pos:start], pos)})
        segments.append({"type": "block", "block": _public(b)})
        pos = max(pos, end)
    if cur is not None and pos < len(cur):
        segments.append({"type": "context", "lines": _numbered(cur[pos:], pos)})
    return segments


def _find_entry(subsystem: str, profile: str, key: str) -> Optional[dict[str, Any]]:
    with _queue_lock(subsystem):
        return _file_entries(subsystem, profile).get(key)


# --- routes --------------------------------------------------------------------------------------

@router.get("/files")
def list_files(kind: str = "all") -> dict[str, Any]:
    if kind not in _KINDS:
        raise HTTPException(status_code=400, detail="kind must be skills, memory or all")
    files, errors = [], []
    for name in _known_profiles():
        try:
            with _profile_scope(Path(_profiles_mod().get_profile_dir(name))):
                for subsystem in _KINDS[kind]:
                    if not _queue_dir(subsystem).is_dir():
                        continue
                    with _queue_lock(subsystem):
                        entries = _file_entries(subsystem, name)
                    for entry in entries.values():
                        files.append(_file_info(name, subsystem, entry, _evaluate(subsystem, entry)[1]))
        except Exception as exc:  # one broken profile must not hide the others
            errors.append({"profile": name, "error": str(exc)})
    files.sort(key=lambda f: (-f["latest_staged_at"], f["profile"], f["file"]))
    return {"files": files, "profile_errors": errors}


@router.get("/files/{profile}/{subsystem}/{key}/diff")
def file_diff(profile: str, subsystem: str, key: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_key(key)
    home = _resolve_profile(profile)
    with _profile_scope(home):
        entry = _find_entry(subsystem, profile, key)
        if entry is None:
            return {"status": "gone"}
        cur, blocks = _evaluate(subsystem, entry)
    return {"status": "ok", "file": _file_info(profile, subsystem, entry, blocks), "segments": _segments(cur, blocks)}


def _resolve_block(profile: str, subsystem: str, key: str, block_id: str, apply: bool) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_key(key)
    record_id, fingerprint = _parse_block_id(block_id)
    home = _resolve_profile(profile)
    with _resolve_lock, _profile_scope(home):
        with _queue_lock(subsystem):
            outcome = _claim_and_resolve(subsystem, record_id, op_fingerprint=fingerprint, apply=apply,
                                         expected_key=key, profile=profile)
            gone = key not in _file_entries(subsystem, profile)
    return {"status": outcome["status"], "error": outcome["error"], "file_gone": gone}


@router.post("/files/{profile}/{subsystem}/{key}/blocks/{block_id}/accept")
def accept_block(profile: str, subsystem: str, key: str, block_id: str) -> dict[str, Any]:
    return _resolve_block(profile, subsystem, key, block_id, apply=True)


@router.post("/files/{profile}/{subsystem}/{key}/blocks/{block_id}/reject")
def reject_block(profile: str, subsystem: str, key: str, block_id: str) -> dict[str, Any]:
    return _resolve_block(profile, subsystem, key, block_id, apply=False)


def _resolve_all(profile: str, subsystem: str, key: str, apply: bool) -> dict[str, Any]:
    """Walk the file's blocks in staged order, re-evaluating after every step, so a block that an
    earlier accept made stale is skipped instead of applied."""
    _check_subsystem(subsystem)
    _check_key(key)
    home = _resolve_profile(profile)
    results, attempted = [], set()
    with _resolve_lock, _profile_scope(home):
        while True:
            with _queue_lock(subsystem):
                entry = _file_entries(subsystem, profile).get(key)
                if entry is None:
                    break
                blocks = _evaluate(subsystem, entry)[1]
                nxt = next((b for b in blocks if b["id"] not in attempted), None)
                if nxt is None:
                    break
                attempted.add(nxt["id"])
                if apply and nxt["state"] != "pending":
                    results.append({"block_id": nxt["id"], "status": "skipped", "error": _public(nxt)["reason"]})
                    continue
                record_id, fingerprint = _parse_block_id(nxt["id"])
                outcome = _claim_and_resolve(subsystem, record_id, op_fingerprint=fingerprint, apply=apply,
                                             expected_key=key, profile=profile)
                results.append({"block_id": nxt["id"], "status": outcome["status"], "error": outcome["error"]})
    return {"results": results}


@router.post("/files/{profile}/{subsystem}/{key}/accept-all")
def accept_all(profile: str, subsystem: str, key: str) -> dict[str, Any]:
    return _resolve_all(profile, subsystem, key, apply=True)


@router.post("/files/{profile}/{subsystem}/{key}/reject-all")
def reject_all(profile: str, subsystem: str, key: str) -> dict[str, Any]:
    return _resolve_all(profile, subsystem, key, apply=False)
