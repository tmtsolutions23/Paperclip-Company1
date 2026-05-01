# TMTA-3: v1 architecture and two-week delivery plan

Date: 2026-04-30
Owner: CTO
Status: Ready to execute

## Executive decision

Build the first pilot as a narrow `after-hours + overflow AI call handling` system for plumbing and HVAC shops, optimized for `callback capture first` and `limited booking second`.

This is the smallest version that can prove recovered revenue without taking on full dispatch complexity in week 1.

## Recommended stack

### Core stack

- `Twilio Programmable Voice + Media Streams + SMS`
- `OpenAI Realtime API` for low-latency voice handling
- `Node.js + TypeScript` for the application runtime
- `Postgres` as the system of record
- `Supabase` for managed Postgres, auth, file storage, and quick internal tooling
- `Render` for the first hosted app deployment
- `Sentry` for error tracking

### Why this stack

`Twilio` is the fastest path to production telephony for US SMB pilots, supports inbound voice/SMS, and officially supports bidirectional media streaming over WebSockets for AI voice interactions. `OpenAI Realtime API` is designed for low-latency speech-to-speech interactions, which fits the receptionist use case better than stitching together separate STT, LLM, and TTS services in v1.

`Supabase + Postgres` keeps the data model and audit trail simple while avoiding premature multi-service infrastructure. We do not need a separate vector stack or event bus for the first pilot. `Render` is sufficient for the first pilot environment because the workload is small, deployment is fast, and the operational surface stays narrow.

### Vendor decision summary

1. `Twilio` for telephony
Cost: moderate usage-based spend
Complexity: low to moderate
Delivery risk: low
Customer impact: high, because call handling quality is the product

2. `OpenAI Realtime API` for live conversation
Cost: moderate variable inference spend
Complexity: moderate
Delivery risk: medium, mostly around prompt/control quality
Customer impact: high, because latency and conversation quality drive trust

3. `Supabase/Postgres` instead of a larger cloud stack
Cost: low
Complexity: low
Delivery risk: low
Customer impact: indirect but positive through faster delivery

4. `Direct CRM integrations` only for the first 1-2 target systems
Cost: moderate engineering cost
Complexity: medium
Delivery risk: medium
Customer impact: high, because reliable handoff into existing workflow is required for ROI

## v1 product scope

### In scope

- Route after-hours and overflow calls from a Twilio number
- Answer with an AI receptionist tuned for plumbing/HVAC repair intake
- Capture caller identity, address, service category, urgency, and free-text problem summary
- Enforce service-area and service-type eligibility
- Distinguish `book now`, `schedule callback`, `emergency escalation`, and `unsupported`
- Send SMS confirmation or callback acknowledgement
- Persist transcript, summary, disposition, and structured intake record
- Push the result into the customer's operating system where supported
- Expose a basic internal review queue for failed or uncertain calls

### Out of scope

- Full daytime front-desk replacement
- Multi-location franchise workflows
- Complex dispatch optimization
- Payment collection
- Broad omnichannel inbox
- Deep analytics beyond pilot ROI and QA

## Architecture

### System shape

1. Inbound call hits `Twilio`.
2. Twilio invokes our webhook and upgrades the call into a bidirectional media stream.
3. `Voice session service` bridges Twilio audio to `OpenAI Realtime API`.
4. The realtime agent runs on a constrained prompt and emits:
   - live spoken responses
   - structured tool calls for intake fields and dispositions
   - confidence and fallback signals
5. `Workflow service` validates service area, hours, and escalation rules.
6. `Ops database` stores:
   - customer account config
   - routing rules
   - call records
   - transcripts
   - structured lead objects
   - callback tasks
   - audit events
7. `Integration adapters` write outcomes into the customer's FSM/CRM when credentials and permissions exist.
8. `SMS service` sends confirmations and callback acknowledgements through Twilio.
9. Internal operators review exception cases in a lightweight admin console.

### Services

#### 1. Voice edge

Responsibilities:
- Twilio webhook handling
- media stream lifecycle
- barge-in/interruption handling
- basic call recording controls
- fallback to voicemail or human escalation path

Decision:
- Keep this inside the main Node app for v1, not as a separate microservice.

#### 2. Conversation orchestrator

Responsibilities:
- session prompt assembly
- business rule tools
- structured extraction
- escalation decisions
- retry/fallback behavior when the model is uncertain

Decision:
- Use a strict tool schema and deterministic guardrails around service area, emergency categories, and booking eligibility.

#### 3. Workflow and integrations layer

Responsibilities:
- normalize intake into a stable internal lead schema
- create callback tasks or bookings
- sync notes/transcripts/dispositions
- manage provider-specific retries and idempotency

Decision:
- Build the internal lead schema first, then map outward to external systems. Do not let external API shapes leak into the core workflow.

#### 4. Admin and QA console

Responsibilities:
- account setup
- hours and routing configuration
- service-area configuration
- transcript review
- failed-sync review
- prompt/rule version visibility

Decision:
- Build as a thin authenticated web app over Supabase/Postgres. Keep it internal for the first pilots.

## Initial data model

### Core tables

- `accounts`
- `phone_numbers`
- `routing_rules`
- `service_areas`
- `service_types`
- `call_sessions`
- `call_events`
- `call_transcripts`
- `leads`
- `appointments`
- `callback_tasks`
- `integration_connections`
- `integration_sync_events`
- `prompt_versions`

### Key design choices

- Every call gets a durable `call_session` row before AI handling starts.
- All model outputs that matter to the business must land in typed columns, not only raw transcript text.
- External writes must be idempotent and logged in `integration_sync_events`.
- Prompt versions must be attached to each call for QA and rollback.

## Integration strategy

### Phase 1 target

Support:
- `Jobber`
- `Housecall Pro`
- `ServiceTitan` as a design target, but only if pilot demand requires it immediately

### Why this order

`Jobber` exposes a public GraphQL API for reading and modifying account data. `Housecall Pro` exposes a public API, but access is tied to eligible plans, so onboarding risk is commercial as much as technical. `ServiceTitan` has broad API coverage including job planning and dispatch, but access and tenant setup are heavier, so it should not be the first integration unless a pilot specifically forces that choice.

### Fallback

If a pilot customer cannot support direct API integration in week 2, ship with:
- SMS confirmation to the customer
- email or webhook delivery of structured intake to the office
- internal callback queue

This keeps the pilot live without blocking on partner API access.

## Reliability and safety rules

- Default to `schedule callback` instead of autonomous booking when availability or intent is ambiguous.
- Emergency keywords route to escalation or emergency callback instructions, not fully autonomous scheduling.
- Unsupported geography or work type exits cleanly and captures the lead for manual review.
- If the realtime session fails, fail over to voicemail capture plus SMS acknowledgement.
- Keep humans in the loop for all low-confidence outcomes in v1.

## Security and compliance

- Record explicit customer consent language for recording/transcription where required.
- Store credentials for external systems in managed secrets, not in the database.
- Retain transcripts and recordings with account-level retention settings.
- Start with standard SMB data handling; do not position for HIPAA or payments in v1.

## Two-week delivery plan

### Week 1: prove the live call path

#### Milestone 1: foundation and telephony loop

Deliver by day 2:
- repo scaffold
- deployment target
- Twilio inbound webhook
- bidirectional media stream bridge
- OpenAI realtime session bootstrap

Acceptance:
- test number answers a call and returns live spoken responses with stable latency

#### Milestone 2: structured intake and persistence

Deliver by day 4:
- constrained prompt
- tool schema for intake fields
- Postgres schema
- call transcript and lead persistence
- basic service-area and urgency rules

Acceptance:
- 10 scripted calls produce usable structured records in the database

#### Milestone 3: fallback and SMS

Deliver by day 5:
- callback disposition flow
- failure fallback
- SMS acknowledgement
- internal QA log view

Acceptance:
- failed or unsupported calls still create a usable callback record and outbound SMS

### Week 2: pilot-readiness and first integration

#### Milestone 4: integration adapter

Deliver by day 8:
- internal lead schema finalized
- first external adapter live, recommended `Jobber`
- idempotent sync logging
- retry queue for failed writes

Acceptance:
- successful lead or callback creation in the target external system from test calls

#### Milestone 5: admin configuration and QA hardening

Deliver by day 10:
- account config UI for hours, service area, and escalation rules
- transcript review
- prompt version tagging
- Sentry instrumentation

Acceptance:
- non-engineer operator can update routing rules and review call outcomes without database access

#### Milestone 6: pilot launch package

Deliver by day 14:
- pilot playbook
- onboarding checklist
- known limitations
- ROI metric dashboard for answer rate, qualified outcomes, and booked/callback outcomes

Acceptance:
- one pilot account can be configured and tested end-to-end in under one hour

## Engineering work breakdown

### Track A: voice and conversation core

- Twilio webhook and stream handling
- Realtime session management
- prompt/tool orchestration
- fallback behavior

### Track B: application core

- schema and migrations
- call persistence
- lead workflow
- retry and audit logging

### Track C: integrations and ops

- first CRM/FSM adapter
- SMS notification flow
- internal admin/QA console
- pilot onboarding docs

## Highest-risk unknowns and how to de-risk them

### 1. Live call quality and latency

Risk:
- callers will not tolerate laggy or unnatural turn-taking

De-risk first:
- build the Twilio to Realtime loop before anything else
- run 20 internal scripted calls across mobile and landline paths
- instrument turn latency and fallback rates

### 2. Booking trust

Risk:
- autonomous booking mistakes destroy trust quickly

De-risk first:
- default to callback capture
- allow direct booking only for narrow, clearly valid slots and job types
- require explicit confirmation readback before committing a booking

### 3. Integration onboarding friction

Risk:
- customers may not have API access or credentials ready

De-risk first:
- choose one easier first integration
- maintain email/SMS/manual fallback path
- collect required customer integration prerequisites before pilot kickoff

### 4. Trade-specific intent coverage

Risk:
- generic prompting will mishandle edge cases like no-cool, water leak severity, and membership/customer status

De-risk first:
- constrain the initial taxonomy to a small set of high-frequency repair intents
- review real transcripts weekly and update prompts/rules as a release artifact

## Recommendation on sequencing

Do not split effort evenly across all surfaces. The correct order is:

1. Live voice loop
2. Structured intake and persistence
3. Callback fallback and SMS
4. First integration adapter
5. Internal admin tooling
6. Pilot onboarding package

If scope pressure appears, cut autonomous booking breadth before cutting reliability or CRM handoff.

## Sources

- Twilio Media Streams overview: https://www.twilio.com/docs/voice/media-streams
- Twilio `<Stream>` TwiML reference: https://www.twilio.com/docs/voice/twiml/stream
- Twilio Programmable Voice docs: https://www.twilio.com/docs/voice
- OpenAI Realtime API guide: https://platform.openai.com/docs/guides/realtime
- OpenAI Realtime API reference: https://platform.openai.com/docs/api-reference/realtime
- Jobber developer docs: https://developer.getjobber.com/docs/
- Jobber API queries and mutations: https://developer.getjobber.com/docs/using_jobbers_api/api_queries_and_mutations/
- Jobber API rate limits: https://developer.getjobber.com/docs/using_jobbers_api/api_rate_limits
- Housecall Pro API overview: https://help.housecallpro.com/en/articles/8505035-api-overview
- Housecall Pro public API docs: https://docs.housecallpro.com/docs/housecall-public-api/
- ServiceTitan developer overview: https://developer.servicetitan.io/docs/overview/
- ServiceTitan job planning and management APIs: https://developer.servicetitan.io/docs/api-resources-job-planning
- ServiceTitan dispatch APIs: https://developer.servicetitan.io/docs/api-resources-dispatch
- Supabase docs: https://supabase.com/docs/
