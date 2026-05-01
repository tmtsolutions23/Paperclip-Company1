# TMTA-7: Internal admin console spec

Date: 2026-04-30
Owner: CTO
Status: Ready for implementation

## Executive decision

Build the admin console as a thin internal web app over the v1 ops database. Optimize for `pilot setup speed`, `QA visibility`, and `exception handling`, not for a polished external customer product.

The v1 console should let an operator:
- configure one pilot account without database access
- review call outcomes and transcripts
- resolve failed syncs and callback tasks
- see which prompt/rule version handled each call

Do not build a broad dashboard, role matrix, or customer-facing portal in v1.

## Product boundaries

### Primary users

- internal operator
- CTO / engineer on support
- pilot onboarding owner

### Jobs to be done

1. Configure a new account in under one hour.
2. Confirm the AI is following routing and escalation rules.
3. Find calls that need human action.
4. Diagnose sync failures without reading raw logs.

### Out of scope

- customer self-serve billing
- advanced analytics warehouse
- multi-location hierarchy
- granular RBAC beyond internal authenticated access
- prompt editing UI

## Recommended implementation shape

### Stack

- `Next.js` or equivalent Node web app in the main repo
- `Supabase Auth` for internal login
- server-rendered pages or simple server actions
- direct Postgres reads/writes through a typed data layer

### Why this cut

Cost:
- low

Complexity:
- low to moderate

Delivery risk:
- low if kept internal-only

Expected customer impact:
- indirect but high because faster setup and clearer exception handling shorten time to pilot value

## Information architecture

### 1. Accounts

Purpose:
- create and edit pilot account configuration

Required fields:
- account name
- timezone
- primary phone number
- overflow mode enabled
- after-hours schedule enabled
- emergency escalation phone
- SMS acknowledgement template
- recording/transcript consent copy

Acceptance:
- operator can create an account and save required settings in one pass

### 2. Routing rules

Purpose:
- define when AI answers and what happens next

Required fields:
- business hours by day
- overflow thresholds
- service area zip codes
- supported service types
- emergency keywords
- unsupported intents
- disposition default: `callback` or `book`

Acceptance:
- operator can update hours, service area, and escalation rules without engineering help

### 3. Call review

Purpose:
- inspect outcome quality and confirm structured extraction

Required columns:
- call start time
- caller phone
- account
- disposition
- urgency
- sync status
- callback status
- prompt version
- confidence flag

Detail view:
- transcript
- structured lead fields
- rule decisions
- external sync attempts
- sent SMS copy

Acceptance:
- operator can open a call and determine in under two minutes whether it needs action

### 4. Callback queue

Purpose:
- manage calls that need human follow-up

Required fields:
- customer name
- phone
- requested service
- urgency
- callback due time
- owner
- status
- notes

Statuses:
- `new`
- `assigned`
- `contacted`
- `resolved`
- `closed_lost`

Acceptance:
- every non-booked eligible lead lands in a visible queue with an owner-ready record

### 5. Failed sync review

Purpose:
- surface integration failures without raw log digging

Required fields:
- sync target
- failure reason
- retry count
- last attempt time
- payload summary
- retry action

Actions:
- retry sync
- mark handled manually
- open lead record

Acceptance:
- operator can distinguish transient API failures from mapping/configuration failures

### 6. Prompt and rule version visibility

Purpose:
- support QA and rollback decisions

Required fields:
- prompt version id
- routing rules version id
- deployed at
- active account scope

Acceptance:
- each call record clearly shows which prompt and rules version produced the outcome

## Minimum navigation

- `/accounts`
- `/accounts/:id`
- `/accounts/:id/routing`
- `/calls`
- `/calls/:id`
- `/callbacks`
- `/sync-failures`

This is enough for v1. Do not add dashboard home widgets unless the console becomes hard to operate without them.

## Data model additions and field expectations

Use the `TMTA-3` core tables and add the following fields or supporting tables where needed:

- `accounts`
  - `timezone`
  - `emergency_escalation_phone`
  - `sms_ack_template`
  - `consent_script`
- `routing_rules`
  - `hours_json`
  - `overflow_threshold_json`
  - `emergency_keywords_json`
  - `default_disposition`
- `service_areas`
  - `postal_code`
  - `city`
  - `state`
- `call_sessions`
  - `prompt_version_id`
  - `routing_rule_version_id`
  - `confidence_state`
  - `requires_human_review`
- `callback_tasks`
  - `owner_name`
  - `due_at`
  - `status`
  - `resolution_notes`
- `integration_sync_events`
  - `target_system`
  - `status`
  - `error_code`
  - `error_summary`
  - `retry_count`
  - `last_attempt_at`

If schema pressure appears, store versioned rule snapshots as JSON first and normalize later.

## API surface

Minimum endpoints:

- `GET /api/accounts`
- `POST /api/accounts`
- `GET /api/accounts/:id`
- `PATCH /api/accounts/:id`
- `GET /api/accounts/:id/routing`
- `PATCH /api/accounts/:id/routing`
- `GET /api/calls`
- `GET /api/calls/:id`
- `GET /api/callbacks`
- `PATCH /api/callbacks/:id`
- `GET /api/sync-failures`
- `POST /api/sync-failures/:id/retry`

Keep writes narrow and auditable. Prefer explicit fields over generic document blobs on mutable operator actions.

## Security and access

- internal-only authenticated access
- no public signup
- no shared customer login in v1
- audit every operator write affecting routing, escalation, or callback status
- redact secrets from UI and logs

## Acceptance test

The console is good enough for pilot launch when an operator can:

1. create an account
2. configure hours, service area, and escalation settings
3. place a test call
4. review the transcript and disposition
5. confirm SMS delivery
6. inspect a simulated failed sync
7. assign a callback task

Target total time:
- under 60 minutes for a new pilot account

## Implementation sequence

1. scaffold authenticated internal app shell
2. ship account setup and routing pages
3. ship call review list and detail page
4. ship callback queue
5. ship failed sync review and retry action
6. add prompt/rule version visibility and Sentry hooks

If scope pressure appears, cut visual polish and dashboard summaries before cutting callback queue or sync review.
