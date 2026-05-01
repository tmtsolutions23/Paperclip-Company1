import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket, { type WebSocket } from "@fastify/websocket";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Account, CallbackTask, RoutingRule, SyncFailure } from "./domain/admin.js";
import type { CallSession } from "./domain/call-session.js";
import { JobberGraphqlTransport, type JobberTransport } from "./integrations/jobber-transport.js";
import { TwilioSmsTransport, type SmsTransport } from "./integrations/twilio-sms.js";
import { buildInboundTwiml } from "./services/twiml.js";
import { RealtimeBridge } from "./services/realtime-bridge.js";
import { CallSessionStore } from "./state/call-session-store.js";
import { AdminStore } from "./state/admin-store.js";

function websocketUrl(baseUrl: string, path: string): string {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

const accountCreateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  publicHost: z.string().min(1).optional(),
  status: z.enum(["active", "inactive"]),
  brandName: z.string().min(1).optional(),
  timezone: z.string().min(1),
  primaryPhoneNumber: z.string().min(1),
  overflowModeEnabled: z.boolean(),
  afterHoursScheduleEnabled: z.boolean(),
  emergencyEscalationPhone: z.string().min(1),
  smsAckTemplate: z.string().min(1),
  consentScript: z.string().min(1),
  brandTheme: z.record(z.string(), z.string()).optional(),
});

const accountPatchSchema = accountCreateSchema.omit({ id: true }).partial();

const routingPatchSchema = z.object({
  businessHours: z.record(
    z.string(),
    z.array(
      z.object({
        start: z.string().min(1),
        end: z.string().min(1),
      }),
    ),
  ).optional(),
  overflowThresholds: z
    .object({
      maxActiveCalls: z.number().int().nonnegative(),
      maxQueueDepth: z.number().int().nonnegative(),
    })
    .optional(),
  serviceAreaZipCodes: z.array(z.string()).optional(),
  supportedServiceTypes: z.array(z.string()).optional(),
  emergencyKeywords: z.array(z.string()).optional(),
  unsupportedIntents: z.array(z.string()).optional(),
  defaultDisposition: z.enum(["callback", "book"]).optional(),
  versionId: z.string().min(1).optional(),
});

const callbackPatchSchema = z
  .object({
    ownerName: z.string().min(1).optional(),
    status: z.enum(["new", "assigned", "contacted", "resolved", "closed_lost"]).optional(),
    notes: z.string().optional(),
    dueAt: z.string().datetime().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one callback field must be provided",
  });

const syncFailureActionSchema = z.object({
  action: z.enum(["retry", "handled_manually", "resolved"]),
});

const loginResolutionSchema = z.object({
  userId: z.string().min(1),
  email: z.string().trim().email(),
  lastAccountSlug: z.string().min(1).optional(),
});

type HtmlFormBody = Record<string, string | undefined>;
type BusinessHourSlot = { start: string; end: string };

function parseCheckbox(value: string | undefined): boolean {
  return value === "on" || value === "true" || value === "1";
}

function parseLines(value: string | undefined): string[] {
  return (value ?? "")
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+$/, "");
}

function parseBrandTheme(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return z.record(z.string(), z.string()).parse(parsed);
  } catch {
    return undefined;
  }
}

function encodeFormValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function renderTextAreaLines(values: string[]): string {
  return encodeFormValue(values.join("\n"));
}

function parseBusinessHours(body: HtmlFormBody): Record<string, BusinessHourSlot[]> {
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

  return Object.fromEntries(
    days.map((day) => {
      const raw = body[`hours_${day}`] ?? "";
      const slots = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [start, end] = entry.split("-").map((part) => part.trim());
          return { start: start ?? "", end: end ?? "" };
        })
        .filter((slot) => slot.start.length > 0 && slot.end.length > 0);

      return [day, slots];
    }),
  );
}

function renderBusinessHoursValue(slots: BusinessHourSlot[]): string {
  return slots.map((slot) => `${slot.start}-${slot.end}`).join(", ");
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

function renderStatePill(label: string, tone: "accent" | "warn" | "danger" | "neutral" = "neutral"): string {
  return `<span class="pill pill-${tone}">${escapeHtml(label)}</span>`;
}

function renderEntityLink(
  href: string | undefined,
  label: string,
  options: {
    sublabel?: string;
    eyebrow?: string;
  } = {},
): string {
  const content = `
    ${options.eyebrow ? `<span class="entity-eyebrow">${escapeHtml(options.eyebrow)}</span>` : ""}
    <strong>${escapeHtml(label)}</strong>
    ${options.sublabel ? `<span class="entity-sublabel">${escapeHtml(options.sublabel)}</span>` : ""}
  `;

  if (!href) {
    return `<span class="entity-link entity-static">${content}</span>`;
  }

  return `<a class="entity-link" href="${href}">${content}</a>`;
}

function renderDefinitionList(items: Array<{ label: string; value: string }>): string {
  return `
    <dl class="facts">
      ${items
        .map(
          (item) => `
            <div>
              <dt>${escapeHtml(item.label)}</dt>
              <dd>${item.value}</dd>
            </div>`,
        )
        .join("")}
    </dl>`;
}

function renderChecklist(items: Array<{ label: string; complete: boolean; hint?: string }>): string {
  return `
    <ul class="checklist">
      ${items
        .map(
          (item) => `
            <li>
              <span class="checkmark ${item.complete ? "ready" : "pending"}">${item.complete ? "Ready" : "Needs setup"}</span>
              <div>
                <strong>${escapeHtml(item.label)}</strong>
                ${item.hint ? `<span class="entity-sublabel">${escapeHtml(item.hint)}</span>` : ""}
              </div>
            </li>`,
        )
        .join("")}
    </ul>`;
}

function renderEmptyState(title: string, detail: string): string {
  return `
    <div class="card">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(detail)}</p>
    </div>`;
}

function computeLaunchReadiness(account: Account, routingRule?: RoutingRule): Array<{ label: string; complete: boolean; hint?: string }> {
  return [
    {
      label: "Hours configured",
      complete: Boolean(routingRule && Object.values(routingRule.businessHours).some((slots) => slots.length > 0)),
      hint: routingRule ? `Version ${routingRule.versionId}` : "No routing rule saved yet",
    },
    {
      label: "Escalation number present",
      complete: account.emergencyEscalationPhone.trim().length > 0,
    },
    {
      label: "SMS template present",
      complete: account.smsAckTemplate.trim().length > 0,
    },
    {
      label: "Consent copy present",
      complete: account.consentScript.trim().length > 0,
    },
    {
      label: "Routing version deployed",
      complete: Boolean(routingRule?.versionId),
      hint: routingRule ? `Deployed ${formatTimestamp(routingRule.deployedAt)}` : "Waiting for first deployment",
    },
  ];
}

function readinessSummary(items: Array<{ complete: boolean }>): string {
  const completed = items.filter((item) => item.complete).length;
  return `${completed}/${items.length} ready`;
}

function renderPage(title: string, content: string, options: { showMasthead?: boolean } = {}): string {
  const showMasthead = options.showMasthead ?? true;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3f6fb;
        --bg-elevated: #ffffff;
        --panel: rgba(255, 255, 255, 0.9);
        --panel-strong: #ffffff;
        --ink: #182033;
        --muted: #53627f;
        --line: #d9e2f3;
        --accent: #3b6cff;
        --accent-strong: #2d52c4;
        --success: #0e9f6e;
        --warn: #b26a00;
        --danger: #c43d5c;
        --radius: 16px;
        --shadow: 0 12px 36px rgba(21, 37, 75, 0.12);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #0b1220;
          --bg-elevated: #111a2d;
          --panel: rgba(17, 26, 45, 0.9);
          --panel-strong: #16213b;
          --ink: #eef3ff;
          --muted: #a8b7d6;
          --line: #2c3c61;
          --accent: #7da1ff;
          --accent-strong: #9fb8ff;
          --success: #63d8ad;
          --warn: #ffca78;
          --danger: #ff95ab;
          --shadow: 0 12px 36px rgba(0, 0, 0, 0.34);
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at top left, rgba(59, 108, 255, 0.12), transparent 38%), var(--bg);
      }
      header, main { max-width: 1280px; margin: 0 auto; padding: 28px; }
      .masthead, section, table, form, .card, .proof-card, .timeline-card, .faq-item, .industry-band {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }
      .masthead { padding: 24px; display: grid; gap: 14px; }
      .eyebrow { color: var(--muted); font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; font-weight: 600; }
      .title-row { display:flex; justify-content:space-between; flex-wrap:wrap; gap:16px; align-items:end; }
      .title-block p, p, li, .muted, .entity-sublabel { color: var(--muted); }
      nav { display:flex; flex-wrap:wrap; gap:10px; }
      nav a, .button { border:1px solid var(--line); color:var(--ink); background:var(--bg-elevated); border-radius:10px; padding:10px 14px; text-decoration:none; transition:.16s ease; font-weight: 500; }
      nav a:hover, .button:hover { border-color: var(--accent); transform: translateY(-1px); }
      .button.primary { background: linear-gradient(135deg, var(--accent), var(--accent-strong)); color:white; border-color: transparent; }
      .button.secondary { background: color-mix(in srgb, var(--accent) 10%, var(--bg-elevated)); }
      .hero-stats, .grid, .metric-grid, .step-grid, .proof-grid, .comparison-grid { display:grid; gap:14px; }
      .hero-stats { grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); }
      .hero-stats div, .metric-card, .attention-card, .logo-strip div, .step-grid article, .proof-grid article, .comparison-grid article { background: var(--panel-strong); border:1px solid var(--line); border-radius:12px; padding:16px; }
      .hero-label, th, .facts dt, .entity-eyebrow { text-transform: uppercase; letter-spacing: .09em; font-size: .74rem; }
      .hero-value, h1, h2, .metric-card strong { font-family: "Space Grotesk", Inter, sans-serif; letter-spacing: -0.03em; }
      .hero-value, .metric-card strong { color: var(--accent-strong); }
      h1 { margin:0; font-size: clamp(2rem, 5vw, 3.4rem); }
      h2 { font-size: clamp(1.2rem,2.8vw,1.9rem); margin-top:0; }
      h3 { margin-top:0; font-size:1rem; }
      section, .card, form { padding:20px; margin-bottom:18px; }
      table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; margin-bottom:18px; background: var(--panel-strong); }
      th,td { padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
      th { background: color-mix(in srgb, var(--accent) 12%, var(--panel-strong)); color: var(--accent-strong); }
      tr:last-child td { border-bottom:none; }
      tbody tr:hover td { background: color-mix(in srgb, var(--accent) 8%, var(--panel-strong)); }
      .grid.two { grid-template-columns: repeat(auto-fit,minmax(260px,1fr)); }
      .split-callout, .public-hero { display:grid; gap:16px; grid-template-columns: minmax(0,1.3fr) minmax(0,1fr); }
      input, textarea, select { width:100%; padding:10px 12px; border-radius:10px; border:1px solid var(--line); color:var(--ink); background:var(--bg-elevated); font:inherit; }
      input:focus, textarea:focus, select:focus { outline: 2px solid color-mix(in srgb, var(--accent) 40%, transparent); outline-offset: 1px; border-color: var(--accent); }
      code, pre { background: color-mix(in srgb, var(--accent) 8%, var(--bg-elevated)); color:var(--ink); border-radius:10px; }
      pre { padding:14px; overflow:auto; }
      .pill,.checkmark { border-radius:999px; padding:5px 10px; font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; font-weight:600; }
      .pill-accent { background: color-mix(in srgb, var(--accent) 16%, var(--bg-elevated)); color:var(--accent-strong); }
      .pill-warn,.checkmark.pending { background: color-mix(in srgb, var(--warn) 14%, var(--bg-elevated)); color:var(--warn); }
      .pill-danger { background: color-mix(in srgb, var(--danger) 14%, var(--bg-elevated)); color:var(--danger); }
      .pill-neutral,.checkmark.ready { background: color-mix(in srgb, var(--success) 14%, var(--bg-elevated)); color:var(--success); }
      .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:14px 18px; margin:0; }
      .facts div, .checklist li, .activity-list li { border-top:1px solid var(--line); padding-top:12px; }
      .action-row,.nav-actions,.filter-row,.industry-tabs { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
      .checklist,.activity-list,.timeline,.faq-list,.stack,.overview-shell,.attention-list,.page-intro { list-style:none; padding:0; margin:0 0 18px; display:grid; gap:12px; }
      .checklist li { display:grid; grid-template-columns:auto 1fr; gap:12px; }
      .public-shell { min-height:100vh; background: radial-gradient(circle at top, rgba(59,108,255,.13), transparent 30%), var(--bg); }
      .public-nav { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; }
      .logo-strip { grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); }
      .step-grid, .proof-grid, .comparison-grid { grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); }
      @media (max-width: 780px) {
        header, main { padding: 16px; }
        .masthead, section, .card, form { padding: 16px; }
        .split-callout, .public-hero { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    ${showMasthead
      ? `<header>
      <div class="masthead">
        <div class="eyebrow">Operator Product / Internal Pilot Console</div>
        <div class="title-row">
          <div class="title-block">
            <h1>${escapeHtml(title)}</h1>
            <p class="lede">A real-time command center for onboarding, call quality, and exception handling across operations and customer support teams.</p>
          </div>
          <nav>
            <a href="/internal/admin">Overview</a>
            <a href="/accounts">Accounts</a>
            <a href="/calls">Calls</a>
            <a href="/callbacks">Callbacks</a>
            <a href="/sync-failures">Sync Failures</a>
          </nav>
        </div>
      </div>
    </header>`
      : ""}
    <main>${content}</main>
  </body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function joinLines(values: string[]): string {
  return values.map((value) => escapeHtml(value)).join("<br />");
}

function renderAccountCreateForm(): string {
  return `
    <section>
      <h2>Create New Account</h2>
      <p>Keep creation separate from editing so operators can set up a pilot account without competing with the existing account list.</p>
    </section>
    <form method="post" action="/accounts">
      <h2>Create pilot account</h2>
      <div class="grid two">
        <label>
          Account ID
          <input name="id" placeholder="pilot_account_two" required />
        </label>
        <label>
          Account name
          <input name="name" placeholder="Second Pilot HVAC" required />
        </label>
        <label>
          Account slug
          <input name="slug" placeholder="pilot-hvac" required />
        </label>
        <label>
          Public host
          <input name="publicHost" placeholder="pilot-hvac.voice.example.com" />
        </label>
        <label>
          Brand name
          <input name="brandName" placeholder="Pilot HVAC" />
        </label>
        <label>
          Timezone
          <input name="timezone" value="America/Chicago" required />
          <span class="muted">Use the dispatcher timezone, for example <code>America/Chicago</code>.</span>
        </label>
        <label>
          Primary phone number
          <input name="primaryPhoneNumber" placeholder="+15551234567" required />
          <span class="muted">Store numbers in E.164 format so routing and SMS stay consistent.</span>
        </label>
        <label>
          Emergency escalation phone
          <input name="emergencyEscalationPhone" placeholder="+15557654321" required />
        </label>
        <label>
          Status
          <select name="status">
            <option value="active" selected>active</option>
            <option value="inactive">inactive</option>
          </select>
        </label>
        <label>
          SMS acknowledgement template
          <textarea name="smsAckTemplate" required>Thanks for calling. We captured your request and the on-call team will call you shortly.</textarea>
        </label>
        <label>
          Consent script
          <textarea name="consentScript" required>This call may be recorded and transcribed to help us schedule your callback.</textarea>
          <span class="muted">Explain recording and transcript use before live calls begin.</span>
        </label>
        <label>
          Brand theme JSON
          <textarea name="brandTheme">{}</textarea>
        </label>
        <label>
          <input name="overflowModeEnabled" type="checkbox" checked />
          Overflow mode enabled
        </label>
        <label>
          <input name="afterHoursScheduleEnabled" type="checkbox" checked />
          After-hours schedule enabled
        </label>
      </div>
      <button class="button primary" type="submit">Create account</button>
    </form>`;
}

function renderAccountList(accounts: Account[], routingRulesById: Map<string, RoutingRule>): string {
  return `
    <section class="page-intro">
      <div class="title-row">
        <div>
          <h2>Accounts</h2>
          <p>List, filter, and review launch readiness here. Create a new account from its own setup screen.</p>
        </div>
        <div class="nav-actions">
          <a class="button primary" href="/accounts/new">New account</a>
        </div>
      </div>
      <div class="filter-row">
        <span class="pill pill-neutral">All</span>
        <span class="pill pill-warn">Setup incomplete</span>
        <span class="pill pill-accent">Active</span>
      </div>
    </section>
    <section>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Timezone</th>
            <th>Primary Number</th>
            <th>Routing Status</th>
            <th>Last Updated</th>
            <th>Launch Readiness</th>
          </tr>
        </thead>
        <tbody>
          ${accounts
            .map((account) => {
              const routingRule = routingRulesById.get(account.id);
              const readiness = computeLaunchReadiness(account, routingRule);

              return `
                <tr>
                  <td>${renderEntityLink(`/accounts/${encodeURIComponent(account.id)}`, account.name, {
                    eyebrow: account.status,
                    sublabel: account.publicHost ?? account.slug,
                  })}</td>
                  <td>${escapeHtml(account.timezone)}</td>
                  <td>${escapeHtml(account.primaryPhoneNumber)}</td>
                  <td>${routingRule ? renderStatePill(routingRule.defaultDisposition, "accent") : renderStatePill("Missing", "warn")}</td>
                  <td>${escapeHtml(formatTimestamp(account.updatedAt))}</td>
                  <td>${escapeHtml(readinessSummary(readiness))}</td>
                </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </section>`;
}

function renderAccountDetail(account: Account, routingRule?: RoutingRule): string {
  const readiness = computeLaunchReadiness(account, routingRule);
  return `
    <div class="grid two">
      <section>
        <h2>Account Config</h2>
        ${renderDefinitionList([
          { label: "Account name", value: escapeHtml(account.name) },
          { label: "Route slug", value: `<code>${escapeHtml(account.slug)}</code>` },
          { label: "Public host", value: escapeHtml(account.publicHost ?? "Not configured") },
          { label: "Status", value: escapeHtml(account.status) },
          { label: "Brand name", value: escapeHtml(account.brandName ?? account.name) },
          { label: "Timezone", value: escapeHtml(account.timezone) },
          { label: "Primary phone", value: escapeHtml(account.primaryPhoneNumber) },
          { label: "Overflow mode", value: account.overflowModeEnabled ? "Enabled" : "Disabled" },
          { label: "After hours", value: account.afterHoursScheduleEnabled ? "Enabled" : "Disabled" },
          { label: "Emergency escalation", value: escapeHtml(account.emergencyEscalationPhone) },
        ])}
      </section>
      <section>
        <h2>Operator Messaging</h2>
        <p><strong>SMS acknowledgement</strong><br />${escapeHtml(account.smsAckTemplate)}</p>
        <p><strong>Consent script</strong><br />${escapeHtml(account.consentScript)}</p>
        <h3>Launch readiness</h3>
        ${renderChecklist(readiness)}
        ${
          routingRule
            ? `<p><strong>Routing version</strong><br />${escapeHtml(routingRule.versionId)} deployed ${escapeHtml(routingRule.deployedAt)}</p>`
            : "<p>No routing rule found.</p>"
        }
        <a class="button primary" href="/accounts/${encodeURIComponent(account.id)}/routing">Open routing rules</a>
      </section>
    </div>
    <form method="post" action="/accounts/${encodeURIComponent(account.id)}">
      <h2>Edit account</h2>
      <div class="grid two">
        <label>
          Account name
          <input name="name" value="${encodeFormValue(account.name)}" required />
        </label>
        <label>
          Account slug
          <input name="slug" value="${encodeFormValue(account.slug)}" required />
        </label>
        <label>
          Public host
          <input name="publicHost" value="${encodeFormValue(account.publicHost ?? "")}" />
        </label>
        <label>
          Brand name
          <input name="brandName" value="${encodeFormValue(account.brandName ?? "")}" />
        </label>
        <label>
          Timezone
          <input name="timezone" value="${encodeFormValue(account.timezone)}" required />
          <span class="muted">Use the account's operating timezone before launch.</span>
        </label>
        <label>
          Primary phone number
          <input name="primaryPhoneNumber" value="${encodeFormValue(account.primaryPhoneNumber)}" required />
          <span class="muted">Use E.164 formatting so call routing and SMS copy stay predictable.</span>
        </label>
        <label>
          Emergency escalation phone
          <input name="emergencyEscalationPhone" value="${encodeFormValue(account.emergencyEscalationPhone)}" required />
        </label>
        <label>
          Status
          <select name="status">
            <option value="active" ${account.status === "active" ? "selected" : ""}>active</option>
            <option value="inactive" ${account.status === "inactive" ? "selected" : ""}>inactive</option>
          </select>
        </label>
        <label>
          SMS acknowledgement template
          <textarea name="smsAckTemplate" required>${encodeFormValue(account.smsAckTemplate)}</textarea>
        </label>
        <label>
          Consent script
          <textarea name="consentScript" required>${encodeFormValue(account.consentScript)}</textarea>
          <span class="muted">Keep the consent language explicit for recording and transcript handling.</span>
        </label>
        <label>
          Brand theme JSON
          <textarea name="brandTheme">${encodeFormValue(JSON.stringify(account.brandTheme ?? {}, null, 2))}</textarea>
        </label>
        <label>
          <input name="overflowModeEnabled" type="checkbox" ${account.overflowModeEnabled ? "checked" : ""} />
          Overflow mode enabled
        </label>
        <label>
          <input name="afterHoursScheduleEnabled" type="checkbox" ${account.afterHoursScheduleEnabled ? "checked" : ""} />
          After-hours schedule enabled
        </label>
      </div>
      <button class="button primary" type="submit">Save account</button>
    </form>`;
}

function renderRoutingRule(account: Account, routingRule?: RoutingRule): string {
  if (!routingRule) {
    return `<section><p>No routing rules configured for ${escapeHtml(account.name)}.</p></section>`;
  }

  return `
    <div class="grid two">
      <section>
        <h2>Hours and thresholds</h2>
        ${renderDefinitionList([
          { label: "Version", value: escapeHtml(routingRule.versionId) },
          { label: "Deployed at", value: escapeHtml(formatTimestamp(routingRule.deployedAt)) },
          { label: "Default disposition", value: escapeHtml(routingRule.defaultDisposition) },
          { label: "Max active calls", value: String(routingRule.overflowThresholds.maxActiveCalls) },
          { label: "Max queue depth", value: String(routingRule.overflowThresholds.maxQueueDepth) },
        ])}
        <pre>${escapeHtml(JSON.stringify(routingRule.businessHours, null, 2))}</pre>
      </section>
      <section>
        <h2>Coverage and escalation</h2>
        <p><strong>Service area ZIP codes</strong><br />${joinLines(routingRule.serviceAreaZipCodes)}</p>
        <p><strong>Supported service types</strong><br />${joinLines(routingRule.supportedServiceTypes)}</p>
        <p><strong>Emergency keywords</strong><br />${joinLines(routingRule.emergencyKeywords)}</p>
        <p><strong>Unsupported intents</strong><br />${joinLines(routingRule.unsupportedIntents)}</p>
      </section>
    </div>
    <form method="post" action="/accounts/${encodeURIComponent(account.id)}/routing">
      <h2>Edit routing rules</h2>
      <p>Enter business hours as comma-separated ranges like <code>08:00-12:00, 13:00-17:00</code>. Leave blank for closed days.</p>
      <div class="grid two">
        ${Object.entries(routingRule.businessHours)
          .map(
            ([day, slots]) => `
              <label>
                ${escapeHtml(day[0].toUpperCase() + day.slice(1))}
                <input name="hours_${escapeHtml(day)}" value="${encodeFormValue(renderBusinessHoursValue(slots))}" />
              </label>`,
          )
          .join("")}
        <label>
          Max active calls
          <input name="maxActiveCalls" type="number" min="0" value="${routingRule.overflowThresholds.maxActiveCalls}" />
        </label>
        <label>
          Max queue depth
          <input name="maxQueueDepth" type="number" min="0" value="${routingRule.overflowThresholds.maxQueueDepth}" />
        </label>
        <label>
          Default disposition
          <select name="defaultDisposition">
            <option value="callback" ${routingRule.defaultDisposition === "callback" ? "selected" : ""}>callback</option>
            <option value="book" ${routingRule.defaultDisposition === "book" ? "selected" : ""}>book</option>
          </select>
        </label>
        <label>
          Version ID
          <input name="versionId" value="${encodeFormValue(routingRule.versionId)}" />
        </label>
      </div>
      <div class="grid two">
        <label>
          Service area ZIP codes
          <textarea name="serviceAreaZipCodes">${renderTextAreaLines(routingRule.serviceAreaZipCodes)}</textarea>
        </label>
        <label>
          Supported service types
          <textarea name="supportedServiceTypes">${renderTextAreaLines(routingRule.supportedServiceTypes)}</textarea>
        </label>
        <label>
          Emergency keywords
          <textarea name="emergencyKeywords">${renderTextAreaLines(routingRule.emergencyKeywords)}</textarea>
        </label>
        <label>
          Unsupported intents
          <textarea name="unsupportedIntents">${renderTextAreaLines(routingRule.unsupportedIntents)}</textarea>
        </label>
      </div>
      <button class="button primary" type="submit">Save routing rules</button>
    </form>`;
}

function renderPublicSite(account: Account): string {
  const brandPrimary = account.brandTheme?.accent ?? "#8e2f1c";
  const brandSecondary = account.brandTheme?.secondary ?? "#465445";
  const surfaceBase = account.brandTheme?.surface ?? "#fffdf9";
  const industryLabel = account.brandName?.includes("HVAC")
    ? "HVAC"
    : account.brandName?.includes("Electric")
      ? "Electrical"
      : "Home services";

  return renderPage(`${account.brandName ?? account.name} Reception`, `
    <div class="public-shell" style="--accent:${escapeHtml(brandPrimary)};--accent-strong:${escapeHtml(brandPrimary)};--olive:${escapeHtml(brandSecondary)};--panel-strong:${escapeHtml(surfaceBase)};">
      <header>
        <div class="public-nav">
          <div class="eyebrow">${escapeHtml(industryLabel)} AI Reception</div>
          <nav>
            <a href="#how-it-works">How It Works</a>
            <a href="#industries">Industries</a>
            <a href="#integrations">Integrations</a>
            <a href="#proof">Proof</a>
            <a href="#faq">FAQ</a>
            <a class="button primary" href="#book-demo">Book a demo</a>
          </nav>
        </div>
      </header>
      <main class="stack">
        <section class="public-hero">
          <div class="stack">
            <span class="eyebrow">After-hours coverage that sounds operational</span>
            <h1>Never miss the service calls that turn into revenue.</h1>
            <p class="lede">${escapeHtml(account.brandName ?? account.name)} answers overflow and after-hours calls, captures structured lead data, routes urgent jobs, and hands everything into the team already running dispatch.</p>
            <div class="action-row">
              <a class="button primary" href="#book-demo">Book a demo</a>
              <a class="button secondary" href="#proof">See how a callback flow works</a>
            </div>
            <div class="logo-strip">
              <div><strong>Answers overflow</strong><p>Captures every caller after hours or when the line is slammed.</p></div>
              <div><strong>Routes urgent calls</strong><p>Escalates high-risk issues with the right disposition instead of generic voicemail.</p></div>
              <div><strong>Creates usable records</strong><p>Leaves the dispatcher with structured service, urgency, and callback context.</p></div>
            </div>
          </div>
          <div class="stack">
            <div class="proof-card">
              <h2>Live proof module</h2>
              <p class="muted">Example timeline for the current tenant surface.</p>
              <ol class="timeline">
                <li><strong>8:42 PM</strong><span>Caller reports no heat for a family home.</span></li>
                <li><strong>8:43 PM</strong><span>AI confirms address, urgency, and callback number.</span></li>
                <li><strong>8:43 PM</strong><span>Urgency tagged high, callback task created, on-call SMS sent.</span></li>
                <li><strong>8:44 PM</strong><span>CRM sync confirms lead creation for next-step dispatch.</span></li>
              </ol>
            </div>
            <div class="timeline-card">
              <h2>Callback outcome</h2>
              <p><strong>Status:</strong> Technician dispatched within 11 minutes.</p>
              <p><strong>Captured:</strong> service need, urgency, location, callback window, consent state.</p>
              <p><strong>Integration:</strong> Job synced cleanly to downstream ops tooling.</p>
            </div>
          </div>
        </section>
        <section id="how-it-works" class="stack">
          <h2>How it works</h2>
          <div class="step-grid">
            <article><h3>Answer</h3><p>Pick up overflow and after-hours calls with brand-safe language and consent copy.</p></article>
            <article><h3>Qualify</h3><p>Capture job type, urgency, location, and callback details in a repeatable structure.</p></article>
            <article><h3>Decide</h3><p>Apply routing rules for emergency escalation, callback creation, or booking handoff.</p></article>
            <article><h3>Hand off</h3><p>Deliver a usable callback record and sync status instead of another voicemail transcript.</p></article>
          </div>
        </section>
        <section id="industries" class="industry-band stack">
          <h2>Built for real service workflows</h2>
          <div class="industry-tabs">
            <span class="industry-pill">Plumbing: leak triage and water shutoff cues</span>
            <span class="industry-pill">HVAC: no-heat and no-cooling urgency routing</span>
            <span class="industry-pill">Electrical: outage and sparking escalation paths</span>
            <span class="industry-pill">General home services: overflow capture and callback scheduling</span>
          </div>
          <p>The layout stays fixed. Tenant-specific proof, accent color, and brand language vary through account tokens instead of bespoke page rebuilds.</p>
        </section>
        <section id="integrations" class="stack">
          <h2>Practical workflow proof</h2>
          <div class="proof-grid">
            <article><h3>Captured caller need</h3><p>Burst pipe in crawlspace, customer requesting callback before dispatch.</p></article>
            <article><h3>Urgency tagging</h3><p>High urgency based on flooding keywords and after-hours window.</p></article>
            <article><h3>Callback creation</h3><p>Owner-ready follow-up task with phone, service request, due time, and notes.</p></article>
            <article><h3>CRM / job sync</h3><p>Integration status is explicit so the operator knows whether to retry or move on.</p></article>
          </div>
        </section>
        <section id="proof" class="stack">
          <h2>Before and after</h2>
          <div class="comparison-grid">
            <article><h3>Before</h3><p>Missed calls, generic voicemail, and dispatchers piecing together urgency from fragments.</p></article>
            <article><h3>After</h3><p>Every captured call leaves a structured trail: transcript, disposition, callback, and sync outcome.</p></article>
          </div>
        </section>
        <section id="faq" class="stack">
          <h2>FAQ</h2>
          <div class="faq-list">
            <div class="faq-item"><strong>Does this replace my dispatch software?</strong><p>No. It sits in front of the stack you already use and pushes cleaner intake into it.</p></div>
            <div class="faq-item"><strong>Can it vary by trade?</strong><p>Yes. The same layout supports trade-specific proof, copy, accent color, and examples through tenant tokens.</p></div>
            <div class="faq-item"><strong>What does the team see internally?</strong><p>An operator console for calls, callbacks, sync failures, and launch readiness instead of raw logs.</p></div>
          </div>
        </section>
        <form id="book-demo" class="cta-form">
          <h2>Book a demo</h2>
          <div class="grid two">
            <label>Name<input name="name" placeholder="Alex Rivera" /></label>
            <label>Company<input name="company" placeholder="Northside Service Co." /></label>
            <label>Work email<input name="email" type="email" placeholder="alex@northside.example" /></label>
            <label>Phone (optional)<input name="phone" placeholder="+15551234567" /></label>
          </div>
          <div class="action-row">
            <button class="button primary" type="submit">Request demo</button>
            <span class="muted">Current tenant route: ${account.publicHost ? escapeHtml(account.publicHost) : `/sites/${escapeHtml(account.slug)}`}</span>
          </div>
        </form>
      </main>
    </div>`, { showMasthead: false });
}

function renderReactShell(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Paperclip Ops UI</title>
    <style>
      :root { --bg:#111014; --panel:#1b1822; --ink:#f8f4f2; --muted:#baafb3; --line:#3a3242; --accent:#ff6b35; }
      *{box-sizing:border-box} body{margin:0;font-family:"Spectral", Georgia, serif;background:radial-gradient(circle at top right,#302338,var(--bg) 50%);color:var(--ink)}
      .shell{display:grid;grid-template-columns:280px 1fr;min-height:100vh}
      .rail{border-right:1px solid var(--line);padding:24px;background:rgba(0,0,0,.2)}
      .rail h1{font-size:1.2rem;letter-spacing:.08em;text-transform:uppercase}
      .rail a{display:block;color:var(--muted);text-decoration:none;padding:10px 12px;border-radius:8px;margin-bottom:8px}
      .rail a.active,.rail a:hover{background:#2a2432;color:var(--ink)}
      .content{padding:28px}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
      .card{background:var(--panel);border:1px solid var(--line);padding:16px;border-radius:14px}
      table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:12px;overflow:hidden}
      th,td{padding:10px;border-bottom:1px solid var(--line);text-align:left}
      th{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
      .k{font-size:.8rem;color:var(--muted)} .v{font-size:1.8rem;color:var(--accent)}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">
      import React from 'https://esm.sh/react@18.3.1';
      import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';

      const e = React.createElement;
      function useJson(url, pick){ const [state,setState]=React.useState({loading:true,data:[]}); React.useEffect(()=>{fetch(url).then(r=>r.json()).then(data=>setState({loading:false,data:pick?pick(data):data}));},[url]); return state; }
      function useObject(url){ const [state,setState]=React.useState({loading:true,data:null}); React.useEffect(()=>{fetch(url).then(r=>r.json()).then(data=>setState({loading:false,data}));},[url]); return state; }
      function Nav({route,setRoute}){ const links=[['overview','Overview'],['accounts','Accounts'],['calls','Calls'],['callbacks','Callbacks'],['sync','Sync Failures']]; return e('aside',{className:'rail'},e('h1',null,'Operator Console'),...links.map(([id,label])=>e('a',{href:'/ui/'+id,className:route===id?'active':'',onClick:(ev)=>{ev.preventDefault();history.replaceState({},'', '/ui/'+id);setRoute(id);}},label))); }
      function Overview(){ const {loading,data}=useObject('/api/ui/overview');
        return e('div',null,e('h2',null,'Command Overview'),e('div',{className:'grid'},
          e('div',{className:'card'},e('div',{className:'k'},'Accounts'),e('div',{className:'v'},loading?'…':data.accounts)),
          e('div',{className:'card'},e('div',{className:'k'},'Callbacks'),e('div',{className:'v'},loading?'…':data.callbacks)),
          e('div',{className:'card'},e('div',{className:'k'},'Sync Failures'),e('div',{className:'v'},loading?'…':data.syncFailures)),
          e('div',{className:'card'},e('div',{className:'k'},'Calls'),e('div',{className:'v'},loading?'…':data.calls))
        )); }
      function Accounts(){ const {loading,data}=useJson('/api/accounts', (payload)=>payload.accounts ?? []); return e('div',null,e('h2',null,'Accounts'),loading?e('p',null,'Loading…'):e('table',null,e('thead',null,e('tr',null,e('th',null,'Name'),e('th',null,'Timezone'),e('th',null,'Phone'))),e('tbody',null,...data.map(a=>e('tr',null,e('td',null,a.name),e('td',null,a.timezone),e('td',null,a.primaryPhoneNumber))))));}
      function Calls(){ const {loading,data}=useJson('/api/ui/calls'); return e('div',null,e('h2',null,'Calls'),loading?e('p',null,'Loading…'):e('table',null,e('thead',null,e('tr',null,e('th',null,'Call'),e('th',null,'Account'),e('th',null,'Status'),e('th',null,'Updated'))),e('tbody',null,...data.map(c=>e('tr',null,e('td',null,c.callSid),e('td',null,c.accountId),e('td',null,c.status),e('td',null,c.updatedAt)))))); }
      function Callbacks(){ const {loading,data}=useJson('/api/ui/callbacks'); return e('div',null,e('h2',null,'Callbacks'),loading?e('p',null,'Loading…'):e('div',{className:'grid'},...data.map(c=>e('div',{className:'card'},e('strong',null,c.ownerName ?? 'Unassigned'),e('p',null,c.status),e('p',null,c.notes ?? ''),e('a',{href:'/calls/'+c.callSid},'Open call'))))); }
      function Sync(){ const {loading,data}=useJson('/api/ui/sync-failures'); return e('div',null,e('h2',null,'Sync Failures'),loading?e('p',null,'Loading…'):e('div',{className:'grid'},...data.map(f=>e('div',{className:'card'},e('strong',null,f.provider),e('p',null,f.status),e('p',null,f.errorMessage),e('a',{href:'/calls/'+f.callSid},'Open call'))))); }
      function App(){ const initial = location.pathname.split('/')[2] || 'overview'; const [route,setRoute]=React.useState(initial); const page = route==='accounts'?e(Accounts):route==='calls'?e(Calls):route==='callbacks'?e(Callbacks):route==='sync'?e(Sync):e(Overview); return e('div',{className:'shell'},e(Nav,{route,setRoute}),e('main',{className:'content'},page));}
      createRoot(document.getElementById('root')).render(e(App));
    </script>
  </body>
</html>`;
}

function renderTenantPicker(accounts: Account[], viewerEmail: string): string {
  return `
    <section>
      <h1>Select account</h1>
      <p>Signed in as <strong>${escapeHtml(viewerEmail)}</strong>. Choose the tenant admin surface to open.</p>
      <ul>
        ${accounts
          .map(
            (account) =>
              `<li><a href="/app/${encodeURIComponent(account.slug)}">${escapeHtml(account.brandName ?? account.name)}</a> <code>${escapeHtml(account.slug)}</code></li>`,
          )
          .join("")}
      </ul>
    </section>`;
}

function renderTenantAdminHome(account: Account): string {
  return `
    <section class="banner">
      <p class="eyebrow">Tenant Admin</p>
      <h1>${escapeHtml(account.brandName ?? account.name)}</h1>
      <p>Admin routing is now anchored on <code>/app/${escapeHtml(account.slug)}</code>.</p>
    </section>
    <section>
      <div class="actions">
        <a class="button primary" href="/app/${encodeURIComponent(account.slug)}/accounts">Account config</a>
        <a class="button secondary" href="/app/${encodeURIComponent(account.slug)}/routing">Routing config</a>
        <a class="button secondary" href="/app/${encodeURIComponent(account.slug)}/calls">Calls</a>
        <a class="button secondary" href="/app/${encodeURIComponent(account.slug)}/callbacks">Callbacks</a>
        <a class="button secondary" href="/app/${encodeURIComponent(account.slug)}/sync-failures">Sync failures</a>
      </div>
    </section>`;
}

function renderAccessPending(viewerEmail: string): string {
  return `
    <section>
      <h1>Access pending</h1>
      <p>No active tenant memberships were found for <strong>${escapeHtml(viewerEmail)}</strong>.</p>
      <p>Contact the operator who manages account memberships before retrying login.</p>
    </section>`;
}

function renderAuditActivity(entries: ReturnType<AdminStore["listAuditEntries"]>): string {
  if (entries.length === 0) {
    return renderEmptyState("No recent changes", "Activity will appear here as operators update accounts, routing, callbacks, and sync exceptions.");
  }

  return `
    <ul class="activity-list">
      ${entries
        .map(
          (entry) => `
            <li>
              <strong>${escapeHtml(entry.action.replaceAll("_", " "))}</strong>
              <p>${escapeHtml(entry.entityType.replaceAll("_", " "))} ${escapeHtml(entry.entityId)}</p>
              <span class="entity-sublabel">${escapeHtml(formatTimestamp(entry.at))}</span>
            </li>`,
        )
        .join("")}
    </ul>`;
}

function renderAdminOverview(
  config: AppConfig,
  accounts: Account[],
  calls: CallSession[],
  callbacks: CallbackTask[],
  syncFailures: SyncFailure[],
  auditEntries: ReturnType<AdminStore["listAuditEntries"]>,
): string {
  const callsNeedingReview = calls.filter((call) => call.requiresHumanReview);
  const dueSoonCallbacks = callbacks.filter((task) => task.status !== "resolved" && task.status !== "closed_lost").slice(0, 3);
  const pendingFailures = syncFailures.filter((failure) => failure.status !== "resolved").slice(0, 3);

  return `
    <div class="overview-shell">
      <section class="banner">
        <div class="title-row">
          <div>
            <h2>What needs attention right now?</h2>
            <p>Environment ${renderStatePill(config.SENTRY_ENVIRONMENT, "neutral")} last refreshed ${escapeHtml(formatTimestamp(new Date().toISOString()))}</p>
          </div>
          <div class="nav-actions">
            <a class="button secondary" href="/calls">Open call review</a>
            <a class="button secondary" href="/callbacks">Open callback queue</a>
            <a class="button secondary" href="/sync-failures">Open sync failures</a>
          </div>
        </div>
      </section>
      <section>
        <h2>Needs attention now</h2>
        <div class="attention-list">
          ${
            callsNeedingReview.length > 0
              ? callsNeedingReview
                  .slice(0, 3)
                  .map(
                    (call) => `
                      <div class="attention-card">
                        <h3>Call review required</h3>
                        <p>${escapeHtml(call.from ?? "Unknown caller")} on ${escapeHtml(formatTimestamp(call.startedAt))}</p>
                        <div class="action-row">
                          ${renderStatePill(`Confidence ${call.confidenceState ?? "unknown"}`, "warn")}
                          <a class="button primary" href="/calls/${encodeURIComponent(call.callSid)}">Review call</a>
                        </div>
                      </div>`,
                  )
                  .join("")
              : renderEmptyState("No flagged calls", "Calls needing operator review will be elevated here first.")
          }
          ${
            dueSoonCallbacks.length > 0
              ? dueSoonCallbacks
                  .map(
                    (task) => `
                      <div class="attention-card">
                        <h3>Callback due soon</h3>
                        <p>${escapeHtml(task.customerName)} needs ${escapeHtml(task.requestedService)} follow-up by ${escapeHtml(formatTimestamp(task.dueAt))}.</p>
                        <div class="action-row">
                          ${renderStatePill(task.status, "accent")}
                          <a class="button primary" href="/callbacks">Open callback</a>
                        </div>
                      </div>`,
                  )
                  .join("")
              : ""
          }
          ${
            pendingFailures.length > 0
              ? pendingFailures
                  .map(
                    (failure) => `
                      <div class="attention-card">
                        <h3>Sync retry needed</h3>
                        <p>${escapeHtml(failure.targetSystem)} failed with ${escapeHtml(failure.failureReason)}.</p>
                        <div class="action-row">
                          ${renderStatePill(failure.status, failure.status === "pending" ? "danger" : "warn")}
                          <a class="button primary" href="/sync-failures">Retry investigation</a>
                        </div>
                      </div>`,
                  )
                  .join("")
              : ""
          }
        </div>
      </section>
      <section>
        <h2>Health summary</h2>
        <div class="metric-grid">
          <div class="metric-card"><p class="hero-label">Active accounts</p><strong>${accounts.filter((account) => account.status === "active").length}</strong></div>
          <div class="metric-card"><p class="hero-label">Calls today</p><strong>${calls.length}</strong></div>
          <div class="metric-card"><p class="hero-label">Open callbacks</p><strong>${callbacks.filter((task) => task.status !== "resolved" && task.status !== "closed_lost").length}</strong></div>
          <div class="metric-card"><p class="hero-label">Open sync failures</p><strong>${syncFailures.filter((failure) => failure.status !== "resolved").length}</strong></div>
        </div>
      </section>
      <section>
        <h2>Recent changes</h2>
        ${renderAuditActivity(auditEntries)}
      </section>
    </div>`;
}

function scopeTenantMarkup(markup: string, account: Account): string {
  const accountId = encodeURIComponent(account.id);
  const accountSlug = encodeURIComponent(account.slug);

  return markup
    .replaceAll('href="/internal/admin"', `href="/app/${accountSlug}"`)
    .replaceAll('href="/accounts"', `href="/app/${accountSlug}/accounts"`)
    .replaceAll('href="/calls"', `href="/app/${accountSlug}/calls"`)
    .replaceAll('href="/callbacks"', `href="/app/${accountSlug}/callbacks"`)
    .replaceAll('href="/sync-failures"', `href="/app/${accountSlug}/sync-failures"`)
    .replaceAll(`href="/accounts/${accountId}/routing"`, `href="/app/${accountSlug}/routing"`)
    .replaceAll(`href="/accounts/${accountId}"`, `href="/app/${accountSlug}/accounts"`)
    .replaceAll('action="/accounts"', `action="/app/${accountSlug}/accounts"`)
    .replaceAll(`action="/accounts/${accountId}/routing"`, `action="/app/${accountSlug}/routing"`)
    .replaceAll(`action="/accounts/${accountId}"`, `action="/app/${accountSlug}/accounts"`)
    .replaceAll('href="/accounts/new"', `href="/app/${accountSlug}/accounts"`)
    .replaceAll('href="/calls/', `href="/app/${accountSlug}/calls/`)
    .replaceAll('action="/callbacks/', `action="/app/${accountSlug}/callbacks/`)
    .replaceAll('action="/sync-failures/', `action="/app/${accountSlug}/sync-failures/`);
}

function renderCallList(calls: CallSession[], accountsById: Map<string, Account>): string {
  return `
    <section>
      <h2>Call Review</h2>
      <p class="table-note">Review calls by confidence, deployment version, and whether the operator needs to intervene.</p>
      <table>
        <thead>
          <tr>
            <th>Started</th>
            <th>Caller</th>
            <th>Account</th>
            <th>Disposition</th>
            <th>Review</th>
            <th>Sync</th>
            <th>Callback</th>
            <th>Prompt</th>
            <th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          ${calls
            .map(
              (call) => {
                const account = call.accountId ? accountsById.get(call.accountId) : undefined;
                return `
                <tr>
                  <td><a href="/calls/${encodeURIComponent(call.callSid)}">${escapeHtml(formatTimestamp(call.startedAt))}</a></td>
                  <td>${escapeHtml(call.from ?? "unknown")}</td>
                  <td>${renderEntityLink(
                    account ? `/accounts/${encodeURIComponent(account.id)}` : undefined,
                    account?.name ?? call.accountId ?? "Unassigned",
                    {
                      eyebrow: "Account",
                      sublabel: account?.primaryPhoneNumber,
                    },
                  )}</td>
                  <td>${escapeHtml(call.disposition)}</td>
                  <td>${renderStatePill(call.requiresHumanReview ? "Needs operator review" : "Clear for pilot flow", call.requiresHumanReview ? "warn" : "neutral")}</td>
                  <td>${escapeHtml(call.syncStatus ?? "not_started")}</td>
                  <td>${escapeHtml(call.callbackStatus ?? "not_required")}</td>
                  <td>${escapeHtml(call.promptVersionId ?? "prompt-v1")}</td>
                  <td>${escapeHtml(call.confidenceState ?? "unknown")}</td>
                </tr>`;
              },
            )
            .join("")}
        </tbody>
      </table>
    </section>`;
}

function renderCallDetail(
  call: CallSession,
  account: Account | undefined,
  routingRule: RoutingRule | undefined,
  callback: CallbackTask | undefined,
  syncFailures: SyncFailure[],
): string {
  const structuredIntake = call.structuredIntake
    ? `<section>
        <h2>Structured Intake</h2>
        <pre>${escapeHtml(JSON.stringify(call.structuredIntake, null, 2))}</pre>
      </section>`
    : "";
  const leadRecord = call.leadRecord
    ? `<section>
        <h2>Lead Record</h2>
        <pre>${escapeHtml(JSON.stringify(call.leadRecord, null, 2))}</pre>
      </section>`
    : "";
  const syncEvents = call.integrationSyncEvents
    ? `<section>
        <h2>Queued Sync Events</h2>
        <pre>${escapeHtml(JSON.stringify(call.integrationSyncEvents, null, 2))}</pre>
      </section>`
    : "";
  const reviewBanner = call.requiresHumanReview
    ? `<section class="banner warn">
        <h2>Review Required</h2>
        <p>This call is flagged for pilot QA. Review the transcript, structured intake, and linked exception records before clearing follow-up work.</p>
        <div class="action-row">
          ${renderStatePill(`Confidence ${call.confidenceState ?? "unknown"}`, "warn")}
          ${renderStatePill(`Callback ${call.callbackStatus ?? "not_required"}`, "accent")}
          ${renderStatePill(`Sync ${call.syncStatus ?? "not_started"}`, call.syncStatus === "failed" ? "danger" : "neutral")}
        </div>
        ${call.fallbackReason ? `<p><strong>Fallback reason</strong><br />${escapeHtml(call.fallbackReason)}</p>` : ""}
      </section>`
    : `<section class="banner">
        <h2>QA Summary</h2>
        <p>This call did not trigger human review. Use the linked account and exception records below if follow-up work still needs operator confirmation.</p>
      </section>`;
  const linkedExceptions = callback || syncFailures.length > 0
    ? `<section>
        <h2>Linked Exception Context</h2>
        <div class="grid two">
          ${
            callback
              ? `<div class="card">
                  <h3>Callback Queue</h3>
                  ${renderEntityLink("/callbacks", callback.customerName, {
                    eyebrow: callback.status,
                    sublabel: `${callback.requestedService} • due ${formatTimestamp(callback.dueAt)}`,
                  })}
                  <p><strong>Owner</strong><br />${escapeHtml(callback.ownerName || "Unassigned")}</p>
                  <p><strong>Notes</strong><br />${escapeHtml(callback.notes || "No callback notes yet.")}</p>
                </div>`
              : ""
          }
          ${
            syncFailures.length > 0
              ? `<div class="card">
                  <h3>Sync Failures</h3>
                  ${syncFailures
                    .map((failure) =>
                      renderEntityLink("/sync-failures", failure.targetSystem, {
                        eyebrow: failure.status,
                        sublabel: `${failure.failureReason} • retry ${failure.retryCount}`,
                      }),
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
      </section>`
    : "";

  return `
    ${reviewBanner}
    <div class="split-callout">
      <section>
        <h2>Outcome</h2>
        ${renderDefinitionList([
          { label: "Call SID", value: escapeHtml(call.callSid) },
          { label: "Disposition", value: escapeHtml(call.disposition) },
          { label: "Started", value: escapeHtml(formatTimestamp(call.startedAt)) },
          { label: "Prompt version", value: escapeHtml(call.promptVersionId ?? "prompt-v1") },
          { label: "Routing version", value: escapeHtml(call.routingRuleVersionId ?? "rules-v1") },
          { label: "Confidence", value: escapeHtml(call.confidenceState ?? "unknown") },
          { label: "Requires review", value: call.requiresHumanReview ? "Yes" : "No" },
          { label: "Sync status", value: escapeHtml(call.syncStatus ?? "not_started") },
          { label: "Callback status", value: escapeHtml(call.callbackStatus ?? "not_required") },
          { label: "SMS copy", value: escapeHtml(call.sentSmsCopy ?? "Not sent") },
        ])}
      </section>
      <section>
        <h2>Operator Context</h2>
        ${
          account
            ? renderEntityLink(`/accounts/${encodeURIComponent(account.id)}`, account.name, {
                eyebrow: "Account",
                sublabel: `${account.timezone} • ${account.primaryPhoneNumber}`,
              })
            : "<p>No account is attached to this call yet.</p>"
        }
        ${
          account
            ? `<div class="action-row">
                <a class="button secondary" href="/accounts/${encodeURIComponent(account.id)}">Open account</a>
                <a class="button secondary" href="/accounts/${encodeURIComponent(account.id)}/routing">Open routing</a>
              </div>`
            : ""
        }
        ${
          routingRule
            ? `<div class="card">
                <h3>Routing Deployment</h3>
                <p><strong>${escapeHtml(routingRule.versionId)}</strong></p>
                <p class="muted">Deployed ${escapeHtml(formatTimestamp(routingRule.deployedAt))} with default disposition <strong>${escapeHtml(routingRule.defaultDisposition)}</strong>.</p>
              </div>`
            : ""
        }
        <div class="action-row">
          <a class="button secondary" href="/callbacks">Review callback queue</a>
          <a class="button secondary" href="/sync-failures">Review sync failures</a>
        </div>
      </section>
    </div>
    <section>
      <h2>Transcript</h2>
      <pre>${escapeHtml(call.transcript.join("\n") || "Transcript not captured yet.")}</pre>
    </section>
    ${linkedExceptions}
    <div class="grid two">
      ${structuredIntake}
      ${leadRecord}
    </div>
    ${syncEvents}
    <section>
      <h2>Rule decisions and events</h2>
      <pre>${escapeHtml(JSON.stringify(call.events, null, 2))}</pre>
    </section>`;
}

function renderCallbacks(
  callbacks: CallbackTask[],
  accountsById: Map<string, Account>,
  callsById: Map<string, CallSession>,
): string {
  return `
    <section>
      <h2>Callback Queue</h2>
      <p class="table-note">Every row should let the operator jump straight into the account and call that created the follow-up task.</p>
      <table>
        <thead>
          <tr>
            <th>Due</th>
            <th>Customer</th>
            <th>Service</th>
            <th>Urgency</th>
            <th>Linked Context</th>
            <th>Owner</th>
            <th>Status</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${callbacks
            .map(
              (task) => {
                const account = accountsById.get(task.accountId);
                const call = task.callSid ? callsById.get(task.callSid) : undefined;
                return `
                <tr>
                  <td>${escapeHtml(formatTimestamp(task.dueAt))}</td>
                  <td>${escapeHtml(task.customerName)}<br /><span class="muted">${escapeHtml(task.phone)}</span></td>
                  <td>${escapeHtml(task.requestedService)}</td>
                  <td>${escapeHtml(task.urgency)}</td>
                  <td>
                    ${renderEntityLink(
                      account ? `/accounts/${encodeURIComponent(account.id)}` : undefined,
                      account?.name ?? task.accountId,
                      {
                        eyebrow: "Account",
                        sublabel: account?.primaryPhoneNumber,
                      },
                    )}
                    ${renderEntityLink(
                      task.callSid ? `/calls/${encodeURIComponent(task.callSid)}` : undefined,
                      task.callSid ?? "No call linked",
                      {
                        eyebrow: "Call",
                        sublabel: call?.promptVersionId ?? call?.routingRuleVersionId,
                      },
                    )}
                  </td>
                  <td colspan="3">
                    <form method="post" action="/callbacks/${encodeURIComponent(task.id)}">
                      <div class="grid two">
                        <label>
                          Owner
                          <input name="ownerName" value="${encodeFormValue(task.ownerName)}" />
                        </label>
                        <label>
                          Due at
                          <input name="dueAt" type="datetime-local" value="${encodeFormValue(task.dueAt.slice(0, 16))}" />
                        </label>
                        <label>
                          Status
                          <select name="status">
                            ${["new", "assigned", "contacted", "resolved", "closed_lost"]
                              .map(
                                (status) =>
                                  `<option value="${status}" ${task.status === status ? "selected" : ""}>${status}</option>`,
                              )
                              .join("")}
                          </select>
                        </label>
                        <label>
                          Notes
                          <textarea name="notes">${encodeFormValue(task.notes)}</textarea>
                        </label>
                      </div>
                      <button class="button primary" type="submit">Update callback</button>
                    </form>
                  </td>
                </tr>`;
              },
            )
            .join("")}
        </tbody>
      </table>
    </section>`;
}

function renderSyncFailures(
  syncFailures: SyncFailure[],
  accountsById: Map<string, Account>,
  callsById: Map<string, CallSession>,
): string {
  return `
    <section>
      <h2>Failed Sync Review</h2>
      <p class="table-note">Use linked call and account context to separate transient delivery failures from pilot configuration problems.</p>
      <table>
        <thead>
          <tr>
            <th>Target</th>
            <th>Reason</th>
            <th>Retry Count</th>
            <th>Last Attempt</th>
            <th>Linked Context</th>
            <th>Payload</th>
            <th>Status</th>
            <th>Sentry</th>
          </tr>
        </thead>
        <tbody>
          ${syncFailures
            .map(
              (failure) => {
                const account = accountsById.get(failure.accountId);
                const call = failure.callSid ? callsById.get(failure.callSid) : undefined;
                return `
                <tr>
                  <td>${escapeHtml(failure.targetSystem)}</td>
                  <td>${escapeHtml(failure.failureReason)}</td>
                  <td>${failure.retryCount}</td>
                  <td>${escapeHtml(formatTimestamp(failure.lastAttemptAt))}</td>
                  <td>
                    ${renderEntityLink(
                      account ? `/accounts/${encodeURIComponent(account.id)}` : undefined,
                      account?.name ?? failure.accountId,
                      {
                        eyebrow: "Account",
                        sublabel: account?.primaryPhoneNumber,
                      },
                    )}
                    ${renderEntityLink(
                      failure.callSid ? `/calls/${encodeURIComponent(failure.callSid)}` : undefined,
                      failure.callSid ?? "No call linked",
                      {
                        eyebrow: "Call",
                        sublabel: call?.promptVersionId ?? call?.routingRuleVersionId,
                      },
                    )}
                  </td>
                  <td>${escapeHtml(failure.payloadSummary)}</td>
                  <td>${escapeHtml(failure.status)}</td>
                  <td>
                    ${escapeHtml(failure.sentryEventId ?? "Not linked")}
                    <form method="post" action="/sync-failures/${encodeURIComponent(failure.id)}/actions">
                      <input type="hidden" name="action" value="retry" />
                      <button class="button" type="submit">Retry sync</button>
                    </form>
                    <form method="post" action="/sync-failures/${encodeURIComponent(failure.id)}/actions">
                      <input type="hidden" name="action" value="handled_manually" />
                      <button class="button" type="submit">Mark handled manually</button>
                    </form>
                  </td>
                </tr>`;
              },
            )
            .join("")}
        </tbody>
      </table>
    </section>`;
}

function seedAdminStore(adminStore: AdminStore, config: AppConfig): void {
  adminStore.seedAccount({
    id: config.DEFAULT_ACCOUNT_ID,
    name: "Pilot Plumbing",
    slug: "pilot-plumbing",
    publicHost: "pilot-plumbing.voice.example.com",
    status: "active",
    brandName: "Pilot Plumbing",
    brandTheme: {
      accent: "#8e2f1c",
      surface: "#fffdf9",
    },
    timezone: "America/Chicago",
    primaryPhoneNumber: "+15551230000",
    overflowModeEnabled: true,
    afterHoursScheduleEnabled: true,
    emergencyEscalationPhone: "+15559870000",
    smsAckTemplate: "Thanks for calling Pilot Plumbing. We logged your request and an on-call tech will call back soon.",
    consentScript: config.TWILIO_RECORDING_CONSENT_LINE,
  });

  adminStore.seedUserMembership({
    userId: "user-pilot-admin",
    accountId: config.DEFAULT_ACCOUNT_ID,
    emailNormalized: "ops@pilotplumbing.example",
    role: "admin",
    isDefault: true,
  });

  if (adminStore.listCallbackTasks().length === 0) {
    adminStore.seedCallbackTask({
      accountId: config.DEFAULT_ACCOUNT_ID,
      callSid: "CA_seed_callback",
      customerName: "Morgan Lee",
      phone: "+15550002222",
      requestedService: "burst pipe in crawlspace",
      urgency: "high",
      dueAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      ownerName: "On-call dispatcher",
      status: "assigned",
      notes: "Customer requested callback before technician dispatch.",
    });
  }

  if (adminStore.listSyncFailures().length === 0) {
    adminStore.seedSyncFailure({
      accountId: config.DEFAULT_ACCOUNT_ID,
      callSid: "CA_seed_callback",
      targetSystem: "Jobber",
      failureReason: "Missing client address field for create request",
      retryCount: 1,
      lastAttemptAt: new Date().toISOString(),
      payloadSummary: "lead:create for Morgan Lee / burst pipe in crawlspace",
      status: "pending",
      sentryEventId: "sentry-demo-tmta7",
    });
  }
}

function getViewer(request: FastifyRequest): { userId?: string; email?: string } {
  const userId = typeof request.headers["x-viewer-user-id"] === "string" ? request.headers["x-viewer-user-id"] : undefined;
  const email = typeof request.headers["x-viewer-email"] === "string" ? request.headers["x-viewer-email"] : undefined;
  return {
    userId,
    email: email ? normalizeEmail(email) : undefined,
  };
}

function findScopedCall(store: CallSessionStore, accountId: string, callSid: string): CallSession | undefined {
  const call = store.get(callSid);
  return call?.accountId === accountId ? call : undefined;
}

function findScopedCallback(adminStore: AdminStore, accountId: string, callbackId: string): CallbackTask | undefined {
  return adminStore.listCallbackTasks().find((task) => task.id === callbackId && task.accountId === accountId);
}

function findScopedSyncFailure(adminStore: AdminStore, accountId: string, syncFailureId: string): SyncFailure | undefined {
  return adminStore.listSyncFailures().find((failure) => failure.id === syncFailureId && failure.accountId === accountId);
}

function resolveLogin(adminStore: AdminStore, input: { userId: string; email: string; lastAccountSlug?: string }) {
  const memberships = adminStore.listMembershipsForViewer(input.userId, input.email);

  if (memberships.length === 0) {
    return {
      outcome: "access_pending" as const,
      location: "/login/access-pending",
      memberships: [],
    };
  }

  const lastUsed = input.lastAccountSlug
    ? memberships.find((membership) => membership.account.slug === input.lastAccountSlug)
    : undefined;
  const chosenMembership = lastUsed ?? memberships.find((membership) => membership.isDefault) ?? memberships[0];

  if (memberships.length === 1 || lastUsed || chosenMembership.isDefault) {
    return {
      outcome: "redirect" as const,
      location: `/app/${encodeURIComponent(chosenMembership.account.slug)}`,
      memberships,
    };
  }

  return {
    outcome: "select_account" as const,
    location: "/app/select-account",
    memberships,
  };
}

export function buildApp(
  config: AppConfig,
  dependencies: {
    callSessionStore?: CallSessionStore;
    adminStore?: AdminStore;
    smsTransport?: SmsTransport;
    jobberTransport?: JobberTransport;
  } = {},
) {
  const app = Fastify({ logger: true });
  const store = dependencies.callSessionStore ?? new CallSessionStore();
  const adminStore = dependencies.adminStore ?? new AdminStore();
  const smsTransport =
    dependencies.smsTransport ??
    (config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_SMS_FROM_E164
      ? new TwilioSmsTransport(config)
      : undefined);
  const jobberTransport =
    dependencies.jobberTransport ?? (config.JOBBER_ACCESS_TOKEN ? new JobberGraphqlTransport(config) : undefined);

  seedAdminStore(adminStore, config);

  app.register(formbody);
  app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  const requireTenantAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    const viewer = getViewer(request);
    if (!viewer.userId || !viewer.email) {
      reply.code(303).header("location", "/login").send();
      return undefined;
    }

    const { accountSlug } = request.params as { accountSlug: string };
    const account = adminStore.getAccountBySlug(accountSlug);
    if (!account || account.status !== "active") {
      reply.code(404).send({ error: "Account not found" });
      return undefined;
    }

    const memberships = adminStore.listMembershipsForViewer(viewer.userId, viewer.email);
    if (!memberships.some((membership) => membership.account.id === account.id)) {
      reply.code(403).send({ error: "Forbidden for tenant" });
      return undefined;
    }

    return { viewer, account };
  };

  app.post("/api/login/resolve", async (request, reply) => {
    const parsed = loginResolutionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const resolution = resolveLogin(adminStore, parsed.data);
    reply.send({
      outcome: resolution.outcome,
      location: resolution.location,
      accounts: resolution.memberships.map((membership) => ({
        id: membership.account.id,
        slug: membership.account.slug,
        name: membership.account.name,
        brandName: membership.account.brandName ?? membership.account.name,
        role: membership.role,
        isDefault: membership.isDefault,
      })),
    });
  });

  app.get("/api/public/resolve", async (request, reply) => {
    const query = request.query as { host?: string; accountSlug?: string };
    const account =
      (query.host ? adminStore.getAccountByPublicHost(normalizeHost(query.host)) : undefined) ??
      (query.accountSlug ? adminStore.getAccountBySlug(query.accountSlug) : undefined);

    if (!account || account.status !== "active") {
      reply.code(404).send({ error: "Tenant not found" });
      return;
    }

    reply.send({
      accountId: account.id,
      accountSlug: account.slug,
      brandName: account.brandName ?? account.name,
      source: query.host ? "host" : "path",
    });
  });

  app.get("/login", async (_request, reply) => {
    reply.type("text/html").send(
      renderPage(
        "Login",
        `
          <section>
            <h1>Login entry point</h1>
            <p>Authentication is expected to land here, then resolve tenant access by normalized email.</p>
          </section>`,
      ),
    );
  });

  app.get("/login/access-pending", async (request, reply) => {
    const viewer = getViewer(request);
    reply.type("text/html").send(renderPage("Access Pending", renderAccessPending(viewer.email ?? "unknown user")));
  });

  app.get("/", async (request, reply) => {
    const hostHeader = typeof request.headers.host === "string" ? normalizeHost(request.headers.host) : undefined;
    const hostAccount = hostHeader ? adminStore.getAccountByPublicHost(hostHeader) : undefined;
    const fallbackAccount = hostAccount ?? adminStore.listAccounts().find((account) => account.status === "active");
    if (!fallbackAccount) {
      reply.code(404).send({ error: "No public tenant configured" });
      return;
    }

    reply.type("text/html").send(renderPublicSite(fallbackAccount));
  });

  app.get("/sites/:accountSlug", async (request, reply) => {
    const { accountSlug } = request.params as { accountSlug: string };
    const account = adminStore.getAccountBySlug(accountSlug);
    if (!account || account.status !== "active") {
      reply.code(404).send({ error: "Tenant not found" });
      return;
    }

    reply.type("text/html").send(renderPublicSite(account));
  });

  app.get("/ui", async (_request, reply) => {
    reply.type("text/html").send(renderReactShell());
  });

  app.get("/ui/*", async (_request, reply) => {
    reply.type("text/html").send(renderReactShell());
  });

  app.get("/app", async (request, reply) => {
    const viewer = getViewer(request);
    if (!viewer.userId || !viewer.email) {
      reply.code(303).header("location", "/login").send();
      return;
    }

    const resolution = resolveLogin(adminStore, { userId: viewer.userId, email: viewer.email });
    reply.code(303).header("location", resolution.location).send();
  });

  app.get("/app/select-account", async (request, reply) => {
    const viewer = getViewer(request);
    if (!viewer.userId || !viewer.email) {
      reply.code(303).header("location", "/login").send();
      return;
    }

    const resolution = resolveLogin(adminStore, { userId: viewer.userId, email: viewer.email });
    if (resolution.outcome === "access_pending") {
      reply.code(303).header("location", resolution.location).send();
      return;
    }

    reply.type("text/html").send(
      renderPage(
        "Select Account",
        renderTenantPicker(
          resolution.memberships.map((membership) => membership.account),
          viewer.email,
        ),
      ),
    );
  });

  app.get("/app/:accountSlug", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply.type("text/html").send(renderPage(`${access.account.brandName ?? access.account.name} Admin`, renderTenantAdminHome(access.account)));
  });

  app.get("/api/app/:accountSlug/account", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply.send(access.account);
  });

  app.patch("/api/app/:accountSlug/account", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const parsed = accountPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const account = adminStore.updateAccount(access.account.id, parsed.data);
    reply.send(account);
  });

  app.get("/api/app/:accountSlug/routing", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const routingRule = adminStore.getRoutingRule(access.account.id);
    if (!routingRule) {
      reply.code(404).send({ error: "Routing rule not found" });
      return;
    }

    reply.send(routingRule);
  });

  app.patch("/api/app/:accountSlug/routing", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const parsed = routingPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    reply.send(adminStore.upsertRoutingRule(access.account.id, parsed.data));
  });

  app.get("/api/app/:accountSlug/calls", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply.send({
      calls: store.list().filter((call) => call.accountId === access.account.id),
    });
  });

  app.get("/api/app/:accountSlug/calls/:callSid", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const { callSid } = request.params as { accountSlug: string; callSid: string };
    const session = findScopedCall(store, access.account.id, callSid);
    if (!session) {
      reply.code(404).send({ error: "Call session not found" });
      return;
    }

    reply.send(session);
  });

  app.get("/api/app/:accountSlug/callbacks", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply.send({
      callbacks: adminStore.listCallbackTasks().filter((task) => task.accountId === access.account.id),
    });
  });

  app.patch("/api/app/:accountSlug/callbacks/:callbackId", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const { callbackId } = request.params as { accountSlug: string; callbackId: string };
    if (!findScopedCallback(adminStore, access.account.id, callbackId)) {
      reply.code(404).send({ error: "Callback task not found" });
      return;
    }

    const parsed = callbackPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    reply.send(adminStore.updateCallbackTask(callbackId, parsed.data));
  });

  app.get("/api/app/:accountSlug/sync-failures", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply.send({
      syncFailures: adminStore.listSyncFailures().filter((failure) => failure.accountId === access.account.id),
    });
  });

  app.post("/api/app/:accountSlug/sync-failures/:syncFailureId/retry", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const { syncFailureId } = request.params as { accountSlug: string; syncFailureId: string };
    if (!findScopedSyncFailure(adminStore, access.account.id, syncFailureId)) {
      reply.code(404).send({ error: "Sync failure not found" });
      return;
    }

    reply.send(adminStore.retrySyncFailure(syncFailureId));
  });

  app.get("/app/:accountSlug/accounts", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply
      .type("text/html")
      .send(scopeTenantMarkup(renderPage(`${access.account.name} Account`, renderAccountDetail(access.account, adminStore.getRoutingRule(access.account.id))), access.account));
  });

  app.post("/app/:accountSlug/accounts", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const body = request.body as HtmlFormBody;
    const parsed = accountPatchSchema.safeParse({
      name: body.name,
      slug: body.slug,
      publicHost: body.publicHost || undefined,
      status: body.status,
      brandName: body.brandName || undefined,
      timezone: body.timezone,
      primaryPhoneNumber: body.primaryPhoneNumber,
      overflowModeEnabled: parseCheckbox(body.overflowModeEnabled),
      afterHoursScheduleEnabled: parseCheckbox(body.afterHoursScheduleEnabled),
      emergencyEscalationPhone: body.emergencyEscalationPhone,
      smsAckTemplate: body.smsAckTemplate,
      consentScript: body.consentScript,
      brandTheme: parseBrandTheme(body.brandTheme),
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const updatedAccount = adminStore.updateAccount(access.account.id, parsed.data);
    reply.code(303).header("location", `/app/${encodeURIComponent(updatedAccount?.slug ?? access.account.slug)}/accounts`).send();
  });

  app.get("/app/:accountSlug/routing", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    reply
      .type("text/html")
      .send(scopeTenantMarkup(renderPage(`${access.account.name} Routing`, renderRoutingRule(access.account, adminStore.getRoutingRule(access.account.id))), access.account));
  });

  app.post("/app/:accountSlug/routing", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const body = request.body as HtmlFormBody;
    const parsed = routingPatchSchema.safeParse({
      businessHours: parseBusinessHours(body),
      overflowThresholds: {
        maxActiveCalls: Number(body.maxActiveCalls ?? 0),
        maxQueueDepth: Number(body.maxQueueDepth ?? 0),
      },
      serviceAreaZipCodes: parseLines(body.serviceAreaZipCodes),
      supportedServiceTypes: parseLines(body.supportedServiceTypes),
      emergencyKeywords: parseLines(body.emergencyKeywords),
      unsupportedIntents: parseLines(body.unsupportedIntents),
      defaultDisposition: body.defaultDisposition,
      versionId: body.versionId,
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    adminStore.upsertRoutingRule(access.account.id, parsed.data);
    reply.code(303).header("location", `/app/${encodeURIComponent(access.account.slug)}/routing`).send();
  });

  app.get("/app/:accountSlug/calls", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const scopedCalls = store.list().filter((call) => call.accountId === access.account.id);
    reply
      .type("text/html")
      .send(scopeTenantMarkup(renderPage("Call Review", renderCallList(scopedCalls, new Map([[access.account.id, access.account]]))), access.account));
  });

  app.get("/app/:accountSlug/calls/:callSid", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const { callSid } = request.params as { accountSlug: string; callSid: string };
    const session = findScopedCall(store, access.account.id, callSid);
    if (!session) {
      reply.code(404).send({ error: "Call session not found" });
      return;
    }

    const callback = adminStore.listCallbackTasks().find((task) => task.callSid === callSid && task.accountId === access.account.id);
    const syncFailures = adminStore.listSyncFailures().filter((failure) => failure.callSid === callSid && failure.accountId === access.account.id);
    reply
      .type("text/html")
      .send(scopeTenantMarkup(renderPage(`Call ${callSid}`, renderCallDetail(session, access.account, adminStore.getRoutingRule(access.account.id), callback, syncFailures)), access.account));
  });

  app.get("/app/:accountSlug/callbacks", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const callbacks = adminStore.listCallbackTasks().filter((task) => task.accountId === access.account.id);
    const calls = store.list().filter((call) => call.accountId === access.account.id);
    reply
      .type("text/html")
      .send(scopeTenantMarkup(renderPage("Callback Queue", renderCallbacks(callbacks, new Map([[access.account.id, access.account]]), new Map(calls.map((call) => [call.callSid, call])))), access.account));
  });

  app.post("/app/:accountSlug/callbacks/:callbackId", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const { callbackId } = request.params as { accountSlug: string; callbackId: string };
    if (!findScopedCallback(adminStore, access.account.id, callbackId)) {
      reply.code(404).send({ error: "Callback task not found" });
      return;
    }

    const body = request.body as HtmlFormBody;
    const parsed = callbackPatchSchema.safeParse({
      ownerName: body.ownerName,
      status: body.status,
      notes: body.notes,
      dueAt: body.dueAt ? new Date(body.dueAt).toISOString() : undefined,
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    adminStore.updateCallbackTask(callbackId, parsed.data);
    reply.code(303).header("location", `/app/${encodeURIComponent(access.account.slug)}/callbacks`).send();
  });

  app.get("/app/:accountSlug/sync-failures", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const failures = adminStore.listSyncFailures().filter((failure) => failure.accountId === access.account.id);
    const calls = store.list().filter((call) => call.accountId === access.account.id);
    reply
      .type("text/html")
      .send(scopeTenantMarkup(renderPage("Failed Sync Review", renderSyncFailures(failures, new Map([[access.account.id, access.account]]), new Map(calls.map((call) => [call.callSid, call])))), access.account));
  });

  app.post("/app/:accountSlug/sync-failures/:syncFailureId/actions", async (request, reply) => {
    const access = await requireTenantAccess(request, reply);
    if (!access) {
      return;
    }

    const { syncFailureId } = request.params as { accountSlug: string; syncFailureId: string };
    if (!findScopedSyncFailure(adminStore, access.account.id, syncFailureId)) {
      reply.code(404).send({ error: "Sync failure not found" });
      return;
    }

    const body = request.body as HtmlFormBody;
    const parsed = syncFailureActionSchema.safeParse({
      action: body.action,
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    if (parsed.data.action === "retry") {
      adminStore.retrySyncFailure(syncFailureId);
    } else {
      adminStore.updateSyncFailureStatus(syncFailureId, parsed.data.action);
    }

    reply.code(303).header("location", `/app/${encodeURIComponent(access.account.slug)}/sync-failures`).send();
  });

  app.post("/twilio/voice/inbound", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;
    const callSid = body.CallSid ?? "unknown";
    const routingRule = adminStore.getRoutingRule(config.DEFAULT_ACCOUNT_ID);
    store.upsert(callSid, {
      accountId: config.DEFAULT_ACCOUNT_ID,
      from: body.From,
      to: body.To,
      promptVersionId: "prompt-v1",
      routingRuleVersionId: routingRule?.versionId ?? `rules-${config.DEFAULT_ACCOUNT_ID}-v1`,
      confidenceState: "medium",
      requiresHumanReview: false,
      syncStatus: "pending",
      callbackStatus: "new",
      sentSmsCopy: "Thanks for calling. The on-call team will return your call shortly.",
    });
    store.appendEvent(callSid, "inbound_webhook_received");

    const twiml = buildInboundTwiml({
      streamUrl: websocketUrl(config.PUBLIC_BASE_URL, `/twilio/voice/stream?callSid=${encodeURIComponent(callSid)}`),
      hostMessage:
        "Thanks for calling. I can help capture your service request and arrange a callback from the on-call team.",
      fallbackMessage:
        "We are switching to voicemail so we can make sure the team calls you back with the right information.",
      consentLine: config.TWILIO_RECORDING_CONSENT_LINE,
    });

    reply.type("text/xml").send(twiml);
  });

  app.get(
    "/twilio/voice/stream",
    { websocket: true },
    async (connection: WebSocket, request) => {
      const { callSid } = request.query as { callSid?: string };
      if (!callSid) {
        connection.close();
        return;
      }

      store.appendEvent(callSid, "twilio_socket_connected");
      let bridge: RealtimeBridge | undefined;

      try {
        bridge = new RealtimeBridge({
          callSid,
          config,
          twilioSocket: connection,
          store,
          adminStore,
          smsTransport,
          jobberTransport,
        });
        await bridge.connect();
      } catch (error) {
        store.upsert(callSid, {
          disposition: "callback_capture",
          fallbackReason: error instanceof Error ? error.message : "Unknown realtime setup failure",
          confidenceState: "low",
          requiresHumanReview: true,
          syncStatus: "failed",
        });
        store.appendEvent(callSid, "realtime_setup_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
        connection.close();
        return;
      }

      connection.on("message", (raw: Buffer) => {
        bridge?.handleTwilioMessage(raw.toString());
      });

      connection.on("close", () => {
        store.appendEvent(callSid, "twilio_socket_closed");
        bridge?.close();
      });
    },
  );

  app.get("/internal/calls/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };
    const session = store.get(callSid);
    if (!session) {
      reply.code(404).send({ error: "Call session not found" });
      return;
    }

    reply.send(session);
  });

  app.get("/api/accounts", async () => ({
    accounts: adminStore.listAccounts(),
    audit: adminStore.listAuditEntries(),
  }));

  app.get("/api/ui/overview", async () => ({
    accounts: adminStore.listAccounts().length,
    calls: store.list().length,
    callbacks: adminStore.listCallbacks().length,
    syncFailures: adminStore.listSyncFailures().length,
  }));

  app.get("/api/ui/calls", async () =>
    store.list().map((session) => ({
      callSid: session.callSid,
      accountId: session.accountId,
      status: session.status,
      updatedAt: session.updatedAt,
    })),
  );

  app.get("/api/ui/callbacks", async () =>
    adminStore.listCallbackTasks().map((task) => ({
      id: task.id,
      callSid: task.callSid,
      ownerName: task.ownerName,
      status: task.status,
      notes: task.notes,
      dueAt: task.dueAt,
    })),
  );

  app.get("/api/ui/sync-failures", async () =>
    adminStore.listSyncFailures().map((failure) => ({
      id: failure.id,
      callSid: failure.callSid,
      provider: failure.provider,
      status: failure.status,
      errorMessage: failure.errorMessage,
      createdAt: failure.createdAt,
    })),
  );

  app.post("/api/accounts", async (request, reply) => {
    const parsed = accountCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    const account = adminStore.createAccount(parsed.data);
    reply.code(201).send(account);
  });

  app.get("/api/accounts/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = adminStore.getAccount(accountId);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply.send(account);
  });

  app.patch("/api/accounts/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const parsed = accountPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    const account = adminStore.updateAccount(accountId, parsed.data);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply.send(account);
  });

  app.get("/api/accounts/:accountId/routing", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const routingRule = adminStore.getRoutingRule(accountId);
    if (!routingRule) {
      reply.code(404).send({ error: "Routing rule not found" });
      return;
    }
    reply.send(routingRule);
  });

  app.patch("/api/accounts/:accountId/routing", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const parsed = routingPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    if (!adminStore.getAccount(accountId)) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const routingRule = adminStore.upsertRoutingRule(accountId, parsed.data);
    reply.send(routingRule);
  });

  app.get("/api/calls", async () => ({
    calls: store.list(),
  }));

  app.get("/api/calls/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };
    const session = store.get(callSid);
    if (!session) {
      reply.code(404).send({ error: "Call session not found" });
      return;
    }
    reply.send(session);
  });

  app.get("/api/callbacks", async () => ({
    callbacks: adminStore.listCallbackTasks(),
  }));

  app.patch("/api/callbacks/:callbackId", async (request, reply) => {
    const { callbackId } = request.params as { callbackId: string };
    const parsed = callbackPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }
    const callback = adminStore.updateCallbackTask(callbackId, parsed.data);
    if (!callback) {
      reply.code(404).send({ error: "Callback task not found" });
      return;
    }
    reply.send(callback);
  });

  app.get("/api/sync-failures", async () => ({
    syncFailures: adminStore.listSyncFailures(),
  }));

  app.post("/api/sync-failures/:syncFailureId/retry", async (request, reply) => {
    const { syncFailureId } = request.params as { syncFailureId: string };
    const failure = adminStore.retrySyncFailure(syncFailureId);
    if (!failure) {
      reply.code(404).send({ error: "Sync failure not found" });
      return;
    }
    reply.send(failure);
  });

  app.post("/accounts", async (request, reply) => {
    const body = request.body as HtmlFormBody;
    const parsed = accountCreateSchema.safeParse({
      id: body.id,
      name: body.name,
      slug: body.slug,
      publicHost: body.publicHost || undefined,
      status: body.status,
      brandName: body.brandName || undefined,
      timezone: body.timezone,
      primaryPhoneNumber: body.primaryPhoneNumber,
      overflowModeEnabled: parseCheckbox(body.overflowModeEnabled),
      afterHoursScheduleEnabled: parseCheckbox(body.afterHoursScheduleEnabled),
      emergencyEscalationPhone: body.emergencyEscalationPhone,
      smsAckTemplate: body.smsAckTemplate,
      consentScript: body.consentScript,
      brandTheme: parseBrandTheme(body.brandTheme),
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const account = adminStore.createAccount(parsed.data);
    reply.code(303).header("location", `/accounts/${encodeURIComponent(account.id)}`).send();
  });

  app.post("/accounts/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const body = request.body as HtmlFormBody;
    const parsed = accountPatchSchema.safeParse({
      name: body.name,
      slug: body.slug,
      publicHost: body.publicHost || undefined,
      status: body.status,
      brandName: body.brandName || undefined,
      timezone: body.timezone,
      primaryPhoneNumber: body.primaryPhoneNumber,
      overflowModeEnabled: parseCheckbox(body.overflowModeEnabled),
      afterHoursScheduleEnabled: parseCheckbox(body.afterHoursScheduleEnabled),
      emergencyEscalationPhone: body.emergencyEscalationPhone,
      smsAckTemplate: body.smsAckTemplate,
      consentScript: body.consentScript,
      brandTheme: parseBrandTheme(body.brandTheme),
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const account = adminStore.updateAccount(accountId, parsed.data);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }

    reply.code(303).header("location", `/accounts/${encodeURIComponent(accountId)}`).send();
  });

  app.post("/accounts/:accountId/routing", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    if (!adminStore.getAccount(accountId)) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }

    const body = request.body as HtmlFormBody;
    const parsed = routingPatchSchema.safeParse({
      businessHours: parseBusinessHours(body),
      overflowThresholds: {
        maxActiveCalls: Number(body.maxActiveCalls ?? 0),
        maxQueueDepth: Number(body.maxQueueDepth ?? 0),
      },
      serviceAreaZipCodes: parseLines(body.serviceAreaZipCodes),
      supportedServiceTypes: parseLines(body.supportedServiceTypes),
      emergencyKeywords: parseLines(body.emergencyKeywords),
      unsupportedIntents: parseLines(body.unsupportedIntents),
      defaultDisposition: body.defaultDisposition,
      versionId: body.versionId,
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    adminStore.upsertRoutingRule(accountId, parsed.data);
    reply.code(303).header("location", `/accounts/${encodeURIComponent(accountId)}/routing`).send();
  });

  app.post("/callbacks/:callbackId", async (request, reply) => {
    const { callbackId } = request.params as { callbackId: string };
    const body = request.body as HtmlFormBody;
    const parsed = callbackPatchSchema.safeParse({
      ownerName: body.ownerName,
      status: body.status,
      notes: body.notes,
      dueAt: body.dueAt ? new Date(body.dueAt).toISOString() : undefined,
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const callback = adminStore.updateCallbackTask(callbackId, parsed.data);
    if (!callback) {
      reply.code(404).send({ error: "Callback task not found" });
      return;
    }

    reply.code(303).header("location", "/callbacks").send();
  });

  app.post("/sync-failures/:syncFailureId/actions", async (request, reply) => {
    const { syncFailureId } = request.params as { syncFailureId: string };
    const body = request.body as HtmlFormBody;
    const parsed = syncFailureActionSchema.safeParse({
      action: body.action,
    });
    if (!parsed.success) {
      reply.code(400).send({ error: parsed.error.flatten() });
      return;
    }

    const failure =
      parsed.data.action === "retry"
        ? adminStore.retrySyncFailure(syncFailureId)
        : adminStore.updateSyncFailureStatus(syncFailureId, parsed.data.action);

    if (!failure) {
      reply.code(404).send({ error: "Sync failure not found" });
      return;
    }

    reply.code(303).header("location", "/sync-failures").send();
  });

  app.get("/internal/admin", async (_request, reply) => {
    reply.code(303).header("location", "/ui/overview").send();
  });

  app.get("/accounts", async (_request, reply) => {
    const accounts = adminStore.listAccounts();
    const routingRulesById = new Map(
      accounts
        .map((account) => {
          const routingRule = adminStore.getRoutingRule(account.id);
          return routingRule ? [account.id, routingRule] : undefined;
        })
        .filter((entry): entry is [string, RoutingRule] => entry !== undefined),
    );
    reply.type("text/html").send(renderPage("Accounts", renderAccountList(accounts, routingRulesById)));
  });

  app.get("/accounts/new", async (_request, reply) => {
    reply.type("text/html").send(renderPage("New Account", renderAccountCreateForm()));
  });

  app.get("/accounts/:accountId", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = adminStore.getAccount(accountId);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply
      .type("text/html")
      .send(renderPage(account.name, renderAccountDetail(account, adminStore.getRoutingRule(accountId))));
  });

  app.get("/accounts/:accountId/routing", async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = adminStore.getAccount(accountId);
    if (!account) {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    reply
      .type("text/html")
      .send(renderPage(`${account.name} Routing`, renderRoutingRule(account, adminStore.getRoutingRule(accountId))));
  });

  app.get("/calls", async (_request, reply) => {
    reply.code(303).header("location", "/ui/calls").send();
  });

  app.get("/calls/:callSid", async (request, reply) => {
    const { callSid } = request.params as { callSid: string };
    const session = store.get(callSid);
    if (!session) {
      reply.code(404).send({ error: "Call session not found" });
      return;
    }
    const account = session.accountId ? adminStore.getAccount(session.accountId) : undefined;
    const routingRule = session.accountId ? adminStore.getRoutingRule(session.accountId) : undefined;
    const callback = adminStore.listCallbackTasks().find((task) => task.callSid === callSid);
    const syncFailures = adminStore.listSyncFailures().filter((failure) => failure.callSid === callSid);
    reply
      .type("text/html")
      .send(renderPage(`Call ${callSid}`, renderCallDetail(session, account, routingRule, callback, syncFailures)));
  });

  app.get("/callbacks", async (_request, reply) => {
    reply.code(303).header("location", "/ui/callbacks").send();
  });

  app.get("/sync-failures", async (_request, reply) => {
    reply.code(303).header("location", "/ui/sync").send();
  });

  return app;
}
