import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { AdminStore } from "./state/admin-store.js";

const config = {
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
  SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
  SENTRY_ENVIRONMENT: "test",
  TWILIO_RECORDING_CONSENT_LINE: "Consent line",
};

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

describe("voice edge app", () => {
  it("returns TwiML for inbound calls with a media stream and fallback recording", async () => {
    const app = buildApp(config);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/twilio/voice/inbound",
      payload: {
        CallSid: "CA123",
        From: "+15551234567",
        To: "+15557654321",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/xml");
    expect(response.body).toContain("<Connect>");
    expect(response.body).toContain("wss://voice.example.com/twilio/voice/stream?callSid=CA123");
    expect(response.body).toContain("<Record");
  });

  it("stores the call session created by the inbound webhook", async () => {
    const app = buildApp(config);
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/twilio/voice/inbound",
      payload: {
        CallSid: "CA456",
        From: "+15550001111",
        To: "+15559998888",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/calls/CA456",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.callSid).toBe("CA456");
    expect(body.from).toBe("+15550001111");
    expect(body.events[0].type).toBe("inbound_webhook_received");
    expect(body.promptVersionId).toBe("prompt-v1");
    expect(body.routingRuleVersionId).toBe("rules-pilot_account-v1");
  });

  it("exposes account and routing configuration through the admin API", async () => {
    const app = buildApp(config);
    apps.push(app);

    const accountsResponse = await app.inject({
      method: "GET",
      url: "/api/accounts",
    });

    expect(accountsResponse.statusCode).toBe(200);
    const accountsBody = accountsResponse.json();
    expect(accountsBody.accounts[0].id).toBe("pilot_account");

    const routingResponse = await app.inject({
      method: "PATCH",
      url: "/api/accounts/pilot_account/routing",
      payload: {
        serviceAreaZipCodes: ["60601", "60602"],
        emergencyKeywords: ["flood", "sparking panel"],
        defaultDisposition: "callback",
      },
    });

    expect(routingResponse.statusCode).toBe(200);
    const routingBody = routingResponse.json();
    expect(routingBody.serviceAreaZipCodes).toEqual(["60601", "60602"]);
    expect(routingBody.emergencyKeywords).toContain("sparking panel");
  });

  it("lists seeded sync failures and retries them through the admin API", async () => {
    const adminStore = new AdminStore();
    const app = buildApp(config, { adminStore });
    apps.push(app);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/sync-failures",
    });

    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json();
    expect(listBody.syncFailures).toHaveLength(1);

    const retryResponse = await app.inject({
      method: "POST",
      url: `/api/sync-failures/${listBody.syncFailures[0].id}/retry`,
    });

    expect(retryResponse.statusCode).toBe(200);
    const retryBody = retryResponse.json();
    expect(retryBody.retryCount).toBe(2);
    expect(retryBody.status).toBe("retrying");
  });

  it("renders the internal admin console page with pilot operations sections", async () => {
    const app = buildApp(config);
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/twilio/voice/inbound",
      payload: {
        CallSid: "CA789",
        From: "+15553334444",
        To: "+15557776666",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/internal/admin",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Pilot Operations Console");
    expect(response.body).toContain("Configured Accounts");
    expect(response.body).toContain("Call Review");
  });

  it("lets an operator update account and routing settings from HTML forms", async () => {
    const app = buildApp(config);
    apps.push(app);

    const accountResponse = await app.inject({
      method: "POST",
      url: "/accounts/pilot_account",
      payload: {
        name: "Pilot Plumbing North",
        timezone: "America/Denver",
        primaryPhoneNumber: "+15558889999",
        emergencyEscalationPhone: "+15557770000",
        smsAckTemplate: "Updated SMS copy",
        consentScript: "Updated consent line",
        overflowModeEnabled: "on",
      },
    });

    expect(accountResponse.statusCode).toBe(303);

    const routingResponse = await app.inject({
      method: "POST",
      url: "/accounts/pilot_account/routing",
      payload: {
        hours_monday: "07:00-11:00, 12:00-18:00",
        hours_tuesday: "07:00-18:00",
        hours_wednesday: "",
        hours_thursday: "07:00-18:00",
        hours_friday: "07:00-18:00",
        hours_saturday: "",
        hours_sunday: "",
        maxActiveCalls: "4",
        maxQueueDepth: "2",
        defaultDisposition: "callback",
        versionId: "rules-pilot_account-v2",
        serviceAreaZipCodes: "60601\n60610",
        supportedServiceTypes: "plumbing\nhvac",
        emergencyKeywords: "flood\nsmoke",
        unsupportedIntents: "billing",
      },
    });

    expect(routingResponse.statusCode).toBe(303);

    const accountDetail = await app.inject({
      method: "GET",
      url: "/api/accounts/pilot_account",
    });
    expect(accountDetail.json().name).toBe("Pilot Plumbing North");
    expect(accountDetail.json().timezone).toBe("America/Denver");

    const routingDetail = await app.inject({
      method: "GET",
      url: "/api/accounts/pilot_account/routing",
    });
    expect(routingDetail.json().businessHours.monday).toEqual([
      { start: "07:00", end: "11:00" },
      { start: "12:00", end: "18:00" },
    ]);
    expect(routingDetail.json().serviceAreaZipCodes).toEqual(["60601", "60610"]);
    expect(routingDetail.json().versionId).toBe("rules-pilot_account-v2");
  });

  it("lets an operator manage callback and sync failure exceptions from HTML forms", async () => {
    const adminStore = new AdminStore();
    const app = buildApp(config, { adminStore });
    apps.push(app);

    const callbacksResponse = await app.inject({
      method: "GET",
      url: "/api/callbacks",
    });
    const callbackId = callbacksResponse.json().callbacks[0].id;

    const callbackUpdate = await app.inject({
      method: "POST",
      url: `/callbacks/${callbackId}`,
      payload: {
        ownerName: "Dispatch Lead",
        status: "contacted",
        notes: "Confirmed 8am callback window",
        dueAt: "2026-05-01T08:00",
      },
    });
    expect(callbackUpdate.statusCode).toBe(303);

    const updatedCallbacks = await app.inject({
      method: "GET",
      url: "/api/callbacks",
    });
    expect(updatedCallbacks.json().callbacks[0].ownerName).toBe("Dispatch Lead");
    expect(updatedCallbacks.json().callbacks[0].status).toBe("contacted");

    const failuresResponse = await app.inject({
      method: "GET",
      url: "/api/sync-failures",
    });
    const syncFailureId = failuresResponse.json().syncFailures[0].id;

    const handledResponse = await app.inject({
      method: "POST",
      url: `/sync-failures/${syncFailureId}/actions`,
      payload: {
        action: "handled_manually",
      },
    });
    expect(handledResponse.statusCode).toBe(303);

    const updatedFailures = await app.inject({
      method: "GET",
      url: "/api/sync-failures",
    });
    expect(updatedFailures.json().syncFailures[0].status).toBe("handled_manually");
  });
});
