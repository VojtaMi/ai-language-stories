---
name: language-addition
description: Add a curated learning language to this app, including registry guidance, generated visual assets, AVIF conversion, validation, and browser verification.
---

# Add a language

Use this skill when adding a new curated language to the application. This is
a product and pedagogy change, not a translation-only change. Keep the
interface in English and do not add deployment changes unless requested.

## Establish the language

Before editing, establish:

- a lowercase ASCII language ID, English label, and 2–4 letter uppercase code;
- beginner grammar priorities and constructions to avoid;
- a natural target-language recap title; and
- at least one absolute-beginner calibration passage.

Do not copy another language's grammar guidance and merely replace its name.
If these choices cannot be made responsibly, ask the user for direction.

## Implement the registry entry

Add one complete entry to `src/languages.ts` with the current fields:

```ts
{
  id: "language-id",
  label: "Language",
  shortCode: "XX",
  teachingTopics: "...",
  absoluteBeginnerGuidance: "...",
  grammarInvariants: "...",
  starterFocus: "...",
  calibrationSnippets: ["..."],
  recapTitle: "...",
}
```

Keep language-specific pedagogy in the registry. Shared prompts, TTS wording,
starter briefs, and asset URLs are derived by the application; do not create a
parallel language-specific application or add derived fields to the entry.

## Create and optimize assets

Add a wide story-poster source and a square transparent-background bot source:

- `assets/language-images/<id>-story-hero.png` — normally 1672×941;
- `assets/language-images/<id>-story-bot.png` — normally 1254×1254 with real
  alpha transparency;
- `public/favicon-<id>.svg` — transparent, simple, and legible at tab size.

When available, use the native Codex `imagegen` skill to create and visually
iterate the source PNGs. The asset workflow must not depend on that tool,
though: an API-generated or user-provided PNG is also acceptable when the
language is added outside Codex.

Convert the source PNGs into the served AVIF files:

```bash
npm run images:optimize
```

The script preserves dimensions, keeps bot alpha, and writes the AVIF files to
`public/images/`. Inspect the actual source and output files; a bot that only
looks transparent but has an opaque background will render as a square.

## Finish and verify

Add focused tests only for language rules that are important or unusual. Update
the language list and query example in `README.md`. Search for language-specific
exceptions with:

```bash
rg -n 'esperanto|german|spanish|dutch' src scripts tests README.md docs
```

Run:

```bash
npm run language:validate -- <language-id>
npm run check
```

With provider credentials, optionally generate one smoke-test story and read it
for target-language quality, level, grammar, natural names, and English
metadata. Render `http://localhost:5173/<language-id>` in the existing dev
server and verify the selector, title, favicon, AVIF poster, and AVIF bot.

Before handoff, confirm that all three derived asset paths exist, the bot source
has alpha transparency, deterministic checks pass, and no deployment files or
production caches were changed.
