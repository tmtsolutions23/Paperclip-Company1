import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { CallSessionStore } from "./state/call-session-store.js";
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
const tenantViewerHeaders = {
  "x-viewer-user-id": "user-pilot-admin",
  "x-viewer-email": "ops@pilotplumbing.example",
};

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

  it("redirects internal admin traffic to the React cutover route", async () => {
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

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/ui/overview");
  });

  it("lets an operator update account and routing settings from HTML forms", async () => {
    const app = buildApp(config);
    apps.push(app);

    const accountResponse = await app.inject({
      method: "POST",
      url: "/accounts/pilot_account",
      payload: {
        name: "Pilot Plumbing North",
        slug: "pilot-plumbing-north",
        publicHost: "north.voice.example.com",
        status: "active",
        brandName: "Pilot Plumbing North",
        timezone: "America/Denver",
        primaryPhoneNumber: "+15558889999",
        emergencyEscalationPhone: "+15557770000",
        smsAckTemplate: "Updated SMS copy",
        consentScript: "Updated consent line",
        brandTheme: JSON.stringify({ accent: "#114488" }),
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
    expect(accountDetail.json().slug).toBe("pilot-plumbing-north");
    expect(accountDetail.json().publicHost).toBe("north.voice.example.com");
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

  it("redirects callback and sync list pages to React cutover routes", async () => {
    const adminStore = new AdminStore();
    const callSessionStore = new CallSessionStore();
    callSessionStore.upsert("CA_seed_callback", {
      accountId: "pilot_account",
      from: "+15550002222",
      promptVersionId: "prompt-v3",
      routingRuleVersionId: "rules-pilot_account-v4",
      confidenceState: "low",
      requiresHumanReview: true,
      syncStatus: "failed",
      callbackStatus: "assigned",
    });

    const app = buildApp(config, { adminStore, callSessionStore });
    apps.push(app);

    const callbacksPage = await app.inject({
      method: "GET",
      url: "/callbacks",
    });

    expect(callbacksPage.statusCode).toBe(303);
    expect(callbacksPage.headers.location).toBe("/ui/callbacks");

    const syncFailuresPage = await app.inject({
      method: "GET",
      url: "/sync-failures",
    });

    expect(syncFailuresPage.statusCode).toBe(303);
    expect(syncFailuresPage.headers.location).toBe("/ui/sync");
  });

  it("surfaces review context and linked operator paths on the call detail page", async () => {
    const adminStore = new AdminStore();
    const callSessionStore = new CallSessionStore();
    callSessionStore.upsert("CA_review", {
      accountId: "pilot_account",
      from: "+15553334444",
      disposition: "callback_capture",
      promptVersionId: "prompt-v7",
      routingRuleVersionId: "rules-pilot_account-v9",
      confidenceState: "low",
      requiresHumanReview: true,
      syncStatus: "failed",
      callbackStatus: "assigned",
      fallbackReason: "Realtime bridge dropped before tool handoff",
      transcript: ["Caller: basement flood", "AI: capturing callback details"],
    });
    adminStore.seedCallbackTask({
      accountId: "pilot_account",
      callSid: "CA_review",
      customerName: "Riley Chen",
      phone: "+15550008888",
      requestedService: "basement flood",
      urgency: "emergency",
      dueAt: "2026-05-01T09:00:00.000Z",
      ownerName: "Dispatch lead",
      status: "assigned",
      notes: "Escalate after transcript review.",
    });
    adminStore.seedSyncFailure({
      accountId: "pilot_account",
      callSid: "CA_review",
      targetSystem: "Jobber",
      failureReason: "Missing service address",
      retryCount: 2,
      lastAttemptAt: "2026-05-01T08:45:00.000Z",
      payloadSummary: "lead:create Riley Chen basement flood",
      status: "pending",
      sentryEventId: "sentry-review-1",
    });

    const app = buildApp(config, { adminStore, callSessionStore });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/calls/CA_review",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Review Required");
    expect(response.body).toContain("prompt-v7");
    expect(response.body).toContain("rules-pilot_account-v9");
    expect(response.body).toContain('href="/accounts/pilot_account/routing"');
    expect(response.body).toContain('href="/callbacks"');
    expect(response.body).toContain('href="/sync-failures"');
  });

  it("resolves public tenants from host first and slug path as fallback", async () => {
    const app = buildApp(config);
    apps.push(app);

    const hostResponse = await app.inject({
      method: "GET",
      url: "/api/public/resolve?host=pilot-plumbing.voice.example.com",
    });

    expect(hostResponse.statusCode).toBe(200);
    expect(hostResponse.json()).toMatchObject({
      accountSlug: "pilot-plumbing",
      source: "host",
    });

    const slugPage = await app.inject({
      method: "GET",
      url: "/sites/pilot-plumbing",
    });

    expect(slugPage.statusCode).toBe(200);
    expect(slugPage.body).toContain("Pilot Plumbing");
    expect(slugPage.body).toContain("Never miss the service calls that turn into revenue.");
    expect(slugPage.body).toContain("Book a demo");
  });

  it("renders the public landing page from the root route", async () => {
    const app = buildApp(config);
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("How it works");
    expect(response.body).toContain("Built for real service workflows");
    expect(response.body).toContain("Request demo");
  });

  it("redirects account list and creation routes to React cutover paths", async () => {
    const app = buildApp(config);
    apps.push(app);

    const accountsPage = await app.inject({
      method: "GET",
      url: "/accounts",
    });

    expect(accountsPage.statusCode).toBe(303);
    expect(accountsPage.headers.location).toBe("/ui/accounts");

    const newAccountPage = await app.inject({
      method: "GET",
      url: "/accounts/new",
    });

    expect(newAccountPage.statusCode).toBe(303);
    expect(newAccountPage.headers.location).toBe("/ui/accounts/new");
  });

  it("redirects a single-membership user straight to the tenant admin path", async () => {
    const app = buildApp(config);
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/login/resolve",
      payload: {
        userId: "user-pilot-admin",
        email: " Ops@PilotPlumbing.Example ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      outcome: "redirect",
      location: "/app/pilot-plumbing",
    });
  });

  it("sends multi-membership users to account selection unless a default or last-used slug resolves them", async () => {
    const adminStore = new AdminStore();
    adminStore.seedAccount({
      id: "pilot_account_two",
      name: "Pilot HVAC",
      slug: "pilot-hvac",
      publicHost: "pilot-hvac.voice.example.com",
      status: "active",
      brandName: "Pilot HVAC",
      brandTheme: {},
      timezone: "America/Chicago",
      primaryPhoneNumber: "+15550003333",
      overflowModeEnabled: true,
      afterHoursScheduleEnabled: true,
      emergencyEscalationPhone: "+15550004444",
      smsAckTemplate: "HVAC SMS",
      consentScript: "HVAC consent",
    });
    adminStore.seedUserMembership({
      userId: "user-multi",
      accountId: "pilot_account",
      emailNormalized: "multi@example.com",
      role: "admin",
      isDefault: false,
    });
    adminStore.seedUserMembership({
      userId: "user-multi",
      accountId: "pilot_account_two",
      emailNormalized: "multi@example.com",
      role: "admin",
      isDefault: false,
    });

    const app = buildApp(config, { adminStore });
    apps.push(app);

    const unresolved = await app.inject({
      method: "POST",
      url: "/api/login/resolve",
      payload: {
        userId: "user-multi",
        email: "multi@example.com",
      },
    });

    expect(unresolved.statusCode).toBe(200);
    expect(unresolved.json()).toMatchObject({
      outcome: "select_account",
      location: "/app/select-account",
    });

    const lastUsed = await app.inject({
      method: "POST",
      url: "/api/login/resolve",
      payload: {
        userId: "user-multi",
        email: "multi@example.com",
        lastAccountSlug: "pilot-hvac",
      },
    });

    expect(lastUsed.json()).toMatchObject({
      outcome: "redirect",
      location: "/app/pilot-hvac",
    });
  });

  it("rejects tenant admin access when the signed-in viewer lacks membership for that slug", async () => {
    const adminStore = new AdminStore();
    adminStore.seedAccount({
      id: "pilot_account_two",
      name: "Pilot HVAC",
      slug: "pilot-hvac",
      publicHost: "pilot-hvac.voice.example.com",
      status: "active",
      brandName: "Pilot HVAC",
      brandTheme: {},
      timezone: "America/Chicago",
      primaryPhoneNumber: "+15550003333",
      overflowModeEnabled: true,
      afterHoursScheduleEnabled: true,
      emergencyEscalationPhone: "+15550004444",
      smsAckTemplate: "HVAC SMS",
      consentScript: "HVAC consent",
    });

    const app = buildApp(config, { adminStore });
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/app/pilot-hvac",
      headers: tenantViewerHeaders,
    });

    expect(response.statusCode).toBe(403);
  });

  it("serves tenant-scoped admin pages and rewrites links under /app/:accountSlug", async () => {
    const adminStore = new AdminStore();
    const callSessionStore = new CallSessionStore();
    callSessionStore.upsert("CA_scoped", {
      accountId: "pilot_account",
      from: "+15551110000",
      disposition: "callback_capture",
      promptVersionId: "prompt-v4",
      routingRuleVersionId: "rules-pilot_account-v4",
      confidenceState: "low",
      requiresHumanReview: true,
      syncStatus: "failed",
      callbackStatus: "assigned",
    });

    const app = buildApp(config, { adminStore, callSessionStore });
    apps.push(app);

    const callsPage = await app.inject({
      method: "GET",
      url: "/app/pilot-plumbing/calls",
      headers: tenantViewerHeaders,
    });

    expect(callsPage.statusCode).toBe(200);
    expect(callsPage.body).toContain('href="/app/pilot-plumbing/calls/CA_scoped"');
    expect(callsPage.body).toContain('href="/app/pilot-plumbing/accounts"');

    const callbacksPage = await app.inject({
      method: "GET",
      url: "/app/pilot-plumbing/callbacks",
      headers: tenantViewerHeaders,
    });

    expect(callbacksPage.statusCode).toBe(200);
    expect(callbacksPage.body).toContain('action="/app/pilot-plumbing/callbacks/');
  });

  it("enforces tenant scope on the new admin APIs and forms", async () => {
    const adminStore = new AdminStore();
    adminStore.seedAccount({
      id: "pilot_account_two",
      name: "Pilot HVAC",
      slug: "pilot-hvac",
      publicHost: "pilot-hvac.voice.example.com",
      status: "active",
      brandName: "Pilot HVAC",
      brandTheme: {},
      timezone: "America/Chicago",
      primaryPhoneNumber: "+15550003333",
      overflowModeEnabled: true,
      afterHoursScheduleEnabled: true,
      emergencyEscalationPhone: "+15550004444",
      smsAckTemplate: "HVAC SMS",
      consentScript: "HVAC consent",
    });

    const app = buildApp(config, { adminStore });
    apps.push(app);

    const scopedAccount = await app.inject({
      method: "GET",
      url: "/api/app/pilot-plumbing/account",
      headers: tenantViewerHeaders,
    });

    expect(scopedAccount.statusCode).toBe(200);
    expect(scopedAccount.json().slug).toBe("pilot-plumbing");

    const forbiddenAccount = await app.inject({
      method: "GET",
      url: "/api/app/pilot-hvac/account",
      headers: tenantViewerHeaders,
    });

    expect(forbiddenAccount.statusCode).toBe(403);

    const routedFormUpdate = await app.inject({
      method: "POST",
      url: "/app/pilot-plumbing/routing",
      headers: tenantViewerHeaders,
      payload: {
        hours_monday: "06:00-12:00",
        hours_tuesday: "",
        hours_wednesday: "",
        hours_thursday: "",
        hours_friday: "",
        hours_saturday: "",
        hours_sunday: "",
        maxActiveCalls: "5",
        maxQueueDepth: "1",
        defaultDisposition: "callback",
        versionId: "rules-pilot_account-v5",
        serviceAreaZipCodes: "60601",
        supportedServiceTypes: "plumbing",
        emergencyKeywords: "flood",
        unsupportedIntents: "billing",
      },
    });

    expect(routedFormUpdate.statusCode).toBe(303);
    expect(routedFormUpdate.headers.location).toBe("/app/pilot-plumbing/routing");

    const scopedRouting = await app.inject({
      method: "GET",
      url: "/api/app/pilot-plumbing/routing",
      headers: tenantViewerHeaders,
    });

    expect(scopedRouting.json().versionId).toBe("rules-pilot_account-v5");
    expect(scopedRouting.json().overflowThresholds.maxActiveCalls).toBe(5);
  });
});
