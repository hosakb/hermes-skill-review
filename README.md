# Skill Review

Skill Review is a Hermes Desktop plugin with a Python backend that shows staged skill and memory writes as visual diffs in one review tab, where you accept or reject each proposed change.

## What it does

With `skills.write_approval` or `memory.write_approval` on, Hermes does not write skill or memory changes straight to disk. It stages each one as a JSON record under `<HERMES_HOME>/pending/skills/` or `<HERMES_HOME>/pending/memory/`. Skill Review reads those records and shows them in Desktop.

- One review tab lists every file with pending changes once: a `SKILL.md` or supporting file, `MEMORY.md` or `USER.md`.
- Each proposed change is its own block in the file's diff. You accept or reject blocks one at a time, or use Accept all and Reject all for the whole file.
- Blocks staged since you last opened the file are marked New. Earlier ones are marked Older.
- Changed lines get word-level highlights.
- Unchanged lines fold to 3 lines of context. Expand rows show 10 more lines above or below, or the whole gap.
- You can edit a proposed change in place before you accept it. Hermes's own size limits and content scan run on the edited text.
- For a memory replace or patch, Remove entirely deletes the existing entry and drops the proposal, so neither version is kept.
- Filters show skills, memory or all. You can limit the list to some profiles and sort it by newest, oldest, name or number of changes.
- A Review button in the status bar shows the pending count. Click it to open the tab. Right-click it to pick the notification mode.
- New changes show a popup or light up the Review button, as you choose. With auto-open on, the tab opens by itself instead.
- Settings live under Settings > Plugins > Skill Review.

## Requirements

- Hermes 0.23.2 or newer, with Hermes Desktop.
- The write-approval gate turned on in every profile you want to review. The keys are `skills.write_approval` and `memory.write_approval`. Both default to off.

```bash
hermes config set skills.write_approval true
hermes config set memory.write_approval true

# for a named profile
hermes -p <profile> config set skills.write_approval true
```

In chat, `/skills approval on` and `/memory approval on` set the same keys.

## Install

From the plugin catalog, once the plugin is listed there:

```bash
hermes plugins install skill-review
```

From GitHub:

```bash
hermes plugins install https://github.com/hosakb/hermes-skill-review
# or the owner/repo shorthand
hermes plugins install hosakb/hermes-skill-review
```

The install asks whether to enable the plugin. To enable it later, run `hermes plugins enable skill-review`, which adds it to `plugins.enabled` in `config.yaml`. The Python backend loads only when it is on that list.

Then turn on the Desktop half in Desktop under Capabilities > Plugins. It starts off.

The gateway imports the Python backend when it starts. After an install or update, restart the backend (for example `hermes gateway restart`) and reload Desktop so both halves run the same version.

## How it works

`dashboard/plugin_api.py` mounts routes under `/api/plugins/skill-review/` in the gateway. It lists the pending records of the default profile and every profile under `<HERMES_HOME>/profiles/`, groups their operations by target file and diffs each one against the file as it is now. It uses Hermes's own functions in `tools/write_approval.py` and the memory store for this.

`desktop/plugin.js` asks the backend for the pending list every 3 seconds through `ctx.rest`. It draws the tab, the Review button and the settings page.

Accepting a block takes Hermes's pending-queue lock, cuts that operation out of its record and applies it with the same code as `/skills approve` and `/memory approve`. If Hermes refuses to apply it, the record stays as it was. Rejecting drops the operation from its record, and a record with no operations left is deleted.

The diff marks a block stale when its file changed so that the change no longer applies, and marks a conflict when it overlaps another pending block. Accept all works through the file's blocks in staged order, checks each one again against the file on disk, and skips stale and conflicting blocks with a reason.

## Disclosure

- No network calls. The Desktop half talks only to the Hermes backend it runs against, through `ctx.rest`. The backend makes no outgoing connections.
- No telemetry and no usage reporting.
- No credentials. The plugin reads no secrets, tokens or `.env` files.
- No tools, hooks, shell commands or background processes. The Python `register()` does nothing.
- It reads pending records under `<HERMES_HOME>/pending/` and, for the default profile and every profile under `<HERMES_HOME>/profiles/`, each profile's `MEMORY.md`, `USER.md` and `SKILL.md` files. If you set external skill folders in Hermes, it reads `SKILL.md` files there too.
- It writes pending records: rejecting a block removes it from its record, and an edit or Remove entirely rewrites it.
- On Accept, Hermes's own approval code writes the change to the profile's skill or memory files, the same as `/skills approve` or `/memory approve`.
- Editing a skill change runs Hermes's content scan on a copy of the file in a temporary folder, which is deleted right after.
- The backend keeps an in-memory cache of up to 512 diff results. Nothing is cached on disk.
- The Desktop half stores its settings in Desktop plugin storage: notification mode, auto-open, shown profiles, sort order, which changes it already announced and when you last opened each file.

## Known limits

- The review tab cannot be closed, because Desktop turns a plugin off when its only pane closes. Collapse it, or hide it from the zone menu or with "Toggle Pending writes tab" in the command palette.
- If you drag the tab into the chat zone, cmd-W there still closes it and switches the plugin off. This is a Desktop limitation.
- After an update, reload Desktop and restart the backend before the new version runs.
- Word highlights stop at 2,500 tokens per line and 4,000,000 comparison cells per line pair (16,000,000 per block). Longer lines are tinted without word marks. Diffs themselves are not truncated.
- An edit can be at most 100,000 characters, and Hermes's own size limit for the file still applies.
- Remove entirely handles single-line memory entries only, and refuses if the entry appears more than once in the file.

## Development

The JavaScript tests use Node's built-in test runner and need no install:

```bash
node --test tests/js/*.test.mjs
```

The Python tests import Hermes from a checkout of the Hermes source repository. Run them with a Python that has Hermes's dependencies and pytest installed, for example the Hermes virtual environment:

```bash
HERMES_AGENT_SRC=/path/to/hermes-source python -m pytest -q tests
```

Each test builds a throwaway Hermes root in a temporary folder and never touches `~/.hermes`.

## License

MIT. See [LICENSE](LICENSE).
