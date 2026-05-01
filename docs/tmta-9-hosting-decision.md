# TMTA-9: Hosting decision for web access and dashboard

Date: 2026-05-01
Owner: CTO
Status: Recommended

## Executive decision

Host the v1 application on `Render` as a single Node web service, with `Supabase` continuing to own Postgres/auth and `Sentry` handling error tracking.

This repo is a long-lived `Fastify` server with inbound HTTP routes, outbound WebSocket connections to `OpenAI Realtime`, and inbound WebSocket handling for `Twilio Media Streams`. That is a better fit for a standard always-on container/web-service host than for an edge or serverless-first platform.

## Why Render is the best fit now

### Technical fit

- The current app already runs as one Node process with `pnpm build` and `pnpm start`.
- Render web services accept inbound WebSocket connections and do not impose a fixed WebSocket timeout.
- Render gives us a simple public HTTPS endpoint for Twilio webhooks and media-stream upgrades without rewriting the runtime model.
- The app already exposes `GET /health`, which fits Render health checks cleanly.

### Business fit

Cost:
- low for the first pilot

Complexity:
- low

Delivery risk:
- low, because it matches the current architecture with no platform rewrite

Expected customer impact:
- high, because it is the fastest path to getting a pilot phone number live and an internal console reachable by the team

## Platform comparison

### Render

Decision:
- choose for v1

Why:
- supports inbound WebSockets on a normal web service
- no fixed platform WebSocket duration limit
- simple Git-based deploy flow for an always-on Node app
- enough scaling headroom for the first pilot by moving to a larger instance or more instances later

Tradeoff:
- less globally distributed than an edge platform
- multi-instance scaling will require shared state discipline for any connection-bound session recovery

### Vercel

Decision:
- reject for the main voice-edge app

Why:
- Vercel Functions do not act as a WebSocket server
- the current app depends on server-side WebSocket handling for live call streaming

Tradeoff:
- good frontend platform in general, but wrong default for this realtime telephony runtime

### Cloudflare Workers

Decision:
- reject for v1

Why:
- Workers can handle WebSockets, but the runtime model is different enough that we would be signing up for a platform adaptation instead of shipping
- stateful coordination typically pushes us toward Durable Objects, which is extra architecture we do not need before pilot validation

Tradeoff:
- potentially strong global edge story later, but higher delivery risk now

### Railway

Decision:
- keep as fallback, not first choice

Why:
- Railway can host WebSocket apps, but documents a 15-minute maximum request duration
- that is a bad default constraint for voice sessions where we want fewer platform-enforced disconnect behaviors in production

Tradeoff:
- good developer experience, but the request-duration limit is an avoidable risk when Render does not impose that fixed limit

## Deployment shape

### v1 topology

1. `Render Web Service`
   - runs this Fastify app
   - serves HTTP routes and WebSocket upgrades
2. `Supabase`
   - Postgres
   - internal auth when we wire it in
3. `Twilio`
   - inbound voice webhook to the Render base URL
   - media stream upgrades against the same host
4. `OpenAI Realtime API`
   - outbound WebSocket connection from the app
5. `Sentry`
   - runtime error capture

### Scaling path

Phase 1:
- one Render web service instance

Phase 2:
- larger instance size if CPU or memory pressure appears before connection fan-out becomes the problem

Phase 3:
- multiple instances only after we are ready to externalize any connection recovery/session state that cannot stay in-process

## Required runtime configuration

Required now:
- `PUBLIC_BASE_URL`

Recommended before pilot:
- `OPENAI_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_SMS_FROM_E164`
- `SENTRY_DSN`
- `SENTRY_ENVIRONMENT=production`

Useful defaults already handled in code:
- `PORT`
- `DEFAULT_ACCOUNT_ID`
- `OPENAI_REALTIME_MODEL`
- `OPENAI_REALTIME_URL`
- `REALTIME_VOICE`
- `JOBBER_API_VERSION`
- `TWILIO_RECORDING_CONSENT_LINE`

## Setup handoff

The person creating the hosting service should use [docs/tmta-9-render-setup.md](/home/paperclip/.paperclip-tmt/instances/tmt-fresh/projects/d6d01fa3-a334-49c2-9168-9339bce0014e/72689670-0e7d-4f63-a3ff-8c56fe32929d/Paperclip-Company1/docs/tmta-9-render-setup.md).

## Sources checked on 2026-05-01

- Render WebSockets: https://render.com/docs/websocket
- Vercel limits: https://vercel.com/docs/limits
- Vercel WebSocket KB: https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Cloudflare Workers WebSockets: https://developers.cloudflare.com/workers/runtime-apis/websockets/
- Railway WebSocket guide: https://docs.railway.com/guides/socketio
- Railway public networking limits: https://docs.railway.com/networking/public-networking/specs-and-limits
