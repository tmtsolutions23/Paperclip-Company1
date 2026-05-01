import { describe, expect, it } from "vitest";

import type { StructuredCallIntake } from "../src/domain/call-intake.js";
import { createWorkflowOutcome } from "../src/workflows/lead-workflow.js";

const baseIntake: StructuredCallIntake = {
  callSessionId: "call_123",
  accountId: "acct_123",
  callerPhoneE164: "+15551230000",
  callerName: "Jamie Doe",
  email: "[email protected]",
  serviceAddress: "12 Main St",
  city: "Austin",
  postalCode: "78701",
  serviceCategory: "plumbing",
  summary: "Kitchen sink leak",
  requestedDisposition: "book_now",
  urgency: "same_day",
  inServiceArea: true,
  serviceTypeSupported: true,
  bookingIntentConfirmed: true,
  availabilityConfirmed: true,
  modelConfidence: 0.91,
  transcriptExcerpt: "Caller reports active leak.",
};

describe("createWorkflowOutcome", () => {
  it("keeps confirmed book-now calls eligible for external sync", () => {
    const outcome = createWorkflowOutcome(baseIntake);

    expect(outcome.lead.disposition).toBe("book_now");
    expect(outcome.lead.qualificationStatus).toBe("qualified");
    expect(outcome.callbackTask).toBeNull();
    expect(outcome.syncTarget).toBe("jobber_request");
    expect(outcome.shouldSendSmsAcknowledgement).toBe(false);
  });

  it("falls back to callback when confidence is low", () => {
    const outcome = createWorkflowOutcome({
      ...baseIntake,
      modelConfidence: 0.42,
    });

    expect(outcome.lead.disposition).toBe("callback");
    expect(outcome.callbackTask?.reason).toBe("low_confidence");
    expect(outcome.callbackTask?.priority).toBe("high");
    expect(outcome.shouldSendSmsAcknowledgement).toBe(true);
  });

  it("marks unsupported service areas for manual follow-up", () => {
    const outcome = createWorkflowOutcome({
      ...baseIntake,
      inServiceArea: false,
    });

    expect(outcome.lead.disposition).toBe("unsupported");
    expect(outcome.lead.qualificationStatus).toBe("unsupported");
    expect(outcome.callbackTask?.reason).toBe("unsupported_request");
    expect(outcome.syncTarget).toBe("none");
  });

  it("routes emergencies to urgent manual review", () => {
    const outcome = createWorkflowOutcome({
      ...baseIntake,
      urgency: "emergency",
      requestedDisposition: "callback",
    });

    expect(outcome.lead.disposition).toBe("emergency_escalation");
    expect(outcome.callbackTask?.reason).toBe("emergency_review");
    expect(outcome.callbackTask?.priority).toBe("urgent");
    expect(outcome.syncTarget).toBe("manual_review");
  });
});
