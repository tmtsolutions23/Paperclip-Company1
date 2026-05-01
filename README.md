# Paperclip Company1 Pilot Backend

Current scope:

- initial Postgres schema for call persistence and lead workflow
- typed call intake normalization and callback decisioning
- first `Jobber` adapter request builder
- voice-edge service for Twilio inbound calls and OpenAI Realtime bridging
- thin internal admin console routes for accounts, routing, call review, callback queue, and failed sync review
- operator-facing HTML forms for account setup, routing edits, callback ownership, and failed-sync resolution
- focused unit tests for workflow, adapter payload generation, and Twilio voice responses

## Internal operator routes

- `GET /internal/admin`
- `GET /accounts`
- `GET /accounts/:accountId`
- `GET /accounts/:accountId/routing`
- `GET /calls`
- `GET /calls/:callSid`
- `GET /callbacks`
- `GET /sync-failures`

## Operator form actions

- `POST /accounts`
- `POST /accounts/:accountId`
- `POST /accounts/:accountId/routing`
- `POST /callbacks/:callbackId`
- `POST /sync-failures/:syncFailureId/actions`

## Admin API surface

- `GET|POST /api/accounts`
- `GET|PATCH /api/accounts/:accountId`
- `GET|PATCH /api/accounts/:accountId/routing`
- `GET /api/calls`
- `GET /api/calls/:callSid`
- `GET /api/callbacks`
- `PATCH /api/callbacks/:callbackId`
- `GET /api/sync-failures`
- `POST /api/sync-failures/:syncFailureId/retry`

## Commands

```bash
pnpm test
```

## Deployment target

The v1 deployment target for the live app is `Render` as a standard Node web service, not `Vercel` or `Cloudflare Workers`.

Once the Render service is connected to this GitHub repository with auto-deploy enabled, each push to `main` should trigger a Render redeploy. Treat `main` as the deploy branch for future engineering work unless the CTO changes that operating model.

- Hosting decision: [docs/tmta-9-hosting-decision.md](/home/paperclip/.paperclip-tmt/instances/tmt-fresh/projects/d6d01fa3-a334-49c2-9168-9339bce0014e/72689670-0e7d-4f63-a3ff-8c56fe32929d/Paperclip-Company1/docs/tmta-9-hosting-decision.md)
- Service-owner handoff: [docs/tmta-9-render-setup.md](/home/paperclip/.paperclip-tmt/instances/tmt-fresh/projects/d6d01fa3-a334-49c2-9168-9339bce0014e/72689670-0e7d-4f63-a3ff-8c56fe32929d/Paperclip-Company1/docs/tmta-9-render-setup.md)
- Render blueprint: [render.yaml](/home/paperclip/.paperclip-tmt/instances/tmt-fresh/projects/d6d01fa3-a334-49c2-9168-9339bce0014e/72689670-0e7d-4f63-a3ff-8c56fe32929d/Paperclip-Company1/render.yaml)
