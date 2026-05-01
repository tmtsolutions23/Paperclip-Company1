# TMTA-7: Operator acceptance checklist

Date: 2026-04-30
Owner: CTO

Use this checklist before marking the admin console and pilot launch package ready.

## Admin console

- operator can create a new account without direct database access
- operator can set timezone, primary number, and escalation contact
- operator can configure business hours
- operator can configure service area zip codes
- operator can configure supported service types
- operator can review a saved routing rule set
- operator can open a call record and read transcript, disposition, and prompt version
- operator can find all callback tasks requiring action
- operator can identify failed syncs and retry or mark handled

## Pilot launch

- one Twilio number is attached to the account
- disclosure and consent copy is configured
- at least five scripted test calls were completed
- each test call produced a stored transcript and structured record
- SMS acknowledgement was confirmed where applicable
- callback ownership is assigned
- failed-sync review owner is assigned
- first transcript QA review date is scheduled

## Success thresholds

- new pilot account configured in under 60 minutes
- answerable test calls produce a first response in under 15 seconds median
- structured lead record is usable on at least 4 of 5 scripted test calls
- no emergency test call results in an autonomous booking
- failed syncs are visible in the console within one minute of failure

## Stop-ship conditions

- routing rules require direct SQL edits
- operators cannot tell which calls need action
- failed syncs are only visible in raw logs
- prompt or rules version cannot be tied to a call
- callback tasks are created without a usable contact path
