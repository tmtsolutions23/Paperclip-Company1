import type {
  CallbackTaskDraft,
  CallDisposition,
  LeadRecordDraft,
  StructuredCallIntake,
  WorkflowOutcome,
} from "../domain/call-intake.js";

const LOW_CONFIDENCE_THRESHOLD = 0.7;

function deriveDisposition(intake: StructuredCallIntake): CallDisposition {
  if (!intake.inServiceArea || !intake.serviceTypeSupported) {
    return "unsupported";
  }

  if (intake.urgency === "emergency") {
    return "emergency_escalation";
  }

  if (
    intake.requestedDisposition === "book_now" &&
    intake.bookingIntentConfirmed &&
    intake.availabilityConfirmed &&
    intake.modelConfidence >= LOW_CONFIDENCE_THRESHOLD
  ) {
    return "book_now";
  }

  return "callback";
}

function buildLeadDraft(
  intake: StructuredCallIntake,
  disposition: CallDisposition,
): LeadRecordDraft {
  const qualificationStatus =
    disposition === "unsupported"
      ? "unsupported"
      : disposition === "book_now"
        ? "qualified"
        : "review_required";

  return {
    accountId: intake.accountId,
    callSessionId: intake.callSessionId,
    callerPhoneE164: intake.callerPhoneE164,
    callerName: intake.callerName ?? null,
    email: intake.email ?? null,
    serviceAddress: intake.serviceAddress ?? null,
    city: intake.city ?? null,
    postalCode: intake.postalCode ?? null,
    serviceCategory: intake.serviceCategory,
    urgency: intake.urgency,
    summary: intake.summary,
    source: "voice_call",
    disposition,
    qualificationStatus,
    transcriptExcerpt: intake.transcriptExcerpt ?? null,
  };
}

function buildCallbackTask(
  intake: StructuredCallIntake,
  disposition: CallDisposition,
): CallbackTaskDraft | null {
  if (disposition === "book_now") {
    return null;
  }

  if (disposition === "unsupported") {
    return {
      accountId: intake.accountId,
      callSessionId: intake.callSessionId,
      requestedForLeadPhone: intake.callerPhoneE164,
      reason: "unsupported_request",
      priority: "normal",
      notes:
        "Caller requested unsupported geography or service type. Manual outreach recommended.",
    };
  }

  if (disposition === "emergency_escalation") {
    return {
      accountId: intake.accountId,
      callSessionId: intake.callSessionId,
      requestedForLeadPhone: intake.callerPhoneE164,
      reason: "emergency_review",
      priority: "urgent",
      notes:
        "Emergency signal detected. Follow documented escalation path and contact caller immediately.",
    };
  }

  return {
    accountId: intake.accountId,
    callSessionId: intake.callSessionId,
    requestedForLeadPhone: intake.callerPhoneE164,
    reason:
      intake.modelConfidence < LOW_CONFIDENCE_THRESHOLD
        ? "low_confidence"
        : "after_hours_followup",
    priority: intake.modelConfidence < LOW_CONFIDENCE_THRESHOLD ? "high" : "normal",
    notes:
      intake.modelConfidence < LOW_CONFIDENCE_THRESHOLD
        ? "AI intake confidence was below threshold. Review transcript before calling back."
        : "Capture callback because autonomous booking was not confirmed.",
  };
}

export function createWorkflowOutcome(
  intake: StructuredCallIntake,
): WorkflowOutcome {
  const disposition = deriveDisposition(intake);
  const callbackTask = buildCallbackTask(intake, disposition);
  const lead = buildLeadDraft(intake, disposition);

  return {
    lead,
    callbackTask,
    shouldSendSmsAcknowledgement: disposition !== "book_now",
    syncTarget:
      disposition === "book_now"
        ? "jobber_request"
        : disposition === "callback"
          ? "jobber_client"
          : disposition === "emergency_escalation"
            ? "manual_review"
            : "none",
  };
}
