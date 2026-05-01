export interface IntegrationSyncEnvelope<TPayload> {
  integrationKey: "jobber";
  externalEndpoint: string;
  idempotencyKey: string;
  payload: TPayload;
}

