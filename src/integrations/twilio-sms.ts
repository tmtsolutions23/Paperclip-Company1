import type { AppConfig } from "../config.js";

export interface SmsTransport {
  sendMessage(input: { to: string; body: string; callSid: string }): Promise<{ providerMessageId: string }>;
}

export class TwilioSmsTransport implements SmsTransport {
  constructor(private readonly config: AppConfig) {}

  async sendMessage(input: { to: string; body: string; callSid: string }): Promise<{ providerMessageId: string }> {
    if (!this.config.TWILIO_ACCOUNT_SID || !this.config.TWILIO_AUTH_TOKEN || !this.config.TWILIO_SMS_FROM_E164) {
      throw new Error("Twilio SMS transport is not configured");
    }

    const form = new URLSearchParams({
      To: input.to,
      From: this.config.TWILIO_SMS_FROM_E164,
      Body: input.body,
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.config.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${this.config.TWILIO_ACCOUNT_SID}:${this.config.TWILIO_AUTH_TOKEN}`,
          ).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );

    const body = (await response.json()) as { sid?: string; message?: string };
    if (!response.ok || !body.sid) {
      throw new Error(body.message ?? `Twilio SMS request failed with status ${response.status}`);
    }

    return {
      providerMessageId: body.sid,
    };
  }
}
