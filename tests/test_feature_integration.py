"""Edit, expand context and Remove entirely together on one file.

Expand context reads its lines from the v1 diff (context segments plus removed lines), so "the lines
an expand shows" are that diff's lines; the cache they come from is the evaluation cache."""

from conftest import read_memory, skill_content, write_memory

BASE = "/api/plugins/skill-review"


def entry(client, file, profile="dev"):
    found = [f for f in client.get(f"{BASE}/files").json()["files"] if f["file"] == file and f["profile"] == profile]
    assert len(found) == 1, found
    return found[0]


def base(f):
    return f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}"


def diff(client, f):
    return client.get(f"{base(f)}/diff").json()


def blocks(d):
    return [s["block"] for s in d["segments"] if s["type"] == "block"]


def lines(d):
    """Every current line the diff carries for context expansion, by number."""
    out = {l["no"]: l["text"] for s in d["segments"] if s["type"] == "context" for l in s["lines"]}
    for b in blocks(d):
        out.update({l["no"]: l["text"] for l in b["removed"]})
    return [out[n] for n in sorted(out)]


def edit(client, f, block_id, text, apply=False):
    return client.post(f"{base(f)}/blocks/{block_id}/edit", json={"text": text, "apply": apply}).json()


def mpatch(entry_text, old, new):
    return {"action": "patch", "old_text": old, "content": new, "matched_entry": entry_text}


def batch(*ops):
    return {"action": "batch", "target": "memory", "operations": list(ops)}


def test_after_save_and_accept_of_an_edit_the_expand_lines_show_the_new_text(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact", "gamma fact"])
    stage("dev", batch(mpatch("beta fact", "beta", "BETA"), {"action": "add", "content": "delta fact"}))
    f = entry(client, "MEMORY.md")
    d = diff(client, f)
    assert "beta fact" in lines(d)
    patch = next(b for b in blocks(d) if b["op_index"] == 0)
    assert edit(client, f, patch["id"], "Beta, edited", apply=True)["status"] == "applied"
    after = diff(client, entry(client, "MEMORY.md"))
    assert "Beta, edited fact" in lines(after) and "beta fact" not in lines(after)
    assert read_memory(root, "dev") == ["alpha fact", "Beta, edited fact", "gamma fact"]


def test_save_as_proposal_shows_the_edited_text_in_the_block_beside_unchanged_lines(client, stage, root):
    from conftest import home_of
    import json
    from agent.runtime_scope import bind_profile_scope
    from tools.skill_manager_tool import apply_skill_pending
    with bind_profile_scope(home_of(root, "dev"), hydrate_secrets=False):
        assert json.loads(apply_skill_pending({"action": "create", "name": "demo", "content": skill_content(), "category": ""}))["success"]
    stage("dev", {"action": "patch", "name": "demo", "old_string": "line two", "new_string": "line 2"})
    f = entry(client, "demo/SKILL.md")
    before = diff(client, f)
    (b,) = blocks(before)
    assert edit(client, f, b["id"], "line II")["status"] == "saved"
    after = diff(client, entry(client, "demo/SKILL.md"))
    (nb,) = blocks(after)
    assert [l["text"] for l in nb["added"]] == ["line II"]
    assert lines(after) == lines(before), "the live file is unchanged, so expand shows the same lines"


def test_an_edit_drops_the_cached_evaluations_the_lines_come_from(api, client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    write_memory(root, "dev", ["Name is Ben"], target="user")
    stage("dev", batch({"action": "add", "content": "gamma"}))
    stage("dev", {"action": "batch", "target": "user", "operations": [{"action": "add", "content": "Likes tea"}]})
    f, user = entry(client, "MEMORY.md"), entry(client, "USER.md")
    (b,) = blocks(diff(client, f))

    def cached():
        return [k for k in api._cache if k[1] == "memory" and k[2] in (f["key"], user["key"])]

    assert len(cached()) == 2
    assert edit(client, f, b["id"], "gamma, edited")["status"] == "saved"
    assert cached() == [], "the profile's memory evaluations are dropped, as Remove entirely does"
    after = entry(client, "MEMORY.md")
    assert after["version"] != f["version"]
    (nb,) = blocks(diff(client, after))
    assert nb["added"][-1]["text"] == "gamma, edited"


def test_a_failed_edit_keeps_the_cache(api, client, stage, root):
    write_memory(root, "dev", ["alpha fact"])
    stage("dev", batch({"action": "add", "content": "gamma"}))
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    assert any(k[2] == f["key"] for k in api._cache)
    assert edit(client, f, b["id"], "x" * 3000, apply=True)["status"] == "failed"
    assert any(k[2] == f["key"] for k in api._cache), "nothing changed, so nothing is dropped"


def test_remove_entry_still_refuses_skill_blocks_and_add_only_blocks_after_an_edit(client, stage, root):
    stage("dev", {"action": "create", "name": "council", "content": skill_content("council"), "category": ""})
    stage("dev", batch({"action": "add", "content": "gamma"}))
    sf, mf = entry(client, "council/SKILL.md"), entry(client, "MEMORY.md")
    (sb,), (mb,) = blocks(diff(client, sf)), blocks(diff(client, mf))
    new_skill = edit(client, sf, sb["id"], skill_content("council", "edited"))["block_id"]
    new_mem = edit(client, mf, mb["id"], "gamma, edited")["block_id"]
    assert new_skill and new_mem
    r = client.post(f"{base(sf)}/blocks/{new_skill}/remove-entry").json()
    assert r["status"] == "failed" and "memory" in r["error"]
    r = client.post(f"{base(mf)}/blocks/{new_mem}/remove-entry").json()
    assert r["status"] == "failed" and "replaces or patches" in r["error"]


def test_remove_entry_works_on_an_edited_patch_block(client, stage, root):
    write_memory(root, "dev", ["alpha fact", "beta fact"])
    stage("dev", batch(mpatch("alpha fact", "alpha", "ALPHA")))
    f = entry(client, "MEMORY.md")
    (b,) = blocks(diff(client, f))
    new_id = edit(client, f, b["id"], "Alpha")["block_id"]
    assert client.post(f"{base(f)}/blocks/{b['id']}/remove-entry").json()["status"] == "already_handled"
    assert client.post(f"{base(f)}/blocks/{new_id}/remove-entry").json()["status"] == "removed"
    assert read_memory(root, "dev") == ["beta fact"]
