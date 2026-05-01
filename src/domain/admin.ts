export interface Account {
  id: string;
  name: string;
  slug: string;
  publicHost?: string;
  status: "active" | "inactive";
  brandName?: string;
  brandTheme?: Record<string, string>;
  timezone: string;
  primaryPhoneNumber: string;
  overflowModeEnabled: boolean;
  afterHoursScheduleEnabled: boolean;
  emergencyEscalationPhone: string;
  smsAckTemplate: string;
  consentScript: string;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingRule {
  accountId: string;
  businessHours: Record<string, Array<{ start: string; end: string }>>;
  overflowThresholds: {
    maxActiveCalls: number;
    maxQueueDepth: number;
  };
  serviceAreaZipCodes: string[];
  supportedServiceTypes: string[];
  emergencyKeywords: string[];
  unsupportedIntents: string[];
  defaultDisposition: "callback" | "book";
  versionId: string;
  deployedAt: string;
  updatedAt: string;
}

export type CallbackStatus = "new" | "assigned" | "contacted" | "resolved" | "closed_lost";

export interface CallbackTask {
  id: string;
  callSid?: string;
  accountId: string;
  customerName: string;
  phone: string;
  requestedService: string;
  urgency: "low" | "medium" | "high" | "emergency";
  dueAt: string;
  ownerName: string;
  status: CallbackStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export type SyncFailureStatus = "pending" | "retrying" | "handled_manually" | "resolved";

export interface SyncFailure {
  id: string;
  callSid?: string;
  accountId: string;
  targetSystem: string;
  failureReason: string;
  retryCount: number;
  lastAttemptAt: string;
  payloadSummary: string;
  status: SyncFailureStatus;
  sentryEventId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  entityType: "account" | "routing_rule" | "callback_task" | "sync_failure" | "user_membership";
  entityId: string;
  action: string;
  at: string;
  detail?: Record<string, unknown>;
}

export interface UserMembership {
  id: string;
  userId: string;
  accountId: string;
  emailNormalized: string;
  role: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
