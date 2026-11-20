"""The evaluation cache behind GET /files and the per-file diff: reused while nothing changed,
recomputed when any input of the evaluation changed."""

import json
import shutil

import pytest

from conftest import home_of, memory_file, skill_content, skill_file, write_memory

BASE = "/api/plugins/skill-review"


def _apply(root, profile, payload):
    from agent.runtime_scope import bind_profile_scope
    from tools.skill_manager_tool import apply_skill_pending
    with bind_profile_scope(home_of(root, profile), hydrate_secrets=False):
        assert json.loads(apply_skill_pending(payload))["success"]


def listing(client):
    return {(f["profile"], f["file"]): f for f in client.get(f"{BASE}/files").json()["files"]}


def diff(client, f):
    return client.get(f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}/diff").json()


def blocks(d):
    return [s["block"] for s in d["segments"] if s["type"] == "block"]


def mpatch(entry_text, old, new):
    return {"action": "patch", "old_text": old, "content": new, "matched_entry": entry_text}


def batch(*ops):
    return {"action": "batch", "target": "memory", "operations": list(ops)}


@pytest.fixture
def evaluations(api, monkeypatch):
    """Counts real (uncached) evaluations per file label."""
    seen = []
    real = api._evaluate_uncached

    def counting(subsystem, entry):
        seen.append(entry["file"])
        return real(subsystem, entry)

    monkeypatch.setattr(api, "_evaluate_uncached", counting)
    return seen


def fresh(api, client, f):
    """What the evaluation gives with the cache emptied: the answer the cache must agree with."""
    api._cache.clear()
    return diff(client, f)


# --- reuse -------------------------------------------------------------------------------------

def test_repeated_polls_reuse_the_evaluation(client, stage, root, evaluations):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})

    first = listing(client)
    assert sorted(evaluations) == ["MEMORY.md", "demo/SKILL.md"]
    again = listing(client)
    assert sorted(evaluations) == ["MEMORY.md", "demo/SKILL.md"], "second poll recomputed a file"
    assert first == again
    for f in again.values():
        assert len(f["version"]) == 16
        d = diff(client, f)
        assert d["file"]["version"] == f["version"]
    assert len(evaluations) == 2, "the diff after a list reuses the list's evaluation"


def test_a_cached_answer_equals_a_fresh_one(api, client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA"), {"action": "add", "content": "gamma"}))
    stage("dev", batch(mpatch("alpha fact", "alpha", "AlPhA")))
    f = listing(client)[("dev", "MEMORY.md")]
    cached = diff(client, f)
    assert diff(client, f) == cached
    assert fresh(api, client, f) == cached


def test_callers_cannot_change_a_cached_result(api, client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    f = listing(client)[("dev", "MEMORY.md")]
    with api._profile_scope(home_of(root, "dev")):
        entry = api._file_entries("memory", "dev")[f["key"]]
        _cur, got, _v = api._evaluate("memory", entry, {})
        got[0]["state"] = "tampered"
        _cur, again, _v = api._evaluate("memory", entry, {})
    assert again[0]["state"] == "pending"


# --- invalidation: everything that changes the answer --------------------------------------------

def test_editing_the_memory_file_invalidates(api, client, stage, root, evaluations):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    before = listing(client)[("dev", "MEMORY.md")]
    assert before["counts"]["pending"] == 1
    # Same length, so a size check alone would miss it; the bytes differ.
    write_memory(root, "dev", ["alpha facT"])
    after = listing(client)[("dev", "MEMORY.md")]
    assert after["counts"] == {"total": 1, "pending": 0, "stale": 1, "conflict": 0}
    assert after["version"] != before["version"]
    assert blocks(diff(client, after))[0]["state"] == "stale"
    assert diff(client, after) == fresh(api, client, after)


def test_editing_user_md_invalidates_memory_md_too(client, stage, root, evaluations):
    """The dry run reads both files, so both are inputs of both."""
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    listing(client)
    n = len(evaluations)
    write_memory(root, "dev", ["Name is Ben"], target="user")
    listing(client)
    assert len(evaluations) == n + 1


def test_a_new_staged_write_invalidates(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    before = listing(client)[("dev", "MEMORY.md")]
    stage("dev", {"action": "add", "target": "memory", "content": "gamma"})
    after = listing(client)[("dev", "MEMORY.md")]
    assert after["counts"]["total"] == 2 and after["version"] != before["version"]


def test_resolving_a_block_invalidates(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA"), {"action": "add", "content": "gamma"}))
    f = listing(client)[("dev", "MEMORY.md")]
    first = blocks(diff(client, f))[0]
    r = client.post(f"{BASE}/files/dev/memory/{f['key']}/blocks/{first['id']}/reject").json()
    assert r["status"] == "rejected"
    after = listing(client)[("dev", "MEMORY.md")]
    assert after["counts"]["total"] == 1 and after["version"] != f["version"]


def test_a_lower_memory_limit_in_config_invalidates(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", {"action": "add", "target": "memory", "content": "a new fact that needs room " * 4})
    assert listing(client)[("dev", "MEMORY.md")]["counts"]["pending"] == 1
    config = home_of(root, "dev") / "config.yaml"
    config.write_text(config.read_text() + "  memory_char_limit: 20\n")
    after = listing(client)[("dev", "MEMORY.md")]
    assert after["counts"]["stale"] == 1


def test_editing_the_skill_file_invalidates(api, client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    before = listing(client)[("dev", "demo/SKILL.md")]
    assert before["counts"]["pending"] == 1
    path = skill_file(root, "dev", "demo")
    path.write_text(path.read_text().replace("line one", "line ONE"))  # same size
    after = listing(client)[("dev", "demo/SKILL.md")]
    assert after["counts"]["stale"] == 1 and after["version"] != before["version"]
    assert diff(client, after) == fresh(api, client, after)


def test_editing_a_supporting_file_invalidates(client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    ref = skill_file(root, "dev", "demo").parent / "references" / "notes.md"
    ref.parent.mkdir()
    ref.write_text("keep this\n")
    stage("dev", {"action": "patch", "name": "demo", "file_path": "references/notes.md",
                  "old_string": "keep this", "new_string": "kept"})
    assert listing(client)[("dev", "demo/references/notes.md")]["counts"]["pending"] == 1
    ref.write_text("gone now\n")
    assert listing(client)[("dev", "demo/references/notes.md")]["counts"]["stale"] == 1


def test_a_skill_appearing_invalidates_a_create(client, stage, root):
    stage("dev", {"action": "create", "name": "fresh", "content": skill_content("fresh"), "category": ""})
    assert listing(client)[("dev", "fresh/SKILL.md")]["counts"]["pending"] == 1
    _apply(root, "dev", {"action": "create", "name": "fresh", "content": skill_content("fresh"), "category": ""})
    after = listing(client)[("dev", "fresh/SKILL.md")]
    assert after["counts"]["stale"] == 1


def test_a_skill_disappearing_invalidates_a_patch(client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"})
    assert listing(client)[("dev", "demo/SKILL.md")]["counts"]["pending"] == 1
    shutil.rmtree(skill_file(root, "dev", "demo").parent)
    assert listing(client)[("dev", "demo/SKILL.md")]["counts"]["stale"] == 1


def test_a_frontmatter_rename_elsewhere_in_the_tree_invalidates(client, stage, root):
    """The skill lookup falls back to frontmatter names, so another skill's SKILL.md is an input."""
    _apply(root, "dev", {"action": "create", "name": "other", "content": skill_content("other"), "category": ""})
    stage("dev", {"action": "patch", "name": "nick", "old_string": "line one", "new_string": "line 1"})
    assert listing(client)[("dev", "nick/SKILL.md")]["counts"]["stale"] == 1  # no skill called nick
    path = skill_file(root, "dev", "other")
    path.write_text(path.read_text().replace("name: other", "name: nick", 1))
    assert listing(client)[("dev", "nick/SKILL.md")]["counts"]["pending"] == 1


def test_a_write_during_the_evaluation_is_not_cached(api, client, stage, root, monkeypatch, evaluations):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    inner = api._evaluate_uncached
    wrote = []

    def racing(subsystem, entry):
        result = inner(subsystem, entry)
        if not wrote:
            wrote.append(1)
            write_memory(root, "dev", ["alpha facT"])  # lands after the evaluation read the file
        return result

    monkeypatch.setattr(api, "_evaluate_uncached", racing)
    listing(client)
    assert not api._cache, "a result computed across a write was cached"
    assert listing(client)[("dev", "MEMORY.md")]["counts"]["stale"] == 1


def test_profiles_do_not_share_cache_entries(client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    write_memory(root, "ops", ["other fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    stage("ops", batch(mpatch("alpha fact", "alpha", "ALPHA")))  # same op, but ops has no such entry
    got = listing(client)
    assert got[("dev", "MEMORY.md")]["counts"]["pending"] == 1
    assert got[("ops", "MEMORY.md")]["counts"]["stale"] == 1


def test_accept_all_reevaluates_from_disk(api, client, stage, root, monkeypatch):
    """A resolve never trusts the cache: accept-all re-checks every step uncached."""
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    f = listing(client)[("dev", "MEMORY.md")]
    calls = []
    monkeypatch.setattr(api, "_evaluate", lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(AssertionError))
    r = client.post(f"{BASE}/files/dev/memory/{f['key']}/accept-all").json()
    assert [x["status"] for x in r["results"]] == ["applied"] and not calls
    assert memory_file(root, "dev").read_text().startswith("ALPHA fact")
