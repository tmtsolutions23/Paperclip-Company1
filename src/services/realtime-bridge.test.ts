import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { AdminStore } from "../state/admin-store.js";
import { CallSessionStore } from "../state/call-session-store.js";
import { RealtimeBridge } from "./realtime-bridge.js";

const config: AppConfig = {
  PORT: 3000,
  PUBLIC_BASE_URL: "https://voice.example.com",
  DEFAULT_ACCOUNT_ID: "pilot_account",
  OPENAI_API_KEY: "test-key",
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

describe("RealtimeBridge", () => {
  it("persists and dispatches workflow artifacts when OpenAI emits capture_intake arguments", async () => {
    const store = new CallSessionStore();
    const adminStore = new AdminStore();
    store.upsert("CA999", {
      accountId: "pilot_account",
      from: "+15559876543",
      transcript: ["caller: I have a burst pipe in the basement"],
    });

    const twilioSocket = {
      send: () => undefined,
      close: () => undefined,
      readyState: 1,
    } as never;
    const smsTransport = {
      sendMessage: async () => ({ providerMessageId: "SM123" }),
    };
    const jobberTransport = {
      executeSync: async () => ({ externalObjectId: "jobber_client_123" }),
    };

    const bridge = new RealtimeBridge({
      config,
      callSid: "CA999",
      twilioSocket,
      store,
      adminStore,
      smsTransport,
      jobberTransport,
    }) as unknown as { handleModelMessage(raw: string): Promise<void> };

    await bridge.handleModelMessage(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        arguments: JSON.stringify({
          caller_name: "Morgan Lee",
          service_address: "123 Main St",
          service_category: "plumbing",
          urgency: "urgent",
          summary: "Burst pipe in basement",
          disposition: "schedule_callback",
          in_service_area: true,
          service_type_supported: true,
          model_confidence: 0.88,
        }),
      }),
    );

    const session = store.get("CA999");
    expect(session?.leadRecord?.summary).toBe("Burst pipe in basement");
    expect(session?.callbackStatus).toBe("new");
    expect(session?.integrationSyncEvents?.[0]?.status).toBe("completed");
    expect(session?.syncStatus).toBe("completed");
    expect(session?.events.some((event) => event.type === "workflow_outcome_created")).toBe(true);
    expect(session?.events.some((event) => event.type === "sms_ack_sent")).toBe(true);
    expect(adminStore.listCallbackTasks()).toHaveLength(1);
  });
});
