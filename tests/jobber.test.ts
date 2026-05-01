import { describe, expect, it } from "vitest";

import type { LeadRecordDraft } from "../src/domain/call-intake.js";
import { buildJobberClientCreateSync } from "../src/integrations/jobber.js";

const lead: LeadRecordDraft = {
  accountId: "acct_123",
  callSessionId: "call_123",
  callerPhoneE164: "+15551230000",
  callerName: "Jamie Doe",
  email: "[email protected]",
  serviceAddress: "12 Main St",
  city: "Austin",
  postalCode: "78701",
  serviceCategory: "plumbing",
  urgency: "same_day",
  summary: "Kitchen sink leak",
  source: "voice_call",
  disposition: "callback",
  qualificationStatus: "review_required",
  transcriptExcerpt: "Caller reports active leak.",
};

describe("buildJobberClientCreateSync", () => {
  it("builds a stable idempotent Jobber client create request", () => {
    const sync = buildJobberClientCreateSync("lead_123", lead, {
      accountId: "acct_123",
      apiVersion: "2025-01-20",
    });

    expect(sync.integrationKey).toBe("jobber");
    expect(sync.externalEndpoint).toBe("https://api.getjobber.com/api/graphql");
    expect(sync.idempotencyKey).toBe("jobber:clientCreate:acct_123:lead_123");
    expect(sync.payload.headers["X-JOBBER-GRAPHQL-VERSION"]).toBe("2025-01-20");
    expect(sync.payload.query).toMatch(/clientCreate/);
    expect(sync.payload.variables.input.firstName).toBe("Jamie");
    expect(sync.payload.variables.input.lastName).toBe("Doe");
    expect(sync.payload.variables.input.phones[0]?.number).toBe("+15551230000");
    expect(sync.payload.variables.input.billingAddress?.postalCode).toBe("78701");
    expect(sync.payload.variables.input.notes).toMatch(/Disposition: callback/);
  });

  it("uses fallback names when the caller identity is missing", () => {
    const sync = buildJobberClientCreateSync(
      "lead_999",
      {
        ...lead,
        callerName: null,
        email: null,
        serviceAddress: null,
        city: null,
        postalCode: null,
      },
      {
        accountId: "acct_123",
        apiVersion: "2025-01-20",
      },
    );

    expect(sync.payload.variables.input.firstName).toBe("Unknown");
    expect(sync.payload.variables.input.lastName).toBe("Caller");
    expect(sync.payload.variables.input.emails).toEqual([]);
    expect(sync.payload.variables.input.billingAddress).toBeUndefined();
  });
});
