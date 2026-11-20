"""Context expansion reads its lines from the file diff (contract v1), so these tests pin what it relies on:
the diff's context segments plus each block's removed lines are every line of the current file, once, in
order, with the file's real line numbers; a cached diff never serves lines from an older file; and a file
that does not exist yet (a create) or any more (a stale skill) has no context to expand."""

import json

from conftest import home_of, memory_file, skill_content, skill_file, write_memory

BASE = "/api/plugins/skill-review"


def _apply(root, profile, payload):
    from agent.runtime_scope import bind_profile_scope
    from tools.skill_manager_tool import apply_skill_pending
    with bind_profile_scope(home_of(root, profile), hydrate_secrets=False):
        assert json.loads(apply_skill_pending(payload))["success"]


def entry(client, file, profile="dev"):
    found = [f for f in client.get(f"{BASE}/files").json()["files"] if f["file"] == file and f["profile"] == profile]
    assert len(found) == 1, found
    return found[0]


def diff(client, f):
    return client.get(f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}/diff").json()


def context_lines(d):
    return [line for s in d["segments"] if s["type"] == "context" for line in s["lines"]]


def covered(d):
    """Every current line the diff shows: context lines and the lines blocks remove, by number.
    Overlapping blocks may remove the same line, so it is counted once."""
    lines = {line["no"]: line["text"] for line in context_lines(d)}
    for s in d["segments"]:
        if s["type"] == "block":
            for line in s["block"]["removed"]:
                lines.setdefault(line["no"], line["text"])
    return [lines[n] for n in sorted(lines)], sorted(lines)


def long_skill(n=40):
    body = "".join(f"step {i}\n" for i in range(1, n + 1))
    return skill_content() + body


def test_memory_diff_carries_every_line_with_real_numbers(client, stage, root):
    entries = [f"fact {i}\nwith a second line" if i % 3 == 0 else f"fact {i}" for i in range(1, 12)]
    write_memory(root, "dev", entries)
    stage("dev", {"action": "add", "target": "memory", "content": "new fact"})
    d = diff(client, entry(client, "MEMORY.md"))
    raw = memory_file(root, "dev").read_text().split("\n")
    texts, numbers = covered(d)
    assert texts == raw, "the section sign lines are plain lines in the file's own order"
    assert numbers == list(range(1, len(raw) + 1))
    assert raw.count("§") == len(entries) - 1
    add = [s["block"] for s in d["segments"] if s["type"] == "block"][0]
    assert [line["no"] for line in add["added"]] == [len(raw) + 1, len(raw) + 2]


def test_skill_diff_carries_every_line_around_two_changes(client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": long_skill(), "category": ""})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "step 5\n", "new_string": "step five\n"})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "step 33\n", "new_string": "step 33b\n"})
    d = diff(client, entry(client, "demo/SKILL.md"))
    raw = skill_file(root, "dev", "demo").read_text().splitlines()
    texts, numbers = covered(d)
    assert texts == raw and numbers == list(range(1, len(raw) + 1))
    kinds = [s["type"] for s in d["segments"]]
    assert kinds == ["context", "block", "context", "block", "context"], "a gap above, between and below"
    between = d["segments"][2]["lines"]
    assert len(between) > 20, "the between gap is long enough to fold"


def test_cached_diff_serves_fresh_lines_after_an_external_change(client, stage, root):
    write_memory(root, "dev", ["alpha", "beta"])
    stage("dev", {"action": "add", "target": "memory", "content": "gamma"})
    f = entry(client, "MEMORY.md")
    first = diff(client, f)
    assert diff(client, f) == first, "unchanged: same answer (from the cache)"
    write_memory(root, "dev", ["alpha", "inserted", "beta"])
    g = entry(client, "MEMORY.md")
    assert g["version"] != f["version"], "a version change tells the desktop to reset its expanded gaps"
    texts, _ = covered(diff(client, g))
    assert texts == ["alpha", "§", "inserted", "§", "beta"]


def test_cached_skill_diff_serves_fresh_lines_after_an_external_change(client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": long_skill(), "category": ""})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "step 20\n", "new_string": "step twenty\n"})
    f = entry(client, "demo/SKILL.md")
    diff(client, f)
    path = skill_file(root, "dev", "demo")
    path.write_text(path.read_text().replace("step 1\n", "step one\nstep one and a half\n"))
    g = entry(client, "demo/SKILL.md")
    assert g["version"] != f["version"]
    texts, _ = covered(diff(client, g))
    assert texts == path.read_text().splitlines()
    assert "step one and a half" in texts


def test_lines_are_fresh_after_an_accept(client, stage, root):
    write_memory(root, "dev", ["alpha", "beta"])
    stage("dev", {"action": "add", "target": "memory", "content": "gamma"})
    stage("dev", {"action": "add", "target": "memory", "content": "delta"})
    f = entry(client, "MEMORY.md")
    d = diff(client, f)
    first = [s["block"] for s in d["segments"] if s["type"] == "block"][0]
    res = client.post(f"{BASE}/files/dev/memory/{f['key']}/blocks/{first['id']}/accept").json()
    assert res["status"] == "applied"
    g = entry(client, "MEMORY.md")
    assert g["version"] != f["version"]
    texts, numbers = covered(diff(client, g))
    assert texts == memory_file(root, "dev").read_text().split("\n")
    assert texts[-1] in {"gamma", "delta"} and numbers == list(range(1, len(texts) + 1))


def test_new_file_create_and_missing_skill_have_no_context(client, stage, root):
    stage("dev", {"action": "create", "name": "council", "content": skill_content("council"), "category": ""})
    assert context_lines(diff(client, entry(client, "council/SKILL.md"))) == []
    _apply(root, "dev", {"action": "create", "name": "demo", "content": long_skill(), "category": ""})
    stage("dev", {"action": "patch", "name": "demo", "old_string": "step 3\n", "new_string": "step three\n"})
    _apply(root, "dev", {"action": "delete", "name": "demo"})
    d = diff(client, entry(client, "demo/SKILL.md"))
    assert context_lines(d) == []
    assert [s["block"]["state"] for s in d["segments"] if s["type"] == "block"] == ["stale"]
