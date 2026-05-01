import { randomUUID } from "node:crypto";
import type { Account, AuditEntry, CallbackTask, RoutingRule, SyncFailure, SyncFailureStatus } from "../domain/admin.js";

function nowIso(): string {
  return new Date().toISOString();
}

function defaultBusinessHours(): RoutingRule["businessHours"] {
  return {
    monday: [{ start: "08:00", end: "17:00" }],
    tuesday: [{ start: "08:00", end: "17:00" }],
    wednesday: [{ start: "08:00", end: "17:00" }],
    thursday: [{ start: "08:00", end: "17:00" }],
    friday: [{ start: "08:00", end: "17:00" }],
    saturday: [],
    sunday: [],
  };
}

export class AdminStore {
  private readonly accounts = new Map<string, Account>();
  private readonly routingRules = new Map<string, RoutingRule>();
  private readonly callbackTasks = new Map<string, CallbackTask>();
  private readonly syncFailures = new Map<string, SyncFailure>();
  private readonly auditEntries: AuditEntry[] = [];

  listAccounts(): Account[] {
    return [...this.accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  createAccount(input: Omit<Account, "createdAt" | "updatedAt">): Account {
    const timestamp = nowIso();
    const account: Account = {
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.accounts.set(account.id, account);
    this.recordAudit("account", account.id, "created", { name: account.name });
    if (!this.routingRules.has(account.id)) {
      this.upsertRoutingRule(account.id, {
        businessHours: defaultBusinessHours(),
        overflowThresholds: { maxActiveCalls: 2, maxQueueDepth: 1 },
        serviceAreaZipCodes: [],
        supportedServiceTypes: ["emergency_repair"],
        emergencyKeywords: ["flood", "gas leak", "no heat"],
        unsupportedIntents: ["billing", "reschedule"],
        defaultDisposition: "callback",
      });
    }
    return account;
  }

  getAccount(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  updateAccount(accountId: string, patch: Partial<Omit<Account, "id" | "createdAt" | "updatedAt">>): Account | undefined {
    const existing = this.accounts.get(accountId);
    if (!existing) {
      return undefined;
    }

    const next: Account = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    this.accounts.set(accountId, next);
    this.recordAudit("account", accountId, "updated", patch as Record<string, unknown>);
    return next;
  }

  getRoutingRule(accountId: string): RoutingRule | undefined {
    return this.routingRules.get(accountId);
  }

  upsertRoutingRule(
    accountId: string,
    patch: Omit<Partial<RoutingRule>, "accountId" | "updatedAt" | "deployedAt">,
  ): RoutingRule {
    const timestamp = nowIso();
    const existing = this.routingRules.get(accountId);
    const next: RoutingRule = {
      accountId,
      businessHours: existing?.businessHours ?? defaultBusinessHours(),
      overflowThresholds: existing?.overflowThresholds ?? { maxActiveCalls: 2, maxQueueDepth: 1 },
      serviceAreaZipCodes: existing?.serviceAreaZipCodes ?? [],
      supportedServiceTypes: existing?.supportedServiceTypes ?? [],
      emergencyKeywords: existing?.emergencyKeywords ?? [],
      unsupportedIntents: existing?.unsupportedIntents ?? [],
      defaultDisposition: existing?.defaultDisposition ?? "callback",
      versionId: existing?.versionId ?? `rules-${accountId}-v1`,
      deployedAt: existing?.deployedAt ?? timestamp,
      ...existing,
      ...patch,
      updatedAt: timestamp,
    };
    this.routingRules.set(accountId, next);
    this.recordAudit("routing_rule", accountId, existing ? "updated" : "created", {
      versionId: next.versionId,
      defaultDisposition: next.defaultDisposition,
    });
    return next;
  }

  listCallbackTasks(): CallbackTask[] {
    return [...this.callbackTasks.values()].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  createCallbackTask(input: Omit<CallbackTask, "id" | "createdAt" | "updatedAt">): CallbackTask {
    const timestamp = nowIso();
    const task: CallbackTask = {
      id: randomUUID(),
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.callbackTasks.set(task.id, task);
    this.recordAudit("callback_task", task.id, "created", {
      accountId: task.accountId,
      status: task.status,
    });
    return task;
  }

  updateCallbackTask(
    callbackTaskId: string,
    patch: Partial<Pick<CallbackTask, "ownerName" | "status" | "notes" | "dueAt">>,
  ): CallbackTask | undefined {
    const existing = this.callbackTasks.get(callbackTaskId);
    if (!existing) {
      return undefined;
    }
    const next: CallbackTask = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    this.callbackTasks.set(callbackTaskId, next);
    this.recordAudit("callback_task", callbackTaskId, "updated", patch as Record<string, unknown>);
    return next;
  }

  createSyncFailure(input: Omit<SyncFailure, "id" | "createdAt" | "updatedAt">): SyncFailure {
    const timestamp = nowIso();
    const failure: SyncFailure = {
      id: randomUUID(),
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.syncFailures.set(failure.id, failure);
    this.recordAudit("sync_failure", failure.id, "created", {
      targetSystem: failure.targetSystem,
      status: failure.status,
    });
    return failure;
  }

  listSyncFailures(): SyncFailure[] {
    return [...this.syncFailures.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  retrySyncFailure(syncFailureId: string): SyncFailure | undefined {
    const existing = this.syncFailures.get(syncFailureId);
    if (!existing) {
      return undefined;
    }
    const timestamp = nowIso();
    const next: SyncFailure = {
      ...existing,
      retryCount: existing.retryCount + 1,
      lastAttemptAt: timestamp,
      status: "retrying",
      updatedAt: timestamp,
    };
    this.syncFailures.set(syncFailureId, next);
    this.recordAudit("sync_failure", syncFailureId, "retried", {
      retryCount: next.retryCount,
    });
    return next;
  }

  updateSyncFailureStatus(syncFailureId: string, status: SyncFailureStatus): SyncFailure | undefined {
    const existing = this.syncFailures.get(syncFailureId);
    if (!existing) {
      return undefined;
    }

    const next: SyncFailure = {
      ...existing,
      status,
      updatedAt: nowIso(),
    };
    this.syncFailures.set(syncFailureId, next);
    this.recordAudit("sync_failure", syncFailureId, "status_updated", {
      status,
    });
    return next;
  }

  listAuditEntries(limit = 20): AuditEntry[] {
    return this.auditEntries.slice(-limit).reverse();
  }

  seedAccount(account: Omit<Account, "createdAt" | "updatedAt">): void {
    if (!this.accounts.has(account.id)) {
      this.createAccount(account);
    }
  }

  seedCallbackTask(task: Omit<CallbackTask, "id" | "createdAt" | "updatedAt">): void {
    this.createCallbackTask(task);
  }

  seedSyncFailure(failure: Omit<SyncFailure, "id" | "createdAt" | "updatedAt">): void {
    this.createSyncFailure(failure);
  }

  private recordAudit(
    entityType: AuditEntry["entityType"],
    entityId: string,
    action: string,
    detail?: Record<string, unknown>,
  ): void {
    this.auditEntries.push({
      id: randomUUID(),
      entityType,
      entityId,
      action,
      at: nowIso(),
      detail,
    });
  }
}
