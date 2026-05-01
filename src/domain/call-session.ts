import type { CallbackTaskDraft, LeadRecordDraft, StructuredCallIntake } from "./call-intake.js";

export type CallDisposition =
  | "live_conversation"
  | "callback_capture"
  | "voicemail_capture"
  | "completed"
  | "failed";

export interface LatencyMetric {
  name: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
}

export interface CallEvent {
  at: string;
  type: string;
  detail?: Record<string, unknown>;
}

export interface StoredIntegrationSyncEvent {
  integrationKey: "jobber";
  externalObjectType: "client" | "request";
  idempotencyKey: string;
  status: "pending" | "completed" | "failed";
  payloadSummary: string;
  requestPayload: Record<string, unknown>;
  externalObjectId?: string;
  errorMessage?: string;
}

export interface CallSession {
  callSid: string;
  accountId?: string;
  streamSid?: string;
  accountSid?: string;
  from?: string;
  to?: string;
  startedAt: string;
  updatedAt: string;
  disposition: CallDisposition;
  promptVersionId?: string;
  routingRuleVersionId?: string;
  confidenceState?: "low" | "medium" | "high";
  requiresHumanReview?: boolean;
  syncStatus?: "not_started" | "pending" | "failed" | "completed";
  callbackStatus?: "not_required" | "new" | "assigned" | "resolved";
  sentSmsCopy?: string;
  fallbackReason?: string;
  structuredIntake?: StructuredCallIntake;
  leadRecord?: LeadRecordDraft;
  callbackTaskDraft?: CallbackTaskDraft;
  callbackTaskId?: string;
  integrationSyncEvents?: StoredIntegrationSyncEvent[];
  transcript: string[];
  events: CallEvent[];
  latencyMetrics: LatencyMetric[];
}
