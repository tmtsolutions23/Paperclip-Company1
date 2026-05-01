export type CallDisposition =
  | "book_now"
  | "callback"
  | "unsupported"
  | "emergency_escalation";

export type LeadUrgency = "routine" | "same_day" | "emergency";

export interface StructuredCallIntake {
  callSessionId: string;
  accountId: string;
  callerPhoneE164: string;
  callerName?: string;
  email?: string;
  serviceAddress?: string;
  city?: string;
  postalCode?: string;
  serviceCategory: string;
  summary: string;
  requestedDisposition: CallDisposition;
  urgency: LeadUrgency;
  inServiceArea: boolean;
  serviceTypeSupported: boolean;
  bookingIntentConfirmed: boolean;
  availabilityConfirmed: boolean;
  modelConfidence: number;
  transcriptExcerpt?: string;
}

export interface LeadRecordDraft {
  accountId: string;
  callSessionId: string;
  callerPhoneE164: string;
  callerName: string | null;
  email: string | null;
  serviceAddress: string | null;
  city: string | null;
  postalCode: string | null;
  serviceCategory: string;
  urgency: LeadUrgency;
  summary: string;
  source: "voice_call";
  disposition: CallDisposition;
  qualificationStatus: "qualified" | "review_required" | "unsupported";
  transcriptExcerpt: string | null;
}

export interface CallbackTaskDraft {
  accountId: string;
  callSessionId: string;
  requestedForLeadPhone: string;
  reason:
    | "after_hours_followup"
    | "unsupported_request"
    | "emergency_review"
    | "low_confidence";
  priority: "normal" | "high" | "urgent";
  notes: string;
}

export interface WorkflowOutcome {
  lead: LeadRecordDraft;
  callbackTask: CallbackTaskDraft | null;
  shouldSendSmsAcknowledgement: boolean;
  syncTarget:
    | "jobber_client"
    | "jobber_request"
    | "manual_review"
    | "none";
}

