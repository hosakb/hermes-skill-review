// Fixtures that follow backend contract v1 for /files and /files/.../diff. The text is invented,
// shaped like real staged writes (memory batches with add/replace/remove, skill patches, a new skill).

export const T0 = 1795000000 // staged_at values are Unix seconds, like created_at

const counts = (total, pending, stale = 0, conflict = 0) => ({ total, pending, stale, conflict })

export const MEMORY_FILE = {
  key: 'bWVtb3J5L01FTU9SWS5tZA',
  profile: 'dev',
  subsystem: 'memory',
  file: 'MEMORY.md',
  counts: counts(3, 3),
  latest_staged_at: T0 + 300
}

export const USER_FILE = {
  key: 'bWVtb3J5L1VTRVIubWQ',
  profile: 'dev',
  subsystem: 'memory',
  file: 'USER.md',
  counts: counts(1, 1),
  latest_staged_at: T0 + 50
}

export const SKILL_FILE = {
  key: 'c2tpbGxzL2NvdW5jaWwvU0tJTEwubWQ',
  profile: 'dev',
  subsystem: 'skills',
  file: 'council/SKILL.md',
  counts: counts(3, 1, 1, 1),
  latest_staged_at: T0 + 200
}

export const NEW_SKILL_FILE = {
  key: 'c2tpbGxzL3JlbGVhc2Utbm90ZXMvU0tJTEwubWQ',
  profile: 'ops',
  subsystem: 'skills',
  file: 'release-notes/SKILL.md',
  counts: counts(1, 1),
  latest_staged_at: T0 + 10
}

// A slash in a key or profile must survive as one path segment.
export const ODD_FILE = { ...USER_FILE, key: 'a/b c', profile: 'my profile' }

export const FILES = {
  files: [MEMORY_FILE, USER_FILE, SKILL_FILE, NEW_SKILL_FILE],
  profile_errors: [{ profile: 'broken', error: 'pending/ is not readable' }]
}

const block = fields => ({
  record_id: 'r0',
  op_index: 0,
  state: 'pending',
  staged_at: T0,
  origin: 'background_review',
  summary: '',
  reason: null,
  conflicts_with: null,
  can_accept: true,
  removed: [],
  added: [],
  ...fields
})

// MEMORY.md: a replace, an add at the end and a remove, from two staged records.
export const MEMORY_DIFF = {
  status: 'ok',
  file: MEMORY_FILE,
  segments: [
    { type: 'context', lines: [{ no: 1, text: 'The test suite runs with `pytest -q` from the repo root.' }, { no: 2, text: '§' }] },
    {
      type: 'block',
      block: block({
        id: 'r1-0',
        record_id: 'r1',
        staged_at: T0 + 100,
        summary: 'replace: deploy host',
        removed: [{ no: 3, text: 'Deploys go to the staging box first.' }],
        added: [{ no: 3, text: 'Deploys go to staging first, then production after a smoke test.' }]
      })
    },
    { type: 'context', lines: [{ no: 4, text: '§' }] },
    {
      type: 'block',
      block: block({
        id: 'r1-1',
        record_id: 'r1',
        op_index: 1,
        staged_at: T0 + 100,
        summary: 'remove: old editor note',
        removed: [{ no: 5, text: 'Prefers tabs over spaces in Makefiles only.' }, { no: 6, text: '§' }]
      })
    },
    { type: 'context', lines: [{ no: 7, text: 'Release notes are written in sentence case.' }] },
    {
      type: 'block',
      block: block({
        id: 'r2-0',
        record_id: 'r2',
        staged_at: T0 + 300,
        origin: 'chat',
        summary: 'add: commit style',
        added: [{ no: 8, text: '§' }, { no: 9, text: 'Commit messages use the imperative mood.' }]
      })
    }
  ]
}

// council/SKILL.md: a pending patch, a stale patch whose anchor text is gone, and a patch that
// overlaps the first one.
export const SKILL_DIFF = {
  status: 'ok',
  file: SKILL_FILE,
  segments: [
    { type: 'context', lines: [{ no: 1, text: '---' }, { no: 2, text: 'name: council' }, { no: 3, text: '---' }] },
    {
      type: 'block',
      block: block({
        id: 'p1-0',
        record_id: 'p1',
        staged_at: T0 + 200,
        summary: 'patch: reviewer count',
        removed: [{ no: 4, text: 'Spawn three reviewers.' }],
        added: [{ no: 4, text: 'Spawn three reviewers, each with a different lens.' }]
      })
    },
    {
      type: 'block',
      block: block({
        id: 'p2-0',
        record_id: 'p2',
        staged_at: T0 + 150,
        state: 'conflict',
        conflicts_with: 'p1-0',
        summary: 'patch: reviewer count again',
        removed: [{ no: 4, text: 'Spawn three reviewers.' }],
        added: [{ no: 4, text: 'Spawn four reviewers.' }]
      })
    },
    { type: 'context', lines: [{ no: 5, text: 'Merge their findings into one list.' }] },
    {
      type: 'block',
      block: block({
        id: 'p3-0',
        record_id: 'p3',
        staged_at: T0 - 86400,
        state: 'stale',
        can_accept: false,
        reason: 'old_string no longer appears in the file',
        summary: 'patch: output format',
        removed: [{ no: 6, text: 'Print the list as a table.' }],
        added: [{ no: 6, text: 'Print the list as Markdown.' }]
      })
    }
  ]
}

// A new-skill create: one block, added lines only, no context.
export const CREATE_DIFF = {
  status: 'ok',
  file: NEW_SKILL_FILE,
  segments: [
    {
      type: 'block',
      block: block({
        id: 'c1-0',
        record_id: 'c1',
        staged_at: T0 + 10,
        summary: 'create skill release-notes',
        added: [
          { no: 1, text: '---' },
          { no: 2, text: 'name: release-notes' },
          { no: 3, text: '---' },
          { no: 4, text: 'Collect merged PR titles since the last tag and group them by area.' }
        ]
      })
    }
  ]
}

export const GONE = { status: 'gone' }

// The shape the write review API backend sends: each block carries its preview as `kind` and
// `text`, and `writes` carries every write's opaque `expect`, to send back unchanged.
const EXPECT_M1 = { profile: 'p', record_sha256: 'a'.repeat(64), targets: {}, review_kind: 'memory', review_id: 'm1' }
const EXPECT_M2 = { profile: 'p', record_sha256: 'b'.repeat(64), targets: {}, review_kind: 'memory', review_id: 'm2', extra: [1, { x: 2 }] }

export const API_DIFF = {
  status: 'ok',
  file: MEMORY_FILE,
  segments: [
    {
      type: 'block',
      block: block({ id: 'm1-0123456789', record_id: 'm1', staged_at: T0 + 100, summary: 'add to MEMORY.md: gamma fact',
        can_reject: true, kind: 'create', text: 'gamma fact' })
    },
    {
      type: 'block',
      block: block({ id: 'm2-aaaaaaaaaa', record_id: 'm2', staged_at: T0 + 200, summary: 'patch in MEMORY.md: ALPHA',
        can_accept: false, can_reject: false, kind: 'diff',
        reason: 'This change is one part of a write with 2 changes. Hermes accepts or rejects a write only as a whole, so use Accept all or Reject all for this file.',
        text: '--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1 +1 @@\n-alpha fact\n+ALPHA fact\n' })
    },
    {
      type: 'block',
      block: block({ id: 'm2-bbbbbbbbbb', record_id: 'm2', staged_at: T0 + 200, summary: 'remove from MEMORY.md: beta fact',
        can_accept: false, can_reject: false, kind: 'delete', text: 'beta fact',
        reason: 'This change is one part of a write with 2 changes. Hermes accepts or rejects a write only as a whole, so use Accept all or Reject all for this file.' })
    },
    {
      type: 'block',
      block: block({ id: 'm3-cccccccccc', record_id: 'm3', staged_at: T0 + 300, summary: 'create skill council', state: 'conflict',
        can_accept: false, can_reject: true, kind: 'diff', text: '', reason: "Skill 'council' already exists, so this create cannot apply." })
    }
  ],
  writes: {
    m1: { expect: EXPECT_M1, status: 'ready', reason: null, op_count: 1 },
    m2: { expect: EXPECT_M2, status: 'ready', reason: null, op_count: 2 },
    m3: { expect: null, status: 'conflict', reason: "Skill 'council' already exists, so this create cannot apply.", op_count: 1 }
  }
}
export { EXPECT_M1, EXPECT_M2 }
