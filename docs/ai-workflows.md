# AI workflows

The browser never talks directly to a provider:

```text
feature → src/ai.ts → /api → src/server → provider
```

Language-sensitive calls carry a validated `LanguageId`; the server resolves
generation, tutor, recap, image, and pronunciation guidance from
`src/languages.ts`.

| Operation | Owner |
| --- | --- |
| Complete story planning, manuscript, logic check, proofreading, semantic split, visual plan | `src/server/openingsStore.ts`, `src/reading_story/`, `src/story.ts` |
| Section narration and images | `src/story_session/readingMedia.ts`, `src/server/storyAudioStore.ts`, `src/server/images/` |
| Contextual word glosses and pronunciation | `src/server/aiEndpointHandlers.ts`, `src/server/wordAudioStore.ts` |
| Story recap | `src/storyRecap.ts` and `src/story_session/` |
| Next-story brief and anti-repetition record | `src/server/nextStoryBriefService.ts`, `src/server/storyFinalizationService.ts` |
| Tutor chat | `src/exercise_screen/chatbot/LanguageChatModal.tsx` and `src/ai.ts` |

The whole manuscript is generated before reading begins. Advancing sections
never generates prose. On finish, one idempotent record at
`stories/<language>/<id>/finish-evidence.json` binds the evidence and successor brief;
reopening an old story cannot revise that handoff.

Translation/audio files and in-flight media work are cached. Cache hits do not
call a provider. Enable `AI_CALL_LOG=1` to trace real provider calls, with the
provider's token usage, to `logs/ai-calls.ndjson` (or `AI_CALL_LOG_PATH`);
`AI_CALL_LOG_PAYLOAD=full` includes full prompts and learner content and should
be handled as private data. The log is emptied when the server starts, which
under `tsx watch` means on every source edit; set `AI_CALL_LOG_APPEND=1` to keep
it across restarts.

Every generated reading story also keeps `generation.json` beside its media:
the plot draft and reviewed plot, the draft manuscript, and each logic-check
and proofreading edit, proposed and applied. `npm run story:show -- <story-id>`
prints it, so a flaw in a finished story can be traced to the pass that
introduced or missed it.

## Reading a chain of stories in the real app

Try prompt and model changes with `npm run story:chain` first: it runs the
same text pipeline, including the image-scene plans, for a few cents a story
and spends no image or TTS quota. Use the real app once the text is right, to
judge the images and the finished experience.

`npm run story:drive` reads a chain of stories end to end in a real browser as
one simulated learner, including narration, images, the recap, and the
difficulty rating that steers the next story:

```bash
npm run story:drive -- --base http://localhost:5174 --language german \
  --feedback tooEasy,tooEasy,tooHard,right --out .artifacts/chain-a
```

The browser profile under `--out` is the learner, so a rerun with the same
`--out` continues the chain. Run it against a separate dev instance started
with `AI_RATE_LIMIT_ENABLED=false`: the per-minute provider limit otherwise
stalls the chain. Each story spends real image and TTS quota; Gemini TTS on
Tier 1 allows 100 requests a day, and word-audio prewarming spends most of
them.

## Comparing manuscript models

The text-model evaluator calls the production manuscript prompt and parser with
fixed reviewed plots. It deliberately excludes plot drafting, splitting, visual
planning, and handoff generation so every candidate receives the same authoring
input. Use the chain runner separately to test adaptation across stories.
The evaluator records an invalid initial response as a failure instead of using
the production repair model, so a candidate cannot be rescued by another model.

Validate a small run without spending API credits:

```bash
npm run model:compare -- --smoke --dry-run
```

Run the default GPT-5.6 Luna, GPT-6 Luna, and GPT-6 Sol comparison:

```bash
npm run model:compare -- --smoke
```

A full run covers every language and fixture twice. Narrow it with
`--candidates`, `--languages`, `--fixtures`, or `--repeats`. Candidate values
use `model:reasoning` syntax. Pass `--no-judge` for deterministic checks only.
Pass `--output <existing-directory>` to resume a partially completed run.

Each run writes its manifest, raw generations, cached anonymous judgments,
scores, Markdown summary, and a model-blinded human review sheet under
`.artifacts/model-comparison/`. Pricing is a checked-in estimate recorded in the
manifest; confirm current provider pricing before using cost rankings for a
production decision.
