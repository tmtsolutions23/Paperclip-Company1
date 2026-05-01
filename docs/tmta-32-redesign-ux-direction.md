# TMTA-32: UX direction for the redesign

Date: 2026-05-01
Owner: UXDesigner
Status: Ready for engineering handoff

## Reviewed artifact baseline

- Current renderable admin routes reviewed via server-side route injection on 2026-05-01:
  - `/internal/admin`
  - `/accounts`
  - `/accounts/:accountId`
  - `/accounts/:accountId/routing`
  - `/calls`
  - `/callbacks`
  - `/sync-failures`
- Current code baseline reviewed in `src/app.ts`
- Existing admin requirements reviewed in `docs/tmta-7-admin-console-spec.md`

## Executive direction

The redesign should split into two clearly different product surfaces:

1. A new public front page that sells the product with enough flexibility to support multiple small-business tenants without rebuilding the layout for every customer.
2. A tighter internal admin console that prioritizes operator speed, issue triage, and configuration clarity over decorative dashboard patterns.

The current admin console already proves the information model, but it puts too much content on single screens, mixes summary and editing modes, and relies on raw tables and JSON blocks where operators need scannable decision support. There is no current public front page, so that surface should be treated as a net-new experience.

## Design principles

- `Cognitive Load`: reduce simultaneous choices on high-density admin pages and move secondary detail behind progressive reveal.
- `Hick's Law`: keep global navigation short and task-shaped.
- `Recognition over Recall`: surface account, call, callback, and sync context inline so operators do not need to remember IDs or prior decisions.
- `Progressive Disclosure`: default to summaries first, then expose transcript, payload, and raw rule detail on demand.
- `Information Scent`: make the next likely action obvious from every row and detail page.
- `Plain Language`: use customer-service language instead of system phrasing where possible.
- `Trust Signals`: the public page must feel credible for home-service operators evaluating an AI receptionist.
- `Responsive Principles`: mobile behavior matters on the public page and for internal triage in narrow laptop widths.
- `WCAG POUR`: preserve contrast, keyboard access, visible focus, clear labels, and non-color status cues.
- `Dark Pattern Avoidance`: no fake urgency, hidden pricing traps, or misleading form defaults on the public page.

## Target user flows

### Public front page

Primary user:
- owner or operations lead at a plumbing, HVAC, electrical, or similar service business

Target flow:
1. Understand within 5 seconds that the product answers after-hours and overflow calls.
2. See proof that it works with real service workflows, not generic AI copy.
3. Learn the simple operating model: answer, qualify, route, callback, sync.
4. View industry-specific examples without leaving the main page.
5. Request a demo or contact sales from a short form or clear CTA.

### Internal operator console

Primary users:
- internal operator
- onboarding owner
- CTO / support engineer

Target flows:
1. `Overview -> queue requiring attention -> relevant detail view -> action complete`
2. `Accounts -> create/edit account -> routing setup -> launch-ready confirmation`
3. `Calls -> flagged call detail -> review transcript + structured output + linked exceptions -> clear next action`
4. `Sync failures -> diagnose transient vs configuration issue -> retry or mark handled`

## Information architecture

## Public front page IA

- Top nav: `How It Works`, `Industries`, `Integrations`, `Proof`, `FAQ`, primary CTA
- Hero
- Trust strip
- How it works
- Industry / tenant personalization band
- Integrations and workflow proof
- Before/after operations comparison
- FAQ
- Demo/contact CTA
- Footer

This should remain a one-page marketing flow for v1. Do not add a complex multi-page marketing site yet.

## Admin IA

Recommended primary nav:
- `Overview`
- `Accounts`
- `Call Review`
- `Callback Queue`
- `Sync Failures`

Recommended secondary nav:
- inside account detail: `Overview`, `Routing`, `Version History` placeholder
- inside call detail: `Summary`, `Transcript`, `Extracted Data`, `Exceptions`, `Raw Events`

Important IA change:
- Move account creation out of the same visual block as the account list. Listing and creating are different tasks and should not compete on the same screen.

## Surface guidance

### 1. Public front page

#### Intent

Make the product feel operationally trustworthy, not futuristic. The message should focus on missed-call recovery, after-hours coverage, and smoother handoff into real service software.

#### Layout and hierarchy

- Hero with one direct headline, one supporting sentence, and two CTAs:
  - primary: `Book a demo`
  - secondary: `See how a callback flow works`
- Right side of hero should show a product proof module, not a stock illustration:
  - sample call flow timeline
  - callback outcome card
  - integration confirmation state
- Trust strip immediately below hero:
  - supported business categories
  - operational claims such as `Answers overflow`, `Captures structured lead data`, `Routes urgent calls`
- How-it-works section should use a 4-step horizontal or vertical sequence:
  - answer
  - qualify
  - decide
  - hand off
- Tenant personalization section should show how the same product adapts by trade:
  - plumbing
  - HVAC
  - electrical
  - general home services
- Proof section should show practical outputs:
  - captured caller need
  - urgency tagging
  - callback creation
  - CRM/job sync outcome
- Final CTA should repeat the value and keep the form short:
  - name
  - company
  - work email
  - optional phone

#### Tenant branding flexibility

The public page should be built from stable layout slots plus tenant tokens:

- logo
- accent color
- industry label
- proof/example copy
- testimonial/case-study block
- CTA destination or contact copy

Keep the base layout and typography fixed. Allow brand variance through tokens and content modules, not bespoke page structures.

#### Component and token direction

- Typography:
  - public display face with more personality than the admin UI
  - neutral, highly readable body face
- Core tokens:
  - `--brand-primary`
  - `--brand-secondary`
  - `--surface-base`
  - `--surface-elevated`
  - `--text-strong`
  - `--text-muted`
  - `--success`
  - `--warning`
  - `--danger`
- Components:
  - hero proof card
  - trust logo/tag strip
  - step card
  - industry switcher or segmented filter
  - proof stat card
  - FAQ accordion
  - compact lead form

### 2. Admin overview

#### Intent

The overview should answer one question first: `What needs attention right now?`

#### Layout and hierarchy

- Top row:
  - page title
  - environment badge
  - last data refresh timestamp
- Priority worklist section first:
  - calls needing review
  - callbacks due soon
  - sync failures pending retry
- Health summary cards second:
  - active accounts
  - calls today
  - open callbacks
  - open sync failures
- Recent changes / audit activity third

#### Interaction direction

- Every attention item must expose a direct CTA such as `Review call`, `Open callback`, or `Retry investigation`
- Do not place full account tables and full call tables on the overview page
- Replace raw JSON audit output with a structured activity list

### 3. Accounts

#### List page

- Primary action: `New account`
- Table columns:
  - account
  - timezone
  - primary number
  - routing status
  - last updated
  - launch readiness
- Add list filters:
  - all
  - setup incomplete
  - active

#### Detail page

- Use a split layout:
  - left: account summary and readiness
  - right: operator messaging and key configuration facts
- Add a launch readiness checklist:
  - hours configured
  - escalation number present
  - SMS template present
  - consent copy present
  - routing version deployed
- Keep editing in titled sections rather than one long mixed form

#### Form behavior

- Required fields should be visually marked before submit
- Add inline helper text for timezone, phone formatting, and consent copy purpose
- Use inline validation and preserve entered values on error

### 4. Routing

#### Intent

Operators should understand the routing policy without parsing raw JSON.

#### Layout and hierarchy

- Summary banner:
  - version id
  - deployed time
  - default disposition
  - last editor placeholder
- Sections:
  - business hours
  - overflow thresholds
  - coverage
  - emergency handling
  - unsupported intents

#### Interaction direction

- Replace freeform day/hour fields with repeatable day rows and clearer time-slot inputs
- Group related threshold controls together
- Show a read-only plain-English summary of the current rule set above the form
- Keep raw JSON export as a secondary utility, not the default view

### 5. Call review list

#### Intent

Operators need triage first, detail second.

#### Layout and hierarchy

- Add filter chips:
  - needs review
  - low confidence
  - sync failed
  - callback open
- Default sort:
  - newest flagged items first
- Table emphasis:
  - status cluster first
  - caller/problem context second
  - technical metadata last

Recommended columns:
- review priority
- started
- caller
- account
- disposition
- callback state
- sync state
- prompt/rules version

Use visually distinct status pills with icons or labels so state is not color-only.

### 6. Call detail

#### Intent

This is the highest-cognitive-load surface and needs the largest redesign.

#### Layout and hierarchy

- Sticky summary rail or top summary card:
  - review status
  - disposition
  - urgency/confidence
  - callback state
  - sync state
  - account link
- Primary content tabs or anchored sections:
  - summary
  - transcript
  - extracted data
  - linked exceptions
  - raw events

#### Interaction direction

- Put the recommendation or risk summary above the transcript
- Convert structured intake and lead record from raw JSON to labeled definition groups where fields are known
- Keep raw payloads available in expandable blocks
- Linked callback and sync failures should include next-step actions inline
- Preserve direct links back to account and routing context

### 7. Callback queue

#### Intent

The queue should behave like work management, not a table with embedded long forms.

#### Layout and hierarchy

- Split the surface into:
  - queue table
  - selected row detail/edit drawer or dedicated detail page
- Priority signals:
  - overdue
  - due soon
  - high urgency
  - unassigned

Recommended columns:
- due time
- customer
- service
- urgency
- owner
- status
- linked account/call

#### Interaction direction

- Inline edits should be limited to the highest-frequency fields:
  - owner
  - status
- Notes editing should happen in a focused panel, not inside a crowded table row
- Add quick actions:
  - assign to me
  - mark contacted
  - open source call

### 8. Sync failures

#### Intent

Operators must quickly separate retryable failures from structural configuration issues.

#### Layout and hierarchy

- Default grouping by failure state:
  - retry now
  - needs configuration fix
  - manually handled
- Recommended columns:
  - target
  - failure class
  - last attempt
  - retry count
  - affected account/call
  - current owner/state

#### Interaction direction

- Translate low-level failure reasons into operator-readable labels where possible
- Keep payload summary collapsed unless expanded
- Pair each failure with a recommended next action:
  - retry
  - fix mapping
  - handle manually

## Key states

## Public page states

- Loading:
  - skeleton blocks for hero proof card and industry examples if content hydrates client-side
- Empty:
  - not generally applicable except for optional proof/testimonial modules; hide missing modules cleanly
- Error:
  - form submission errors should preserve fields and show field-level guidance plus a concise summary
- Success:
  - demo request confirmation should explain timing and next step

## Admin states

- Loading:
  - skeleton cards/table rows on overview, lists, and detail sections
- Empty:
  - overview with zero accounts should drive directly to `Create first account`
  - call review with no flagged calls should show a calm all-clear state
  - callback queue with no open work should show a resolved queue state
  - sync failures with no issues should show an integration health success state
- Error:
  - route-level failure banner with retry action
  - field-level validation under inputs
  - preserve entered form values on validation failures
- Success:
  - non-blocking success toast or inline confirmation after save, retry, or status update

## Visual system direction

- Use a cleaner, lighter neutral base than the current warm monochrome shell for internal ops surfaces.
- Keep admin UI sober and operational; reserve stronger brand expression for the public front page.
- Standardize spacing on an 8px base scale.
- Use consistent status colors and labels across calls, callbacks, and sync failures.
- Use card elevation sparingly; the hierarchy should come from spacing, headings, and grouping before shadows.

## Engineering acceptance criteria

The redesign is implementation-ready when the following are true:

1. A public front page exists with:
   - clear hero, trust, workflow, industry personalization, proof, FAQ, and CTA sections
   - token-based tenant branding hooks without requiring layout rewrites
   - responsive behavior for mobile and desktop
2. The admin console uses a consistent shell and narrows the primary nav to the five core areas:
   - overview
   - accounts
   - call review
   - callback queue
   - sync failures
3. The overview page prioritizes actionable worklists over full data dumps.
4. Account list and account creation are separated into distinct experiences.
5. Routing rules are understandable without reading raw JSON first.
6. Call review surfaces triage state before technical metadata.
7. Call detail exposes summary, transcript, extracted data, linked exceptions, and raw events in a progressive structure.
8. Callback and sync-failure workflows support fast operator action without embedding long edit forms inside crowded table rows.
9. Every major surface includes explicit loading, empty, error, and success behavior.
10. Status semantics and styling are consistent across the admin experience.

## Recommended implementation sequence

1. Create the shared design tokens and layout shell for public and admin surfaces.
2. Build the public front page as a net-new route and component set.
3. Redesign the admin overview and list surfaces.
4. Redesign the highest-complexity detail surface: call detail.
5. Refine account/routing configuration flows and queue interactions.

## Verification note

This direction was produced after reviewing the current server-rendered admin routes in renderable HTML form and the current implementation in `src/app.ts`. Public front page verification remains pending because that surface does not exist yet and will need implementation before visual QA.
