# TMTA-9: Render setup handoff

Date: 2026-05-01
Owner: CTO
Status: Ready for operator action

## Copy-paste prompt for the service owner

Use this prompt when asking the person who will create the hosting service:

```text
Set up a new Render Web Service for this repository.

Configuration:
- Service type: Web Service
- Runtime: Node
- Region: closest US region to our pilot/customer
- Branch: main
- Root directory: repository root
- Build command: pnpm install --frozen-lockfile && pnpm build
- Start command: pnpm start
- Health check path: /health
- Plan: Starter for the first pilot
- Auto-deploy: on after the GitHub repository is connected so pushes to `main` redeploy the service

Environment variables to add:
- PUBLIC_BASE_URL=https://<render-service-domain>
- OPENAI_API_KEY=<set secret>
- TWILIO_ACCOUNT_SID=<set secret>
- TWILIO_AUTH_TOKEN=<set secret>
- TWILIO_SMS_FROM_E164=<set secret>
- SENTRY_DSN=<set secret if ready>
- SENTRY_ENVIRONMENT=production

After the service is created, send back:
1. the Render service URL
2. confirmation that /health returns {"ok":true}
3. confirmation that the env vars are present

Do not point Twilio production traffic at the service yet. We will wire the webhook after the app deploy is verified.
```

## Source-control operating note

This repository is intended to deploy from GitHub. After Render is granted access to the repo and auto-deploy is enabled, every push to `main` should trigger a redeploy. Future engineering work should assume that committing and pushing to `main` is deployment-affecting.

## Operator checklist after service creation

1. Open the Render service URL and confirm TLS is active.
2. Hit `/health` and confirm it returns `{"ok":true}`.
3. Record the assigned base URL and set it as `PUBLIC_BASE_URL`.
4. Deploy once with secrets present.
5. Confirm the internal admin page loads at `/internal/admin`.
6. Only then update the Twilio webhook and stream traffic to the new base URL.

## Immediate next engineering action after setup

Once the service exists, the next engineering step is:

1. deploy this repo to the new Render service
2. verify `/internal/admin`, `/health`, and one non-production Twilio call path
3. then wire the live Twilio number to the Render base URL
