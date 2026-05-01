import type { AppConfig } from "../config.js";
import type { StoredIntegrationSyncEvent } from "../domain/call-session.js";

export interface JobberTransport {
  executeSync(syncEvent: StoredIntegrationSyncEvent): Promise<{ externalObjectId: string }>;
}

export class JobberGraphqlTransport implements JobberTransport {
  constructor(private readonly config: AppConfig) {}

  async executeSync(syncEvent: StoredIntegrationSyncEvent): Promise<{ externalObjectId: string }> {
    if (!this.config.JOBBER_ACCESS_TOKEN) {
      throw new Error("Jobber transport is not configured");
    }

    const response = await fetch("https://api.getjobber.com/api/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.JOBBER_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": this.config.JOBBER_API_VERSION,
      },
      body: JSON.stringify(syncEvent.requestPayload),
    });

    const body = (await response.json()) as {
      data?: {
        clientCreate?: {
          client?: { id?: string };
          userErrors?: Array<{ message?: string }>;
        };
      };
      errors?: Array<{ message?: string }>;
    };

    const userError = body.data?.clientCreate?.userErrors?.find((error) => error.message);
    const externalObjectId = body.data?.clientCreate?.client?.id;
    if (!response.ok || userError || !externalObjectId) {
      throw new Error(
        userError?.message ?? body.errors?.[0]?.message ?? `Jobber request failed with status ${response.status}`,
      );
    }

    return { externalObjectId };
  }
}
