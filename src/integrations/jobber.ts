import type { LeadRecordDraft } from "../domain/call-intake.js";
import type { IntegrationSyncEnvelope } from "./types.js";

export interface JobberConnectionConfig {
  accountId: string;
  apiVersion: string;
}

export interface JobberClientCreateVariables {
  input: {
    firstName: string;
    lastName: string;
    companyName?: string;
    phones: Array<{
      description: "MAIN";
      primary: true;
      number: string;
    }>;
    emails: Array<{
      description: "MAIN";
      primary: true;
      address: string;
    }>;
    billingAddress?: {
      street1: string;
      city?: string;
      postalCode?: string;
    };
    notes: string;
  };
}

export interface JobberClientCreateRequest {
  query: string;
  variables: JobberClientCreateVariables;
  headers: Record<string, string>;
}

function splitName(fullName: string | null): { firstName: string; lastName: string } {
  if (!fullName) {
    return {
      firstName: "Unknown",
      lastName: "Caller",
    };
  }

  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: "Caller",
    };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

export function buildJobberClientCreateSync(
  leadId: string,
  lead: LeadRecordDraft,
  connection: JobberConnectionConfig,
): IntegrationSyncEnvelope<JobberClientCreateRequest> {
  const { firstName, lastName } = splitName(lead.callerName);
  const notes = [
    `Call session: ${lead.callSessionId}`,
    `Disposition: ${lead.disposition}`,
    `Urgency: ${lead.urgency}`,
    `Category: ${lead.serviceCategory}`,
    `Summary: ${lead.summary}`,
  ].join("\n");

  const variables: JobberClientCreateVariables = {
    input: {
      firstName,
      lastName,
      phones: [
        {
          description: "MAIN",
          primary: true,
          number: lead.callerPhoneE164,
        },
      ],
      emails: lead.email
        ? [
            {
              description: "MAIN",
              primary: true,
              address: lead.email,
            },
          ]
        : [],
      notes,
    },
  };

  if (lead.serviceAddress) {
    variables.input.billingAddress = {
      street1: lead.serviceAddress,
      city: lead.city ?? undefined,
      postalCode: lead.postalCode ?? undefined,
    };
  }

  return {
    integrationKey: "jobber",
    externalEndpoint: "https://api.getjobber.com/api/graphql",
    idempotencyKey: `jobber:clientCreate:${connection.accountId}:${leadId}`,
    payload: {
      query: `
mutation CreateClient($input: ClientCreateInput!) {
  clientCreate(input: $input) {
    client {
      id
      firstName
      lastName
    }
    userErrors {
      message
      path
    }
  }
}`.trim(),
      variables,
      headers: {
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": connection.apiVersion,
      },
    },
  };
}
