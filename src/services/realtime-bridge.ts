import WebSocket from "ws";
import type { AppConfig } from "../config.js";
import type { JobberTransport } from "../integrations/jobber-transport.js";
import type { SmsTransport } from "../integrations/twilio-sms.js";
import type { StructuredCallIntake } from "../domain/call-intake.js";
import type { AdminStore } from "../state/admin-store.js";
import type { CallSessionStore } from "../state/call-session-store.js";
import { dispatchCallFollowups } from "./outbound-dispatch.js";
import { persistWorkflowOutcome } from "./workflow-persistence.js";
import { createWorkflowOutcome } from "../workflows/lead-workflow.js";

interface BridgeOptions {
  config: AppConfig;
  callSid: string;
  twilioSocket: WebSocket;
  store: CallSessionStore;
  adminStore: AdminStore;
  smsTransport?: SmsTransport;
  jobberTransport?: JobberTransport;
}

interface TwilioMessage {
  event: "start" | "media" | "stop";
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    callSid: string;
    accountSid?: string;
    tracks?: string[];
    mediaFormat?: Record<string, unknown>;
    customParameters?: Record<string, string>;
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  stop?: {
    accountSid?: string;
    callSid?: string;
  };
}

function asEventDetail(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return value as Record<string, unknown>;
}

export class RealtimeBridge {
  private readonly config: AppConfig;
  private readonly callSid: string;
  private readonly twilioSocket: WebSocket;
  private readonly store: CallSessionStore;
  private readonly adminStore: AdminStore;
  private readonly smsTransport?: SmsTransport;
  private readonly jobberTransport?: JobberTransport;
  private modelSocket?: WebSocket;
  private streamSid?: string;
  private closed = false;
  private readonly connectMetricName: string;

  constructor(options: BridgeOptions) {
    this.config = options.config;
    this.callSid = options.callSid;
    this.twilioSocket = options.twilioSocket;
    this.store = options.store;
    this.adminStore = options.adminStore;
    this.smsTransport = options.smsTransport;
    this.jobberTransport = options.jobberTransport;
    this.connectMetricName = this.store.beginLatency(this.callSid, "openai_connect");
  }

  async connect(): Promise<void> {
    if (!this.config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const url = new URL(this.config.OPENAI_REALTIME_URL);
    url.searchParams.set("model", this.config.OPENAI_REALTIME_MODEL);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.modelSocket = socket;

      socket.once("open", () => {
        this.store.endLatency(this.callSid, this.connectMetricName);
        this.store.appendEvent(this.callSid, "openai_connected");
        this.bootstrapSession();
        resolve();
      });

      socket.once("error", (error) => {
        reject(error);
      });

      socket.on("message", (raw) => {
        void this.handleModelMessage(raw.toString());
      });

      socket.on("close", () => {
        this.store.appendEvent(this.callSid, "openai_closed");
        if (!this.closed) {
          this.twilioSocket.close();
        }
      });
    });
  }

  handleTwilioMessage(raw: string): void {
    const message = JSON.parse(raw) as TwilioMessage;

    if (message.event === "start" && message.start) {
      this.streamSid = message.start.streamSid;
      this.store.upsert(this.callSid, {
        streamSid: message.start.streamSid,
        accountSid: message.start.accountSid,
      });
      this.store.appendEvent(this.callSid, "twilio_stream_started", {
        streamSid: message.start.streamSid,
      });
      return;
    }

    if (message.event === "media" && message.media && this.modelSocket?.readyState === WebSocket.OPEN) {
      this.modelSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: message.media.payload,
        }),
      );
      return;
    }

    if (message.event === "stop") {
      this.store.appendEvent(this.callSid, "twilio_stream_stopped");
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    this.modelSocket?.close();
  }

  private bootstrapSession(): void {
    this.modelSocket?.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          voice: this.config.REALTIME_VOICE,
          instructions: [
            "You are an after-hours plumbing and HVAC call handler.",
            "Keep replies short and spoken-language natural.",
            "Your primary goal is callback capture and qualified intake, not autonomous booking.",
            "If intent or availability is ambiguous, choose callback_capture.",
            "If the caller describes an emergency, advise that the office will return the call as soon as possible and capture the emergency details.",
          ].join(" "),
          turn_detection: {
            type: "server_vad",
          },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          tools: [
            {
              type: "function",
              name: "capture_intake",
              description: "Persist structured intake fields during or after the call.",
              parameters: {
                type: "object",
                properties: {
                  caller_name: { type: "string" },
                  service_address: { type: "string" },
                  service_category: { type: "string" },
                  urgency: { type: "string", enum: ["routine", "urgent", "emergency"] },
                  summary: { type: "string" },
                  disposition: {
                    type: "string",
                    enum: ["book_now", "schedule_callback", "emergency_escalation", "unsupported"],
                  },
                },
                required: ["summary", "disposition"],
              },
            },
          ],
        },
      }),
    );

    this.modelSocket?.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Greet the caller, confirm what issue they need help with, and capture callback details if you cannot confidently continue.",
        },
      }),
    );
  }

  private async handleModelMessage(raw: string): Promise<void> {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const type = typeof payload.type === "string" ? payload.type : "unknown";

    if (type === "response.audio.delta" && this.streamSid && typeof payload.delta === "string") {
      this.twilioSocket.send(
        JSON.stringify({
          event: "media",
          streamSid: this.streamSid,
          media: {
            payload: payload.delta,
          },
        }),
      );
      return;
    }

    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      this.store.appendTranscript(this.callSid, `assistant: ${payload.delta}`);
      return;
    }

    if (type === "response.function_call_arguments.done" && typeof payload.arguments === "string") {
      try {
        const parsed = JSON.parse(payload.arguments) as Record<string, unknown>;
        this.store.appendEvent(this.callSid, "tool_capture_intake", parsed);
        const workflowOutcome = this.materializeWorkflowOutcome(parsed);
        if (workflowOutcome) {
          persistWorkflowOutcome({
            config: this.config,
            callSid: this.callSid,
            intake: workflowOutcome.intake,
            outcome: workflowOutcome.outcome,
            store: this.store,
            adminStore: this.adminStore,
          });
          await dispatchCallFollowups({
            callSid: this.callSid,
            store: this.store,
            adminStore: this.adminStore,
            smsTransport: this.smsTransport,
            jobberTransport: this.jobberTransport,
          });
          this.store.appendEvent(this.callSid, "workflow_outcome_created", asEventDetail(workflowOutcome));
        }
      } catch {
        this.store.appendEvent(this.callSid, "tool_capture_intake_parse_failed");
      }
      return;
    }

    if (type === "error") {
      this.store.appendEvent(this.callSid, "openai_error", payload);
      this.twilioSocket.close();
      return;
    }

    this.store.appendEvent(this.callSid, "openai_event", { type });
  }

  private materializeWorkflowOutcome(
    payload: Record<string, unknown>,
  ): { intake: StructuredCallIntake; outcome: ReturnType<typeof createWorkflowOutcome> } | null {
    const session = this.store.get(this.callSid);
    if (!session) {
      return null;
    }

    const summary = asOptionalString(payload.summary);
    if (!summary) {
      return null;
    }

    const intake: StructuredCallIntake = {
      callSessionId: this.callSid,
      accountId: session.accountId ?? this.config.DEFAULT_ACCOUNT_ID,
      callerPhoneE164: session.from ?? "unknown",
      callerName: asOptionalString(payload.caller_name),
      email: asOptionalString(payload.email),
      serviceAddress: asOptionalString(payload.service_address),
      city: asOptionalString(payload.city),
      postalCode: asOptionalString(payload.postal_code),
      serviceCategory: asOptionalString(payload.service_category) ?? "general_service",
      summary,
      requestedDisposition: mapRequestedDisposition(payload.disposition),
      urgency: mapUrgency(payload.urgency),
      inServiceArea: asOptionalBoolean(payload.in_service_area) ?? true,
      serviceTypeSupported: asOptionalBoolean(payload.service_type_supported) ?? true,
      bookingIntentConfirmed: asOptionalBoolean(payload.booking_intent_confirmed) ?? false,
      availabilityConfirmed: asOptionalBoolean(payload.availability_confirmed) ?? false,
      modelConfidence: asOptionalNumber(payload.model_confidence) ?? 0.5,
      transcriptExcerpt: session.transcript.slice(-6).join(" "),
    };

    return {
      intake,
      outcome: createWorkflowOutcome(intake),
    };
  }
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function mapRequestedDisposition(
  value: unknown,
): StructuredCallIntake["requestedDisposition"] {
  if (value === "book_now") {
    return "book_now";
  }

  if (value === "emergency_escalation") {
    return "emergency_escalation";
  }

  if (value === "unsupported") {
    return "unsupported";
  }

  return "callback";
}

function mapUrgency(value: unknown): StructuredCallIntake["urgency"] {
  if (value === "emergency") {
    return "emergency";
  }

  if (value === "same_day" || value === "urgent") {
    return "same_day";
  }

  return "routine";
}
