import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  DEFAULT_ACCOUNT_ID: z.string().default("pilot_account"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  OPENAI_REALTIME_URL: z.string().url().default("wss://api.openai.com/v1/realtime"),
  REALTIME_VOICE: z.string().default("alloy"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_SMS_FROM_E164: z.string().optional(),
  JOBBER_ACCESS_TOKEN: z.string().optional(),
  JOBBER_API_VERSION: z.string().default("2025-01-20"),
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().default("development"),
  TWILIO_RECORDING_CONSENT_LINE: z
    .string()
    .default("This call may be recorded and transcribed to help us schedule your callback."),
});

export type AppConfig = z.infer<typeof envSchema>;

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse({
    ...env,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL,
  });
}
