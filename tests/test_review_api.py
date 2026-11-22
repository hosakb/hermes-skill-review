"""Pending review through Hermes's public write review API (tools.write_review_api).

GET  /pending                                  metadata of the scoped profile's writes, counts, gates
GET  /files?kind=                              one entry per file (or per multi-file write)
GET  /files/{owner}/{subsystem}/{key}/diff     blocks from preview_write, plus each write's expect
POST /files/{owner}/{subsystem}/{key}/blocks/{id}/accept|reject    body {"expect": ...}
POST /files/{owner}/{subsystem}/{key}/accept-all|reject-all        body {"expects": {id: ...}}

Requests run in the default profile unless a test calls ``scope``.
"""

import importlib.util
import json
import sys

import pytest

from conftest import API_FILE, home_of, pending_file, read_memory, skill_content, skill_file, write_memory

BASE = "/api/plugins/skill-review"


def make_skill(root, profile, name, content=None):
    folder = home_of(root, profile) / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(content if content is not None else skill_content(name))
    return folder


def files(client, kind="all"):
    response = client.get(f"{BASE}/files", params={"kind": kind})
    assert response.status_code == 200, response.text
    return response.json()


def only_file(client, subsystem=None):
    found = [f for f in files(client)["files"] if subsystem in (None, f["subsystem"])]
    assert len(found) == 1, found
    return found[0]


def base(f):
    return f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}"


def diff(client, f):
    response = client.get(f"{base(f)}/diff")
    assert response.status_code == 200, response.text
    return response.json()


def blocks(data):
    return [s["block"] for s in data["segments"] if s["type"] == "block"]


def accept(client, f, data, block, verb="accept"):
    expect = data["writes"][block["record_id"]]["expect"]
    response = client.post(f"{base(f)}/blocks/{block['id']}/{verb}", json={"expect": expect})
    assert response.status_code == 200, response.text
    return response.json()


def bulk(client, f, data, verb):
    expects = {wid: w["expect"] for wid, w in data["writes"].items()}
    response = client.post(f"{base(f)}/{verb}", json={"expects": expects})
    assert response.status_code == 200, response.text
    return response.json()


def pid(staged):
    return staged.get("pending_id") or staged.get("id")


# --- list ---------------------------------------------------------------------------------------

def test_pending_lists_metadata_counts_and_gates_of_the_scoped_profile(client, stage, root, scope):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", {"action": "add", "target": "memory", "content": "secret beta fact"})
    stage("dev", {"action": "create", "name": "demo", "content": skill_content()})
    stage("ops", {"action": "add", "target": "memory", "content": "ops fact"})
    scope("dev")
    body = client.get(f"{BASE}/pending").json()
    assert body["status"] == "ok" and body["total"] == 2 and body["totals"] == {"skills": 1, "memory": 1}
    [p] = body["profiles"]
    assert p["profile"] == "dev" and p["gates"] == {"skills": True, "memory": True}
    assert p["needs_review"] == {"skills": 0, "memory": 0, "total": 0}
    assert {i["profile"] for i in body["items"]} == {"dev"}
    assert "secret beta fact" not in json.dumps(body), "the list never carries write text"


def test_files_group_ops_by_file_and_a_multi_file_write_is_its_own_entry(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    make_skill(root, "default", "demo")
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    stage("default", {"action": "add", "target": "user", "content": "Name is Ben"})
    stage("default", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    stage("default", {"action": "batch", "operations": [
        {"action": "patch", "name": "demo", "old_string": "line two", "new_string": "line 2"},
        {"action": "write_file", "name": "demo", "file_path": "references/a.md", "file_content": "ref\n"}]})
    listed = {f["file"]: f for f in files(client)["files"]}
    assert set(listed) == {"MEMORY.md", "USER.md", "demo/SKILL.md", "demo/SKILL.md and 1 more file"}
    assert listed["demo/SKILL.md and 1 more file"]["files"] == ["demo/SKILL.md", "demo/references/a.md"]
    assert listed["demo/SKILL.md"]["counts"] == {"total": 1, "pending": 1, "stale": 0, "conflict": 0}
    assert all(len(f["key"]) == 16 and f["profile"] == "default" for f in listed.values())
    assert files(client, "memory")["files"] and all(f["subsystem"] == "memory" for f in files(client, "memory")["files"])


def test_kind_must_be_known(client):
    assert client.get(f"{BASE}/files", params={"kind": "nope"}).status_code == 400


def test_the_version_changes_when_the_target_file_changes(client, stage, root):
    make_skill(root, "default", "demo")
    stage("default", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    first = only_file(client)["version"]
    assert only_file(client)["version"] == first
    skill_file(root, "default", "demo").write_text(skill_content("demo").replace("line two", "line deux"))
    assert only_file(client)["version"] != first


# --- preview: blocks from preview_write ops -------------------------------------------------------

def test_memory_blocks_show_each_op_from_its_action_and_entries(client, stage, root):
    write_memory(root, "default", ["alpha fact", "beta fact", "gamma fact"])
    stage("default", {"action": "add", "target": "memory", "content": "delta fact"})
    stage("default", {"action": "batch", "target": "memory", "operations": [
        {"action": "patch", "old_text": "alpha", "content": "ALPHA", "matched_entry": "alpha fact"},
        {"action": "remove", "old_text": "beta fact", "matched_entry": "beta fact"},
        {"action": "replace", "old_text": "gamma", "content": "GAMMA FACT", "matched_entry": "gamma fact"}]})
    data = diff(client, only_file(client))
    add, patch, remove, replace = blocks(data)
    assert (add["kind"], add["text"], add["state"], add["can_accept"]) == ("create", "delta fact", "pending", True)
    assert patch["kind"] == "diff" and "-alpha fact\n+ALPHA fact" in patch["text"]
    assert (remove["kind"], remove["text"]) == ("delete", "beta fact")
    assert "-gamma fact\n+GAMMA FACT" in replace["text"]
    assert all(not b["can_accept"] and not b["can_reject"] for b in (patch, remove, replace))
    assert "3 changes" in patch["reason"] and "Accept all" in patch["reason"]
    assert data["writes"][patch["record_id"]]["op_count"] == 3


def test_skill_blocks_carry_the_preview_gist_and_diff(client, stage, root):
    make_skill(root, "default", "demo")
    stage("default", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    stage("default", {"action": "create", "name": "fresh", "content": skill_content("fresh")})
    by_file = {f["file"]: f for f in files(client)["files"]}
    [patch] = blocks(diff(client, by_file["demo/SKILL.md"]))
    assert patch["summary"].startswith("patch 'demo' SKILL.md")
    assert patch["text"].startswith("--- a/SKILL.md\n+++ b/SKILL.md\n@@") and "-line one\n+line 1" in patch["text"]
    [create] = blocks(diff(client, by_file["fresh/SKILL.md"]))
    assert (create["kind"], create["text"]) == ("create", skill_content("fresh"))


def test_a_stale_memory_write_is_greyed_with_reason_and_cannot_be_accepted(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "batch", "target": "memory", "operations": [
        {"action": "patch", "old_text": "alpha", "content": "ALPHA", "matched_entry": "alpha fact"}]})
    write_memory(root, "default", ["alpha fact, edited"])
    f = only_file(client)
    [block] = blocks(diff(client, f))
    assert block["state"] == "stale" and block["can_accept"] is False and block["can_reject"] is True
    assert block["reason"]
    assert f["counts"]["stale"] == 1


def test_a_skill_write_that_cannot_apply_is_a_conflict(client, stage, root):
    make_skill(root, "default", "demo")
    stage("default", {"action": "create", "name": "demo", "content": skill_content("demo", "again")})
    [block] = blocks(diff(client, only_file(client)))
    assert block["state"] == "conflict" and block["can_accept"] is False and "already exists" in block["reason"]
    assert block["text"] == ""


def test_diff_of_a_resolved_key_is_gone(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    assert accept(client, f, diff(client, f), blocks(diff(client, f))[0])["status"] == "applied"
    assert diff(client, f) == {"status": "gone"}


def test_previews_never_write(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    staged = stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    record = pending_file(root, "default", pid(staged), "memory").read_bytes()
    for _ in range(3):
        diff(client, only_file(client))
    assert read_memory(root, "default") == ["alpha fact"]
    assert pending_file(root, "default", pid(staged), "memory").read_bytes() == record


# --- decide: whole writes through decide_write ------------------------------------------------------

def test_accept_applies_a_single_op_write(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    data = diff(client, f)
    out = accept(client, f, data, blocks(data)[0])
    assert out["status"] == "applied" and out["file_gone"] is True
    assert read_memory(root, "default") == ["alpha fact", "beta fact"]


def test_reject_discards_without_writing(client, stage, root):
    make_skill(root, "default", "demo")
    stage("default", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    f = only_file(client)
    data = diff(client, f)
    assert accept(client, f, data, blocks(data)[0], "reject")["status"] == "rejected"
    assert skill_file(root, "default", "demo").read_text() == skill_content("demo")
    assert files(client)["files"] == []


def test_a_second_decision_is_already_resolved(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    data = diff(client, f)
    [block] = blocks(data)
    assert accept(client, f, data, block)["status"] == "applied"
    again = accept(client, f, data, block)
    assert again["status"] == "gone", "the block left the file, so nothing is decided twice"
    assert read_memory(root, "default") == ["alpha fact", "beta fact"]


def test_a_block_of_a_multi_op_write_cannot_be_decided_alone(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "batch", "target": "memory", "operations": [
        {"action": "add", "content": "one"}, {"action": "add", "content": "two"}]})
    f = only_file(client)
    data = diff(client, f)
    for verb in ("accept", "reject"):
        out = accept(client, f, data, blocks(data)[0], verb)
        assert out["status"] == "whole_write" and "2 changes" in out["reason"]
    assert read_memory(root, "default") == ["alpha fact"]
    assert len(blocks(diff(client, f))) == 2


def test_accept_all_applies_whole_writes_in_staged_order(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "one"})
    stage("default", {"action": "batch", "target": "memory", "operations": [
        {"action": "add", "content": "two"}, {"action": "add", "content": "three"}]})
    f = only_file(client)
    out = bulk(client, f, diff(client, f), "accept-all")
    assert [r["status"] for r in out["results"]] == ["applied", "applied"] and out["file_gone"] is True
    assert read_memory(root, "default") == ["alpha fact", "one", "two", "three"]


def test_accept_all_skips_stale_writes_and_writes_staged_after_the_view(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stale = stage("default", {"action": "batch", "target": "memory", "operations": [
        {"action": "patch", "old_text": "alpha", "content": "ALPHA", "matched_entry": "alpha fact"}]})
    fine = stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    data = diff(client, f)
    write_memory(root, "default", ["alpha fact, edited"])
    late = stage("default", {"action": "add", "target": "memory", "content": "late fact"})
    out = bulk(client, f, data, "accept-all")
    by_id = {r["id"]: r for r in out["results"]}
    assert by_id[pid(stale)]["status"] == "stale" and by_id[pid(stale)]["reason"]
    assert by_id[pid(fine)]["status"] == "applied"
    assert by_id[pid(late)]["status"] == "unseen"
    assert read_memory(root, "default") == ["alpha fact, edited", "beta fact"]


def test_reject_all_decides_only_this_files_writes(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "one"})
    stage("default", {"action": "add", "target": "user", "content": "Name is Ben"})
    by_file = {f["file"]: f for f in files(client)["files"]}
    mem, user = by_file["MEMORY.md"], by_file["USER.md"]
    mem_data, user_data = diff(client, mem), diff(client, user)
    expects = {**{w: v["expect"] for w, v in mem_data["writes"].items()},
               **{w: v["expect"] for w, v in user_data["writes"].items()}}
    response = client.post(f"{base(mem)}/reject-all", json={"expects": expects})
    assert [r["status"] for r in response.json()["results"]] == ["rejected"]
    assert [f["file"] for f in files(client)["files"]] == ["USER.md"], "the USER.md write is untouched"


def test_stacked_skill_writes_conflict_after_the_first_accept(client, stage, root):
    """The second write was previewed against the old file, so its expect no longer matches."""
    make_skill(root, "default", "demo")
    stage("default", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    stage("default", {"action": "patch", "name": "demo", "old_string": "line two", "new_string": "line 2"})
    f = only_file(client)
    out = bulk(client, f, diff(client, f), "accept-all")
    assert [r["status"] for r in out["results"]] == ["applied", "conflict"]
    assert out["results"][1]["reason"]
    assert "line 1" in skill_file(root, "default", "demo").read_text()
    assert "line two" in skill_file(root, "default", "demo").read_text()


# --- decide: the expect goes through unchanged, and every status comes back ---------------------------

@pytest.fixture
def recorded(api, monkeypatch):
    calls = []

    def fake(reply):
        def decide(kind, write_id, decision, *, expect):
            calls.append((kind, write_id, decision, expect))
            return {"id": write_id, "subsystem": kind, **reply}
        monkeypatch.setattr(api, "decide_write", decide)
    return calls, fake


def test_the_expect_reaches_decide_write_exactly_as_the_client_sent_it(client, stage, root, recorded):
    calls, fake = recorded
    fake({"status": "applied", "result": {"secret": "never sent back"}})
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    data = diff(client, f)
    [block] = blocks(data)
    sent = {**data["writes"][block["record_id"]]["expect"], "extra": ["kept", {"as": "is"}]}
    out = client.post(f"{base(f)}/blocks/{block['id']}/accept", json={"expect": sent}).json()
    assert calls == [("memory", block["record_id"], "approve", sent)]
    assert "result" not in out and "never sent back" not in json.dumps(out)


@pytest.mark.parametrize("reply, expected", [
    ({"status": "applied"}, {"status": "applied", "reason": None}),
    ({"status": "rejected"}, {"status": "rejected", "reason": None}),
    ({"status": "already_resolved", "prior": "applied", "decided_at": 1.5},
     {"status": "already_resolved", "reason": None, "prior": "applied", "decided_at": 1.5}),
    ({"status": "already_resolved", "prior": "rejected", "decided_at": 2.0},
     {"status": "already_resolved", "reason": None, "prior": "rejected", "decided_at": 2.0}),
    ({"status": "conflict", "reason": "the pending write changed since it was previewed. Preview it again."},
     {"status": "conflict", "reason": "the pending write changed since it was previewed. Preview it again."}),
    ({"status": "needs_review", "reason": "An earlier approval stopped after it began writing."},
     {"status": "needs_review", "reason": "An earlier approval stopped after it began writing."}),
    ({"status": "rejected", "warning": "files may be partly changed"},
     {"status": "rejected", "reason": None, "warning": "files may be partly changed"}),
])
def test_every_decide_status_is_passed_to_the_client(client, stage, root, recorded, reply, expected):
    _calls, fake = recorded
    fake(reply)
    write_memory(root, "default", ["alpha fact"])
    staged = stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    data = diff(client, f)
    out = accept(client, f, data, blocks(data)[0], "reject" if reply["status"] == "rejected" else "accept")
    assert {k: v for k, v in out.items() if k != "file_gone"} == {"id": pid(staged), "kind": "memory", **expected}


def test_a_stale_write_is_answered_stale_without_asking_hermes(client, stage, root, recorded):
    calls, _fake = recorded
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "batch", "target": "memory", "operations": [
        {"action": "patch", "old_text": "alpha", "content": "ALPHA", "matched_entry": "alpha fact"}]})
    f = only_file(client)
    data = diff(client, f)
    write_memory(root, "default", ["alpha fact, edited"])
    out = accept(client, f, data, blocks(data)[0])
    assert out["status"] == "stale" and out["reason"] and calls == []


def test_a_decide_error_is_a_conflict_with_its_reason(client, stage, root, api, monkeypatch):
    def broken(kind, write_id, decision, *, expect):
        raise OSError(5, "I/O error")
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    data = diff(client, f)
    monkeypatch.setattr(api, "decide_write", broken)
    out = accept(client, f, data, blocks(data)[0])
    assert out["status"] == "conflict" and "I/O error" in out["reason"]


def test_a_missing_or_forged_expect_is_refused_by_hermes(client, stage, root):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    [block] = blocks(diff(client, f))
    url = f"{base(f)}/blocks/{block['id']}/accept"
    assert client.post(url, json={"expect": None}).json()["status"] == "conflict"
    forged = {"profile": "x", "record_sha256": "0" * 64, "targets": {}, "review_kind": "memory",
              "review_id": block["record_id"]}
    assert client.post(url, json={"expect": forged}).json()["status"] == "conflict"
    assert read_memory(root, "default") == ["alpha fact"]


@pytest.mark.parametrize("body", [None, {}, {"expect": 1}, {"expect": {}, "path": "/etc"}, ["x"]])
def test_a_malformed_decision_body_is_422(client, stage, root, body):
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    f = only_file(client)
    [block] = blocks(diff(client, f))
    assert client.post(f"{base(f)}/blocks/{block['id']}/accept", json=body).status_code == 422
    assert client.post(f"{base(f)}/accept-all", json=body).status_code == 422
    assert read_memory(root, "default") == ["alpha fact"]


# --- input checks and the profile boundary ------------------------------------------------------------

def test_bad_keys_block_ids_and_subsystems_are_400(client):
    good = "A" * 16
    assert client.get(f"{BASE}/files/default/skills/short/diff").status_code == 400
    assert client.get(f"{BASE}/files/default/nope/{good}/diff").status_code == 400
    assert client.post(f"{BASE}/files/default/memory/{good}/blocks/bad/accept", json={"expect": {}}).status_code == 400
    assert client.get(f"{BASE}/files/Bad%20Name/memory/{good}/diff").status_code == 400


def test_another_profiles_file_is_404_and_untouched(client, stage, root, scope):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", {"action": "add", "target": "memory", "content": "beta fact"})
    scope("dev")
    f = only_file(client)
    data = diff(client, f)
    scope("ops")
    response = client.post(f"{base(f)}/accept-all", json={"expects": {w: v["expect"] for w, v in data["writes"].items()}})
    assert response.status_code == 404 and "Switch Desktop to 'dev'" in response.json()["detail"]
    assert client.get(f"{base(f)}/diff").status_code == 404
    assert read_memory(root, "dev") == ["alpha fact"]


def test_a_named_profile_is_served_when_the_host_scopes_to_it(client, stage, root, scope):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", {"action": "add", "target": "memory", "content": "beta fact"})
    assert files(client)["files"] == [], "the default profile has nothing pending"
    scope("dev")
    f = only_file(client)
    assert f["profile"] == "dev"
    data = diff(client, f)
    assert accept(client, f, data, blocks(data)[0])["status"] == "applied"
    assert read_memory(root, "dev") == ["alpha fact", "beta fact"]


def test_needs_review_counts_are_reported(client, api, monkeypatch):
    real = api.list_writes

    def with_stuck(kind="all", *, page=1, page_size=25):
        return {**real(kind, page=page, page_size=page_size), "needs_review": {"memory": 1, "skills": 2, "total": 3}}

    monkeypatch.setattr(api, "list_writes", with_stuck)
    assert files(client)["needs_review"] == {"skills": 2, "memory": 1, "total": 3}
    assert client.get(f"{BASE}/pending").json()["profiles"][0]["needs_review"]["total"] == 3


def test_more_than_one_page_of_writes_is_listed(client, stage, root, api, monkeypatch):
    monkeypatch.setattr(api, "_PAGE_SIZE", 2)
    write_memory(root, "default", ["alpha fact"])
    for n in range(5):
        stage("default", {"action": "add", "target": "memory", "content": f"fact {n}"})
    assert client.get(f"{BASE}/pending").json()["total"] == 5
    assert only_file(client)["counts"]["total"] == 5


# --- a Hermes without the write review API ----------------------------------------------------------

@pytest.fixture
def old_hermes(root, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setitem(sys.modules, "tools.write_review_api", None)  # the import fails, as on an older Hermes
    spec = importlib.util.spec_from_file_location("skill_review_plugin_api_old_hermes", API_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = FastAPI()
    app.include_router(module.router, prefix=BASE)
    return module, TestClient(app)


def test_without_the_review_api_every_pending_route_says_so(old_hermes, stage, root):
    module, client = old_hermes
    write_memory(root, "default", ["alpha fact"])
    stage("default", {"action": "add", "target": "memory", "content": "beta fact"})
    assert module.review_api_available() is False
    message = module.NEEDS_API
    assert "needs a Hermes with the write review API" in message
    good = "A" * 16
    answers = [
        client.get(f"{BASE}/pending").json(),
        client.get(f"{BASE}/files").json(),
        client.get(f"{BASE}/files/default/memory/{good}/diff").json(),
        client.post(f"{BASE}/files/default/memory/{good}/blocks/abcdef12-0123456789/accept", json={"expect": {}}).json(),
        client.post(f"{BASE}/files/default/memory/{good}/accept-all", json={"expects": {}}).json(),
    ]
    for answer in answers:
        assert answer["status"] == "unavailable" and answer["message"] == message
    assert read_memory(root, "default") == ["alpha fact"]
    assert pending_file(root, "default", "x", "memory").parent.is_dir(), "the queue is left as it was"


def test_without_the_review_api_no_private_fallback_is_imported(old_hermes):
    module, client = old_hermes
    client.get(f"{BASE}/files")
    assert module.list_writes is None and module.preview_write is None and module.decide_write is None
