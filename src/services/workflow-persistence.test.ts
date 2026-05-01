import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import type { StructuredCallIntake } from "../domain/call-intake.js";
import { AdminStore } from "../state/admin-store.js";
import { CallSessionStore } from "../state/call-session-store.js";
import { createWorkflowOutcome } from "../workflows/lead-workflow.js";
import { persistWorkflowOutcome } from "./workflow-persistence.js";

const config: AppConfig = {
  PORT: 3000,
  PUBLIC_BASE_URL: "https://voice.example.com",
  DEFAULT_ACCOUNT_ID: "pilot_account",
  OPENAI_API_KEY: undefined,
  OPENAI_REALTIME_MODEL: "gpt-realtime",
  OPENAI_REALTIME_URL: "wss://api.openai.com/v1/realtime",
  REALTIME_VOICE: "alloy",
  TWILIO_ACCOUNT_SID: undefined,
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_SMS_FROM_E164: undefined,
  JOBBER_ACCESS_TOKEN: undefined,
  JOBBER_API_VERSION: "2025-01-20",
  SENTRY_DSN: undefined,
  SENTRY_ENVIRONMENT: "test",
  TWILIO_RECORDING_CONSENT_LINE: "Consent line",
};

function buildIntake(overrides: Partial<StructuredCallIntake> = {}): StructuredCallIntake {
  return {
    callSessionId: "CA1000",
    accountId: "pilot_account",
    callerPhoneE164: "+15551234567",
    callerName: "Morgan Lee",
    email: "[email protected]",
    serviceAddress: "123 Main St",
    city: "Chicago",
    postalCode: "60601",
    serviceCategory: "plumbing",
    summary: "Burst pipe in crawlspace",
    requestedDisposition: "callback",
    urgency: "same_day",
    inServiceArea: true,
    serviceTypeSupported: true,
    bookingIntentConfirmed: false,
    availabilityConfirmed: false,
    modelConfidence: 0.83,
    transcriptExcerpt: "Caller has a burst pipe and needs a callback.",
    ...overrides,
  };
}

describe("persistWorkflowOutcome", () => {
  it("stores structured intake, callback work, and a Jobber client sync artifact", () => {
    const adminStore = new AdminStore();
    const store = new CallSessionStore();
    store.upsert("CA1000", {
      accountId: "pilot_account",
      from: "+15551234567",
    });

    const intake = buildIntake();
    const outcome = createWorkflowOutcome(intake);

    persistWorkflowOutcome({
      config,
      callSid: "CA1000",
      intake,
      outcome,
      store,
      adminStore,
    });

    const session = store.get("CA1000");
    expect(session?.structuredIntake?.summary).toBe("Burst pipe in crawlspace");
    expect(session?.leadRecord?.callerName).toBe("Morgan Lee");
    expect(session?.callbackStatus).toBe("new");
    expect(session?.integrationSyncEvents?.[0]?.externalObjectType).toBe("client");
    expect(session?.sentSmsCopy).toContain("call you back shortly");

    const callback = adminStore.listCallbackTasks()[0];
    expect(callback?.callSid).toBe("CA1000");
    expect(callback?.customerName).toBe("Morgan Lee");
  });

  it("stores a request sync artifact without creating a callback for confirmed booking", () => {
    const adminStore = new AdminStore();
    const store = new CallSessionStore();
    store.upsert("CA2000", {
      accountId: "pilot_account",
      from: "+15557654321",
    });

    const intake = buildIntake({
      callSessionId: "CA2000",
      requestedDisposition: "book_now",
      bookingIntentConfirmed: true,
      availabilityConfirmed: true,
      modelConfidence: 0.95,
    });
    const outcome = createWorkflowOutcome(intake);

    persistWorkflowOutcome({
      config,
      callSid: "CA2000",
      intake,
      outcome,
      store,
      adminStore,
    });

    const session = store.get("CA2000");
    expect(session?.disposition).toBe("completed");
    expect(session?.callbackStatus).toBe("not_required");
    expect(session?.sentSmsCopy).toBeUndefined();
    expect(session?.integrationSyncEvents?.[0]?.externalObjectType).toBe("request");
    expect(adminStore.listCallbackTasks()).toHaveLength(0);
  });
});
