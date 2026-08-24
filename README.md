# Language stories

An AI reading-practice app for Esperanto, German, Spanish, Dutch, and Finnish. Choose the
learning language on the main menu, read a finite illustrated and narrated
story, tap unfamiliar words, and finish with a short recap.

The interface is currently English. Language selection is window-specific via
`?language=esperanto|german|spanish|dutch|finnish`, while the most recently selected
language is remembered locally for the next unqualified home visit. Explicit
`prefer` and `avoid` story settings are shared; stories, preparation queues,
evidence, pronunciation caches, and progression remain language-specific.

## How it works

1. The menu prepares one complete story for the selected language.
2. Starting consumes that prepared story. No prose is generated while reading.
3. Narration and alternating illustrations are prepared section by section.
4. Word taps provide contextual English glosses and pronunciation.
5. A recap and optional feedback produce the brief for the next story.

Language identity and generation guidance live in the registry at
[`src/languages.ts`](./src/languages.ts). Adding another language is primarily a
registry-and-assets change. Shared code derives generic prompts, speech
instructions, starter defaults, and asset paths. Follow the coding-agent
workflow in [`docs/adding-a-language.md`](./docs/adding-a-language.md).

## Development

```bash
npm install
echo 'OPENAI_API_KEY=sk-...' > .env.local
npm run dev
npm run check
```

The development server runs the API on port 3001 and Vite on its normal port.
Provider keys stay server-side. `ANTHROPIC_API_KEY` is needed for Claude models;
`GEMINI_API_KEY` is needed for Gemini and single-word pronunciation.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and browser app. |
| `npm run build` | Type-check and build client and server. |
| `npm run check` | Run build, lint, and all deterministic tests. |
| `npm run language:validate -- finnish` | Validate Finnish registry fields, assets, and storage IDs. |
| `npm run story:generate -- --language dutch` | Generate one complete story through the real provider pipeline. |
| `npm run story:chain` | Simulate a sequence of stories and handoffs. |
| `npm run verify:page -- <url>` | Render a page in a real browser and fail on runtime errors. |

Provider-backed scripts can cost money and are not part of `npm run check`.
Local saves and generated media are plain files grouped under
`stories/<language>/`; see
[`docs/local-data.md`](./docs/local-data.md). AI call ownership and caching are
described in [`docs/ai-workflows.md`](./docs/ai-workflows.md).

This worktree is local-only. Deployment configuration under `rosti/` is
unchanged.
