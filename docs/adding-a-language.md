# Adding a language

This is the coding-agent workflow for adding a curated learning language. A
language is a product and pedagogy change, not a translation-only change. Keep
the interface in English and do not add deployment changes unless explicitly
requested.

## Inputs to establish

Before editing, establish:

- a lowercase ASCII language ID, such as `dutch`;
- its English display label and a 2–4 letter uppercase short code;
- beginner grammar priorities and constructions to avoid;
- a natural target-language recap title;
- at least one absolute-beginner calibration passage;
- a wide story-poster image, a square transparent-background bot image, and a
  legible SVG favicon.

If these pedagogical choices cannot be made responsibly, stop and ask for
direction. Do not copy another language's grammar guidance and merely replace
its name.

Before editing, inspect the existing registry, one or two language tests, and
the current asset dimensions/transparency. Search for language-specific code
only after the new language's rules are clear; most registry consumers are
already language-agnostic.

## Implementation

1. Add one complete entry to `src/languages.ts`. Supply only the current nine fields in
   `LanguageDefinition`: identity, teaching topics, two authoring-guidance
   fields, starter focus, calibration snippets, and recap title. Generic story
   prompts, TTS wording, starter-brief structure, and asset URLs are derived by
   shared code; do not add them to an entry. The entry shape is:

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

   Keep `teachingTopics`, authoring guidance, and starter focus specific to the
   language. The calibration text is target-language prose; the other prompt
   fields are English instructions for the models.
2. Put the assets at the paths derived from the language ID:
   `public/images/<id>-story-hero.png`,
   `public/images/<id>-story-bot.png`, and `public/favicon-<id>.svg`. Existing
   assets use 1672×941 for posters and 1254×1254 for bots. Match the established
   visual family and use a genuinely transparent bot background. Check the
   actual files before committing: a bot that merely looks transparent but has
   an opaque image background will render as a visible square. The favicon must
   match the existing family: transparent background, one solid color, and
   simple block-letter forms that remain recognizable at browser-tab size.
3. Add focused assertions to `tests/languages.test.ts` for rules that are
   important or unusual in the new language. Generic registry and asset
   invariants are already checked automatically.
4. Update the language list and example query in `README.md`.
5. Search for language-specific exceptions with
   `rg -n 'esperanto|german|spanish|dutch' src scripts tests README.md docs`. Most
   matches are examples or intentional language-specific behavior. Change only
   code that should apply to every registered language.

Do not add special vocabulary normalization unless the language requires it.
For example, Esperanto's accusative-name handling in `src/storyVocabulary.ts`
is deliberately Esperanto-only.

## Verification

Run the deterministic checks first:

```bash
npm run language:validate -- dutch
npm run check
```

The validator checks registry completeness, uniqueness, asset paths, and story
ID/storage compatibility. It does not judge language quality.

When provider credentials are available and spending a small amount is
acceptable, generate one smoke-test story:

```bash
npm run story:generate -- --language dutch --default-learner
```

Read the result rather than treating successful JSON generation as sufficient.
Check that prose is actually in the target language, character names are
natural for it, the level resembles the calibration passage, required grammar
is correct and metadata remains English.

Finally, render the main menu with the existing development server (if one is
already running) and visit `http://localhost:5173/<id>`. Verify the selector,
dynamic browser title, favicon, poster, and bot. Confirm that the selector can
switch to the new language and that a direct visit to `/<id>` loads it. If you
start a server, stop it when finished.

Before handoff, confirm that:

- the registry entry contains the current nine fields and uses a unique ID, label,
  and short code;
- all three derived asset paths exist, and the bot PNG has an alpha channel;
- the README language list and query example include the new ID;
- deterministic checks pass; and
- no deployment files or production caches were changed.
