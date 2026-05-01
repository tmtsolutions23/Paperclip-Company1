import type { AdminStore } from "../state/admin-store.js";
import type { CallSessionStore } from "../state/call-session-store.js";
import type { JobberTransport } from "../integrations/jobber-transport.js";
import type { SmsTransport } from "../integrations/twilio-sms.js";

interface DispatchFollowupsOptions {
  callSid: string;
  store: CallSessionStore;
  adminStore: AdminStore;
  smsTransport?: SmsTransport;
  jobberTransport?: JobberTransport;
}

export async function dispatchCallFollowups(options: DispatchFollowupsOptions): Promise<void> {
  const { callSid, store, adminStore, smsTransport, jobberTransport } = options;
  const session = store.get(callSid);
  if (!session) {
    return;
  }

  if (session.sentSmsCopy && session.from) {
    if (smsTransport) {
      try {
        const result = await smsTransport.sendMessage({
          to: session.from,
          body: session.sentSmsCopy,
          callSid,
        });
        store.appendEvent(callSid, "sms_ack_sent", {
          providerMessageId: result.providerMessageId,
        });
      } catch (error) {
        store.appendEvent(callSid, "sms_ack_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
        store.upsert(callSid, {
          requiresHumanReview: true,
        });
      }
    } else {
      store.appendEvent(callSid, "sms_ack_skipped", {
        reason: "transport_unconfigured",
      });
    }
  }

  const syncEvents = session.integrationSyncEvents ?? [];
  if (syncEvents.length === 0) {
    return;
  }

  if (!jobberTransport) {
    for (const syncEvent of syncEvents) {
      store.updateIntegrationSyncEvent(callSid, syncEvent.idempotencyKey, {
        status: "failed",
        errorMessage: "Jobber transport is not configured",
      });
      adminStore.createSyncFailure({
        accountId: session.accountId ?? "unknown",
        callSid,
        targetSystem: "Jobber",
        failureReason: "Jobber transport is not configured",
        retryCount: 0,
        lastAttemptAt: new Date().toISOString(),
        payloadSummary: syncEvent.payloadSummary,
        status: "pending",
      });
      store.appendEvent(callSid, "integration_sync_failed", {
        integrationKey: syncEvent.integrationKey,
        idempotencyKey: syncEvent.idempotencyKey,
        error: "Jobber transport is not configured",
      });
    }

    store.upsert(callSid, {
      syncStatus: "failed",
      requiresHumanReview: true,
    });
    return;
  }

  let sawFailure = false;

  for (const syncEvent of syncEvents) {
    try {
      const result = await jobberTransport.executeSync(syncEvent);
      store.updateIntegrationSyncEvent(callSid, syncEvent.idempotencyKey, {
        status: "completed",
        externalObjectId: result.externalObjectId,
        errorMessage: undefined,
      });
      store.appendEvent(callSid, "integration_sync_completed", {
        integrationKey: syncEvent.integrationKey,
        idempotencyKey: syncEvent.idempotencyKey,
        externalObjectId: result.externalObjectId,
      });
    } catch (error) {
      sawFailure = true;
      const message = error instanceof Error ? error.message : "unknown";
      store.updateIntegrationSyncEvent(callSid, syncEvent.idempotencyKey, {
        status: "failed",
        errorMessage: message,
      });
      adminStore.createSyncFailure({
        accountId: session.accountId ?? "unknown",
        callSid,
        targetSystem: "Jobber",
        failureReason: message,
        retryCount: 0,
        lastAttemptAt: new Date().toISOString(),
        payloadSummary: syncEvent.payloadSummary,
        status: "pending",
      });
      store.appendEvent(callSid, "integration_sync_failed", {
        integrationKey: syncEvent.integrationKey,
        idempotencyKey: syncEvent.idempotencyKey,
        error: message,
      });
    }
  }

  store.upsert(callSid, {
    syncStatus: sawFailure ? "failed" : "completed",
    requiresHumanReview: sawFailure ? true : session.requiresHumanReview,
  });
}
