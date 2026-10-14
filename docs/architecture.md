# Architecture

The app has one product workflow: finite reading stories.

```text
language registry → prepare complete story → reveal sections → recap
                  → finalize evidence → prepare the next story
```

## Responsibility areas

| Area | Owns |
| --- | --- |
| `src/languages.ts` | Language identity and pedagogy, plus shared derivation of prompts, starter defaults, speech instructions, and asset paths. |
| `src/App.tsx`, `src/languageSelection.ts` | Window-specific language selection, URL/history, document title, and top-level views. |
| `src/home_menu/` | Language switch, settings, starting/resuming stories, and current-language saves. |
| `src/story_session/` | Preparing, starting, advancing, resuming, persisting, and finalizing a story. |
| `src/exercise_screen/` | Reading, word popovers, tutor chat, recap, and feedback interactions. |
| `src/exercise_screen/story/storyPractice.css` | The recap, completion, and feedback visual system for reading-story practice. |
| `src/reading_story/`, `src/story.ts` | Whole-story generation contracts, validation, splitting, and visual plan. |
| `src/server/` | Provider calls, prepared queues, saved files, evidence, and generated media. |

The browser sends a `LanguageId` with every language-sensitive request. Server
code resolves the canonical registry entry rather than trusting browser-supplied
prompt text. Adding a language should extend that registry and provide its hero
and bot assets, without adding a parallel application.

The selected language is part of the URL (`/<language>`), so two tabs can practice different
languages. Changing it returns that tab to its menu and remounts its reading
session. Shared taste settings intentionally do not change; language-specific
stories and progression are selected or keyed by `genreId`.

## Reading lifecycle

Learner state is scoped by an anonymous learner id that the browser creates
before its first API call (`src/learnerIdentity.ts`) and the server reads from
a cookie (`src/server/learnerScope.ts`). Learner endpoints refuse requests
without one rather than falling back to shared state.

The prepared queue holds at most one complete story per language and learner. The first uses
that language's absolute-beginner starter brief. Finishing a story distills its
word lookups, tutor questions, recap, and feedback into one validated successor
brief. Story memory records include `genreId` and generation sees only matching
records.

A saved story lives in the browser's IndexedDB store and is addressed by
`/<language>/story/<story-id>`. It contains the complete manuscript and its
section cursor. Resume restores it without prose generation. The session's media owner deduplicates
narration and illustration work, seeds already-generated media, and prepares the
next section while the current one is read.

## Placement rule

- Navigation and language selection belong in `App` or `home_menu`.
- Lifecycle, persistence, and generation timing belong in `story_session`.
- Interaction mechanics belong in `exercise_screen`.
- Language differences belong in the registry unless a provider requires a
  genuinely distinct adapter.
- Provider and local-file concerns belong in `server`.
