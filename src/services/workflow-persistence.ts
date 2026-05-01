import type { AppConfig } from "../config.js";
import type { StructuredCallIntake, WorkflowOutcome } from "../domain/call-intake.js";
import type { StoredIntegrationSyncEvent } from "../domain/call-session.js";
import { buildJobberClientCreateSync } from "../integrations/jobber.js";
import type { AdminStore } from "../state/admin-store.js";
import type { CallSessionStore } from "../state/call-session-store.js";

interface PersistWorkflowOutcomeOptions {
  config: AppConfig;
  callSid: string;
  intake: StructuredCallIntake;
  outcome: WorkflowOutcome;
  store: CallSessionStore;
  adminStore: AdminStore;
}

function buildSmsCopy(outcome: WorkflowOutcome): string | undefined {
  if (!outcome.shouldSendSmsAcknowledgement) {
    return undefined;
  }

  switch (outcome.lead.disposition) {
    case "unsupported":
      return "Thanks for calling. Our office will review your request and follow up if we can help.";
    case "emergency_escalation":
      return "Thanks for calling. Your emergency request was captured and the on-call team will review it immediately.";
    default:
      return "Thanks for calling. We captured your request and the on-call team will call you back shortly.";
  }
}

function mapCallbackUrgency(urgency: StructuredCallIntake["urgency"]): "low" | "medium" | "high" | "emergency" {
  switch (urgency) {
    case "emergency":
      return "emergency";
    case "same_day":
      return "high";
    default:
      return "medium";
  }
}

function buildSyncEvents(callSid: string, outcome: WorkflowOutcome): StoredIntegrationSyncEvent[] {
  if (outcome.syncTarget === "jobber_client") {
    const sync = buildJobberClientCreateSync(callSid, outcome.lead, {
      accountId: outcome.lead.accountId,
      apiVersion: "2025-01-20",
    });

    return [
      {
        integrationKey: "jobber",
        externalObjectType: "client",
        idempotencyKey: sync.idempotencyKey,
        status: "pending",
        payloadSummary: `clientCreate for ${outcome.lead.callerName ?? outcome.lead.callerPhoneE164}`,
        requestPayload: sync.payload as unknown as Record<string, unknown>,
      },
    ];
  }

  if (outcome.syncTarget === "jobber_request") {
    return [
      {
        integrationKey: "jobber",
        externalObjectType: "request",
        idempotencyKey: `jobber:requestCreate:${outcome.lead.accountId}:${callSid}`,
        status: "pending",
        payloadSummary: `requestCreate for ${outcome.lead.serviceCategory}`,
        requestPayload: {
          lead: outcome.lead,
          summary: outcome.lead.summary,
        },
      },
    ];
  }

  return [];
}

export function persistWorkflowOutcome(options: PersistWorkflowOutcomeOptions): void {
  const { callSid, intake, outcome, store, adminStore } = options;
  const syncEvents = buildSyncEvents(callSid, outcome);
  const smsCopy = buildSmsCopy(outcome);

  const createdCallbackTask = outcome.callbackTask
    ? adminStore.createCallbackTask({
        callSid,
        accountId: outcome.callbackTask.accountId,
        customerName: outcome.lead.callerName ?? "Unknown caller",
        phone: outcome.lead.callerPhoneE164,
        requestedService: outcome.lead.serviceCategory,
        urgency: mapCallbackUrgency(outcome.lead.urgency),
        dueAt: new Date().toISOString(),
        ownerName: "Unassigned",
        status: "new",
        notes: outcome.callbackTask.notes,
      })
    : undefined;

  store.upsert(callSid, {
    disposition: outcome.lead.disposition === "book_now" ? "completed" : "callback_capture",
    confidenceState: outcome.lead.disposition === "book_now" ? "high" : "medium",
    requiresHumanReview: outcome.lead.disposition !== "book_now",
    syncStatus: syncEvents.length > 0 ? "pending" : "not_started",
    callbackStatus: createdCallbackTask ? "new" : "not_required",
    sentSmsCopy: smsCopy,
    structuredIntake: intake,
    leadRecord: outcome.lead,
    callbackTaskDraft: outcome.callbackTask ?? undefined,
    callbackTaskId: createdCallbackTask?.id,
    integrationSyncEvents: syncEvents,
  });

  if (createdCallbackTask) {
    store.appendEvent(callSid, "callback_task_created", {
      callbackTaskId: createdCallbackTask.id,
      priority: outcome.callbackTask?.priority,
    });
  }

  for (const syncEvent of syncEvents) {
    store.appendEvent(callSid, "integration_sync_enqueued", {
      integrationKey: syncEvent.integrationKey,
      externalObjectType: syncEvent.externalObjectType,
      idempotencyKey: syncEvent.idempotencyKey,
    });
  }
}
