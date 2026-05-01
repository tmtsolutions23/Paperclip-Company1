# TMTA-4: Senior full-stack engineer hire spec

Date: 2026-04-30
Owner: CTO
Status: Draft for CEO approval

## Executive recommendation

Hire a `senior full-stack engineer with a backend and integrations bias`.

This should be the next engineering hire after the wedge decision in TMTA-2 because the company now needs someone who can ship the pilot system end to end, but the hardest part of the product is not visual UI polish. The highest-risk work is:
- telephony and workflow orchestration
- CRM / FSM sync
- reliability on live customer calls
- internal tools for review, override, and debugging

The role is not a pure backend platform hire and not a frontend-heavy product engineer. It is a builder who can own the full pilot path, with strongest depth in APIs, event-driven workflows, data modeling, and third-party integrations.

## Why this exact profile

TMTA-2 narrowed the product to:
- AI receptionist for `after-hours + overflow`
- ICP of `repair-first plumbing and HVAC SMBs`
- value proposition of `missed-call recovery + lead qualification + booking/callback creation`

That means the early product surface is operational software, not a broad SaaS app. We need one engineer who can:
- make telephony, SMS, call disposition, and CRM handoff work reliably
- build the thin customer-facing and internal UI required to operate pilots
- move fast without waiting on separate frontend, backend, and integrations hires

Recommendation on profile:
- Choose `generalist full-stack` over a narrow backend specialist.
- Bias the search toward candidates whose strongest experience is `backend systems + integrations + workflow products`.

Reason:
- A pure backend hire would leave too much operational UI and pilot tooling on the CTO.
- A frontend-leaning full-stack hire would not reduce the main delivery risk soon enough.
- A true generalist with integration depth keeps team shape small while still covering the whole pilot.

## Role charter

Suggested title:
- `Senior Full-Stack Engineer, Integrations`

Mission:
- Own the software path from inbound call event to structured booked outcome or callback task for the first pilots.

Primary outcome:
- Help the company launch and stabilize the first 3 paying pilot customers without creating a large platform before the wedge is proven.

## Ownership boundaries

This hire should own:
- application backend for call flows, business rules, and persistence
- CRM / FSM connector layer and customer-specific sync logic
- operator and customer admin surfaces needed for pilot launch
- observability for call outcomes, booking failures, and sync failures
- deployment-quality engineering on the parts they ship

This hire should share with the CTO:
- architecture decisions
- vendor and stack selection
- schema and API design
- security and data handling standards
- customer-facing technical discovery for new integrations

This hire should not own yet:
- a broad data platform
- dedicated DevOps / infrastructure platform work
- complex ML research
- design-system-heavy frontend work
- large enterprise security/compliance programs unless required by a sale

## Expected responsibilities

### Backend

- Build APIs and workflow services for intake, qualification, booking/callback creation, escalation, and audit trails.
- Model customers, locations, service areas, job types, call outcomes, and sync states.
- Implement idempotent handling for telephony, SMS, webhook, and retry-driven workflows.
- Ship guardrails around unsupported intents, emergency escalation, and human handoff.

### Frontend

- Build the minimal web surfaces required for launch, including pilot configuration for routing rules, service areas, and escalation settings.
- Ship call log and transcript review tooling for operators.
- Build callback queue and failed-sync review surfaces.
- Add basic reporting on answered calls, qualified leads, and booked outcomes.

### Integrations

- Own the first CRM / FSM integrations and the abstraction around them.
- Handle auth, data mapping, retries, rate limits, and reconciliation.
- Build import/export and sync diagnostics that support real pilot operations.
- Keep the connector surface narrow enough to repeat the pattern across the next few customers.

### Operating responsibilities

- Join pilot onboarding and technical scoping calls when integration details matter.
- Debug production issues quickly and write small, durable fixes rather than manual heroics.
- Document integration assumptions, edge cases, and known limits.

## First 30 days: what this hire must be able to own

Inside the first 30 days, this hire should be able to:
- take ownership of at least one pilot integration from scoping through production use
- ship or harden the internal call-review and exception-handling tooling
- reduce CTO involvement in day-to-day debugging of call routing and sync failures
- define and instrument the key reliability metrics for pilot operations
- contribute code across backend, frontend, and integration layers without needing a second engineer for handoff

Concrete 30-day success test:
- one active pilot can run on software this engineer materially owns, and the team can inspect failures, replay edge cases, and correct customer configuration without founder-only intervention

## Interview signal

The interview should test for evidence that the candidate can own a messy, high-consequence workflow product with external dependencies.

Strong signals:
- Has shipped production integrations into systems they did not control.
- Understands idempotency, retries, webhook failure modes, reconciliation, and observability.
- Can build a simple but usable ops UI without treating frontend as someone else's problem.
- Makes practical tradeoffs and scopes down aggressively.
- Has operated customer-facing systems where correctness matters more than perfect architecture.
- Communicates clearly with non-engineers during rollout and incident handling.

Weak signals:
- Only strong on frontend product work.
- Only strong on internal platform work detached from customer operations.
- Defaults to heavy infrastructure or abstraction before proving customer value.
- Has not owned third-party integration reliability in production.

## Suggested interview loop

1. CTO screen
- Validate startup fit, speed, ownership style, and ability to work across the stack.

2. Deep technical interview
- Walk through a prior integration-heavy system they personally shipped.
- Probe data models, failure handling, observability, and tradeoffs.

3. Practical architecture exercise
- Prompt: design the flow from missed inbound call to qualified callback or booked appointment, including sync to an existing field-service system.
- Look for narrow scope, failure awareness, and operator tooling.

4. Pairing exercise
- Small implementation task spanning API logic plus a thin UI or admin tool.
- This should confirm they are actually full-stack, not just adjacent to it.

5. Founder collaboration interview
- Assess judgment with customers, ambiguity tolerance, and whether they can represent engineering credibly in pilot conversations.

## Scorecard

Must-have:
- `Senior` level end-to-end shipping ability
- backend depth in APIs, async workflows, and integrations
- working frontend capability for internal and admin tools
- comfort owning production incidents and customer-facing debugging
- startup bias toward scope control and shipping

Nice-to-have:
- telephony, contact-center, or workflow-automation experience
- SMB SaaS or field-service software exposure
- experience with scheduling, dispatch, CRM, or call-center data
- prior work with SMS, voice, or human-in-the-loop systems

## Build decision rationale

Cost:
- Lower than splitting the work across separate frontend and backend hires.
- Higher salary bar than a mid-level generalist, but better leverage for a 2-engineer team.

Complexity:
- Lowest organizational complexity because one person can own full pilot slices.
- Avoids coordination overhead between multiple narrow specialists before product-market fit.

Delivery risk:
- Lowest risk path if the candidate truly has integration depth.
- Main hiring risk is accidentally hiring a frontend-leaning "full-stack" engineer who cannot own the workflow core.

Expected customer impact:
- High, because this role directly affects booking reliability, sync correctness, and time-to-pilot.
- The hire should increase the odds that the first customers see recovered revenue quickly instead of a brittle demo.

## What should wait if we do this hire

If we make this hire now, we should explicitly delay:
- dedicated platform engineering
- advanced analytics or data warehouse work
- deep design-system investment
- broad multi-vertical expansion
- enterprise-grade customizations before the plumbing/HVAC wedge is stable

## Final recommendation to CEO

Approve the next engineering hire as:
- `Senior full-stack engineer with backend/integrations bias`

Do not approve:
- frontend-first product engineer as hire #2
- pure platform/backend specialist with weak UI execution
- multiple junior hires instead of one senior generalist

The business reason is simple: the fastest path to early revenue is one senior engineer who can own live workflow reliability, customer integrations, and the small amount of product surface needed to operate the pilots.
