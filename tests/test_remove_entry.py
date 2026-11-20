"""Remove entirely: delete the memory entry a replace or patch block targets and drop that proposal.

POST /files/{profile}/{subsystem}/{key}/blocks/{block_id}/remove-entry. The removal goes through
Hermes's own staged-remove path (``_apply_one`` -> ``apply_memory_pending`` -> ``apply_batch``),
pinned to the entry the proposal was reviewed against.
"""

import json
import threading

import pytest

from conftest import home_of, memory_file, pending_file, read_memory, skill_content, skill_file, write_memory

BASE = "/api/plugins/skill-review"


def files(client):
    return client.get(f"{BASE}/files").json()["files"]


def entry(client, file, profile="dev"):
    found = [f for f in files(client) if f["file"] == file and f["profile"] == profile]
    assert len(found) == 1, found
    return found[0]


def diff(client, f):
    return client.get(f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}/diff").json()


def blocks(d):
    return [s["block"] for s in d["segments"] if s["type"] == "block"]


def act(client, f, block_id, verb):
    return client.post(f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}/blocks/{block_id}/{verb}").json()


def remove(client, f, block_id):
    return act(client, f, block_id, "remove-entry")


def mem_batch(*ops, target="memory"):
    return {"action": "batch", "target": target, "operations": list(ops)}


def mreplace(entry_text, old, new):
    return {"action": "replace", "old_text": old, "content": new, "matched_entry": entry_text}


def mpatch(entry_text, old, new):
    return {"action": "patch", "old_text": old, "content": new, "matched_entry": entry_text}


def no_claims(root, profile="dev"):
    folder = home_of(root, profile) / "pending" / "memory"
    return not list(folder.glob("*.claim"))


def _apply_skill(root, profile, payload):
    from agent.runtime_scope import bind_profile_scope
    from tools.skill_manager_tool import apply_skill_pending
    with bind_profile_scope(home_of(root, profile), hydrate_secrets=False):
        assert json.loads(apply_skill_pending(payload))["success"]


# --- success -------------------------------------------------------------------------------------

def test_remove_deletes_the_entry_and_drops_only_that_op(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "alpha reworded"), {"action": "add", "content": "gamma"}))
    f = entry(client, "MEMORY.md")
    replace, add = blocks(diff(client, f))
    r = remove(client, f, replace["id"])
    assert r == {"status": "removed", "error": None, "file_gone": False}
    assert read_memory(root, "dev") == ["beta fact"], "neither the old nor the new line is kept"
    left = json.loads(pending_file(root, "dev", rec["id"], "memory").read_text())
    assert left["id"] == rec["id"] and left["created_at"] == rec["created_at"] and left["origin"] == rec["origin"]
    assert left["payload"]["operations"] == [{"action": "add", "content": "gamma"}]
    assert [b["id"] for b in blocks(diff(client, f))] == [add["id"]]
    assert no_claims(root)


def test_remove_on_a_patch_block_in_user_md_and_last_op_cleans_up(client, stage, root):
    write_memory(root, "dev", ["Name is Ben", "Likes tea"], target="user")
    rec = stage("dev", mem_batch(mpatch("Name is Ben", "Ben", "Benjamin"), target="user"))
    f = entry(client, "USER.md")
    (b,) = blocks(diff(client, f))
    assert b["removed"] == [{"no": 1, "text": "Name is Ben"}]
    r = remove(client, f, b["id"])
    assert r == {"status": "removed", "error": None, "file_gone": True}
    assert read_memory(root, "dev", "user") == ["Likes tea"]
    assert read_memory(root, "dev") == [], "MEMORY.md is untouched"
    assert not pending_file(root, "dev", rec["id"], "memory").exists(), "the record is discarded"
    assert no_claims(root)
    assert [x for x in files(client) if x["file"] == "USER.md"] == []


def test_remove_on_a_single_op_record(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", {"action": "replace", "target": "memory", "old_text": "beta", "content": "beta v2",
                        "matched_entry": "beta fact"})
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    assert remove(client, f, b["id"]) == {"status": "removed", "error": None, "file_gone": True}
    assert read_memory(root, "dev") == ["alpha fact"]
    assert not pending_file(root, "dev", rec["id"], "memory").exists()


def test_remove_runs_through_hermes_apply_one_as_a_pinned_single_remove(client, stage, root, monkeypatch):
    import hermes_cli.write_approval_commands as wac
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "alpha reworded"), {"action": "add", "content": "x"}))
    seen = []
    real = wac._apply_one

    def spy(sub, r, store):
        seen.append((sub, json.loads(json.dumps(r)), store is not None))
        return real(sub, r, store)

    monkeypatch.setattr(wac, "_apply_one", spy)
    f = entry(client, "MEMORY.md")
    first = blocks(diff(client, f))[0]
    assert remove(client, f, first["id"])["status"] == "removed"
    ((sub, applied, has_store),) = seen
    assert sub == "memory" and has_store
    assert applied["id"] == rec["id"] and applied["origin"] == rec["origin"]
    assert applied["payload"] == {"action": "batch", "target": "memory", "operations": [
        {"action": "remove", "old_text": "alpha fact", "matched_entry": "alpha fact"}]}


# --- failures leave everything as it was ---------------------------------------------------------

def test_entry_changed_since_staged_fails_with_hermes_text_and_record_bytes_unchanged(client, stage, root, monkeypatch):
    """The entry changes between our check and Hermes's locked apply (a chat write in another
    process). Hermes's pinned-entry check refuses, and the staged record goes back byte for byte."""
    import hermes_cli.write_approval_commands as wac
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "alpha reworded"), {"action": "add", "content": "x"}))
    path = pending_file(root, "dev", rec["id"], "memory")
    before = path.read_bytes()
    real = wac._apply_one

    def edited_meanwhile(sub, r, store):
        write_memory(root, "dev", ["alpha fact v2", "beta fact"])
        return real(sub, r, store)

    monkeypatch.setattr(wac, "_apply_one", edited_meanwhile)
    f = entry(client, "MEMORY.md")
    first = blocks(diff(client, f))[0]
    r = remove(client, f, first["id"])
    assert r["status"] == "failed" and r["file_gone"] is False
    assert "Entry changed since it was staged" in r["error"], r["error"]
    assert path.read_bytes() == before
    assert read_memory(root, "dev") == ["alpha fact v2", "beta fact"], "the newer entry that contains 'alpha' stays"
    assert no_claims(root)


def test_a_write_landing_after_our_check_cannot_redirect_the_removal(api, client, stage, root, monkeypatch):
    """The entry is rewritten right after our eligibility check, before the remove op is built. The
    removal stays pinned to the reviewed entry, so Hermes refuses instead of deleting the newer one."""
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "alpha reworded"), {"action": "add", "content": "x"}))
    before = pending_file(root, "dev", rec["id"], "memory").read_bytes()
    real = api._removal_refusal

    def then_edited(*args):
        refusal = real(*args)
        write_memory(root, "dev", ["alpha fact v2", "beta fact"])
        return refusal

    monkeypatch.setattr(api, "_removal_refusal", then_edited)
    f = entry(client, "MEMORY.md")
    first = blocks(diff(client, f))[0]
    r = remove(client, f, first["id"])
    assert r["status"] == "failed" and "Entry changed since it was staged" in r["error"], r
    assert read_memory(root, "dev") == ["alpha fact v2", "beta fact"]
    assert pending_file(root, "dev", rec["id"], "memory").read_bytes() == before


def test_stale_block_is_refused(client, stage, root):
    write_memory(root, "dev", ["alpha fact v2", "beta fact"])
    rec = stage("dev", mem_batch(mpatch("alpha fact", "alpha", "ALPHA")))
    path = pending_file(root, "dev", rec["id"], "memory")
    before = path.read_bytes()
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    assert b["state"] == "stale"
    r = remove(client, f, b["id"])
    assert r["status"] == "failed" and r["error"] and r["file_gone"] is False
    assert path.read_bytes() == before and read_memory(root, "dev") == ["alpha fact v2", "beta fact"]


def test_ambiguous_entry_that_appears_twice_is_refused(client, stage, root):
    from tools.memory_tool_store import ENTRY_DELIMITER
    path = memory_file(root, "dev")
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = ENTRY_DELIMITER.join(["alpha fact", "beta fact", "alpha fact"])
    path.write_text(raw)
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "alpha reworded")))
    record_path = pending_file(root, "dev", rec["id"], "memory")
    before = record_path.read_bytes()
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    r = remove(client, f, b["id"])
    assert r["status"] == "failed" and "more than once" in r["error"], r
    assert path.read_text() == raw and record_path.read_bytes() == before


def test_entry_spanning_several_lines_is_refused(client, stage, root):
    write_memory(root, "dev", ["line a\nline b", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("line a\nline b", "line a", "one line now")))
    before = pending_file(root, "dev", rec["id"], "memory").read_bytes()
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    assert len(b["removed"]) == 2
    r = remove(client, f, b["id"])
    assert r["status"] == "failed" and "several lines" in r["error"], r
    assert read_memory(root, "dev") == ["line a\nline b", "beta fact"]
    assert pending_file(root, "dev", rec["id"], "memory").read_bytes() == before


def test_patch_of_one_line_in_a_multi_line_entry_is_refused(client, stage, root):
    write_memory(root, "dev", ["line a\nline b", "beta fact"])
    stage("dev", mem_batch(mpatch("line a\nline b", "line b", "line B")))
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    assert b["removed"] == [{"no": 2, "text": "line b"}]
    r = remove(client, f, b["id"])
    assert r["status"] == "failed" and "several lines" in r["error"], r
    assert read_memory(root, "dev") == ["line a\nline b", "beta fact"]


@pytest.mark.parametrize("op", [
    {"action": "add", "content": "gamma"},
    {"action": "remove", "old_text": "alpha", "matched_entry": "alpha fact"},
], ids=["add-only", "plain-remove"])
def test_blocks_that_do_not_replace_an_entry_are_refused(client, stage, root, op):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(op))
    before = pending_file(root, "dev", rec["id"], "memory").read_bytes()
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    r = remove(client, f, b["id"])
    assert r["status"] == "failed" and "replaces or patches" in r["error"], r
    assert read_memory(root, "dev") == ["alpha fact", "beta fact"]
    assert pending_file(root, "dev", rec["id"], "memory").read_bytes() == before


def test_skill_block_is_refused(client, stage, root):
    _apply_skill(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    rec = stage("dev", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    skill_before = skill_file(root, "dev", "demo").read_bytes()
    record_before = pending_file(root, "dev", rec["id"]).read_bytes()
    f = entry(client, "demo/SKILL.md")
    (b,) = blocks(diff(client, f))
    r = remove(client, f, b["id"])
    assert r["status"] == "failed" and "memory" in r["error"], r
    assert skill_file(root, "dev", "demo").read_bytes() == skill_before
    assert pending_file(root, "dev", rec["id"]).read_bytes() == record_before


def test_block_from_another_file_is_refused(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    write_memory(root, "dev", ["Name is Ben"], target="user")
    stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA")))
    stage("dev", mem_batch(mreplace("Name is Ben", "Ben", "Benjamin"), target="user"))
    mem, user = entry(client, "MEMORY.md"), entry(client, "USER.md")
    (b,) = blocks(diff(client, mem))
    r = remove(client, user, b["id"])
    assert r["status"] == "failed" and r["error"]
    assert read_memory(root, "dev") == ["alpha fact"]


def test_unknown_block_is_already_handled(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA")))
    f = entry(client, "MEMORY.md")
    r = remove(client, f, "nosuchrecord-0123456789")
    assert r["status"] == "already_handled" and read_memory(root, "dev") == ["alpha fact"]


def test_bad_block_id_is_rejected(client):
    r = client.post(f"{BASE}/files/dev/memory/AAAAAAAAAAAAAAAA/blocks/../remove-entry")
    assert r.status_code in (400, 404)
    r = client.post(f"{BASE}/files/dev/memory/AAAAAAAAAAAAAAAA/blocks/bad id/remove-entry")
    assert r.status_code == 400


# --- races ---------------------------------------------------------------------------------------

def _race(*calls):
    gate = threading.Barrier(len(calls), timeout=5)
    out = [None] * len(calls)

    def run(i, call):
        try:
            gate.wait()
        except threading.BrokenBarrierError:
            pass
        out[i] = call()

    threads = [threading.Thread(target=run, args=(i, c)) for i, c in enumerate(calls)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    return out


def test_two_removes_racing_remove_once(client, stage, root, monkeypatch):
    import hermes_cli.write_approval_commands as wac
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA"), {"action": "add", "content": "x"}))
    calls = []
    real = wac._apply_one

    def counting(sub, r, store):
        calls.append(r["id"])
        return real(sub, r, store)

    monkeypatch.setattr(wac, "_apply_one", counting)
    f = entry(client, "MEMORY.md")
    first = blocks(diff(client, f))[0]
    out = _race(lambda: remove(client, f, first["id"])["status"], lambda: remove(client, f, first["id"])["status"])
    assert sorted(out) == ["already_handled", "removed"]
    assert len(calls) == 1 and read_memory(root, "dev") == ["beta fact"]


def test_remove_racing_accept_resolves_once(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA"), {"action": "add", "content": "x"}))
    f = entry(client, "MEMORY.md")
    first = blocks(diff(client, f))[0]
    out = _race(lambda: act(client, f, first["id"], "accept")["status"], lambda: remove(client, f, first["id"])["status"])
    assert sorted(out) in (["already_handled", "applied"], ["already_handled", "removed"]), out
    winner = "applied" if "applied" in out else "removed"
    assert read_memory(root, "dev") == (["ALPHA", "beta fact"] if winner == "applied" else ["beta fact"])
    left = json.loads(pending_file(root, "dev", rec["id"], "memory").read_text())
    assert left["payload"]["operations"] == [{"action": "add", "content": "x"}]


def test_chat_approve_during_our_remove_sees_nothing(client, stage, root, monkeypatch):
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    import hermes_cli.write_approval_commands as wac
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA"), {"action": "add", "content": "x"}))
    real = wac._apply_one
    chat = []

    def with_chat(sub, r, store):
        chat.append(handle_pending_subcommand("memory", ["approve", rec["id"]]))  # same profile scope
        return real(sub, r, store)

    monkeypatch.setattr(wac, "_apply_one", with_chat)
    f = entry(client, "MEMORY.md")
    first = blocks(diff(client, f))[0]
    assert remove(client, f, first["id"])["status"] == "removed"
    assert "No pending" in chat[0]
    assert read_memory(root, "dev") == ["beta fact"], "chat applied nothing while the record was claimed"


def test_chat_approve_first_leaves_remove_already_handled(client, stage, root, monkeypatch):
    from agent.runtime_scope import bind_profile_scope
    from hermes_cli.write_approval_commands import handle_pending_subcommand
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA")))
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    from tools.memory_tool import load_on_disk_store
    with bind_profile_scope(home_of(root, "dev"), hydrate_secrets=False):
        said = handle_pending_subcommand("memory", ["approve", rec["id"]], memory_store=load_on_disk_store())
    assert "pproved" in said or "pplied" in said, said
    r = remove(client, f, b["id"])
    assert r["status"] == "already_handled" and r["file_gone"] is True
    assert read_memory(root, "dev") == ["ALPHA", "beta fact"], "the approved change stays"


# --- evaluation cache ----------------------------------------------------------------------------

def test_remove_invalidates_the_evaluation_cache(api, client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    write_memory(root, "dev", ["Name is Ben"], target="user")
    stage("dev", mem_batch(mreplace("alpha fact", "alpha", "ALPHA"), {"action": "add", "content": "x"}))
    stage("dev", mem_batch(mreplace("Name is Ben", "Ben", "Benjamin"), target="user"))
    f = entry(client, "MEMORY.md")
    user = entry(client, "USER.md")
    first = blocks(diff(client, f))[0]
    def cached():
        return [k for k in api._cache if k[1] == "memory" and k[2] in (f["key"], user["key"])]

    assert len(cached()) == 2, "both memory files were cached"
    assert remove(client, f, first["id"])["status"] == "removed"
    assert cached() == [], "the profile's memory evaluations are dropped"
    after = entry(client, "MEMORY.md")
    assert after["version"] != f["version"] and after["counts"]["total"] == 1
    (left,) = blocks(diff(client, after))
    assert left["summary"].startswith("add")
