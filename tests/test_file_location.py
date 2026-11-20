"""Where a file lives, for the desktop's "Open in VS Code" link (new route; contract v1 is unchanged).

GET /files/{profile}/{subsystem}/{key}/location
    {"status": "ok", "path": str | None, "exists": bool, "host": str, "user": str}
    {"status": "refused", "error": str}   the file resolves outside the profile's memories/ or skills/
    {"status": "gone"}                    no pending change for that key any more
The path is the live file as Hermes resolves it, never a path from the request.
"""

import json
import os
import socket

import pytest

from conftest import home_of, memory_file, skill_content, write_memory

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


def location(client, f):
    return client.get(f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}/location").json()


def test_memory_file_location(client, stage, root):
    write_memory(root, "dev", ["alpha"])
    stage("dev", {"action": "add", "target": "memory", "content": "x"})
    loc = location(client, entry(client, "MEMORY.md"))
    assert loc["status"] == "ok" and loc["exists"] is True
    assert loc["path"] == str(memory_file(root, "dev")) and os.path.isabs(loc["path"])
    assert loc["host"] == socket.gethostname() and loc["user"]


def test_user_md_in_the_default_profile(client, stage, root):
    write_memory(root, "default", ["Name is Ben"], target="user")
    stage("default", {"action": "add", "target": "user", "content": "x"})
    loc = location(client, entry(client, "USER.md", profile="default"))
    assert loc["path"] == str(memory_file(root, "default", "user")) and loc["exists"] is True


def test_missing_memory_file_exists_false(client, stage, root):
    stage("dev", {"action": "add", "target": "memory", "content": "first entry"})
    loc = location(client, entry(client, "MEMORY.md"))
    assert loc["status"] == "ok" and loc["exists"] is False and loc["path"] == str(memory_file(root, "dev"))


def test_skill_and_supporting_file_locations(client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    _apply(root, "dev", {"action": "write_file", "name": "demo", "file_path": "references/a b é.md", "file_content": "x\n"})
    stage("dev", {"action": "batch", "operations": [
        {"action": "patch", "name": "demo", "old_string": "line one", "new_string": "line 1"},
        {"action": "write_file", "name": "demo", "file_path": "references/a b é.md", "file_content": "y\n"}]})
    skills = home_of(root, "dev") / "skills"
    loc = location(client, entry(client, "demo/SKILL.md"))
    assert loc == {**loc, "status": "ok", "exists": True, "path": str(skills / "demo" / "SKILL.md")}
    loc = location(client, entry(client, "demo/references/a b é.md"))
    assert loc["path"] == str(skills / "demo" / "references" / "a b é.md") and loc["exists"] is True


def test_new_skill_does_not_exist_yet(client, stage, root):
    stage("dev", {"action": "create", "name": "council", "content": skill_content("council"), "category": ""})
    loc = location(client, entry(client, "council/SKILL.md"))
    assert loc["status"] == "ok" and loc["exists"] is False and loc["path"] is None


def test_supporting_file_not_written_yet(client, stage, root):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    stage("dev", {"action": "write_file", "name": "demo", "file_path": "references/new.md", "file_content": "y\n"})
    loc = location(client, entry(client, "demo/references/new.md"))
    assert loc["status"] == "ok" and loc["exists"] is False


def test_symlinked_memory_file_escaping_the_profile_is_refused(client, stage, root, tmp_path):
    outside = tmp_path / "elsewhere.md"
    outside.write_text("secret")
    mem = memory_file(root, "dev")
    mem.parent.mkdir(parents=True, exist_ok=True)
    mem.symlink_to(outside)
    stage("dev", {"action": "add", "target": "memory", "content": "x"})
    loc = location(client, entry(client, "MEMORY.md"))
    assert loc["status"] == "refused" and "path" not in loc and str(outside) not in json.dumps(loc)


def test_symlinked_skill_escaping_the_profile_is_refused(client, stage, root, tmp_path):
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    outside = tmp_path / "outside.md"
    outside.write_text("x\n")
    refs = home_of(root, "dev") / "skills" / "demo" / "references"
    refs.mkdir()
    (refs / "link.md").symlink_to(outside)
    stage("dev", {"action": "patch", "name": "demo", "file_path": "references/link.md", "old_string": "x", "new_string": "y"})
    loc = location(client, entry(client, "demo/references/link.md"))
    assert loc["status"] == "refused" and "path" not in loc


def test_skill_in_an_external_dir_is_refused(client, stage, root, tmp_path):
    ext = tmp_path / "ext-skills"
    (ext / "shared").mkdir(parents=True)
    (ext / "shared" / "SKILL.md").write_text(skill_content("shared"))
    (home_of(root, "dev") / "config.yaml").write_text("skills:\n  write_approval: true\n  external_dirs:\n    - " + str(ext) + "\nmemory:\n  write_approval: true\n")
    stage("dev", {"action": "patch", "name": "shared", "old_string": "line one", "new_string": "line 1"})
    loc = location(client, entry(client, "shared/SKILL.md"))
    assert loc["status"] == "refused"


def test_record_file_path_cannot_steer_the_location(client, stage, root, tmp_path):
    (tmp_path / "secret.txt").write_text("TOP SECRET\n")
    _apply(root, "dev", {"action": "create", "name": "demo", "content": skill_content(), "category": ""})
    stage("dev", {"action": "write_file", "name": "demo", "file_path": "../../../../../secret.txt", "file_content": "x"})
    for f in client.get(f"{BASE}/files").json()["files"]:
        loc = location(client, f)
        assert loc["status"] in ("refused", "ok")
        if loc["status"] == "ok" and loc["path"]:
            assert loc["path"].startswith(str(home_of(root, "dev") / "skills") + os.sep)
        assert "secret.txt" not in (loc.get("path") or "")


def test_location_for_a_resolved_key_is_gone(client, stage, root):
    stage("dev", {"action": "add", "target": "memory", "content": "x"})
    f = entry(client, "MEMORY.md")
    client.post(f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}/reject-all")
    assert location(client, f) == {"status": "gone"}


@pytest.mark.parametrize("key", ["MEMORY.md", "..", "a/b", "short", "A" * 17, "%2e%2e", "..%2F..%2Fetc"])
def test_bad_keys_are_rejected(client, key):
    assert client.get(f"{BASE}/files/dev/memory/{key}/location").status_code in (400, 404)


def test_bad_subsystem_and_profile(client):
    assert client.get(f"{BASE}/files/dev/bogus/AAAAAAAAAAAAAAAA/location").status_code == 400
    assert client.get(f"{BASE}/files/Nope/memory/AAAAAAAAAAAAAAAA/location").status_code == 400
    assert client.get(f"{BASE}/files/nope/memory/AAAAAAAAAAAAAAAA/location").status_code == 404


def test_the_request_carries_no_path(client, stage, root):
    """Query parameters are ignored: the path comes from the server's own file key only."""
    write_memory(root, "dev", ["alpha"])
    stage("dev", {"action": "add", "target": "memory", "content": "x"})
    f = entry(client, "MEMORY.md")
    url = f"{BASE}/files/dev/memory/{f['key']}/location"
    assert client.get(url, params={"path": "/etc/passwd"}).json()["path"] == str(memory_file(root, "dev"))
