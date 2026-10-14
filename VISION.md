# Story-Based Language Learning Vision

This project is evolving from an AI typing-practice story app into a
story-based language learning app. The core loop is already in place: short
Esperanto reading stories, typing practice, narration, images, local saves,
word translation/audio popovers, and the Esperanto Bot tutor.

The product direction is guided story practice, not a generic flashcard deck. A
learner should see and hear language in context, ask questions when confused,
practice what they saw, and then get future stories that reuse what is becoming
familiar while gently stretching one step further.

Esperanto is the first prototype language because its regular grammar and
predictable word forms make the learning loop easier to prove before adding
languages with heavier early grammar.

## Current Learning Model

The app has a lightweight learner model for adaptive reading:

- `learner/profile.md` stores a bounded, human-readable learner handout with
  four sections: **Confident**, **Currently learning (their edge)**,
  **Shaky / watch for**, and **Recently practiced**.
- The seed profile treats the learner as a complete beginner, preserving the
  original day-one behavior.
- When the Esperanto Bot chat closes, the transcript is folded into the profile
  as evidence about confident, current-edge, and shaky vocabulary/grammar.
- Reading story generation receives the profile as a ceiling and target: reuse
  known material, stretch into currently-learning material, and avoid exceeding
  the learner's edge.
- Clicking a word in the reader logs `{ "word", "timestamp" }` to
  `learner/word-log.json` as raw evidence that the word needed inspection.

This is deliberately smaller than a full curriculum engine. The profile is the
LLM-facing summary; the word log is raw evidence. Both are per-learner
files.

Finishing a reading story now closes with two steps:

1. **Recap practice** ("Eta praktiko") — a short, auto-generated lesson drawn
   from the story just read, always three exercises: word-connect,
   fill-missing-word, and a comprehension question. It currently blocks
   progression until completed (a "Skip recap" escape hatch only appears if
   generation fails). Each exercise tracks how many attempts it took to answer
   correctly (1 = first try). On completion, these results are folded into the
   learner profile the same way chat transcripts and word lookups are: a
   first-try-correct answer is stronger evidence of real command than a mere
   lookup and can promote a word out of "Shaky / watch for" toward "Confident";
   an item that took several attempts reinforces it as shaky, even if it was
   never separately clicked or asked about.
2. **Completion screen** — a congratulations message, a gallery of the images
   generated across the story's parts, and the existing difficulty feedback
   form (five-point scale plus optional note), kept inline rather than in a
   separate modal.

## Near-Term Shape

The prose profile should stay concise and derived. It should not become an
unbounded diary or a substitute for structured state. It answers one immediate
question: "What should the next reading story assume this learner knows?"

The word log should remain append-only for now. Repeated clicks can later be
aggregated into the profile, for example "recently looked up several times:
`havas`, `iras`, `mia`." A single click is weak evidence; repeated clicks across
stories are stronger.

The next useful refinement is a small scoring layer on top of the log:

- clicked word: possible recognition gap
- correctly typed or answered later: increase familiarity
- repeated correct use: mark familiar enough to stop surfacing as shaky
- repeated lookup or mistake: keep in review

That scoring layer can be added without changing the current profile format.
Recap exercise results are now one input to it (see Current Learning Model
above): first-try-correct vs. multi-attempt is itself a small score per word,
even before a structured scoring layer exists.

Two follow-ups on top of the current recap feedback loop:

- Recap word-connect pairs now prefer the words the learner looked up while
  reading that story, so a first-try match is direct evidence about a word that
  needed help. It does not yet reach back to shaky words from earlier stories.
- A possible branch on recap outcome: on an all-correct recap, offer an
  optional stretch round pulling from "Currently learning (their edge)"; on a
  missed item, offer optional remediation on that specific word. Neither
  exists yet — recap today is always the same fixed three exercises.

Open question on the recap/completion flow: whether recap should ever be
skippable on success (not just on generation failure).

## Future Curriculum Model

If the app needs more precise control, add structured state beneath the prose
profile rather than replacing the profile immediately:

- Word/concept registry: lemma, translation, examples, status, score.
- Evidence log: clicked words, chat questions, typing mistakes, correct answers.
- Review scheduling: weak, known, review due, retired/familiar.
- Lesson content: introduced words, target sentences, story text, exercises.

The prose profile can then be regenerated from the structured evidence and used
only as compact context for story generation.

### Reading focus: from per-story handoff toward curriculum progression

The near-term step for reading adaptation is a per-story *focus handoff*: a
finished story hands the next one a single grammar focus and a pace nudge,
chosen at finalization from that story's recap performance and difficulty
feedback. It advances the focus when the concept was handled cleanly and
reinforces it (with a different construction) when it was not. This is
deliberately pragmatic and reversible — a wrong advance simply self-corrects on
the next story — so it needs no concept taxonomy or scoring to be useful, and it
replaces the previously LLM-guessed difficulty level with a pure feedback nudge.

The deterministic evolution is to anchor that focus selection to an explicit,
ordered grammar-concept curriculum rather than an ad-hoc per-story choice. The
lesson system already defines identified concepts (`GrammarConcept.id`); as a
learner completes lessons, that progress can be stored in the learner model as a
derived level and a set of known/unlocked concepts. Reading focus then becomes
"advance along the known curriculum order, gated by recap performance," with the
AI reduced to the pass/fail read and the prose itself — consistent with the AI
Boundary below. Dropping the LLM-guessed level in the handoff step is not in
tension with this: a future level would be *derived* from lesson completion, not
guessed. This direction is gated on the lesson curriculum being filled in (not
all lessons are implemented yet); until then, the per-story handoff is the
working mechanism, and it is a stepping stone toward the curriculum-anchored
version rather than a detour from it.

## Exercise Direction

Exercise types in use or planned:

- Type-over practice using the existing typing exercise.
- Multiple-choice comprehension questions.
- Fill-the-missing-word exercises.
- Word-connect (match term to meaning).
- Reading popovers for translation and word audio.
- Later, AI-generated variants constrained to known vocabulary and unlocked
  grammar, beyond the current fixed three-exercise recap.

Exercise selection can be flexible, but it should respect the learner model:
known words should dominate, weak words should reappear, and new material should
arrive slowly.

Today, dedicated exercise sessions (typing story, reading story) and the
per-story recap are separate surfaces. Letting exercises appear dynamically
within a story's parts, rather than only at typing sessions and story-end, is
still a future step.

## AI Boundary

AI should remain a constrained content generator, not the curriculum itself.

The current adaptive-reading loop is acceptable because it is bounded: a small
profile, local files, explicit prompt guardrails, and beginner-oriented story
constraints. Future structured scoring should make the system more reliable,
not more magical.

Generated beginner content should keep being validated by shape and constrained
by vocabulary/grammar guidance before it reaches the learner.
