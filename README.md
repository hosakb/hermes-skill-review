# Skill Review

![Skill Review: a review tab with the pending file list and per-change diff blocks](docs/banner.png)

Skill Review is a Hermes Desktop plugin with a Python backend that shows staged skill and memory writes as visual diffs on one review page, where you accept or reject each proposed change. Its Library mode lists each profile's identity, memory and skill files and edits them in place.

## What it does

With `skills.write_approval` or `memory.write_approval` on, Hermes does not write skill or memory changes straight to disk. It stages each one as a JSON record under `<HERMES_HOME>/pending/skills/` or `<HERMES_HOME>/pending/memory/`. Skill Review reads those records and shows them in Desktop.

- Skill review in the sidebar opens the review page in the main area, the way Memory Wiki and Kanban open theirs. The page lists every file with pending changes once: a `SKILL.md` or supporting file, `MEMORY.md` or `USER.md`.
- Each proposed change is its own block in the file's diff. You accept or reject blocks one at a time, or use Accept all and Reject all for the whole file.
- Blocks staged since you last opened the file are marked New. Earlier ones are marked Older.
- Changed lines get word-level highlights.
- Unchanged lines fold to 3 lines of context. Expand rows show 10 more lines above or below, or the whole gap.
- You can edit a proposed change in place before you accept it. Hermes's own size limits and content scan run on the edited text.
- For a memory replace or patch, Remove entirely deletes the existing entry and drops the proposal, so neither version is kept.
- Filters show skills, memory or all. You can limit the list to some profiles and sort it by newest, oldest, name or number of changes.
- A Review button in the status bar shows the pending count. Click it to open the page. Right-click it to pick the notification mode.
- New changes show a popup with an Open button or light up the Review button, as you choose. Nothing opens the page by itself.
- Settings live under Settings > Plugins > Skill Review.

### Library

Two buttons under the page title, Pending N and Library, switch what the page shows. Pending is the review list above.

- Library lists the default profile and every named profile, minus the profiles you hid in the settings. Each profile has three groups: Identity (`SOUL.md`, `PROJECT.md`, `AGENTS.md`, each when it exists in the profile folder), Memory (`MEMORY.md`, `USER.md`) and Skills (each skill folder with its `SKILL.md` and the text files under `references/`, `templates/`, `scripts/` and `assets/`). Library lists only files inside the profile folder: skills in external skill folders from `skills.external_dirs` are not listed, and a file is left out when any part of its path below the profile folder is a symlink.
- Every profile, skill and file row shows how many pending changes it has. Pending changes to files that are not in the library, such as a new skill or a skill in an external skill folder, are listed under "Only in Pending" and open in Pending. The counts add up to the Pending total.
- The search box filters by file, skill or profile name.
- Selecting a file opens it in an editor with line numbers. Save writes the text straight to the file, with no staging. Revert puts back the text you opened. A file with unsaved text has a blue dot in the list, and switching to another file or to Pending asks before it drops the text.
- If the file has pending changes, a link above the editor opens them in Pending.
- Save refuses if the file changed on disk since you opened it, and offers Reload. Reload replaces your text with the file as it is now.
- Save runs the checks Hermes runs on its own writes and refuses with Hermes's reason if one fails. Your text stays in the editor. For `MEMORY.md` and `USER.md` that is `memory.memory_enabled` or `memory.user_profile_enabled`, the profile's `memory.memory_char_limit` or `memory.user_char_limit`, and the memory threat scan on new or changed entries. For skill files it is the 100,000-character limit, for `SKILL.md` a valid frontmatter with `name` and `description` and a description of at most 60 characters, and the Skills Guard scan when `skills.guard_agent_created` is on. Identity files can be at most 200,000 characters.
- Pending changes to a file you saved are checked again, and the review list marks the ones that no longer apply as stale.

## Requirements

- Hermes 0.23.2 or newer, with Hermes Desktop.
- Library mode needs a backend on Linux or macOS. It opens files through folder handles without following symlinks, which Windows does not offer, so there the Library view shows that message and lists nothing. Pending works on every system.
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

`desktop/plugin.js` asks the backend for the pending list every 3 seconds through `ctx.rest`. It draws the page, its sidebar row, the Review button and the settings page.

Accepting a block takes Hermes's pending-queue lock, cuts that operation out of its record and applies it with the same code as `/skills approve` and `/memory approve`. If Hermes refuses to apply it, the record stays as it was. Rejecting drops the operation from its record, and a record with no operations left is deleted.

Library uses `GET /library` for the tree and `GET` and `PUT /library/<profile>/<key>` for one file. The key is an opaque value the backend builds; on every request the backend lists the files it allows for that profile again and looks the key up there, so the Desktop half never sends a path. A file is on that list only when it is inside the profile folder, no part of its path below that folder is a symlink, and, for a skill file, it is inside its own skill folder.

Every read and save opens the file's folder from the profile folder one path part at a time without following symlinks, then opens the file without following a symlink and without waiting on a FIFO. It refuses anything that is not a regular file, a file with a second hard link and a file over 1 MB, judged on the opened file. A symlink swapped in anywhere on the path after the lookup makes that open fail, so a read never returns an outside file and a save never writes through a link.

A save holds the memory store's file lock for `MEMORY.md` and `USER.md` or Hermes's per-skill lock for skill files, looks the key up again, reads the file and notes its folder and file identity. It compares the SHA-256 of the file's bytes with the one from when you opened it and runs Hermes's checks. Then it opens the folder again the same way and writes only if the folder and the file are the same ones it read (or the file is still absent). It writes a temporary file in that folder, gives it the old file's permissions and, where the system allows it, the old file's owner and group, flushes it to disk and renames it over the file, both relative to the opened folder, so the text lands in the folder that was checked. A process that does not take these locks and rewrites the file in place in the moment between that last check and the rename can still lose its change, as with any edit of a shared file. A skill file save is recorded in Hermes's skill audit ledger with actor `user`, as `skill_manage` records its own writes.

The diff marks a block stale when its file changed so that the change no longer applies, and marks a conflict when it overlaps another pending block. Accept all works through the file's blocks in staged order, checks each one again against the file on disk, and skips stale and conflicting blocks with a reason.

## Disclosure

- No network calls. The Desktop half talks only to the Hermes backend it runs against, through `ctx.rest`. The backend makes no outgoing connections.
- No telemetry and no usage reporting.
- No credentials. The plugin reads no secrets, tokens or `.env` files.
- No tools, hooks, shell commands or background processes. The Python `register()` does nothing.
- It reads pending records under `<HERMES_HOME>/pending/` and, for the default profile and every profile under `<HERMES_HOME>/profiles/`, each profile's `MEMORY.md`, `USER.md` and `SKILL.md` files. If you set external skill folders in Hermes, it reads `SKILL.md` files there too.
- Library also reads each profile's `SOUL.md`, `PROJECT.md` and `AGENTS.md` and the supporting files of every skill in the profile's own skills folder. It does not read or write external skill folders.
- On Save in Library, the plugin writes that one file itself: `SOUL.md`, `PROJECT.md`, `AGENTS.md`, `MEMORY.md`, `USER.md`, a `SKILL.md` or a skill's supporting file in the profile's own skills folder. It writes nothing else, and only after you press Save, apart from Hermes's own bookkeeping for a skill save: Hermes's skill audit ledger (`skills/.curator_ledger.jsonl` and its copies under `.curator_backups/blobs/`) records the change when `skills.ledger` is on, as it does for every skill write. It creates `MEMORY.md` or `USER.md` when you save one that did not exist. To serialise saves across Hermes processes it holds a lock file at `<profile>/pending/.skill-review-library.lock`.
- It writes pending records: rejecting a block removes it from its record, and an edit or Remove entirely rewrites it.
- On Accept, Hermes's own approval code writes the change to the profile's skill or memory files, the same as `/skills approve` or `/memory approve`.
- Editing a skill change, and saving a skill file in Library, runs Hermes's content scan on a copy of the file in a temporary folder, which is deleted right after.
- The backend keeps an in-memory cache of up to 512 diff results. Nothing is cached on disk.
- The Desktop half stores its settings in Desktop plugin storage: notification mode, shown profiles, sort order, which changes it already announced and when you last opened each file.

## Known limits

- The review page takes the main area while it is open, as Memory Wiki and Kanban do. Pick a chat in the sidebar to go back.
- After an update, reload Desktop and restart the backend before the new version runs.
- Word highlights stop at 2,500 tokens per line and 4,000,000 comparison cells per line pair (16,000,000 per block). Longer lines are tinted without word marks. Diffs themselves are not truncated.
- An edit can be at most 100,000 characters, and Hermes's own size limit for the file still applies.
- Remove entirely handles single-line memory entries only, and refuses if the entry appears more than once in the file.
- Library opens UTF-8 text files of at most 1 MB. It lists supporting files only under `references/`, `templates/`, `scripts/` and `assets/`, and leaves out files that are not UTF-8 text.
- The Library editor does not wrap lines. A long line scrolls sideways.
- Once you edit a file with Windows line endings in Library, it is saved with Unix line endings, because the browser's text box turns every line ending into a line feed.
- The profile picker in the settings lists only profiles with pending changes, so a profile with none cannot be hidden from Library.
- The Skills Guard scan on a Library save sees only the file you save, not the rest of the skill folder, the same as when you edit a proposed change.
- Closing or reloading Desktop with unsaved text in Library does not ask first. The Desktop plugin SDK has no hook for that; only switching files, switching to Pending and Back ask.
- Library leaves out a file that has a second hard link, and refuses one that gains a link after the list was read. It leaves out a file reached through a symlink, even one that points inside the profile folder. A skill whose `SKILL.md` is left out this way is left out whole, with its other files.
- Library writes files directly. A Hermes process that holds a file's text in memory, such as a running chat with `SOUL.md` already in its prompt, sees the new text only when it reads the file again.

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
