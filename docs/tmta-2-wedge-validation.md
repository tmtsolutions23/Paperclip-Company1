# TMTA-2: AI receptionist wedge validation

Date: 2026-04-30
Owner: CTO
Decision: Adjust, then go

## Executive call

The wedge is real, but the initial positioning needs to tighten.

Recommendation:
- Go forward with `AI receptionist + missed-call recovery + lead qualification`.
- Adjust the target from "home-service SMBs" broadly to `repair-first plumbing and HVAC SMBs with 5-20 techs, 1-3 office staff, and heavy inbound phone demand`.
- Start with `after-hours + overflow call capture` instead of a full front-desk replacement.

Why this is the right cut:
- Phone is still the dominant channel in residential trades. ServiceTitan's March 25, 2025 residential report says `64% of contractors still rely on phone calls as the dominant form of communication`.
- The pain is operational, not theoretical. Housecall Pro's April 10, 2024 missed-calls writeup cites Invoca research that home-service businesses miss `around 27%` of inbound calls.
- Consumers punish slow response. Jobber reported that `50%` of consumers are deterred by slow response times from small home-service businesses.
- Homeowners increasingly accept AI at the front door if it is fast and useful. Housecall Pro's 2025 homeowner survey says `53%` are comfortable with AI handling initial inquiries.
- Plumbing and HVAC sit in the most urgent repair categories. Nationwide's 2025 homeowner report shows plumbing leaks/pipe bursts among the most common repair issues (`38%`) and HVAC among the most costly (`39%`).

## Chosen ICP

Initial ICP:
- US residential plumbing and HVAC companies
- 5-20 field technicians
- 1-3 CSRs / office staff
- Roughly $1M-$8M revenue
- High share of repair and replacement work, not new construction
- Inbound leads come mainly from phone, Google, and referrals
- Already using a field-service stack, but not getting reliable 24/7 call coverage

Buyer:
- Owner-operator or GM in smaller shops
- Office manager / dispatcher in slightly larger shops

Why this ICP first:
- Urgency is high: burst pipes, no-heat/no-cool, and water-heater failures create immediate call intent.
- A missed call has high economic value because these are high-intent, high-AOV jobs.
- These teams are small enough that overflow and after-hours coverage is painful, but large enough to pay for a point solution that books revenue.
- The implementation path is simpler than for enterprise consolidators and less fragmented than for solo operators.

## Top 3 pains

### 1. Missed after-hours and overflow calls turn paid demand into lost revenue

What happens:
- Owners and small office teams cannot answer every inbound call during jobs, lunch gaps, evenings, weekends, and weather spikes.
- The same business may be paying for LSA, SEO, or referral generation, then leaking that spend at the phone step.

Why this wedge beats alternatives:
- Better than voicemail: it responds immediately.
- Better than a generic answering service: it can qualify, book, and write structured data back to the system.
- Better than a full FSM replacement sale: it attacks the highest-value leak without forcing workflow migration first.

### 2. Office staff spend too much time on repetitive intake and phone tag

What happens:
- CSRs repeat the same intake questions, manually check service area/job type, and chase voicemails.
- Jobber's 2026 trends report says jobsite management and customer communication take up the most time in day-to-day operations.

Why this wedge beats alternatives:
- Better than adding headcount: lower fixed cost and immediate 24/7 coverage.
- Better than generic AI voice tools: the workflow can be constrained around trade-specific job types, escalation rules, and dispatch boundaries.

### 3. Lead qualification and follow-up are inconsistent

What happens:
- Shops lack consistent intake for new leads, emergency triage, membership status, and callback priority.
- Thriving contractors distinguish themselves on follow-up and smooth customer experience, while struggling shops leave money in unsold estimates and weak process.

Why this wedge beats alternatives:
- Better than "answer only" services because it creates structured next actions.
- Better than broad CRM platforms as an entry wedge because it can layer into the current stack and prove ROI before deeper workflow automation.

## Why not broader nearby alternatives

Do not start with:
- All home-service SMBs: too broad, too many job types, too much intake variance.
- Full virtual front-desk replacement: too much trust required on day one.
- General SMB receptionist: lower urgency, weaker ROI, slower sales.
- Enterprise ServiceTitan-first rollout: incumbents already have strong native AI claims and longer procurement cycles.

The winning position is:
- `overflow + after-hours revenue capture for urgent repair shops`
- sold as a revenue tool first, not an AI platform first

## Narrow MVP for first pilot

MVP goal:
- Catch the missed revenue path with the smallest operational footprint.

Include:
- Answer inbound calls after hours and on configurable overflow
- Detect new lead vs existing customer from caller ID / lookup
- Collect name, phone, address, service type, urgency, and brief problem summary
- Enforce service-area and job-type rules
- Book a limited set of appointments or create a callback task
- Send SMS confirmation / callback acknowledgement
- Push call transcript, summary, and disposition into the team's existing system
- Escalate to a human for emergencies, VIP customers, or unsupported intents

Do not include in v1:
- Full dispatch optimization
- Complex rescheduling trees
- Outbound nurture campaigns
- Multi-location franchise logic
- Broad channel support beyond phone + SMS follow-up

## Success metrics

### First 30 days per pilot

- `>90%` answer rate on routed calls
- `<15 seconds` median time to answer
- `>60%` of eligible new-lead calls reach qualified outcome
- `>35%` of eligible new-lead calls become booked jobs or scheduled callbacks
- `>80%` of calls produce a usable structured summary in the destination system
- `<10%` human-reported bad bookings or bad classifications
- At least `1 clear recovered-job example per week` attributable to after-hours or overflow handling

### First 3 paying customers

- 3 pilots convert to paid within 45 days
- At least 2 customers report positive ROI inside the first billing cycle
- Gross retention at customer 2 and customer 3 onboarding is `100%`
- Each customer keeps the product active on core numbers, not just a sandbox line
- At least one repeatable integration pattern emerges for the next 5 customers

## Cost, complexity, risk, impact

Cost:
- Moderate if positioned as a narrow integration product.
- High if we try to own the full call center and dispatch workflow immediately.

Complexity:
- Moderate for after-hours/overflow routing, structured intake, summaries, and booking/callback creation.
- High once we expand into full scheduling, dispatch constraints, and broad CRM coverage.

Delivery risk:
- Main risk is not demand. It is accuracy and trust on live calls.
- Secondary risk is incumbent competition from Housecall Pro, Jobber, and ServiceTitan, all of which now market AI voice/receptionist capabilities.

Expected customer impact:
- High if we recover even a small number of urgent missed calls per month.
- Strongest ROI story is "we paid for ourselves with one recovered plumbing or HVAC job."

## Final recommendation

Recommendation for TMTA-3 and downstream build planning:
- Proceed with the wedge.
- Narrow the ICP to `repair-first plumbing + HVAC SMBs`.
- Narrow the product to `after-hours + overflow AI call handling with qualification, booking/callback creation, and CRM sync`.
- Treat this as a `revenue recovery product`, not a general receptionist assistant.

If we cannot deliver reliable booking/callback handoff into the customer's existing workflow, we should not build broader features yet.

## Sources

- ServiceTitan residential industry report press release, March 25, 2025: https://www.servicetitan.com/press/residential-industry-report-2025
- ServiceTitan 2026 residential AI report press release, April 7, 2026: https://www.servicetitan.com/press/servicetitan-report-finds-74-of-residential-contractors-see-ai-as-key
- ServiceTitan AI Voice Agent product page: https://www.servicetitan.com/features/pro/voice-agent
- Housecall Pro missed calls article, April 10, 2024: https://www.housecallpro.com/resources/missed-calls/
- Housecall Pro homeowner customer service report, 2025: https://www.housecallpro.com/resources/home-service-customer-service-report-trends-statistics/
- Housecall Pro homepage, accessed 2026-04-30: https://www.housecallpro.com/
- Jobber consumer survey press release: https://www.getjobber.com/about/media/jobber-survey-reveals-92-of-consumers-believe-small-businesses-are-important-to-their-communitys-health/
- Jobber 2026 home service trends report: https://www.getjobber.com/home-service-trends-report/
- Jobber AI Receptionist / help docs: https://www.getjobber.com/features/ai-receptionist and https://help.getjobber.com/hc/en-us/articles/25315927533847-Jobber-AI-Receptionist
- Nationwide 2025 homeowner report PDF: https://news.nationwide.com/download/388cf87e-65b2-4935-ad1e-e872883aa63a/2025nationwidehomeownersreport.pdf
