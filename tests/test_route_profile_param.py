"""Regression: a path parameter named ``profile`` collided with Hermes's router-wide dependency.

Hermes mounts this router with ``dependencies=[Depends(_plugin_route_secret_scope)]``
(hermes_cli/web_server_dashboard.py, include_router call near line 1262). That dependency takes
``profile: Optional[str] = None``. FastAPI binds a dependency parameter to a PATH parameter of the
same name before it looks at the query string, so ``/files/dev/...`` made Hermes scope the request
to profile ``dev`` and refuse it with 404 "Plugin not found". The fix names our path parameter
``owner``; the URL shape stays the same.
"""

from typing import Optional

import pytest

from conftest import write_memory

BASE = "/api/plugins/skill-review"


@pytest.fixture
def hermes_like(api):
    """The plugin router mounted the way Hermes mounts it, with a recording copy of its dependency."""
    from fastapi import Depends, FastAPI
    from fastapi.testclient import TestClient
    from starlette.requests import HTTPConnection

    seen: list[Optional[str]] = []

    # COPY of the signature of hermes_cli.web_server_dashboard._plugin_route_secret_scope
    # (line 1018). Only the parameters matter: FastAPI resolves ``profile`` from the path when a
    # path parameter has that name, else from ``?profile=``. The real one scopes and may 404.
    async def _plugin_route_secret_scope(conn: HTTPConnection, profile: Optional[str] = None):
        seen.append(profile)
        yield True

    app = FastAPI()
    app.include_router(api.router, prefix=BASE, dependencies=[Depends(_plugin_route_secret_scope)])
    return TestClient(app), seen


def _dev_files(client):
    files = client.get(f"{BASE}/files", params={"kind": "all"}).json()["files"]
    return [f for f in files if f["profile"] == "dev"]


def test_no_route_has_a_path_parameter_named_profile(api):
    from fastapi.routing import APIRoute
    routes = [r for r in api.router.routes if isinstance(r, APIRoute)]
    assert routes
    offenders = [r.path for r in routes if "profile" in r.param_convertors]
    assert offenders == []
    for r in routes:
        assert "profile" not in {p.name for p in r.dependant.path_params}, r.path
        assert "profile" not in {p.name for p in r.dependant.query_params}, r.path


def test_hermes_dependency_never_sees_the_file_owner_as_its_profile(hermes_like, stage, root):
    client, seen = hermes_like
    write_memory(root, "dev", ["alpha fact"])
    staged = stage("dev", {"action": "add", "target": "memory", "content": "beta fact"})
    stage("dev", {"action": "add", "target": "memory", "content": "gamma fact"})
    [f] = _dev_files(client)
    base = f"{BASE}/files/{f['profile']}/{f['subsystem']}/{f['key']}"
    pid = staged.get("pending_id") or staged.get("id")

    diff = client.get(f"{base}/diff")
    assert diff.status_code == 200
    blocks = [s["block"] for s in diff.json()["segments"] if s["type"] == "block"]
    assert len(blocks) == 2

    calls = [
        ("get", f"{base}/edits"),
        ("get", f"{base}/location"),
        ("get", f"{BASE}/pending/memory/dev/{pid}/diff"),
        ("post", f"{base}/blocks/{blocks[0]['id']}/accept"),
        ("post", f"{base}/accept-all"),
    ]
    for method, url in calls:
        response = getattr(client, method)(url)
        assert response.status_code == 200, (url, response.text)

    assert len(seen) == 1 + 1 + len(calls)  # /files, diff, then the calls above
    assert seen == [None] * len(seen), "the owner profile leaked into Hermes's profile scope"


def test_an_explicit_query_profile_still_reaches_the_dependency(hermes_like):
    """Only the path collision is removed: a real ?profile= is Hermes's to read, as before."""
    client, seen = hermes_like
    client.get(f"{BASE}/files", params={"kind": "all", "profile": "ops"})
    assert seen == ["ops"]
