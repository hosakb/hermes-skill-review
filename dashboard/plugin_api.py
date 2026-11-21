"""Backend for the skill-review desktop plugin: /api/plugins/skill-review/.

Lists, diffs, accepts and rejects staged writes (``<home>/pending/<subsystem>/<id>.json``) for the
two write-approval subsystems, ``skills`` and ``memory``, across every profile under the Hermes
root this process serves. Both go through the shared ``tools.write_approval`` store functions.
Skill diffs come from ``skill_pending_diff``; Hermes has no memory diff, so memory diffs are
built from the record and the profile's current entries with the memory store's own per-op logic.
Acceptance runs the same applier as ``/skills approve`` and ``/memory approve``.
Authentication is the gateway's own plugin API auth; this module adds none. Outside Hermes's own
functions it opens pending records, and reads MEMORY.md, USER.md, every SKILL.md and a staged write's
target file only to fingerprint them for the evaluation cache (read-only). An edit rewrites one op of
a pending record; its dry-run scan writes only inside a temporary folder.
"""

from __future__ import annotations

import base64
import codecs
import copy
import difflib
import hashlib
import json
import os
import posixpath
import re
import tempfile
import threading
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, Body, HTTPException

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


@router.get("/pending/{subsystem}/{owner}/{pending_id}/diff")
def pending_diff(subsystem: str, owner: str, pending_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(owner)
    with _profile_scope(home):
        record = wa.get_pending(subsystem, pending_id)
        if record is None:
            return {"status": "already_handled", "id": pending_id, "profile": owner, "subsystem": subsystem}
        sections = _sections(subsystem, record)
    return {"status": "ok", "item": _summarise(subsystem, owner, record), "sections": sections}


@router.post("/pending/{subsystem}/{owner}/{pending_id}/accept")
def accept(subsystem: str, owner: str, pending_id: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(owner)
    base = {"id": pending_id, "profile": owner, "subsystem": subsystem}
    with _resolve_lock, _profile_scope(home), _queue_lock(subsystem):
        outcome = _claim_and_resolve(subsystem, pending_id, op_fingerprint=None, apply=True)
    if outcome["status"] == "already_handled":
        return {"status": "already_handled", **base}
    if outcome["status"] == "failed":
        # Same as `/skills approve` and `/memory approve`: a failed apply leaves the record staged.
        return {"status": "failed", **base, "item": outcome["item"], "error": outcome["error"] or "apply failed"}
    return {"status": "applied", **base, "item": outcome["item"]}


@router.post("/pending/{subsystem}/{owner}/{pending_id}/reject")
def reject(subsystem: str, owner: str, pending_id: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_id(pending_id)
    home = _resolve_profile(owner)
    base = {"id": pending_id, "profile": owner, "subsystem": subsystem}
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
    op = _ops(payload)[index]  # index counts object ops only, as _record_ops numbers them
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
    dropped = _ops(payload)[index]
    remaining = [op for op in payload["operations"] if op is not dropped]
    return {**record, "payload": {**payload, "operations": remaining}} if remaining else None


def _claim_and_resolve(subsystem: str, record_id: str, *, op_fingerprint: Optional[str], apply: bool,
                       expected_key: Optional[str] = None, profile: str = "",
                       apply_record: Any = None, edit: Optional[tuple[str, str]] = None) -> dict[str, Any]:
    """Resolve one op (``op_fingerprint``) or the whole record (None). Caller holds the queue lock
    inside the profile scope. Returns ``{status, error, item}``. ``apply_record(record, index)``,
    if given, builds the record to apply from the claimed one in place of that op alone. ``edit`` is
    ``(field, text)``: that op is applied with its proposed text replaced; the staged record itself is
    never rewritten."""
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
            if apply_record is not None:
                target = apply_record(record, index)
            else:
                source = record if edit is None or index is None else _with_edit(record, index, *edit)
                target = source if index is None else _single_op_record(subsystem, source, index)
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
    found, path_error, current, target = None, None, None, None
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
    entry["_target"] = target if found and not path_error else None  # read by the evaluation cache
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


def _evaluate_uncached(subsystem: str, entry: dict[str, Any]) -> tuple[Optional[list[str]], list[dict[str, Any]]]:
    cur, blocks = (_memory_blocks if subsystem == MEMORY else _skill_blocks)(entry)
    return cur, _finish(blocks)


# --- evaluation cache ----------------------------------------------------------------------------
#
# Evaluating a file reruns Hermes's own checks: one memory dry run per op, and for skills a lookup
# that parses the frontmatter of every SKILL.md the profile has. The list polls every few seconds,
# so a result is kept per (profile home, subsystem, file key) and reused while every input of the
# evaluation is unchanged:
#   - the staged records the file's ops come from (whole records, so any rewrite counts);
#   - memory: the raw bytes of MEMORY.md and USER.md (the dry run reads both), the store's limits
#     and flags as Hermes loads them from the effective config, and whether memory is hosted;
#   - skills: the skill roots Hermes searches, every SKILL.md under them (path, real path, bytes),
#     which is all the skill lookup reads, and the target file's real path and bytes.
# A result is stored only if those inputs read the same before and after the evaluation, so a write
# that lands during it is never cached. `version` is a digest of the inputs; the desktop refetches a
# diff only when its file's version changes.

_CACHE_MAX = 512
_cache: "OrderedDict[tuple[str, str, str], dict[str, Any]]" = OrderedDict()
_cache_lock = threading.Lock()


def _digest(*parts: Any) -> str:
    h = hashlib.sha256()
    for part in parts:
        data = part if isinstance(part, bytes) else json.dumps(part, sort_keys=True, ensure_ascii=False,
                                                               default=str).encode("utf-8", "surrogatepass")
        h.update(len(data).to_bytes(8, "big"))
        h.update(data)
    return h.hexdigest()


def _file_bytes(path: Any) -> Any:
    """The file's bytes, or a marker for a missing or unreadable one (both are inputs too)."""
    try:
        return Path(path).read_bytes()
    except FileNotFoundError:
        return ["missing"]
    except OSError as exc:
        return ["unreadable", exc.errno, type(exc).__name__]


def _memory_state() -> str:
    from tools.hosted_tool_policy import host_feature_enabled
    from tools.memory_tool import load_on_disk_store
    from tools.memory_tool_store import MemoryStore
    store = load_on_disk_store()
    limits = [store.memory_char_limit, store.user_char_limit, store.memory_enabled, store.user_profile_enabled,
              host_feature_enabled("builtin_memory")]
    return _digest(limits, _file_bytes(MemoryStore._path_for("memory")), _file_bytes(MemoryStore._path_for("user")))


def _skills_state() -> str:
    """Every SKILL.md Hermes's skill lookup can see. The walk skips Hermes's excluded folders (as the
    lookup does) and, like ``Path.rglob`` on Python 3.13+, does not descend into symlinked folders, so
    below a root only a SKILL.md that is itself a symlink can point elsewhere; its target is recorded."""
    from agent.skill_utils import EXCLUDED_SKILL_DIRS, get_all_skills_dirs
    parts: list[Any] = []
    for root in get_all_skills_dirs():
        parts.append(["root", str(root), os.path.realpath(root), root.is_dir()])
        if not root.is_dir():
            continue
        for folder, dirs, names in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_SKILL_DIRS)
            if "SKILL.md" in names:
                path = os.path.join(folder, "SKILL.md")
                parts.append([path, os.readlink(path) if os.path.islink(path) else None])
                parts.append(_file_bytes(path))
    return _digest(*parts)


def _target_state(target: Optional[Path]) -> Any:
    return None if target is None else [str(target), os.path.realpath(target), _file_bytes(target)]


def _state(subsystem: str) -> str:
    return _memory_state() if subsystem == MEMORY else _skills_state()


def _home_key() -> str:
    from hermes_constants import get_hermes_home, hermes_home_key
    return str(hermes_home_key(get_hermes_home()))


def _evaluate(subsystem: str, entry: dict[str, Any], memo: dict) -> tuple[Optional[list[str]], list[dict[str, Any]], str]:
    """``(current lines, finished blocks, version)``, from the cache when every input is unchanged.
    ``memo`` holds one profile's state for one subsystem, shared by the files of one request; fresh
    results wait in it until ``_store`` checks that state again."""
    home = _home_key()
    if "state" not in memo:
        memo.update(state=_state(subsystem), home=home, subsystem=subsystem, fresh=[])
    assert (memo["home"], memo["subsystem"]) == (home, subsystem), "one memo per profile and subsystem"
    state = memo["state"]
    records = _digest([[record, index] for record, index, _op in entry["ops"]])
    cache_key = (home, subsystem, entry["key"])
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit is not None:
            _cache.move_to_end(cache_key)
    if (hit is not None and hit["records"] == records and hit["state"] == state
            and _target_state(hit["target"]) == hit["target_state"]):
        entry["_target"] = hit["target"]  # as an uncached evaluation leaves it (Library reads it)
        return copy.deepcopy(hit["cur"]), copy.deepcopy(hit["blocks"]), hit["version"]
    cur, blocks = _evaluate_uncached(subsystem, entry)
    target = entry.get("_target")
    target_state = _target_state(target)
    version = _digest(records, state, target_state)[:16]
    memo["fresh"].append((cache_key, {"records": records, "state": state, "target": target,
                                      "target_state": target_state, "version": version,
                                      "cur": copy.deepcopy(cur), "blocks": copy.deepcopy(blocks)}))
    return cur, blocks, version


def _store(memo: dict) -> None:
    """Cache the memo's fresh results if the state still reads as it did before they were computed:
    a write that landed in between leaves them uncached. Same profile scope as the evaluation."""
    if not memo.get("fresh"):
        return
    if _state(memo["subsystem"]) == memo["state"]:
        with _cache_lock:
            for cache_key, value in memo["fresh"]:
                _cache[cache_key] = value
                _cache.move_to_end(cache_key)
            while len(_cache) > _CACHE_MAX:
                _cache.popitem(last=False)
    memo["fresh"] = []


def _file_info(profile: str, subsystem: str, entry: dict[str, Any], blocks: list[dict[str, Any]],
               version: str) -> dict[str, Any]:
    states = [b["state"] for b in blocks]
    return {"key": entry["key"], "profile": profile, "subsystem": subsystem, "file": entry["file"],
            "counts": {"total": len(blocks), "pending": states.count("pending"), "stale": states.count("stale"),
                       "conflict": states.count("conflict")},
            "latest_staged_at": max((b["staged_at"] for b in blocks), default=0), "version": version}


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
                    memo: dict = {}
                    for entry in entries.values():
                        _cur, blocks, version = _evaluate(subsystem, entry, memo)
                        files.append(_file_info(name, subsystem, entry, blocks, version))
                    _store(memo)
        except Exception as exc:  # one broken profile must not hide the others
            errors.append({"profile": name, "error": str(exc)})
    files.sort(key=lambda f: (-f["latest_staged_at"], f["profile"], f["file"]))
    return {"files": files, "profile_errors": errors}


@router.get("/files/{owner}/{subsystem}/{key}/diff")
def file_diff(owner: str, subsystem: str, key: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_key(key)
    home = _resolve_profile(owner)
    with _profile_scope(home):
        entry = _find_entry(subsystem, owner, key)
        if entry is None:
            return {"status": "gone"}
        memo: dict = {}
        cur, blocks, version = _evaluate(subsystem, entry, memo)
        _store(memo)
    return {"status": "ok", "file": _file_info(owner, subsystem, entry, blocks, version),
            "segments": _segments(cur, blocks)}


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


@router.post("/files/{owner}/{subsystem}/{key}/blocks/{block_id}/accept")
def accept_block(owner: str, subsystem: str, key: str, block_id: str) -> dict[str, Any]:
    return _resolve_block(owner, subsystem, key, block_id, apply=True)


@router.post("/files/{owner}/{subsystem}/{key}/blocks/{block_id}/reject")
def reject_block(owner: str, subsystem: str, key: str, block_id: str) -> dict[str, Any]:
    return _resolve_block(owner, subsystem, key, block_id, apply=False)


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
                blocks = _evaluate_uncached(subsystem, entry)[1]  # a resolve always re-checks from disk
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


@router.post("/files/{owner}/{subsystem}/{key}/accept-all")
def accept_all(owner: str, subsystem: str, key: str) -> dict[str, Any]:
    return _resolve_all(owner, subsystem, key, apply=True)


@router.post("/files/{owner}/{subsystem}/{key}/reject-all")
def reject_all(owner: str, subsystem: str, key: str) -> dict[str, Any]:
    return _resolve_all(owner, subsystem, key, apply=False)


# =================================================================================================
# Editing a proposed change. New routes; contract v1 above is unchanged.
#
#   GET  /files/{profile}/{subsystem}/{key}/edits
#        {"status": "ok", "blocks": {block_id: {"field", "scope", "text", "limit"}}} for every block whose
#        proposed text can be edited, or {"status": "gone"}. ``limit`` is {"label", "max", "base",
#        "strip"} or None: the count after an edit is base + len(text), text stripped when "strip".
#   POST /files/{profile}/{subsystem}/{key}/blocks/{block_id}/edit   body {"text": str, "apply": bool}
#        Replaces that one op's proposed text. apply=true accepts the edited op through the same
#        claim and single-op Hermes apply as accept, and on failure leaves the staged record exactly
#        as it was. apply=false runs the scan Hermes would run and rewrites only that op's text.
#        {"status", "error", "block_id" (the edited block's new id, when saved), "file_gone"}
#
# Hermes stages a write without scanning it (skills) or scans only some shapes (a memory batch is
# dry-run, a single memory op is not), so "Save as proposal" runs the scan that accepting would run:
# the memory store's threat scan on the new text and on the entry a patch produces, and Skills Guard
# (``_security_scan_skill``, under the record's origin) on a copy of the file in a temporary folder.
# =================================================================================================

_EDIT_MAX_CHARS = 100_000  # Hermes's MAX_SKILL_CONTENT_CHARS; a memory store is far smaller


def _edit_body(raw: Any) -> tuple[str, bool]:
    """``(text, apply)`` from ``{"text": str, "apply": bool}``; nothing else is accepted (no paths, no keys)."""
    if (not isinstance(raw, dict) or set(raw) - {"text", "apply"} or not isinstance(raw.get("text"), str)
            or not isinstance(raw.get("apply", False), bool)):
        raise HTTPException(status_code=422, detail='body must be {"text": string, "apply": boolean}')
    return raw["text"], raw.get("apply", False)


def _edit_field(subsystem: str, op: dict[str, Any]) -> Optional[str]:
    """The op field that holds its proposed text, or None for a removal (nothing to edit)."""
    action = op.get("action", "")
    if subsystem == MEMORY:
        if action not in {"add", "replace", "patch"}:
            return None
        return "new_text" if not op.get("content") and op.get("new_text") else "content"
    if action in {"create", "edit"} or (action == "patch" and op.get("content")):
        return "content"
    return {"patch": "new_string", "write_file": "file_content"}.get(action)


def _edit_scope(subsystem: str, op: dict[str, Any], field: str) -> str:
    """What the text is: ``span`` (a patch's replacement), ``entry`` (a whole memory entry) or ``file``."""
    if field == "new_string" or (subsystem == MEMORY and op.get("action") == "patch"):
        return "span"
    return "entry" if subsystem == MEMORY else "file"


def _with_edit(record: dict[str, Any], index: int, field: str, text: str) -> dict[str, Any]:
    """A copy of the record with op ``index``'s proposed text replaced; nothing else changes."""
    out = copy.deepcopy(record)
    _ops(out["payload"])[index][field] = text
    return out


def _block_id_of(record: dict[str, Any], op: dict[str, Any]) -> str:
    return f"{record.get('id', '')}-{_fingerprint(op)}"


def _entry_op(entry: Optional[dict[str, Any]], block_id: str):
    for record, index, op in (entry or {}).get("ops", []):
        if _block_id_of(record, op) == block_id:
            return record, index, op
    return None


def _read_target(entry: dict[str, Any]) -> Optional[str]:
    """Current text of a skill file, as the last uncached evaluation of ``entry`` located it."""
    target = entry.get("_target")
    try:
        return target.read_text(encoding="utf-8-sig") if target is not None and target.is_file() else None
    except OSError:
        return None


def _skill_after_text(entry: dict[str, Any], op: dict[str, Any], field: str, text: str) -> Optional[str]:
    """The file after this op with ``text`` as its proposed text; None when a patch no longer folds."""
    if field != "new_string":
        return text
    from tools import write_approval as wa
    current = _read_target(entry)
    if current is None:
        return None
    folded, error = wa._fold_patch(current, op.get("old_string") or "", text, op.get("replace_all"))
    return None if error else folded


def _memory_target(entry: dict[str, Any]) -> str:
    return "user" if entry["file"] == "USER.md" else "memory"


def _stale_fixable(subsystem: str, entry: dict[str, Any], op: dict[str, Any], reason: str) -> bool:
    """Whether new text can fix a stale block: content validation yes, a missing target no."""
    if subsystem == MEMORY:
        if op.get("action") == "add":
            return True
        from tools.memory_tool import load_on_disk_store
        pinned = op.get("matched_entry")
        return bool(pinned) and pinned in load_on_disk_store()._entries_for(_memory_target(entry))
    if entry["rel"] != "SKILL.md":
        return False
    from tools import skill_manager_tool as smt
    field = _edit_field(subsystem, op)
    after = _skill_after_text(entry, op, field, op.get(field) or "")
    return after is not None and reason == _content_errors(smt, after, "SKILL.md")


def _edit_refusal(subsystem: str, entry: dict[str, Any], op: dict[str, Any],
                  block: Optional[dict[str, Any]]) -> Optional[str]:
    if _edit_field(subsystem, op) is None:
        return "This change only removes text, so there is nothing to edit."
    if block is not None and block["stale"] and not _stale_fixable(subsystem, entry, op, block["stale"]):
        return f"Editing cannot fix this change: {block['stale']}"
    return None


def _edit_limit(subsystem: str, entry: dict[str, Any], op: dict[str, Any], field: str, text: str,
                store: Any) -> Optional[dict[str, Any]]:
    """Hermes's size limit for this text, when it is a straight function of the text's length."""
    if subsystem == MEMORY:
        from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore
        target = _memory_target(entry)
        entries = list(store._entries_for(target))
        action, content, old = op.get("action", ""), text, op.get("old_text") or ""
        if action != "patch":
            content, old = content.strip(), old.strip()
        if action == "add" and content in entries:
            return None
        working = list(entries)
        error, *_ = MemoryStore._apply_batch_op(working, action, content, old, "op", op.get("matched_entry"))
        if error:
            return None
        total = len(ENTRY_DELIMITER.join(working))
        return {"label": entry["file"], "max": store._char_limit(target), "base": total - len(content),
                "strip": action != "patch"}
    from tools.skill_manager_tool import MAX_SKILL_CONTENT_CHARS
    if field == "new_string" and op.get("replace_all"):
        return None
    after = _skill_after_text(entry, op, field, text)
    if after is None:
        return None
    return {"label": entry["rel"], "max": MAX_SKILL_CONTENT_CHARS, "base": len(after) - len(text), "strip": False}


def _inside(path: Any, root: Any) -> bool:
    """True when ``path`` resolves (symlinks followed) to something strictly inside ``root``."""
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real != base and os.path.commonpath([real, base]) == base


def _edit_scan(subsystem: str, entry: dict[str, Any], record: dict[str, Any], op: dict[str, Any],
               field: str, text: str) -> Optional[str]:
    """The refusal Hermes's content scan gives the edited text, or None."""
    if subsystem == MEMORY:
        from tools import memory_tool_store as mts
        checked = [text]
        if op.get("action") == "patch" and op.get("matched_entry"):
            checked.append(op["matched_entry"].replace(op.get("old_text") or "", text, 1))
        return next((error for error in map(mts._scan_memory_content, checked) if error), None)
    from tools.skill_provenance import BACKGROUND_REVIEW
    rel = "SKILL.md" if field == "content" else entry["rel"]
    after = _skill_after_text(entry, op, field, text)
    current = None if op.get("action") == "create" else _read_target(entry)
    return _scan_skill_copy(rel, current, after if after is not None else text,
                            background=record.get("origin") == BACKGROUND_REVIEW)


def _scan_skill_copy(rel: str, current: Optional[str], after: str, *, background: bool) -> Optional[str]:
    """Skills Guard's verdict on ``after`` as the skill file ``rel``, run on a copy in a temporary
    folder: the current text first (the baseline for a background write), then the new text.
    The real skill folder is never touched. None when the scan passes or is not required."""
    from tools import skill_manager_tool as smt
    from tools.skill_manager_scan import _replaying_background_write, _scan_baseline
    token = _replaying_background_write.set(background)
    try:
        with tempfile.TemporaryDirectory(prefix="skill-review-scan-") as tmp:
            skill_dir = Path(tmp) / "skill"
            target = skill_dir / rel
            if not _inside(target, skill_dir):
                return "That file is not inside the skill."
            target.parent.mkdir(parents=True, exist_ok=True)
            if current is not None:
                target.write_text(current, encoding="utf-8")
            scope, baseline, error = _scan_baseline(skill_dir, target)
            if error:
                return error
            target.write_text(after, encoding="utf-8")
            return smt._security_scan_skill(skill_dir, baseline, scope)
    finally:
        _replaying_background_write.reset(token)


def _claim_and_rewrite(subsystem: str, profile: str, key: str, record_id: str, fingerprint: str,
                       field: str, text: str) -> dict[str, Any]:
    """Save as proposal: claim the record, rewrite that one op's text in what we claimed, put it back
    with Hermes's ``atomic_json_write``. Same claim as a resolve, so a concurrent chat approve or a
    second edit finds nothing, and an op that changed meanwhile is not rewritten."""
    from utils import atomic_json_write
    gone = {"status": "already_handled", "error": None, "block_id": None}
    path = _queue_dir(subsystem) / f"{record_id}.json"
    claim = path.with_name(path.name + _CLAIM_SUFFIX)
    try:
        os.rename(path, claim)
    except FileNotFoundError:
        return gone
    try:
        record = json.loads(claim.read_text(encoding="utf-8-sig"))
        again = [i for i, op, label in _record_ops(subsystem, record)
                 if _fingerprint(op) == fingerprint and _file_key(profile, subsystem, label) == key]
        if not again:
            os.replace(claim, path)
            return gone
        edited = _with_edit(record, again[0], field, text)
        atomic_json_write(path, edited)
        claim.unlink()
    except BaseException:
        if claim.exists() and not path.exists():
            os.replace(claim, path)
        raise
    return {"status": "saved", "error": None, "block_id": _block_id_of(edited, _ops(edited["payload"])[again[0]])}


def _edit(subsystem: str, profile: str, key: str, block_id: str, text: str, apply: bool) -> dict[str, Any]:
    """Caller holds the resolve lock and the queue lock inside the profile scope."""
    record_id, fingerprint = _parse_block_id(block_id)
    entry = _file_entries(subsystem, profile).get(key)
    found = _entry_op(entry, block_id)
    if found is None:
        return {"status": "already_handled", "error": None, "block_id": None}
    record, _index, op = found
    blocks = {b["id"]: b for b in _evaluate_uncached(subsystem, entry)[1]}  # an edit always re-checks from disk
    if refusal := _edit_refusal(subsystem, entry, op, blocks.get(block_id)):
        return {"status": "not_editable", "error": refusal, "block_id": None}
    field = _edit_field(subsystem, op)
    if apply:
        out = _claim_and_resolve(subsystem, record_id, op_fingerprint=fingerprint, apply=True,
                                 expected_key=key, profile=profile, edit=(field, text))
        return {"status": out["status"], "error": out["error"], "block_id": None}
    if blocked := _edit_scan(subsystem, entry, record, op, field, text):
        return {"status": "blocked", "error": blocked, "block_id": None}
    return _claim_and_rewrite(subsystem, profile, key, record_id, fingerprint, field, text)


@router.get("/files/{owner}/{subsystem}/{key}/edits")
def file_edits(owner: str, subsystem: str, key: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_key(key)
    home = _resolve_profile(owner)
    with _profile_scope(home):
        entry = _find_entry(subsystem, owner, key)
        if entry is None:
            return {"status": "gone"}
        blocks = {b["id"]: b for b in _evaluate_uncached(subsystem, entry)[1]}
        store = None
        if subsystem == MEMORY:
            from tools.memory_tool import load_on_disk_store
            store = load_on_disk_store()
        out = {}
        for record, _index, op in entry["ops"]:
            block_id = _block_id_of(record, op)
            if _edit_refusal(subsystem, entry, op, blocks.get(block_id)) is not None:
                continue
            field = _edit_field(subsystem, op)
            text = op.get(field) or ""
            out[block_id] = {"field": field, "scope": _edit_scope(subsystem, op, field), "text": text,
                             "limit": _edit_limit(subsystem, entry, op, field, text, store)}
    return {"status": "ok", "blocks": out}


@router.post("/files/{owner}/{subsystem}/{key}/blocks/{block_id}/edit")
def edit_block(owner: str, subsystem: str, key: str, block_id: str, raw: Any = Body(...)) -> dict[str, Any]:
    text, apply = _edit_body(raw)
    _check_subsystem(subsystem)
    _check_key(key)
    _parse_block_id(block_id)
    if len(text) > _EDIT_MAX_CHARS:
        raise HTTPException(status_code=413, detail=f"an edit is at most {_EDIT_MAX_CHARS:,} characters")
    home = _resolve_profile(owner)
    with _resolve_lock, _profile_scope(home):
        with _queue_lock(subsystem):
            outcome = _edit(subsystem, owner, key, block_id, text, apply)
            if outcome["status"] in ("applied", "saved"):
                _forget_cached(subsystem)  # as Remove entirely does: never answer an edited file from the cache
            gone = key not in _file_entries(subsystem, owner)
    return {**outcome, "file_gone": gone}


# =================================================================================================
# Remove entirely (memory only): delete the entry that a replace or patch block targets and drop
# that proposal, so neither the old line nor the new one stays.
#
# The deletion is Hermes's own staged remove: a one-op batch ``{"action": "remove", "old_text":
# entry, "matched_entry": entry}`` on the claimed record, applied through ``_apply_one`` like an
# accept. Hermes then takes the memory file lock, re-reads the file, refuses if the pinned entry is
# no longer exactly there, and writes atomically. The op is dropped from the staged record only
# after that succeeded; a refusal puts the claimed bytes back. Skill blocks are refused: deleting a
# span of a skill file needs its own design.
# =================================================================================================

_REMOVABLE_ACTIONS = {"replace", "patch"}
_NOT_REMOVABLE = ("Remove entirely works only on a change that replaces or patches an existing entry. "
                  "Nothing was removed.")


def _removal_refusal(entry: dict[str, Any], block_id: str, op: dict[str, Any]) -> Optional[str]:
    """Why this block's entry cannot be removed, or None. Caller holds the queue lock in the
    profile scope. The block is evaluated fresh from disk, never from the cache."""
    from tools.memory_tool_store import MemoryStore
    if op.get("action") not in _REMOVABLE_ACTIONS or not op.get("matched_entry"):
        return _NOT_REMOVABLE
    block = next((b for b in _evaluate_uncached(MEMORY, entry)[1] if b["id"] == block_id), None)
    if block is None or not block["removed"] or not block["added"]:
        return _NOT_REMOVABLE
    if block["stale"]:
        return f"This change can no longer apply, so nothing was removed: {block['stale']}"
    pinned = op["matched_entry"]
    if len(block["removed"]) != 1 or block["removed"][0]["text"] != pinned:
        return ("This entry spans several lines. Remove entirely handles single-line entries only. "
                "Nothing was removed.")
    path = MemoryStore._path_for("user" if entry["file"] == "USER.md" else "memory")
    raw, read_ok = MemoryStore._read_raw_checked(path)
    if not read_ok:
        return f"{entry['file']} could not be read. Nothing was removed."
    count = MemoryStore._parse_entries(raw).count(pinned)
    if count > 1:
        return (f"This entry appears more than once in {entry['file']}, so it is not clear which one to "
                f"delete. Nothing was removed.")
    if count == 0:
        return _NOT_REMOVABLE
    return None


def _remove_record(record: dict[str, Any], index: Optional[int]) -> dict[str, Any]:
    """The claimed record as Hermes would stage a single pinned remove of that op's entry."""
    payload = record["payload"]
    op = _ops(payload)[index or 0]
    remove_op = {"action": "remove", "old_text": op["matched_entry"], "matched_entry": op["matched_entry"]}
    return {**record, "payload": {"action": "batch", "target": payload.get("target", "memory"),
                                  "operations": [remove_op]}}


def _forget_cached(subsystem: str) -> None:
    """Drop this profile's cached evaluations of ``subsystem``. The inputs fingerprint already
    changes with the write; this keeps a removal from ever being answered from the cache."""
    home = _home_key()
    with _cache_lock:
        for cache_key in [k for k in _cache if k[0] == home and k[1] == subsystem]:
            del _cache[cache_key]


@router.post("/files/{owner}/{subsystem}/{key}/blocks/{block_id}/remove-entry")
def remove_entry_block(owner: str, subsystem: str, key: str, block_id: str) -> dict[str, Any]:
    from tools import write_approval as wa
    _check_subsystem(subsystem)
    _check_key(key)
    record_id, fingerprint = _parse_block_id(block_id)
    home = _resolve_profile(owner)
    if subsystem != MEMORY:
        return {"status": "failed", "error": "Remove entirely works only on memory entries.", "file_gone": False}
    with _resolve_lock, _profile_scope(home):
        with _queue_lock(subsystem):
            outcome = {"status": "already_handled", "error": None}
            record = wa.get_pending(subsystem, record_id)
            found = [] if record is None else [
                (op, label) for _i, op, label in _record_ops(subsystem, record) if _fingerprint(op) == fingerprint]
            if found:
                op, label = found[0]
                entry = _file_entries(subsystem, owner).get(key)
                if _file_key(owner, subsystem, label) != key or entry is None:
                    outcome = {"status": "failed", "error": "that change belongs to another file"}
                elif refusal := _removal_refusal(entry, block_id, op):
                    outcome = {"status": "failed", "error": refusal}
                else:
                    outcome = _claim_and_resolve(subsystem, record_id, op_fingerprint=fingerprint, apply=True,
                                                 expected_key=key, profile=owner, apply_record=_remove_record)
                    if outcome["status"] == "applied":
                        outcome["status"] = "removed"
                        _forget_cached(subsystem)
            gone = key not in _file_entries(subsystem, owner)
    return {"status": outcome["status"], "error": outcome["error"], "file_gone": gone}


# =================================================================================================
# Library: browse and edit each profile's identity, memory and skill files.
#
#   GET /library
#       One row per profile: identity files (SOUL.md, PROJECT.md, AGENTS.md when present), memory
#       files (MEMORY.md, USER.md) and skill folders (SKILL.md plus text files under Hermes's
#       allowed subfolders), each with its count of pending blocks from the same aggregation as
#       /files. A pending block whose file is not listed (a new skill, say) is in ``staged``.
#   GET /library/{owner}/{key}
#       The file's text and a version token ``<sha256 of the bytes>:<mtime_ns>`` ("absent" for a
#       memory file that does not exist yet). Text only: at most 1 MB, strict UTF-8, no NUL bytes.
#   PUT /library/{owner}/{key}   body {"text": str, "version": str}
#       Writes the text straight to the file: 409 when the file changed since that version, 422
#       when one of Hermes's checks refuses it (nothing is written), else an atomic replace.
#
# The key is opaque. Every request rebuilds the list of files this module may touch for that
# profile, here on the server, and looks the key up in it, so a client never names a path. A file
# is on the list only when its real path (symlinks followed) is inside the profile home, or for
# skill files inside the skills root it was found under. A save takes the list again under its
# locks, so a symlink swapped in after the read is refused.
# =================================================================================================

LIBRARY_IDENTITY = ("SOUL.md", "PROJECT.md", "AGENTS.md")
LIBRARY_READ_MAX = 1_048_576
IDENTITY_MAX_CHARS = 200_000
_SNIFF_BYTES = 8192
_ABSENT = "absent"
_LIBRARY_KINDS = {"identity": None, "memory": MEMORY, "skill": SKILLS}


def _library_key(profile: str, path: Any) -> str:
    """Opaque, URL-safe, 16 characters, from the profile and the listed path; never parsed back."""
    digest = hashlib.sha256(f"library\0{profile}\0{path}".encode("utf-8", "surrogatepass")).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode("ascii")


def _contained(path: Any, root: Any) -> bool:
    """A regular file (or, for a memory file, nothing yet) whose real path is inside ``root``."""
    if os.path.lexists(path) and not os.path.isfile(path):  # a folder, a dangling link, a device
        return False
    return _inside(path, root)


def _looks_text(path: Path) -> bool:
    """No NUL byte and valid UTF-8 in the first 8 KB. The tree lists only such supporting files."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(_SNIFF_BYTES)
    except OSError:
        return False
    if b"\0" in head:
        return False
    try:
        codecs.getincrementaldecoder("utf-8")().decode(head, final=False)
    except UnicodeDecodeError:
        return False
    return True


def _skill_files(skill_dir: Path) -> list[str]:
    """SKILL.md, then every file under Hermes's allowed subfolders (the only places its write_file
    reaches), sorted. Excluded folders are skipped and symlinked folders are not entered."""
    from agent.skill_utils import EXCLUDED_SKILL_DIRS
    from tools.skill_manager_tool import ALLOWED_SUBDIRS
    rels = ["SKILL.md"]
    for sub in sorted(ALLOWED_SUBDIRS):
        top = skill_dir / sub
        if not top.is_dir() or top.is_symlink():
            continue
        found = []
        for folder, dirs, names in os.walk(top):
            dirs[:] = [d for d in dirs if d not in EXCLUDED_SKILL_DIRS]
            found += [Path(folder, n).relative_to(skill_dir).as_posix() for n in names]
        rels += sorted(found)
    return rels


def _library_candidates(profile: str) -> list[dict[str, Any]]:
    """Every file Library may show or write for ``profile``, in the current profile scope."""
    from agent.skill_utils import get_all_skills_dirs, get_external_skills_dirs
    from hermes_constants import get_hermes_home
    from tools import skill_manager_tool as smt
    from tools.memory_tool_store import MemoryStore
    home = Path(get_hermes_home())
    out: list[dict[str, Any]] = []

    def add(kind: str, name: str, path: Path, root: Path, **extra: Any) -> None:
        if _contained(path, root):
            out.append({"key": _library_key(profile, path), "kind": kind, "name": name, "path": path,
                        "root": root, "skill": None, **extra})

    for name in LIBRARY_IDENTITY:
        if os.path.lexists(home / name):
            add("identity", name, home / name, home)
    for target in ("memory", "user"):
        path = MemoryStore._path_for(target)
        add("memory", path.name, path, home, target=target)
    external = {os.path.realpath(d) for d in get_external_skills_dirs()}
    seen: set[str] = set()
    for root in get_all_skills_dirs():
        if not root.is_dir():
            continue
        for skill_dir in sorted(smt._iter_skill_dirs(root), key=lambda d: d.relative_to(root).as_posix()):
            real = os.path.realpath(skill_dir)
            if real in seen:
                continue
            seen.add(real)
            for rel in _skill_files(skill_dir):
                add("skill", rel, skill_dir / rel, root, skill=skill_dir.name, skill_dir=skill_dir,
                    external=os.path.realpath(root) in external)
    return out


def _library_entry(profile: str, key: str) -> dict[str, Any]:
    entry = next((c for c in _library_candidates(profile) if c["key"] == key), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="That file is not in the library. Reload the list.")
    return entry


def _library_pending(profile: str) -> list[tuple[Optional[tuple[str, str]], dict[str, Any]]]:
    """``(match, row)`` per pending file of the profile in scope: the same entries, evaluation and
    cache as /files. ``match`` names the file the blocks change: ("memory", target), ("path", real
    path) for a skill file Hermes's lookup located, or None."""
    out = []
    for subsystem in SUBSYSTEMS:
        if not _queue_dir(subsystem).is_dir():
            continue
        with _queue_lock(subsystem):
            entries = _file_entries(subsystem, profile)
        memo: dict = {}
        for entry in entries.values():
            _cur, blocks, _version = _evaluate(subsystem, entry, memo)
            if subsystem == MEMORY:
                match = (MEMORY, _memory_target(entry))
            else:
                target = entry.get("_target")
                match = ("path", os.path.realpath(target)) if target is not None else None
            out.append((match, {"file": entry["file"], "subsystem": subsystem, "pending": len(blocks),
                                "review": {"subsystem": subsystem, "key": entry["key"]}}))
        _store(memo)
    return out


def _stat(path: Path) -> tuple[bool, int, float]:
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return False, 0, 0
    return True, st.st_size, st.st_mtime


def _library_public(entry: dict[str, Any], **extra: Any) -> dict[str, Any]:
    exists, size, mtime = _stat(entry["path"])
    return {"key": entry["key"], "kind": entry["kind"], "name": entry["name"], "skill": entry["skill"],
            "exists": exists, "size": size, "mtime": mtime, **extra}


def _library_profile(name: str) -> dict[str, Any]:
    """One profile's tree with pending counts. Raises on a broken profile; the route reports it."""
    with _profile_scope(Path(_profiles_mod().get_profile_dir(name))):
        candidates = [c for c in _library_candidates(name)
                      if c["kind"] != "skill" or c["name"] == "SKILL.md" or _looks_text(c["path"])]
        pending = _library_pending(name)
    by_match: dict[tuple[str, str], dict[str, Any]] = {}
    for c in candidates:
        match = (MEMORY, c["target"]) if c["kind"] == "memory" else (
            ("path", os.path.realpath(c["path"])) if c["kind"] == "skill" else None)
        if match is not None:
            by_match[match] = {"pending": 0, "review": None}
    staged = []
    for match, row in pending:
        slot = by_match.get(match) if match is not None else None
        if slot is None or slot["review"] is not None:
            staged.append(row)
            continue
        slot.update(pending=row["pending"], review=row["review"])

    def public(c: dict[str, Any]) -> dict[str, Any]:
        match = (MEMORY, c["target"]) if c["kind"] == "memory" else (
            ("path", os.path.realpath(c["path"])) if c["kind"] == "skill" else None)
        slot = by_match.get(match, {"pending": 0, "review": None}) if match is not None else {"pending": 0, "review": None}
        return _library_public(c, pending=slot["pending"], review=slot["review"])

    skills: dict[str, dict[str, Any]] = {}
    for c in candidates:
        if c["kind"] == "skill":
            group = skills.setdefault(str(c["skill_dir"]), {"name": c["skill"], "external": c["external"],
                                                            "pending": 0, "files": []})
            group["files"].append(public(c))
            group["pending"] += group["files"][-1]["pending"]
    row = {"profile": name, "error": None,
           "identity": [public(c) for c in candidates if c["kind"] == "identity"],
           "memory": [public(c) for c in candidates if c["kind"] == "memory"],
           "skills": list(skills.values()), "staged": staged}
    row["pending"] = (sum(f["pending"] for f in row["identity"] + row["memory"])
                      + sum(s["pending"] for s in row["skills"]) + sum(s["pending"] for s in staged))
    return row


def _read_library_bytes(entry: dict[str, Any]) -> Optional[bytes]:
    """The file's bytes, None for a memory file that does not exist yet; 413 past 1 MB."""
    real = os.path.realpath(entry["path"])
    try:
        with open(real, "rb") as fh:
            if os.fstat(fh.fileno()).st_size > LIBRARY_READ_MAX:
                raise HTTPException(status_code=413, detail=f"{entry['name']} is larger than 1 MB, so Library does not open it.")
            return fh.read(LIBRARY_READ_MAX + 1)
    except FileNotFoundError:
        if entry["kind"] == "memory":
            return None
        raise HTTPException(status_code=404, detail="That file no longer exists. Reload the list.")


def _library_text(entry: dict[str, Any], raw: Optional[bytes]) -> str:
    if raw is None:
        return ""
    if len(raw) > LIBRARY_READ_MAX:
        raise HTTPException(status_code=413, detail=f"{entry['name']} is larger than 1 MB, so Library does not open it.")
    try:
        if b"\0" in raw:
            raise UnicodeDecodeError("utf-8", raw, 0, 1, "NUL byte")
        return raw.decode("utf-8")  # strict, and a BOM stays in the text so a save writes it back
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail=f"{entry['name']} is not UTF-8 text, so Library cannot open it.")


def _library_version(entry: dict[str, Any], raw: Optional[bytes]) -> str:
    if raw is None:
        return _ABSENT
    return f"{hashlib.sha256(raw).hexdigest()}:{os.stat(os.path.realpath(entry['path'])).st_mtime_ns}"


def _version_matches(token: str, raw: Optional[bytes]) -> bool:
    """Only the content hash decides; a touch that changes nothing else is not a conflict."""
    if raw is None:
        return token == _ABSENT
    return token.partition(":")[0] == hashlib.sha256(raw).hexdigest()


def _library_limit(entry: dict[str, Any]) -> dict[str, Any]:
    if entry["kind"] == "memory":
        from tools.memory_tool import load_on_disk_store
        return {"label": entry["name"], "max": load_on_disk_store()._char_limit(entry["target"])}
    if entry["kind"] == "skill":
        from tools.skill_manager_tool import MAX_SKILL_CONTENT_CHARS
        return {"label": entry["name"], "max": MAX_SKILL_CONTENT_CHARS}
    return {"label": entry["name"], "max": IDENTITY_MAX_CHARS}


def _memory_save_refusal(entry: dict[str, Any], text: str, current: str) -> Optional[str]:
    """The memory store's own rules for this text: its char limit and its threat scan. Like the
    store, a write that only deletes entries may stay over the limit, and only entries that are new
    or changed are scanned, so a file that already holds a blocked entry can still be cleaned up."""
    from tools.hosted_tool_policy import host_feature_enabled
    from tools.memory_tool import load_on_disk_store
    from tools.memory_tool_store import ENTRY_DELIMITER, MemoryStore, _over_limit, _scan_memory_content
    if not host_feature_enabled("builtin_memory"):
        return "Memory is not available to a hosted agent."
    target = entry["target"]
    limit = load_on_disk_store()._char_limit(target)
    before = set(MemoryStore._parse_entries(current))
    after = list(dict.fromkeys(MemoryStore._parse_entries(text)))
    total = len(ENTRY_DELIMITER.join(after))
    if total > limit and not set(after) <= before:
        setting = "memory.user_char_limit" if target == "user" else "memory.memory_char_limit"
        return f"{entry['name']}: this text {_over_limit(total, limit)} (the limit is {setting})."
    return next((error for e in after if e not in before and (error := _scan_memory_content(e))), None)


def _skill_save_refusal(entry: dict[str, Any], text: str, current: str) -> Optional[str]:
    """Hermes's checks for a skill write: the size limit, for SKILL.md the frontmatter and the
    description budget, then Skills Guard on a copy (as an edit of a proposed change runs it)."""
    from tools import skill_manager_tool as smt
    rel = entry["name"]
    if error := smt._validate_content_size(text, label=rel):
        return error
    if rel == "SKILL.md" and (error := smt._validate_frontmatter(text) or smt._description_budget_error(text, before=current)):
        return error
    return _scan_skill_copy(rel, current, text, background=False)


def _library_refusal(entry: dict[str, Any], text: str, current: str) -> Optional[str]:
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return "The text is not valid UTF-8, so it was not saved."
    if entry["kind"] == "memory":
        return _memory_save_refusal(entry, text, current)
    if entry["kind"] == "skill":
        return _skill_save_refusal(entry, text, current)
    if len(text) > IDENTITY_MAX_CHARS:
        return f"{entry['name']} can be at most {IDENTITY_MAX_CHARS:,} characters. This text has {len(text):,}."
    return None


@contextmanager
def _library_lock(entry: dict[str, Any]) -> Iterator[None]:
    """One lock per profile for Library saves (three Hermes processes mount this plugin), then
    Hermes's own lock for the file: the memory store's file lock, or the per-skill mutation lock."""
    from hermes_constants import get_hermes_home
    from tools.skill_usage import skill_file_lock
    with skill_file_lock(Path(get_hermes_home()) / "pending" / ".skill-review-library.lock"):
        if entry["kind"] == "memory":
            from tools.memory_tool_store import MemoryStore
            with MemoryStore._file_lock(entry["path"]):
                yield
        elif entry["kind"] == "skill":
            from tools import skill_manager_tool as smt
            with smt._skill_mutation_lock(entry["skill"]):
                yield
        else:
            yield


def _library_body(raw: Any) -> tuple[str, str]:
    """``(text, version)`` from ``{"text": str, "version": str}``; nothing else is accepted (no paths)."""
    if (not isinstance(raw, dict) or set(raw) != {"text", "version"} or not isinstance(raw["text"], str)
            or not isinstance(raw["version"], str)):
        raise HTTPException(status_code=400, detail='body must be {"text": string, "version": string}')
    return raw["text"], raw["version"]


@router.get("/library")
def list_library() -> dict[str, Any]:
    profiles = []
    for name in _known_profiles():
        try:
            profiles.append(_library_profile(name))
        except Exception as exc:  # one broken profile must not hide the others
            profiles.append({"profile": name, "pending": 0, "error": str(exc), "identity": [], "memory": [],
                             "skills": [], "staged": []})
    return {"profiles": profiles, "total": sum(p["pending"] for p in profiles)}


@router.get("/library/{owner}/{key}")
def read_library_file(owner: str, key: str) -> dict[str, Any]:
    _check_key(key)
    home = _resolve_profile(owner)
    with _profile_scope(home):
        entry = _library_entry(owner, key)
        raw = _read_library_bytes(entry)
        text = _library_text(entry, raw)
        return {"status": "ok", "file": _library_public(entry), "text": text,
                "version": _library_version(entry, raw), "limit": _library_limit(entry)}


@router.put("/library/{owner}/{key}")
def save_library_file(owner: str, key: str, raw: Any = Body(...)) -> dict[str, Any]:
    from utils import atomic_write_text
    text, version = _library_body(raw)
    _check_key(key)
    if len(text) > LIBRARY_READ_MAX:
        raise HTTPException(status_code=413, detail="Library saves at most 1 MB of text.")
    home = _resolve_profile(owner)
    with _profile_scope(home):
        entry = _library_entry(owner, key)
        with _library_lock(entry):
            entry = _library_entry(owner, key)  # again under the locks: the path may have changed
            current = _read_library_bytes(entry)
            if not _version_matches(version, current):
                raise HTTPException(status_code=409, detail=f"{entry['name']} changed on disk since you opened it. "
                                                            f"Reload it to see the new text.")
            if refusal := _library_refusal(entry, text, _library_text(entry, current)):
                raise HTTPException(status_code=422, detail=refusal)
            try:
                atomic_write_text(os.path.realpath(entry["path"]), text, tmp_prefix=".skill-review-",
                                  preserve_mode=True)
            except OSError as exc:
                raise HTTPException(status_code=500, detail=f"Could not write {entry['name']}: "
                                                            f"{exc.strerror or exc}. The file on disk is unchanged.")
            if subsystem := _LIBRARY_KINDS[entry["kind"]]:
                _forget_cached(subsystem)  # as accept and edit do: pending blocks are evaluated again
            saved = _read_library_bytes(entry)
            return {"status": "saved", "file": _library_public(entry), "version": _library_version(entry, saved)}
