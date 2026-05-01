import { describe, expect, it } from "vitest";

import { AdminStore } from "../state/admin-store.js";
import { CallSessionStore } from "../state/call-session-store.js";
import { createWorkflowOutcome } from "../workflows/lead-workflow.js";
import { persistWorkflowOutcome } from "./workflow-persistence.js";
import { dispatchCallFollowups } from "./outbound-dispatch.js";
import type { AppConfig } from "../config.js";
import type { StructuredCallIntake } from "../domain/call-intake.js";

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
    callSessionId: "CA3000",
    accountId: "pilot_account",
    callerPhoneE164: "+15550003333",
    callerName: "Taylor Smith",
    email: "[email protected]",
    serviceAddress: "5 Oak Ave",
    city: "Chicago",
    postalCode: "60610",
    serviceCategory: "hvac",
    summary: "No heat after hours",
    requestedDisposition: "callback",
    urgency: "same_day",
    inServiceArea: true,
    serviceTypeSupported: true,
    bookingIntentConfirmed: false,
    availabilityConfirmed: false,
    modelConfidence: 0.9,
    transcriptExcerpt: "Caller has no heat.",
    ...overrides,
  };
}

describe("dispatchCallFollowups", () => {
  it("sends SMS and completes Jobber sync when transports succeed", async () => {
    const store = new CallSessionStore();
    const adminStore = new AdminStore();
    store.upsert("CA3000", {
      accountId: "pilot_account",
      from: "+15550003333",
    });

    const intake = buildIntake();
    persistWorkflowOutcome({
      config,
      callSid: "CA3000",
      intake,
      outcome: createWorkflowOutcome(intake),
      store,
      adminStore,
    });

    await dispatchCallFollowups({
      callSid: "CA3000",
      store,
      adminStore,
      smsTransport: {
        sendMessage: async () => ({ providerMessageId: "SM555" }),
      },
      jobberTransport: {
        executeSync: async () => ({ externalObjectId: "jobber_client_555" }),
      },
    });

    const session = store.get("CA3000");
    expect(session?.syncStatus).toBe("completed");
    expect(session?.integrationSyncEvents?.[0]?.status).toBe("completed");
    expect(session?.events.some((event) => event.type === "sms_ack_sent")).toBe(true);
    expect(adminStore.listSyncFailures()).toHaveLength(0);
  });

  it("logs a sync failure when no Jobber transport is configured", async () => {
    const store = new CallSessionStore();
    const adminStore = new AdminStore();
    store.upsert("CA3001", {
      accountId: "pilot_account",
      from: "+15550004444",
    });

    const intake = buildIntake({
      callSessionId: "CA3001",
      summary: "Water heater leaking",
    });
    persistWorkflowOutcome({
      config,
      callSid: "CA3001",
      intake,
      outcome: createWorkflowOutcome(intake),
      store,
      adminStore,
    });

    await dispatchCallFollowups({
      callSid: "CA3001",
      store,
      adminStore,
      smsTransport: {
        sendMessage: async () => ({ providerMessageId: "SM556" }),
      },
    });

    const session = store.get("CA3001");
    expect(session?.syncStatus).toBe("failed");
    expect(session?.integrationSyncEvents?.[0]?.status).toBe("failed");
    expect(adminStore.listSyncFailures()).toHaveLength(1);
    expect(adminStore.listSyncFailures()[0]?.failureReason).toContain("not configured");
  });
});
