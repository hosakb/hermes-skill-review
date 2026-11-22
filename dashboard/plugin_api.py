"""Backend for the skill-review desktop plugin: /api/plugins/skill-review/.

Pending lists, previews, accepts and rejects the staged memory and skill writes of the profile the
host scoped the request to. It uses only Hermes's public write review API
(``tools.write_review_api``: ``list_writes``, ``preview_write`` and ``decide_write``). It never
reads, rewrites or renames the pending queue itself, and it decides a write only as a whole: an
accept or reject sends back the ``expect`` of the preview the user looked at, unchanged. On a Hermes
without that API every Pending route answers ``{"status": "unavailable"}``; nothing falls back to
other code.

Library lists the profile's identity, memory and skill files and opens them as text. It saves only
the identity files (SOUL.md, PROJECT.md, AGENTS.md). Memory and skill files are read-only here,
because Hermes has no public helper yet for the checks and locks a save of those files needs.

Authentication and the profile scope are the host's (its plugin route dependency); this module
adds neither and serves only the profile the request is scoped to.
"""

from __future__ import annotations

import base64
import codecs
import difflib
import hashlib
import json
import os
import posixpath
import re
import secrets
import stat
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, Body, HTTPException

try:
    from tools.write_review_api import decide_write, list_writes, preview_write
except ImportError:  # a Hermes from before the public write review API
    decide_write = list_writes = preview_write = None

router = APIRouter()

SKILLS = "skills"
MEMORY = "memory"
SUBSYSTEMS = (SKILLS, MEMORY)
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_PROFILE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{16}$")
_BLOCK_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-([0-9a-f]{10})$")
_KINDS = {"all": SUBSYSTEMS, SKILLS: (SKILLS,), MEMORY: (MEMORY,)}

NEEDS_API = ("This version of Skill Review needs a Hermes with the write review API "
             "(tools.write_review_api). Update Hermes to review staged writes here. Library still works.")
WHOLE_WRITE = ("This change is one part of a write with {n} changes. Hermes accepts or rejects a write only "
               "as a whole, so use Accept all or Reject all for this file.")
UNSEEN = "This write was staged after the file was loaded. Look at it first, then decide."
_PAGE_SIZE = 100
_MAX_PAGES = 100


def review_api_available() -> bool:
    """Whether this Hermes has the public write review API. Decided once, at import."""
    return list_writes is not None and preview_write is not None and decide_write is not None


def _unavailable(**extra: Any) -> dict[str, Any]:
    return {"status": "unavailable", "message": NEEDS_API, **extra}


# --- profile ---------------------------------------------------------------------------------------

def _active_profile() -> str:
    """The profile the host scoped this request to. The plugin never switches profiles itself."""
    from hermes_constants import get_hermes_home, profile_name_for_home
    return profile_name_for_home(get_hermes_home()) or "default"


def _check_owner(owner: str) -> str:
    """400 for a malformed name, 404 for any profile other than the one this request is scoped to."""
    active = _active_profile()
    if owner == active:
        return owner
    if owner != "default" and not _PROFILE_RE.match(owner or ""):
        raise HTTPException(status_code=400, detail="invalid profile name")
    raise HTTPException(status_code=404, detail=f"That file belongs to profile '{owner}', and Desktop is connected "
                                                f"to '{active}'. Switch Desktop to '{owner}' to open it.")


def _check_subsystem(subsystem: str) -> str:
    if subsystem not in SUBSYSTEMS:
        raise HTTPException(status_code=400, detail="subsystem must be 'skills' or 'memory'")
    return subsystem


def _check_key(key: str) -> str:
    if not _KEY_RE.match(key or ""):
        raise HTTPException(status_code=400, detail="invalid file key")
    return key


def _parse_block_id(block_id: str) -> tuple[str, str]:
    m = _BLOCK_RE.match(block_id or "")
    if not m:
        raise HTTPException(status_code=400, detail="invalid block id")
    return m.group(1), m.group(2)


def _digest(*parts: Any) -> str:
    h = hashlib.sha256()
    for part in parts:
        data = json.dumps(part, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8", "surrogatepass")
        h.update(len(data).to_bytes(8, "big"))
        h.update(data)
    return h.hexdigest()


def _file_key(profile: str, subsystem: str, file: str) -> str:
    """Opaque, URL-safe, 16 characters; derived from the triple and never parsed back."""
    digest = hashlib.sha256(f"{profile}\0{subsystem}\0{file}".encode("utf-8", "surrogatepass")).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode("ascii")


# --- the public API, page by page ------------------------------------------------------------------

def _pending_writes() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Every pending write of the scoped profile (metadata only) and the last ``list_writes`` reply,
    which carries the counts, the gates and the needs_review counts."""
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    page, reply = 1, {}
    while page <= _MAX_PAGES:
        reply = list_writes("all", page=page, page_size=_PAGE_SIZE)
        for item in reply.get("items") or []:
            ident = (item.get("kind"), item.get("id"))
            if ident[0] in SUBSYSTEMS and _ID_RE.match(str(ident[1] or "")) and ident not in seen:
                seen.add(ident)
                items.append(item)
        if page * _PAGE_SIZE >= int(reply.get("total") or 0):
            break
        page += 1
    return items, reply


def _counts(reply: dict[str, Any], key: str) -> dict[str, int]:
    raw = reply.get(key) if isinstance(reply.get(key), dict) else {}
    out = {k: int(raw.get(k) or 0) for k in SUBSYSTEMS}
    out["total"] = sum(out.values())
    return out


def _gates(reply: dict[str, Any]) -> dict[str, bool]:
    raw = reply.get("gates") if isinstance(reply.get("gates"), dict) else {}
    return {k: bool(raw.get(k)) for k in SUBSYSTEMS}


# --- one write as file blocks ----------------------------------------------------------------------

def _memory_label(target: Any) -> str:
    return "USER.md" if target == "user" else "MEMORY.md"


def _skill_rel(op: dict[str, Any]) -> str:
    """The file an op changes, relative to its skill: the preview diff's own ``a/<file>`` header
    when it has one, else the op's ``file_path``. Display and grouping only; nothing is opened."""
    diff = op.get("diff")
    if isinstance(diff, str) and diff.startswith("--- a/"):
        rel = diff.split("\n", 1)[0][len("--- a/"):].strip()
        if rel and ".." not in rel.split("/") and not rel.startswith("/"):
            return posixpath.normpath(rel)
    fp = str(op.get("file_path") or "").strip()
    if op.get("action") in {"create", "edit", "delete"} or not fp:
        return "SKILL.md"
    parts = Path(fp).parts
    if parts and parts[-1] == "SKILL.md" and len(parts) in (1, 2):
        return "SKILL.md"
    return posixpath.normpath(fp.lstrip("/"))


def _op_target(kind: str, op: dict[str, Any]) -> dict[str, Any]:
    """``{label, skill, rel, target}`` of the file one previewed op changes."""
    if kind == MEMORY:
        target = "user" if op.get("target") == "user" else "memory"
        return {"label": _memory_label(target), "skill": None, "rel": _memory_label(target), "target": target}
    name = str(op.get("name") or "")
    rel = _skill_rel(op)
    return {"label": f"{name or '(unnamed)'}/{rel}", "skill": name, "rel": rel, "target": None}


def _entry_diff(label: str, before: str, after: str) -> str:
    """Unified diff of one memory entry. Entries carry no trailing newline, so add one to both sides
    or difflib would glue the removed and added lines together."""
    lines = difflib.unified_diff((before + "\n").splitlines(keepends=True), (after + "\n").splitlines(keepends=True),
                                 fromfile=f"a/{label}", tofile=f"b/{label}")
    return "".join(lines) or "(no textual change)"


def _memory_section(op: dict[str, Any], label: str) -> tuple[str, str, str]:
    """``(summary, kind, text)`` for one memory op of a preview, built from the op alone:
    ``action``, ``content``, ``old_text`` and ``matched_entry``."""
    action = str(op.get("action") or "")
    content = str(op.get("content") or "")
    old_text = str(op.get("old_text") or "")
    pinned = op.get("matched_entry") if isinstance(op.get("matched_entry"), str) else None
    if action != "patch":
        content, old_text = content.strip(), old_text.strip()
    verb = {"add": "add to", "remove": "remove from"}.get(action, f"{action} in")
    summary = f"{verb} {label}: {(content or old_text or pinned or '')[:120]}"
    if action == "add":
        return summary, "create", content
    if action == "remove":
        return summary, "delete", pinned or old_text
    if action == "replace":
        return summary, "diff", _entry_diff(label, pinned or old_text, content)
    if action == "patch":
        if pinned and old_text and old_text in pinned:
            return summary, "diff", _entry_diff(label, pinned, pinned.replace(old_text, content, 1))
        return summary, "diff", _entry_diff(label, old_text, content)
    return summary, "diff", f"({action or 'unknown'} on {label})"


def _skill_section(op: dict[str, Any]) -> tuple[str, str, str]:
    """``(summary, kind, text)`` for one skill op of a preview: its ``gist`` and ``diff``. A blocked
    op has no diff to show; its reason is the block's reason."""
    summary = str(op.get("gist") or op.get("action") or "")
    if op.get("blocker"):
        return summary, "diff", ""
    diff = str(op.get("diff") or "")
    return summary, "create" if op.get("action") == "create" else "diff", diff


_STATES = {"ready": "pending", "stale": "stale", "conflict": "conflict"}


def _write_blocks(kind: str, item: dict[str, Any], preview: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The write (what a decision needs) and one block per op."""
    wid = str(preview.get("id") or item["id"])
    status = preview.get("status")
    ops = [op for op in preview.get("ops") or [] if isinstance(op, dict)]
    created = preview.get("created_at") if isinstance(preview.get("created_at"), (int, float)) else item.get("created_at")
    write = {"id": wid, "kind": kind, "status": status, "reason": preview.get("reason"), "notice": preview.get("notice"),
             "expect": preview.get("expect"), "op_count": len(ops), "staged_at": created or 0,
             "origin": preview.get("origin") or item.get("origin") or "foreground"}
    state = _STATES.get(status, "conflict")
    single = len(ops) == 1
    blocks = []
    for index, op in enumerate(ops):
        target = _op_target(kind, op)
        if kind == MEMORY:
            summary, section, text = _memory_section(op, target["label"])
        else:
            summary, section, text = _skill_section(op)
        if state != "pending":
            reason = (op.get("blocker") if kind == SKILLS else None) or write["reason"] or "Hermes cannot apply this write now."
        else:
            reason = write["notice"]
        if not single:
            note = WHOLE_WRITE.format(n=len(ops))
            reason = f"{reason} {note}" if reason else note
        blocks.append({
            "id": f"{wid}-{_digest([index, op])[:10]}", "record_id": wid, "op_index": index, "state": state,
            "staged_at": write["staged_at"], "origin": write["origin"], "summary": summary, "reason": reason,
            "conflicts_with": None, "can_accept": single and state == "pending", "can_reject": single,
            "kind": section, "text": text, "_target": target,
        })
    return write, blocks


def _entries(kinds: tuple[str, ...]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Pending files of the scoped profile: key -> entry with its blocks and writes, and the last
    ``list_writes`` reply. A write that changes one file joins that file's entry; a write that
    changes several files is its own entry, so every entry holds whole writes only."""
    profile = _active_profile()
    items, reply = _pending_writes()
    out: dict[str, dict[str, Any]] = {}
    for item in items:
        kind = item["kind"]
        if kind not in kinds:
            continue
        preview = preview_write(kind, item["id"])
        if not isinstance(preview.get("expect"), dict):
            continue  # decided or stopped since the list was read
        write, blocks = _write_blocks(kind, item, preview)
        if not blocks:
            continue
        labels = list(dict.fromkeys(b["_target"]["label"] for b in blocks))
        if len(labels) == 1:
            key, name = _file_key(profile, kind, labels[0]), labels[0]
        else:
            key = _file_key(profile, kind, f"write\0{write['id']}")
            name = f"{labels[0]} and {len(labels) - 1} more file{'s' if len(labels) > 2 else ''}"
        entry = out.setdefault(key, {"key": key, "subsystem": kind, "file": name, "files": labels,
                                     "blocks": [], "writes": {}})
        entry["blocks"].extend(blocks)
        entry["writes"][write["id"]] = write
    for entry in out.values():
        entry["blocks"].sort(key=lambda b: (b["staged_at"], b["record_id"], b["op_index"]))
    return out, reply


def _public_block(b: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in b.items() if not k.startswith("_")}


def _file_info(profile: str, entry: dict[str, Any]) -> dict[str, Any]:
    blocks = entry["blocks"]
    states = [b["state"] for b in blocks]
    version = _digest([_public_block(b) for b in blocks],
                      {wid: w["expect"] for wid, w in sorted(entry["writes"].items())})[:16]
    return {"key": entry["key"], "profile": profile, "subsystem": entry["subsystem"], "file": entry["file"],
            "files": entry["files"],
            "counts": {"total": len(blocks), "pending": states.count("pending"), "stale": states.count("stale"),
                       "conflict": states.count("conflict")},
            "latest_staged_at": max((b["staged_at"] for b in blocks), default=0), "version": version}


# --- decisions -------------------------------------------------------------------------------------

def _decide(kind: str, write_id: str, decision: str, expect: Any) -> dict[str, Any]:
    """One ``decide_write`` call with the client's ``expect`` exactly as it was sent."""
    try:
        reply = decide_write(kind, write_id, decision, expect=expect)
    except (OSError, ValueError) as exc:
        reply = {"status": "conflict", "reason": str(exc)}
    out = {"id": write_id, "status": reply.get("status") or "conflict", "reason": reply.get("reason")}
    for extra in ("prior", "decided_at", "warning"):
        if reply.get(extra) is not None:
            out[extra] = reply[extra]
    return out


def _guarded_decide(write: dict[str, Any], decision: str, expect: Any) -> dict[str, Any]:
    """An approve is sent only while the fresh preview says ``ready``: a stale or conflicting write is
    answered with that status and its reason, and Hermes is not asked. A reject is always sent."""
    if decision == "approve" and write["status"] != "ready":
        status = write["status"] if write["status"] in ("stale", "conflict") else "conflict"
        return {"id": write["id"], "status": status, "reason": write["reason"]}
    return _decide(write["kind"], write["id"], decision, expect)


def _expect_body(raw: Any) -> Any:
    if not isinstance(raw, dict) or set(raw) != {"expect"} or not (raw["expect"] is None or isinstance(raw["expect"], dict)):
        raise HTTPException(status_code=422, detail='body must be {"expect": object}, the expect of the preview you saw')
    return raw["expect"]


def _expects_body(raw: Any) -> dict[str, Any]:
    if (not isinstance(raw, dict) or set(raw) != {"expects"} or not isinstance(raw["expects"], dict)
            or not all(isinstance(k, str) and isinstance(v, dict) for k, v in raw["expects"].items())):
        raise HTTPException(status_code=422, detail='body must be {"expects": {write id: expect}}')
    return raw["expects"]


# --- routes: Pending -------------------------------------------------------------------------------

@router.get("/pending")
def list_pending_all() -> dict[str, Any]:
    """The scoped profile's pending writes as metadata (no write text), with counts and gates."""
    empty = {"profiles": [], "items": [], "total": 0, "totals": dict.fromkeys(SUBSYSTEMS, 0)}
    if not review_api_available():
        return _unavailable(**empty)
    profile = _active_profile()
    try:
        items, reply = _pending_writes()
    except (OSError, ValueError) as exc:
        return {"status": "ok", **empty, "profiles": [{"profile": profile, "count": 0, "counts": dict.fromkeys(SUBSYSTEMS, 0),
                                                       "gates": dict.fromkeys(SUBSYSTEMS, False), "error": str(exc)}]}
    rows = [{"id": i["id"], "subsystem": i["kind"], "profile": profile, "subject": i.get("summary") or "",
             "action": i.get("action") or "write", "op_count": i.get("op_count") or 1,
             "origin": i.get("origin") or "foreground", "created_at": i.get("created_at") or 0,
             "summary": i.get("summary") or ""} for i in items]
    totals = {sub: sum(1 for r in rows if r["subsystem"] == sub) for sub in SUBSYSTEMS}
    return {"status": "ok", "profiles": [{"profile": profile, "count": len(rows), "counts": totals, "gates": _gates(reply),
                                          "needs_review": _counts(reply, "needs_review")}],
            "items": rows, "total": len(rows), "totals": totals}


@router.get("/files")
def list_files(kind: str = "all") -> dict[str, Any]:
    if kind not in _KINDS:
        raise HTTPException(status_code=400, detail="kind must be skills, memory or all")
    if not review_api_available():
        return _unavailable(files=[], profile_errors=[])
    profile = _active_profile()
    try:
        entries, reply = _entries(_KINDS[kind])
    except (OSError, ValueError) as exc:
        return {"status": "ok", "files": [], "profile_errors": [{"profile": profile, "error": str(exc)}],
                "gates": dict.fromkeys(SUBSYSTEMS, False), "needs_review": _counts({}, "needs_review")}
    files = [_file_info(profile, e) for e in entries.values()]
    files.sort(key=lambda f: (-f["latest_staged_at"], f["file"]))
    return {"status": "ok", "files": files, "profile_errors": [], "gates": _gates(reply),
            "needs_review": _counts(reply, "needs_review")}


@router.get("/files/{owner}/{subsystem}/{key}/diff")
def file_diff(owner: str, subsystem: str, key: str) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_key(key)
    if not review_api_available():
        return _unavailable()
    profile = _check_owner(owner)
    entry = _entries((subsystem,))[0].get(key)
    if entry is None:
        return {"status": "gone"}
    writes = {wid: {"expect": w["expect"], "status": w["status"], "reason": w["reason"], "op_count": w["op_count"]}
              for wid, w in entry["writes"].items()}
    return {"status": "ok", "file": _file_info(profile, entry),
            "segments": [{"type": "block", "block": _public_block(b)} for b in entry["blocks"]], "writes": writes}


def _resolve_block(owner: str, subsystem: str, key: str, block_id: str, decision: str, raw: Any) -> dict[str, Any]:
    _check_subsystem(subsystem)
    _check_key(key)
    _parse_block_id(block_id)
    expect = _expect_body(raw)
    if not review_api_available():
        return _unavailable(file_gone=False)
    _check_owner(owner)
    entry = _entries((subsystem,))[0].get(key)
    block = next((b for b in (entry or {}).get("blocks", []) if b["id"] == block_id), None)
    if block is None:
        return {"status": "gone", "reason": None, "file_gone": entry is None}
    write = entry["writes"][block["record_id"]]
    if write["op_count"] != 1:
        return {"status": "whole_write", "reason": WHOLE_WRITE.format(n=write["op_count"]), "file_gone": False}
    result = _guarded_decide(write, decision, expect)
    return {**result, "file_gone": key not in _entries((subsystem,))[0]}


@router.post("/files/{owner}/{subsystem}/{key}/blocks/{block_id}/accept")
def accept_block(owner: str, subsystem: str, key: str, block_id: str, raw: Any = Body(None)) -> dict[str, Any]:
    return _resolve_block(owner, subsystem, key, block_id, "approve", raw)


@router.post("/files/{owner}/{subsystem}/{key}/blocks/{block_id}/reject")
def reject_block(owner: str, subsystem: str, key: str, block_id: str, raw: Any = Body(None)) -> dict[str, Any]:
    return _resolve_block(owner, subsystem, key, block_id, "reject", raw)


def _resolve_all(owner: str, subsystem: str, key: str, decision: str, raw: Any) -> dict[str, Any]:
    """Decide every write of this file in staged order, each with the expect the client saw for it.
    A write the client has no expect for (staged after it loaded the file) is left pending."""
    _check_subsystem(subsystem)
    _check_key(key)
    expects = _expects_body(raw)
    if not review_api_available():
        return _unavailable(results=[], file_gone=False)
    _check_owner(owner)
    entry = _entries((subsystem,))[0].get(key)
    if entry is None:
        return {"results": [], "file_gone": True}
    results = []
    for write in sorted(entry["writes"].values(), key=lambda w: (w["staged_at"], w["id"])):
        if write["id"] not in expects:
            results.append({"id": write["id"], "status": "unseen", "reason": UNSEEN})
            continue
        results.append(_guarded_decide(write, decision, expects[write["id"]]))
    return {"results": results, "file_gone": key not in _entries((subsystem,))[0]}


@router.post("/files/{owner}/{subsystem}/{key}/accept-all")
def accept_all(owner: str, subsystem: str, key: str, raw: Any = Body(None)) -> dict[str, Any]:
    return _resolve_all(owner, subsystem, key, "approve", raw)


@router.post("/files/{owner}/{subsystem}/{key}/reject-all")
def reject_all(owner: str, subsystem: str, key: str, raw: Any = Body(None)) -> dict[str, Any]:
    return _resolve_all(owner, subsystem, key, "reject", raw)


# =================================================================================================
# Library: browse each profile's identity, memory and skill files; save identity files.
#
#   GET /library
#       The scoped profile: identity files (SOUL.md, PROJECT.md, AGENTS.md when present), memory
#       files (MEMORY.md, USER.md) and the skill folders in the profile's own skills folder (SKILL.md
#       plus text files under references/, templates/, scripts/ and assets/), each with its count of
#       pending changes from the same entries as /files. A pending change whose file is not listed
#       (a new skill, or a skill in an external skills folder) is in ``staged``.
#   GET /library/{owner}/{key}
#       The file's text, a version token ``<sha256 of the bytes>:<mtime_ns>`` ("absent" for a
#       memory file that does not exist yet) and ``read_only`` with its reason. Text only: at most
#       1 MB, strict UTF-8, no NUL bytes.
#   PUT /library/{owner}/{key}   body {"text": str, "version": str}
#       Identity files only: 409 when the file changed since that version, 422 when the text is
#       refused (nothing is written), else an atomic replace. Memory and skill files answer 403.
#
# The key is opaque. Every request rebuilds the list of files this module may touch for the scoped
# profile, here on the server, and looks the key up in it, so a client never names a path. A file is
# on the list only when it is inside the profile home and no component of its path below the home is
# a symlink; a skill file must also be inside its own skill folder.
#
# Every read and write opens the file's folder from the profile home one component at a time with
# O_NOFOLLOW, so a symlink swapped in anywhere on the path after the lookup makes the open fail; the
# file itself is opened with O_NOFOLLOW and O_NONBLOCK and must be a regular file with one hard link.
# A save does this under the Library lock, then opens the folder the same way again and writes only if
# the folder is the same one (st_dev, st_ino) and the file is the same inode it read. The temp file and
# the rename are relative to that folder fd, so the write lands in the folder that was checked.
# =================================================================================================

LIBRARY_IDENTITY = ("SOUL.md", "PROJECT.md", "AGENTS.md")
LIBRARY_READ_MAX = 1_048_576
IDENTITY_MAX_CHARS = 200_000
_SNIFF_BYTES = 8192
_ABSENT = "absent"
_SKILL_SUBDIRS = ("assets", "references", "scripts", "templates")  # where a skill's supporting files live
_SKIPPED_DIRS = frozenset({"node_modules", "site-packages", "__pycache__", "venv"})  # plus every dot folder
READ_ONLY = {
    "memory": ("Library shows memory files read-only for now. A save must pass Hermes's memory checks (the "
               "character limit and the threat scan) under the memory file lock, and Hermes has no public "
               "helper for those yet. Change memory through chat or the review list."),
    "skill": ("Library shows skill files read-only for now. A save must pass Hermes's skill checks (size, "
              "frontmatter, the 60-character description and the Skills Guard scan) under the skill lock, and "
              "Hermes has no public helper for those yet. Change skills through chat or the review list."),
}


def _library_key(profile: str, path: Any) -> str:
    """Opaque, URL-safe, 16 characters, from the profile and the listed path; never parsed back."""
    digest = hashlib.sha256(f"library\0{profile}\0{path}".encode("utf-8", "surrogatepass")).digest()
    return base64.urlsafe_b64encode(digest[:12]).decode("ascii")


def _inside(path: Any, root: Any) -> bool:
    """True when ``path`` resolves (symlinks followed) to something strictly inside ``root``."""
    real, base = os.path.realpath(path), os.path.realpath(root)
    return real != base and os.path.commonpath([real, base]) == base


def _contained(path: Any, root: Any) -> bool:
    """A regular file (or, for a memory file, nothing yet) whose real path is inside ``root``."""
    if os.path.lexists(path) and not os.path.isfile(path):  # a folder, a dangling link, a device
        return False
    return _inside(path, root)


def _plain_parts(home: Path, path: Path) -> Optional[tuple[str, ...]]:
    """The components of ``path`` below ``home`` when none of them is a symlink, else None. The last
    one may not exist yet (a memory file before its first write)."""
    try:
        parts = path.relative_to(home).parts
    except ValueError:
        return None
    if not parts or any(part in ("", ".", "..") for part in parts):
        return None
    current = home
    for part in parts:
        current = current / part
        if os.path.islink(current):
            return None
    return parts


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_NOT_LISTED = "That file is not in the library. Reload the list."
_UNSUPPORTED = ("Library needs Linux or macOS: it opens files through folder handles without following "
                "symlinks, and this system cannot do that. Pending works as usual.")


def _library_supported() -> bool:
    """Whether this system has what the folder walk, the relative rename and the lock need (POSIX
    only). Python lists ``os.rename`` in ``supports_dir_fd`` but never ``os.replace``, though both are
    the same renameat call and take ``src_dir_fd``/``dst_dir_fd`` together; ``os.rename`` stands for both."""
    try:
        import fcntl  # noqa: F401  (the Library lock)
    except ImportError:
        return False
    return (hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_DIRECTORY")
            and all(fn in os.supports_dir_fd for fn in (os.open, os.rename, os.stat, os.unlink)))


def _require_library() -> None:
    if not _library_supported():
        raise HTTPException(status_code=501, detail=_UNSUPPORTED)


def _single_link(path: Path) -> bool:
    """False for a file with a second hard link; it is not listed (and refused if one appears later)."""
    try:
        return os.lstat(path).st_nlink <= 1
    except FileNotFoundError:
        return True


def _open_plain(path: Path) -> Optional[int]:
    """fd of ``path`` opened with O_NOFOLLOW and O_NONBLOCK when it is a regular file, else None."""
    try:
        fd = os.open(path, os.O_RDONLY | _NOFOLLOW | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        return None
    return fd


def _looks_text(path: Path) -> bool:
    """No NUL byte and valid UTF-8 in the first 8 KB. The tree lists only such supporting files.
    Opened without following a symlink and without waiting on a FIFO."""
    fd = _open_plain(path)
    if fd is None:
        return False
    with os.fdopen(fd, "rb") as fh:
        head = fh.read(_SNIFF_BYTES)
    if b"\0" in head:
        return False
    try:
        codecs.getincrementaldecoder("utf-8")().decode(head, final=False)
    except UnicodeDecodeError:
        return False
    return True


def _skipped(name: str) -> bool:
    return name.startswith(".") or name in _SKIPPED_DIRS


def _skill_files(skill_dir: Path) -> list[str]:
    """SKILL.md, then every file under the supporting-file folders, sorted. Dot folders and package
    folders are skipped and symlinked folders are not entered."""
    rels = ["SKILL.md"]
    for sub in _SKILL_SUBDIRS:
        top = skill_dir / sub
        if not top.is_dir() or top.is_symlink():
            continue
        found = []
        for folder, dirs, names in os.walk(top):
            dirs[:] = [d for d in dirs if not _skipped(d)]
            found += [Path(folder, n).relative_to(skill_dir).as_posix() for n in names]
        rels += sorted(found)
    return rels


def _own_skill_dirs(home: Path) -> list[Path]:
    """The profile's own skill folders, through Hermes's public skill catalog helpers: every skill
    ``find_all_skills`` lists that ``locate_skill`` finds in the live profile's skills folder. Skills
    in external or project skill folders are not listed."""
    from tools.skills_tool import find_all_skills, locate_skill, skill_lookup_path_error, skill_search_dirs
    roots, active = skill_search_dirs()
    active = Path(active)
    own = [(tier, Path(d)) for tier, d in roots if Path(d) == active]
    if not own or not _plain_parts(home, active) or not active.is_dir():
        return []
    dirs: dict[str, Path] = {}
    for skill in find_all_skills(skip_disabled=True):
        name = skill.get("name") if isinstance(skill, dict) else None
        if not isinstance(name, str) or not name or skill_lookup_path_error(name):
            continue
        error, skill_dir, _skill_md = locate_skill(name, None, own)
        if error or skill_dir is None or not _inside(skill_dir, active):
            continue
        dirs.setdefault(os.path.realpath(skill_dir), Path(skill_dir))
    return sorted(dirs.values(), key=lambda d: d.relative_to(active).as_posix() if d.is_relative_to(active) else str(d))


def _library_candidates(profile: str) -> list[dict[str, Any]]:
    """Every file Library may show for the scoped profile."""
    from hermes_constants import get_hermes_home
    home = Path(get_hermes_home())
    out: list[dict[str, Any]] = []

    def add(kind: str, name: str, path: Path, **extra: Any) -> bool:
        parts = _plain_parts(home, path)
        if not (parts and _contained(path, home) and _single_link(path)):
            return False
        out.append({"key": _library_key(profile, path), "kind": kind, "name": name, "path": path,
                    "root": home, "parts": parts, "skill": None, **extra})
        return True

    for name in LIBRARY_IDENTITY:
        if os.path.lexists(home / name):
            add("identity", name, home / name)
    for target in ("memory", "user"):  # Hermes keeps both in <home>/memories/
        label = _memory_label(target)
        add("memory", label, home / "memories" / label, target=target)
    for skill_dir in _own_skill_dirs(home):
        # A skill whose SKILL.md is left out (a link into another home, say) is left out whole.
        for rel in _skill_files(skill_dir):
            ok = _inside(skill_dir / rel, skill_dir) and add(
                "skill", rel, skill_dir / rel, skill=skill_dir.name, skill_dir=skill_dir)
            if rel == "SKILL.md" and not ok:
                break
    return out


def _library_entry(profile: str, key: str) -> dict[str, Any]:
    entry = next((c for c in _library_candidates(profile) if c["key"] == key), None)
    if entry is None:
        raise HTTPException(status_code=404, detail=_NOT_LISTED)
    return entry


def _open_folder(entry: dict[str, Any]) -> int:
    """fd of the file's folder, opened from the profile home one component at a time with
    O_NOFOLLOW, so a symlink anywhere below the home fails the open (ELOOP)."""
    fd = os.open(entry["root"], os.O_RDONLY | _O_DIRECTORY)
    try:
        for part in entry["parts"][:-1]:
            nxt = os.open(part, os.O_RDONLY | _O_DIRECTORY | _NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def _identity(st: os.stat_result) -> tuple[int, int]:
    return st.st_dev, st.st_ino


def _read_at(entry: dict[str, Any], folder: int) -> tuple[Optional[bytes], Optional[os.stat_result]]:
    """``(bytes, stat)`` of the file in the open ``folder``, ``(None, None)`` for a memory file that
    does not exist yet. Refuses a symlink, a FIFO or other non-regular file, a second hard link and
    anything past 1 MB, all judged on the opened fd."""
    try:
        fd = os.open(entry["parts"][-1], os.O_RDONLY | _NOFOLLOW | getattr(os, "O_NONBLOCK", 0), dir_fd=folder)
    except FileNotFoundError:
        if entry["kind"] == "memory":
            return None, None
        raise HTTPException(status_code=404, detail="That file no longer exists. Reload the list.")
    except OSError:  # ELOOP: the name is a symlink now
        raise HTTPException(status_code=404, detail=_NOT_LISTED)
    with os.fdopen(fd, "rb") as fh:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise HTTPException(status_code=404, detail=_NOT_LISTED)
        if st.st_nlink > 1:
            raise HTTPException(status_code=403, detail=f"{entry['name']} has more than one hard link, so Library "
                                                        f"does not open or save it.")
        if st.st_size > LIBRARY_READ_MAX:
            raise HTTPException(status_code=413, detail=f"{entry['name']} is larger than 1 MB, so Library does not open it.")
        data = fh.read(LIBRARY_READ_MAX + 1)
    if len(data) > LIBRARY_READ_MAX:
        raise HTTPException(status_code=413, detail=f"{entry['name']} is larger than 1 MB, so Library does not open it.")
    return data, st


def _read_library_bytes(entry: dict[str, Any]) -> tuple[Optional[bytes], Optional[os.stat_result]]:
    try:
        folder = _open_folder(entry)
    except FileNotFoundError:
        if entry["kind"] == "memory":
            return None, None
        raise HTTPException(status_code=404, detail="That file no longer exists. Reload the list.")
    except OSError:
        raise HTTPException(status_code=404, detail=_NOT_LISTED)
    try:
        return _read_at(entry, folder)
    finally:
        os.close(folder)


def _library_pending() -> list[tuple[Optional[tuple[str, ...]], dict[str, Any]]]:
    """``(match, row)`` per (pending entry, file it changes) of the scoped profile, from the same
    entries as /files. ``match`` is ("memory", target) or ("skill", skill name, file in the skill)."""
    if not review_api_available():
        return []
    out = []
    for entry in _entries(SUBSYSTEMS)[0].values():
        counted: dict[tuple[str, ...], dict[str, Any]] = {}
        for block in entry["blocks"]:
            target = block["_target"]
            if entry["subsystem"] == MEMORY:
                match = (MEMORY, target["target"])
            else:
                match = ("skill", target["skill"], target["rel"]) if target["skill"] else None
            row = counted.get(match)
            if row is None:
                row = {"file": target["label"], "subsystem": entry["subsystem"], "pending": 0,
                       "review": {"subsystem": entry["subsystem"], "key": entry["key"]}}
                counted[match] = row
                out.append((match, row))
            row["pending"] += 1
    return out


def _stat(path: Path) -> tuple[bool, int, float]:
    try:
        st = os.lstat(path)  # metadata only; never follows a link that appeared after the lookup
    except FileNotFoundError:
        return False, 0, 0
    return True, st.st_size, st.st_mtime


def _read_only_reason(entry: dict[str, Any]) -> Optional[str]:
    return READ_ONLY.get(entry["kind"])


def _library_public(entry: dict[str, Any], **extra: Any) -> dict[str, Any]:
    exists, size, mtime = _stat(entry["path"])
    reason = _read_only_reason(entry)
    return {"key": entry["key"], "kind": entry["kind"], "name": entry["name"], "skill": entry["skill"],
            "exists": exists, "size": size, "mtime": mtime, "read_only": reason is not None,
            "read_only_reason": reason, **extra}


def _library_match(c: dict[str, Any]) -> Optional[tuple[str, ...]]:
    if c["kind"] == "memory":
        return (MEMORY, c["target"])
    if c["kind"] == "skill":
        return ("skill", c["skill"], c["name"])
    return None


def _library_profile(name: str) -> dict[str, Any]:
    """The scoped profile's tree with pending counts. Raises on a broken profile; the route reports it."""
    candidates = [c for c in _library_candidates(name)
                  if c["kind"] != "skill" or c["name"] == "SKILL.md" or _looks_text(c["path"])]
    by_match = {m: {"pending": 0, "review": None} for c in candidates if (m := _library_match(c)) is not None}
    staged = []
    for match, row in _library_pending():
        slot = by_match.get(match) if match is not None else None
        if slot is None:
            staged.append(row)
            continue
        slot["pending"] += row["pending"]
        slot["review"] = slot["review"] or row["review"]

    def public(c: dict[str, Any]) -> dict[str, Any]:
        slot = by_match.get(_library_match(c), {"pending": 0, "review": None})
        return _library_public(c, pending=slot["pending"], review=slot["review"])

    skills: dict[str, dict[str, Any]] = {}
    for c in candidates:
        if c["kind"] == "skill":
            group = skills.setdefault(str(c["skill_dir"]), {"name": c["skill"], "pending": 0, "files": []})
            group["files"].append(public(c))
            group["pending"] += group["files"][-1]["pending"]
    row = {"profile": name, "error": None,
           "identity": [public(c) for c in candidates if c["kind"] == "identity"],
           "memory": [public(c) for c in candidates if c["kind"] == "memory"],
           "skills": list(skills.values()), "staged": staged}
    row["pending"] = (sum(f["pending"] for f in row["identity"] + row["memory"])
                      + sum(s["pending"] for s in row["skills"]) + sum(s["pending"] for s in staged))
    return row


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


def _library_version(raw: Optional[bytes], st: Optional[os.stat_result]) -> str:
    if raw is None:
        return _ABSENT
    return f"{hashlib.sha256(raw).hexdigest()}:{st.st_mtime_ns}"


def _version_matches(token: str, raw: Optional[bytes]) -> bool:
    """Only the content hash decides; a touch that changes nothing else is not a conflict."""
    if raw is None:
        return token == _ABSENT
    return token.partition(":")[0] == hashlib.sha256(raw).hexdigest()


def _library_limit(entry: dict[str, Any]) -> Optional[dict[str, Any]]:
    if entry["kind"] == "identity":
        return {"label": entry["name"], "max": IDENTITY_MAX_CHARS}
    return None


def _library_refusal(entry: dict[str, Any], text: str) -> Optional[str]:
    """Why this identity file text is not saved, or None."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return "The text is not valid UTF-8, so it was not saved."
    if len(text) > IDENTITY_MAX_CHARS:
        return f"{entry['name']} can be at most {IDENTITY_MAX_CHARS:,} characters. This text has {len(text):,}."
    return None


@contextmanager
def _library_lock() -> Iterator[None]:
    """One lock per profile for Library saves, so two Desktop windows or two gateway processes never
    save at once. The lock file lives in the plugin's own data folder (``plugin_data_dir``)."""
    import fcntl
    from plugins.plugin_storage import plugin_data_dir
    fd = os.open(plugin_data_dir("skill-review") / "library.lock", os.O_RDWR | os.O_CREAT | _NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing the fd releases the lock


def _library_body(raw: Any) -> tuple[str, str]:
    """``(text, version)`` from ``{"text": str, "version": str}``; nothing else is accepted (no paths)."""
    if (not isinstance(raw, dict) or set(raw) != {"text", "version"} or not isinstance(raw["text"], str)
            or not isinstance(raw["version"], str)):
        raise HTTPException(status_code=400, detail='body must be {"text": string, "version": string}')
    return raw["text"], raw["version"]


@router.get("/library")
def list_library() -> dict[str, Any]:
    _require_library()
    name = _active_profile()
    try:
        profiles = [_library_profile(name)]
    except Exception as exc:  # report a broken profile instead of failing the whole view
        profiles = [{"profile": name, "pending": 0, "error": str(exc), "identity": [], "memory": [],
                     "skills": [], "staged": []}]
    out = {"profiles": profiles, "total": sum(p["pending"] for p in profiles)}
    if not review_api_available():
        out["review"] = _unavailable()
    return out


def _write_at(folder: int, name: str, data: bytes, mode: int, owner: Optional[tuple[int, int]] = None) -> None:
    """Temp file in ``folder``, written and fsynced, then renamed over ``name``; both relative to the
    folder fd. ``owner`` (uid, gid) is set on the temp file before the rename, so the file never
    shows with another owner; a refusal (not root, not the owner) keeps the writer's ids. On any
    failure the temp file is removed and ``name`` is untouched."""
    tmp = f".skill-review-{secrets.token_hex(8)}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=folder)
    try:
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fchmod(fd, mode)
            if owner is not None and hasattr(os, "fchown"):
                with suppress(PermissionError):  # EPERM / EACCES
                    os.fchown(fd, *owner)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, name, src_dir_fd=folder, dst_dir_fd=folder)
    except BaseException:
        with suppress(OSError):
            os.unlink(tmp, dir_fd=folder)
        raise
    with suppress(OSError):  # the rename is done; this only makes it durable sooner
        os.fsync(folder)


def _library_write(entry: dict[str, Any], folder_id: tuple[int, int], before: Optional[os.stat_result],
                   text: str) -> bytes:
    """After the checks: open the folder again through the same O_NOFOLLOW walk and write only if it
    is the folder the save checked and the file is the inode it read (or still absent). Returns the
    bytes written."""
    changed = HTTPException(status_code=409, detail=f"{entry['name']} or its folder changed on disk while saving. "
                                                    f"Nothing was written. Reload it.")
    try:
        folder = _open_folder(entry)
    except OSError:
        raise changed
    try:
        if _identity(os.fstat(folder)) != folder_id:
            raise changed
        name = entry["parts"][-1]
        try:
            now = os.stat(name, dir_fd=folder, follow_symlinks=False)
        except FileNotFoundError:
            now = None
        if (now is None) != (before is None) or (now is not None and (
                not stat.S_ISREG(now.st_mode) or now.st_nlink > 1 or _identity(now) != _identity(before))):
            raise changed
        mode = stat.S_IMODE(before.st_mode) if before is not None else 0o644
        data = text.encode("utf-8")
        try:
            _write_at(folder, name, data, mode, None if before is None else (before.st_uid, before.st_gid))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not write {entry['name']}: "
                                                        f"{exc.strerror or exc}. The file on disk is unchanged.")
    finally:
        os.close(folder)
    return data


@router.get("/library/{owner}/{key}")
def read_library_file(owner: str, key: str) -> dict[str, Any]:
    _require_library()
    _check_key(key)
    profile = _check_owner(owner)
    entry = _library_entry(profile, key)
    raw, st = _read_library_bytes(entry)
    text = _library_text(entry, raw)
    return {"status": "ok", "file": _library_public(entry), "text": text,
            "version": _library_version(raw, st), "limit": _library_limit(entry)}


@router.put("/library/{owner}/{key}")
def save_library_file(owner: str, key: str, raw: Any = Body(...)) -> dict[str, Any]:
    _require_library()
    text, version = _library_body(raw)
    _check_key(key)
    if len(text) > LIBRARY_READ_MAX:
        raise HTTPException(status_code=413, detail="Library saves at most 1 MB of text.")
    profile = _check_owner(owner)
    entry = _library_entry(profile, key)
    if reason := _read_only_reason(entry):
        raise HTTPException(status_code=403, detail=reason)
    with _library_lock():
        entry = _library_entry(profile, key)  # again under the lock
        try:
            folder = _open_folder(entry)
        except OSError:
            raise HTTPException(status_code=404, detail=_NOT_LISTED)
        try:
            folder_id = _identity(os.fstat(folder))
            current, before = _read_at(entry, folder)
        finally:
            os.close(folder)
        if not _version_matches(version, current):
            raise HTTPException(status_code=409, detail=f"{entry['name']} changed on disk since you opened it. "
                                                        f"Reload it to see the new text.")
        if refusal := _library_refusal(entry, text):
            raise HTTPException(status_code=422, detail=refusal)
        written = _library_write(entry, folder_id, before, text)
        try:
            saved, st = _read_library_bytes(entry)
            version = _library_version(saved, st)
        except HTTPException:  # written, but not readable back: the hash still matches what is on disk
            version = f"{hashlib.sha256(written).hexdigest()}:0"
        return {"status": "saved", "file": _library_public(entry), "version": version}
