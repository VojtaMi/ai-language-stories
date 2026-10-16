# Dialogue narration: current design and next direction

Reading stories voice direct speech with a separate Gemini voice per
character. This note records how that works today, a weakness in it, and an
experimentally validated direction for fixing it later.

## Current design

- The manuscript author encloses spoken lines in the language's quotation pair
  (`dialogueQuotes` in `src/languages.ts`) and returns `characters` (name plus
  coarse `voiceType`) and one `{speaker, delivery}` entry per quotation, in
  order. Code validates the count against the quotations in the text
  (`src/reading_story/dialogue.ts`).
- When a section is narrated with a Gemini model, `dialogueTurns` cuts it into
  narrator and character turns and `groupSpeechTurns` packs consecutive turns
  into requests of at most two voices. Each request goes to the Gemini
  Interactions API; the audio is joined with 300 ms gaps
  (`src/server/tts/geminiDialogueTts.ts`).
- Each request's measured duration and text range are saved beside the
  recording (`*.wav.segments.json`) so highlighting is estimated inside each
  segment rather than across the whole section.
- OpenAI narration stays single-voice.

## The weakness

A multi-speaker request accepts **exactly two** speakers. Sending three
returns HTTP 400: `speaker_voice_configs: the number of speaker_voice_configs
must equal 2`.

So a section with the narrator and two characters is split into several
requests, and the narrator appears in more than one of them. Each request is
a separate generation, so the same prebuilt voice can sound noticeably
different at the start and end of one section. The number of requests also
grows with every change of speaker:

| Section turns | Requests today |
| --- | --- |
| N · Lidia · N · Marko · N | 2: `[N Lidia N]` `[Marko N]` |
| N · Ben · N · Anna · N · Ben · N | 3: `[N Ben N]` `[Anna N]` `[Ben N]` |

## Direction: pair request plus inserted characters

Only for sections with three or more voices:

1. **Pair request:** the narrator and the character with the most lines in the
   section, in story order, as one multi-speaker request. Wherever another
   character speaks, its line is left out and `<long pause>` is appended to
   the preceding turn's text.
2. **Inserted characters:** one single-voice request per remaining character,
   with all of that character's lines in the section joined by
   `<long pause>`.
3. **Assembly:** cut the pair recording at its `k` longest internal silences
   (`k` = number of inserted lines), cut each inserted recording the same way,
   trim silence from every piece, and interleave the pieces in story order with
   short fixed gaps. Every piece becomes a highlighting segment.

The narrator then comes from a single request, and the request count no
longer depends on how often speakers alternate: one request for the narrator
plus the first character, plus one per additional character.

| Section turns | Today | Pair plus insert |
| --- | --- | --- |
| N · Lidia · N · Marko · N | 2 | 2: `[N + Lidia, pause]` `[Marko]` |
| N · Ben · N · Anna · N · Ben · N | 3 | 2: `[N + Ben, pause]` `[Anna]` |

Sections with at most two voices keep today's single request.

### Safeguard

If the `k` longest silences are not clearly longer than every other silence,
or the pieces cannot be cut, synthesize that section with today's grouping
instead. This also catches the model speaking during a pause.

## Experimental evidence

All runs used one Esperanto section ("Tiam fiŝkaptisto nomata Marko venas el
la maro… «Ĉu vi serĉas ĉi tion?» demandas Lidia. «Jes. Tiu ŝlosilo…»
respondas Marko… Lidia donas al li la ŝlosilon.") on `gemini-3.8-flash-tts`,
checked with a Gemini transcription that labels voices and timestamps.

| Experiment | Result |
| --- | --- |
| Three speakers in one multi-speaker request | HTTP 400; exactly two speakers are required. |
| Narrator alone, all passages in one text joined by `<long pause>` | Read verbatim. Pauses between passages were 1.9 s and 6.6 s; longest other silence 0.9 s. Cuts landed correctly. |
| Narrator alone, each passage as a separate text item | Unusable: the model **invented the missing dialogue** between items ("Kio estas la demando?", "Mi serĉas ŝlemon"). |
| Pair request (narrator + Lidia) with `<long pause>` where Marko speaks, Marko inserted | Correct order and text. Pause stayed silent at 2.0 s; longest other silence 0.78 s. 2 requests. |

Notes:

- `<long pause>` length varies widely between runs (1.9 s to 6.6 s), so it
  serves only as a cut marker; the assembled audio uses its own gaps.
- Never give the narrator's passages as separate text items with nothing
  between them; that invites invented speech.
- These are single runs on one section. Before adopting the direction, repeat
  it on two or three more three-voice sections and in German.

## Related constraints

- **Quota.** At Tier 1, each Gemini TTS model allows 10 requests per minute
  and 100 per day, per project. AI Studio shows Tier 2 (reached after $100
  of cumulative spend) at 1,000 per minute and 10,000 per day. Every model has
  its own quota, so falling back to another Gemini TTS model when one is
  exhausted roughly triples daily capacity.
- **Language.** Gemini TTS does not officially support Esperanto or Latin and
  detects the language itself. Short fragments were sometimes translated into
  English until every instruction named the language and forbade translation
  (`languageTtsInstructions`). Longer requests, as in the pair request, give
  the model more context.
- **Whole-story narration.** The same per-voice idea applied to an entire
  story (one narrator request, one per character) would need about 3 to 4
  requests per story instead of 8 to 12, but it means narrating every section
  during preparation, adding time and cost for sections nobody reads.
