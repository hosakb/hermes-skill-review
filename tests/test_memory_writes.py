"""Memory (MEMORY.md / USER.md) coverage of the same endpoints: list, diff, accept, reject, isolation."""

import pytest

from conftest import (home_of, memory_file, pending_file, read_memory, skill_content, skill_file, write_memory)

BASE = "/api/plugins/skill-review/pending"
ADD = {"action": "add", "target": "memory", "content": "Uses metric units"}


def patch_payload(entry, old, new, target="memory", action="patch"):
    return {"action": action, "target": target, "old_text": old, "content": new, "matched_entry": entry}


def remove_payload(entry, old, target="memory"):
    return {"action": "remove", "target": target, "old_text": old, "matched_entry": entry}


# --- list -----------------------------------------------------------------------------------

def test_list_mixes_subsystems_with_per_subsystem_counts(client, stage):
    a = stage("dev", {"action": "create", "name": "s", "content": skill_content("s"), "category": ""})
    b = stage("dev", ADD, origin="background_review")
    c = stage("default", {"action": "add", "target": "user", "content": "Name is Ben"}, subsystem="memory")
    body = client.get(BASE).json()
    assert [i["id"] for i in body["items"]] == [a["id"], b["id"], c["id"]]
    assert [i["subsystem"] for i in body["items"]] == ["skills", "memory", "memory"]
    assert body["total"] == 3 and body["totals"] == {"skills": 1, "memory": 2}
    counts = {p["profile"]: p["counts"] for p in body["profiles"]}
    assert counts["dev"] == {"skills": 1, "memory": 1} and counts["default"] == {"skills": 0, "memory": 1}
    mem = body["items"][1]
    assert mem["subject"] == "MEMORY.md" and mem["action"] == "add" and mem["origin"] == "background_review"
    assert body["items"][2]["subject"] == "USER.md"
    assert "payload" not in mem


def test_list_never_returns_memory_text_beyond_the_summary(client, stage):
    stage("dev", {"action": "add", "target": "memory", "content": "SECRET-ENTRY-BODY"}, summary="add to memory")
    assert "SECRET-ENTRY-BODY" not in client.get(BASE).text


# --- diff -----------------------------------------------------------------------------------

def test_diff_add_is_all_added(client, stage, root):
    rec = stage("dev", ADD)
    body = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()
    assert body["status"] == "ok" and body["item"]["subsystem"] == "memory"
    assert body["sections"] == [{"title": "add to MEMORY.md", "kind": "create", "text": "Uses metric units"}]


def test_diff_patch_is_unified_diff_of_the_pinned_entry(client, stage, root):
    entry = "Likes dark mode in all editors"
    write_memory(root, "dev", ["other", entry])
    rec = stage("dev", patch_payload(entry, "dark mode in all editors", "light mode in the terminal"))
    sec = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"][0]
    assert sec["kind"] == "diff" and sec["title"] == "patch in MEMORY.md"
    assert "--- a/MEMORY.md" in sec["text"] and "+++ b/MEMORY.md" in sec["text"]
    assert f"-{entry}" in sec["text"] and "+Likes light mode in the terminal" in sec["text"]


def test_diff_replace_legacy_shows_whole_entry_swap(client, stage, root):
    write_memory(root, "dev", ["old fact"])
    rec = stage("dev", patch_payload("old fact", "old", "brand new entry", action="replace"))
    sec = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"][0]
    assert "-old fact" in sec["text"] and "+brand new entry" in sec["text"]


def test_diff_remove_is_all_removed(client, stage, root):
    write_memory(root, "dev", ["drop me", "keep"], target="user")
    rec = stage("dev", remove_payload("drop me", "drop", target="user"))
    sec = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"][0]
    assert sec == {"title": "remove from USER.md", "kind": "delete", "text": "drop me"}


def test_diff_batch_gives_ordered_sections_against_a_working_copy(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    rec = stage("dev", {"action": "batch", "target": "memory", "operations": [
        {"action": "add", "content": "gamma"},
        {"action": "patch", "old_text": "alpha", "content": "ALPHA", "matched_entry": "alpha fact"},
        {"action": "remove", "old_text": "beta", "matched_entry": "beta fact"}]})
    secs = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"]
    assert [s["kind"] for s in secs] == ["create", "diff", "delete"]
    assert "+ALPHA fact" in secs[1]["text"] and secs[2]["text"] == "beta fact"


def test_diff_stale_pinned_entry_is_a_failure_note_not_a_diff(client, stage, root):
    write_memory(root, "dev", ["changed since"])
    rec = stage("dev", remove_payload("the entry as staged", "entry"))
    sec = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"][0]
    assert sec["kind"] == "diff" and sec["text"].startswith("(would fail:") and "no longer" in sec["text"]


def test_diff_unpinned_destructive_op_says_it_predates_pinning(client, stage, root):
    write_memory(root, "dev", ["x entry"])
    rec = stage("dev", {"action": "remove", "target": "memory", "old_text": "x"})
    sec = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"][0]
    assert sec["text"].startswith("(would fail:") and "pinning" in sec["text"]


def test_diff_add_of_existing_entry_is_a_no_change_note(client, stage, root):
    write_memory(root, "dev", ["Uses metric units"])
    rec = stage("dev", ADD)
    sec = client.get(f"{BASE}/memory/dev/{rec['id']}/diff").json()["sections"][0]
    assert sec["kind"] == "diff" and "already" in sec["text"]


def test_diff_never_writes_the_memory_files(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    before = memory_file(root, "dev").read_bytes()
    rec = stage("dev", patch_payload("alpha fact", "alpha", "ALPHA"))
    client.get(f"{BASE}/memory/dev/{rec['id']}/diff")
    assert memory_file(root, "dev").read_bytes() == before
    assert pending_file(root, "dev", rec["id"], "memory").exists()


# --- accept / reject / idempotency ----------------------------------------------------------

def test_accept_add_writes_only_that_profiles_memory_and_clears_record(client, stage, root):
    rec = stage("dev", ADD)
    body = client.post(f"{BASE}/memory/dev/{rec['id']}/accept").json()
    assert body["status"] == "applied" and body["item"]["subsystem"] == "memory"
    assert read_memory(root, "dev") == ["Uses metric units"]
    assert read_memory(root, "default") == [] and read_memory(root, "ops") == []
    assert not pending_file(root, "dev", rec["id"], "memory").exists()


def test_accept_user_target_writes_user_md(client, stage, root):
    rec = stage("ops", {"action": "add", "target": "user", "content": "Name is Ben"}, subsystem="memory")
    assert client.post(f"{BASE}/memory/ops/{rec['id']}/accept").json()["status"] == "applied"
    assert read_memory(root, "ops", "user") == ["Name is Ben"] and read_memory(root, "ops") == []


def test_accept_patch_and_remove_apply_to_the_pinned_entry(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    p = stage("dev", patch_payload("alpha fact", "alpha", "ALPHA"))
    r = stage("dev", remove_payload("beta fact", "beta"))
    assert client.post(f"{BASE}/memory/dev/{p['id']}/accept").json()["status"] == "applied"
    assert client.post(f"{BASE}/memory/dev/{r['id']}/accept").json()["status"] == "applied"
    assert read_memory(root, "dev") == ["ALPHA fact"]


def test_accept_twice_never_applies_twice(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    rec = stage("dev", patch_payload("alpha fact", "alpha", "ALPHA"))
    url = f"{BASE}/memory/dev/{rec['id']}/accept"
    assert client.post(url).json()["status"] == "applied"
    write_memory(root, "dev", ["edited by hand"])
    assert client.post(url).json()["status"] == "already_handled"
    assert read_memory(root, "dev") == ["edited by hand"]


def test_accept_stale_entry_fails_and_stays_pending(client, stage, root):
    write_memory(root, "dev", ["changed since"])
    rec = stage("dev", remove_payload("the entry as staged", "entry"))
    body = client.post(f"{BASE}/memory/dev/{rec['id']}/accept").json()
    assert body["status"] == "failed" and body["error"]
    assert pending_file(root, "dev", rec["id"], "memory").exists()
    assert read_memory(root, "dev") == ["changed since"]


def test_accept_resolved_elsewhere_is_already_handled(client, stage, root):
    rec = stage("dev", ADD)
    pending_file(root, "dev", rec["id"], "memory").unlink()
    assert client.post(f"{BASE}/memory/dev/{rec['id']}/accept").json()["status"] == "already_handled"
    assert read_memory(root, "dev") == []


def test_reject_discards_without_writing_and_is_idempotent(client, stage, root):
    rec = stage("dev", ADD)
    url = f"{BASE}/memory/dev/{rec['id']}/reject"
    assert client.post(url).json()["status"] == "rejected"
    assert read_memory(root, "dev") == [] and not pending_file(root, "dev", rec["id"], "memory").exists()
    assert client.post(url).json()["status"] == "already_handled"
    assert client.post(f"{BASE}/memory/dev/{rec['id']}/accept").json()["status"] == "already_handled"


def test_accept_uses_the_profiles_own_memory_limits(client, stage, root):
    (root / "profiles" / "dev" / "config.yaml").write_text(
        "memory:\n  write_approval: true\n  memory_char_limit: 10\n")
    rec = stage("dev", {"action": "add", "target": "memory", "content": "x" * 50})
    body = client.post(f"{BASE}/memory/dev/{rec['id']}/accept").json()
    assert body["status"] == "failed" and read_memory(root, "dev") == []


# --- subsystem routing and isolation --------------------------------------------------------

def test_ids_do_not_cross_subsystems(client, stage, root):
    mem = stage("dev", ADD)
    skl = stage("dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    for verb in ("accept", "reject"):
        assert client.post(f"{BASE}/skills/dev/{mem['id']}/{verb}").json()["status"] == "already_handled"
        assert client.post(f"{BASE}/memory/dev/{skl['id']}/{verb}").json()["status"] == "already_handled"
    assert client.get(f"{BASE}/skills/dev/{mem['id']}/diff").json()["status"] == "already_handled"
    assert pending_file(root, "dev", mem["id"], "memory").exists()
    assert pending_file(root, "dev", skl["id"], "skills").exists()
    assert not skill_file(root, "dev", "demo").exists() and read_memory(root, "dev") == []


@pytest.mark.parametrize("bad", ["bogus", "Memory", "skill", "memories", "..", "%2e%2e", "a.b"])
def test_unknown_subsystem_is_rejected(client, bad):
    for method, path in (("post", "accept"), ("post", "reject"), ("get", "diff")):
        r = getattr(client, method)(f"{BASE}/{bad}/dev/deadbeef/{path}")
        assert r.status_code in (400, 404)


def test_subsystem_validator_unit(api):
    from fastapi import HTTPException
    assert api._check_subsystem("skills") == "skills" and api._check_subsystem("memory") == "memory"
    for bad in ("", "x", "../memory", "memory/..", "SKILLS"):
        with pytest.raises(HTTPException) as exc:
            api._check_subsystem(bad)
        assert exc.value.status_code == 400


@pytest.mark.parametrize("bad_id", ["..", "a.b", "x" * 65, "%2e%2e", "a%2f..%2fb"])
def test_memory_ids_are_validated_like_skill_ids(client, bad_id):
    for verb in ("accept", "reject"):
        assert client.post(f"{BASE}/memory/dev/{bad_id}/{verb}").status_code in (400, 404)
    assert client.get(f"{BASE}/memory/dev/{bad_id}/diff").status_code in (400, 404)


def test_memory_traversal_cannot_touch_files_outside_the_queue(client, stage, root, tmp_path):
    victim = tmp_path / "outside.json"
    victim.write_text("{}")
    other = stage("ops", ADD)
    for evil in ("../../../../outside", "..%2f..%2f..%2foutside"):
        client.post(f"{BASE}/memory/dev/{evil}/reject")
    assert victim.exists() and pending_file(root, "ops", other["id"], "memory").exists()
    assert client.post(f"{BASE}/memory/dev/{other['id']}/reject").json()["status"] == "already_handled"


def test_unknown_profile_is_404_for_memory(client):
    assert client.post(f"{BASE}/memory/nope/deadbeef/accept").status_code == 404


def test_memory_accept_origin_background_review(client, stage, root):
    rec = stage("dev", ADD, origin="background_review")
    assert client.get(BASE).json()["items"][0]["origin"] == "background_review"
    assert client.post(f"{BASE}/memory/dev/{rec['id']}/accept").json()["status"] == "applied"


def test_home_is_restored_after_memory_requests(client, stage, root):
    from pathlib import Path
    from hermes_constants import get_hermes_home
    rec = stage("dev", ADD)
    client.get(f"{BASE}/memory/dev/{rec['id']}/diff")
    client.post(f"{BASE}/memory/dev/{rec['id']}/accept")
    assert Path(get_hermes_home()) == root
