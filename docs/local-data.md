# Local data

Server runtime data is plain, git-ignored JSON and media. Saved stories and
reading progress are now browser-local IndexedDB records, scoped to the
browser profile that created them.

| Path | Contents and language scope |
| --- | --- |
| `stories/<language>/<id>/` | Server-side generated media and finish evidence used by the preparation/finalization pipeline. These are not browser save records. |
| `reading-openings/<genreId>.json` | One prepared complete story per language. |
| `word-audio/<genreId>/` | Language-specific pronunciation cache. |
| `story-images/`, `story-audio/` | Legacy media location for older ids. |
| `learner/state.json` | Shared explicit `prefer` and `avoid` settings plus language-tagged anti-repetition memory. |
| `learner/word-log.json` | Story-scoped word evidence; story ids bind it to one language's progression chain. |
| `logs/`, `.artifacts/` | Optional traces and development output. |

The browser stores `last-learning-language` plus saved stories in the
`language-story-reader` IndexedDB database. Routes such as
`/german/story/<story-id>` are local references: another browser profile or a
cleared database cannot load the story from that URL.

Deleting browser IndexedDB deletes that browser profile's saved stories and
reading progress. Deleting server caches is safe but can cause paid
regeneration; deleting `stories/` or `learner/` also discards progression
evidence or settings. AI trace logs can contain complete learner content when
full payload logging is enabled and must remain untracked.
