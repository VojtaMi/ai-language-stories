# Container deployment

The production app is [stories.vmikel.eu](https://stories.vmikel.eu). Its
multi-service hosting, routing, and deployment procedure are owned by the
separate private `vmikel-platform` repository. This public repository owns
only the language application's container and runtime contract.

## Image

[`Dockerfile`](./Dockerfile) builds both the browser and server bundles,
installs native production dependencies such as `sharp`, and starts
`server.mjs` on port 80.

Build it from the repository root:

```bash
docker build -f rosti/Dockerfile -t language-stories .
```

[`docker-compose.yml`](./docker-compose.yml) is a generic standalone example
for local or independent hosting. It is not the production Compose topology.

## Configuration

The container accepts these environment variables:

- `OPENAI_API_KEY` is required for the default setup.
- `GEMINI_API_KEY` optionally enables Gemini text and speech models.
- `ANTHROPIC_API_KEY` is needed only when a Claude model is selected.
- `PORT` defaults to 80.
- `AI_RATE_LIMIT_ENABLED` defaults to `true`.
- `AI_RATE_LIMIT_PER_MINUTE` defaults to 10 provider-backed requests per IP.
- `AI_STORY_PREPARATION_LIMIT_PER_DAY` defaults to 10 full reading-story
  preparations per IP.
- `AI_RATE_LIMIT_OWNER_TOKEN` optionally defines a private token that bypasses
  the daily story limit. It does not bypass the per-minute burst limit.
- `AI_RATE_LIMIT_TRUST_PROXY` defaults to `false`. Set it to `true` only when
  the app is behind a reverse proxy that replaces `X-Forwarded-For` with the
  real client address.

Values belong in the hosting environment or an ignored local environment file,
never in this repository. Without Gemini, narration and pronunciation fall
back to OpenAI TTS. Background images use OpenAI in the normal app flow.

## Persistence

Saved stories and reading progress live in each browser profile's IndexedDB.
They do not need a server volume.

The server writes generated media, prepared stories, learner adaptation state,
and provider-call caches beneath its working directory. The standalone Compose
example gives those paths named volumes. A platform deployment should provide
equivalent persistent mounts. See
[`../docs/local-data.md`](../docs/local-data.md) for the complete data model.

## Public deployment

The server applies a small in-memory abuse guard to provider-backed endpoints.
It is intentionally not an account quota or a durable billing control: counters
reset when the process restarts, so provider-side prepaid credits and spending
limits remain the hard cost ceiling.

To enable owner access in one browser, set the configured token from that
site's developer console. The token stays in that browser's localStorage:

```js
localStorage.setItem("language-stories.owner-token", "YOUR_PRIVATE_TOKEN")
```

Concrete infrastructure identifiers, server paths, Traefik configuration, SSH
commands, and service-specific deployment procedures belong in the private
`vmikel-platform` repository rather than here.
