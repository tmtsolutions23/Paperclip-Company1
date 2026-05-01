# TMTA-7: Pilot launch playbook

Date: 2026-04-30
Owner: CTO
Status: Ready for first pilot use

## Purpose

This playbook defines the smallest repeatable launch path for the first pilot accounts. The goal is to get one plumbing or HVAC customer live with after-hours and overflow coverage in under one hour of operator setup, excluding customer credential delays.

## Launch prerequisites

Customer must provide:
- primary business name
- primary dispatch callback number
- service area zip codes
- supported service types
- business hours
- emergency escalation destination
- SMS consent and recording disclosure language
- integration credentials if direct sync is enabled

Internal team must have ready:
- Twilio number available
- deployed app environment
- database migrations applied
- active OpenAI realtime credentials
- Sentry project configured

## Pilot launch steps

### 1. Account creation

- Create the account in the admin console.
- Set timezone and primary support contact.
- Attach the Twilio number.
- Save the recording/transcript disclosure copy.

Exit criteria:
- account exists and can receive a routed test call

### 2. Routing configuration

- Enter business hours by weekday.
- Enable after-hours coverage.
- Set overflow behavior.
- Add service area zip codes.
- Enable supported service types for plumbing and/or HVAC.
- Configure emergency escalation phone and keywords.

Exit criteria:
- routing rules are saved and visible in the review screen

### 3. Conversation rules check

- Confirm active prompt version.
- Confirm default ambiguous disposition is `schedule callback`.
- Confirm unsupported geography and unsupported work types exit cleanly.

Exit criteria:
- rules align with the pilot's actual operating limits

### 4. Integration path selection

Choose one:

- `direct integration`
- `internal callback queue + SMS fallback`

Use direct integration only if credentials are present and test access succeeds. If not, do not block the pilot. Launch on callback queue fallback.

Exit criteria:
- one working handoff path is active

### 5. Test-call script

Run at least five scripted calls:

1. standard after-hours plumbing lead
2. HVAC urgent callback request
3. unsupported service area
4. emergency escalation phrase
5. integration failure simulation or callback fallback

For each call verify:
- answer path works
- transcript is stored
- structured lead is created
- disposition matches expectation
- SMS acknowledgement is sent when appropriate

Exit criteria:
- five test calls complete with no hidden operator-only fixes

### 6. Pilot handoff

- Share the operating window and escalation expectations with the customer.
- Confirm who owns callback tasks on the customer side.
- Confirm where failed or unsupported calls will be reviewed.
- Set the date for the first transcript QA review.

Exit criteria:
- named owner exists for callback handling and QA review

## Known v1 limitations

- callback capture is the safe default; broad autonomous booking is intentionally limited
- single-account internal operations only; no customer self-serve console
- narrow supported job taxonomy
- manual review required for low-confidence and failed-sync cases
- integration coverage is limited to the first supported target or fallback workflow
- no advanced analytics beyond core pilot ROI and QA metrics

These limits are deliberate. They reduce trust risk and keep the launch path sellable.

## Escalation rules

Escalate to a human or callback path when:
- the caller reports an emergency or safety issue
- address or service area cannot be confidently validated
- booking availability is unknown
- the model shows low confidence
- the sync target rejects the write and no safe retry is possible in-session

## First-week operating cadence

Day 1:
- review every call transcript manually

Days 2-3:
- review all exception cases and at least 50 percent of successful calls

Days 4-7:
- review all exception cases and a daily sample of successful calls

If bad bookings or false dispositions exceed the target threshold, revert to callback-only handling until the prompt/rules are corrected.

## ROI metric definitions

- `answer rate`
  - answered pilot calls divided by routed pilot calls
- `median time to answer`
  - median seconds from answerable inbound call to first assistant response
- `qualified outcome rate`
  - calls with usable customer, address, service type, and next action divided by eligible lead calls
- `booked or callback outcome rate`
  - eligible lead calls that become either a confirmed booking or a callback task
- `bad outcome rate`
  - calls marked by human review as wrong disposition, wrong extraction, or wrong escalation
- `recovered job examples`
  - customer-confirmed jobs attributable to after-hours or overflow capture

## Launch decision rule

Launch the pilot if:
- test calls pass
- one handoff path is live
- callback ownership is explicit
- transcript review path is in place

Do not delay launch for advanced reporting, extra integrations, or visual polish.
