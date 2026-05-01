import { randomUUID } from "node:crypto";
import type { CallEvent, CallSession, LatencyMetric, StoredIntegrationSyncEvent } from "../domain/call-session.js";

export class CallSessionStore {
  private readonly sessions = new Map<string, CallSession>();

  upsert(callSid: string, patch: Partial<CallSession> = {}): CallSession {
    const existing = this.sessions.get(callSid);
    const now = new Date().toISOString();
    const next: CallSession = {
      callSid,
      startedAt: existing?.startedAt ?? now,
      disposition: existing?.disposition ?? "live_conversation",
      transcript: existing?.transcript ?? [],
      events: existing?.events ?? [],
      latencyMetrics: existing?.latencyMetrics ?? [],
      ...existing,
      ...patch,
      updatedAt: now,
    };

    this.sessions.set(callSid, next);
    return next;
  }

  appendEvent(callSid: string, type: string, detail?: Record<string, unknown>): CallEvent {
    const session = this.upsert(callSid);
    const event: CallEvent = {
      at: new Date().toISOString(),
      type,
      detail,
    };
    session.events.push(event);
    session.updatedAt = event.at;
    return event;
  }

  appendTranscript(callSid: string, line: string): void {
    const session = this.upsert(callSid);
    session.transcript.push(line);
    session.updatedAt = new Date().toISOString();
  }

  beginLatency(callSid: string, name: string): string {
    const session = this.upsert(callSid);
    const id = randomUUID();
    const metric: LatencyMetric = {
      name: `${name}:${id}`,
      startedAt: Date.now(),
    };
    session.latencyMetrics.push(metric);
    return metric.name;
  }

  endLatency(callSid: string, metricName: string): void {
    const session = this.upsert(callSid);
    const metric = session.latencyMetrics.find((entry) => entry.name === metricName);
    if (!metric || metric.completedAt) {
      return;
    }

    metric.completedAt = Date.now();
    metric.durationMs = metric.completedAt - metric.startedAt;
    session.updatedAt = new Date().toISOString();
  }

  get(callSid: string): CallSession | undefined {
    return this.sessions.get(callSid);
  }

  updateIntegrationSyncEvent(
    callSid: string,
    idempotencyKey: string,
    patch: Partial<StoredIntegrationSyncEvent>,
  ): StoredIntegrationSyncEvent | undefined {
    const session = this.sessions.get(callSid);
    const syncEvent = session?.integrationSyncEvents?.find((event) => event.idempotencyKey === idempotencyKey);
    if (!session || !syncEvent) {
      return undefined;
    }

    Object.assign(syncEvent, patch);
    session.updatedAt = new Date().toISOString();
    return syncEvent;
  }

  list(): CallSession[] {
    return [...this.sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
