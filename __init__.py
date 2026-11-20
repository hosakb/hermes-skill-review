"""Loader entry point. The plugin has no agent-side behaviour, so register() does nothing.

The backend lives in dashboard/plugin_api.py and the UI in desktop/plugin.js.
"""


def register(ctx):
    return None
