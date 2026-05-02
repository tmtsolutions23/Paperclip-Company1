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

function renderPage(title: string, content: string, options: { showMasthead?: boolean; accountSlug?: string } = {}): string {
  const showMasthead = options.showMasthead ?? true;
  const slug = options.accountSlug;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"/>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
    <link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,wght@0,400;0,700;1,400&family=Jost:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0d0b09;
        --bg-elevated: #1a1714;
        --panel: rgba(26,23,20,0.92);
        --panel-strong: #1e1b17;
        --ink: #ede4d3;
        --muted: #9a8e7d;
        --line: #2e2924;
        --accent: #e8743a;
        --accent-strong: #f2985d;
        --success: #6ec89b;
        --warn: #d4a84b;
        --danger: #cf5c5c;
        --radius: 10px;
        --shadow: 0 8px 32px rgba(0,0,0,0.45);
      }
      @keyframes fadeUp { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:translateY(0); } }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: 'Jost', sans-serif;
        font-weight: 400;
        color: var(--ink);
        background: var(--bg);
        position: relative;
      }
      body::before {
        content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:0.04;
        background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E");
      }
      body > * { position: relative; z-index: 1; }
      header, main { max-width: 1280px; margin: 0 auto; padding: 28px; animation: fadeUp .5s ease both; }
      .masthead, section, table, form, .card, .proof-card, .timeline-card, .faq-item, .industry-band {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }
      .masthead { padding: 24px; display: grid; gap: 14px; }
      .eyebrow { color: var(--accent); font-family: 'JetBrains Mono', monospace; font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; font-weight: 500; }
      .title-row { display:flex; justify-content:space-between; flex-wrap:wrap; gap:16px; align-items:end; }
      .title-block p, p, li, .muted, .entity-sublabel { color: var(--muted); }
      nav { display:flex; flex-wrap:wrap; gap:10px; }
      nav a, .button { border:1px solid var(--line); color:var(--ink); background:var(--bg-elevated); border-radius:8px; padding:10px 14px; text-decoration:none; transition:all .2s ease; font-weight: 500; font-family:'Jost',sans-serif; }
      nav a:hover, .button:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-1px); }
      .button.primary { background: var(--accent); color: #0d0b09; border-color: transparent; font-weight: 600; }
      .button.primary:hover { background: var(--accent-strong); }
      .button.secondary { background: rgba(232,116,58,0.12); color: var(--accent); }
      .hero-stats, .grid, .metric-grid, .step-grid, .proof-grid, .comparison-grid { display:grid; gap:14px; }
      .hero-stats { grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); }
      .hero-stats div, .metric-card, .attention-card, .logo-strip div, .step-grid article, .proof-grid article, .comparison-grid article { background: var(--panel-strong); border:1px solid var(--line); border-radius:8px; padding:16px; }
      .hero-label, th, .facts dt, .entity-eyebrow { text-transform: uppercase; letter-spacing: .1em; font-size: .72rem; font-family: 'JetBrains Mono', monospace; color: var(--muted); }
      .hero-value, h1, h2, .metric-card strong { font-family: 'Bodoni Moda', serif; letter-spacing: -0.02em; }
      .hero-value, .metric-card strong { color: var(--accent); }
      h1 { margin:0; font-size: clamp(2rem, 5vw, 3.4rem); font-weight: 700; }
      h2 { font-size: clamp(1.2rem,2.8vw,1.9rem); margin-top:0; font-weight: 700; }
      h3 { margin-top:0; font-size:1rem; font-family:'Jost',sans-serif; font-weight:600; }
      section, .card, form { padding:20px; margin-bottom:18px; }
      table { width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; margin-bottom:18px; background: var(--panel-strong); }
      th,td { padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
      th { background: rgba(232,116,58,0.08); color: var(--accent); }
      tr:last-child td { border-bottom:none; }
      tbody tr:hover td { background: rgba(232,116,58,0.05); }
      .grid.two { grid-template-columns: repeat(auto-fit,minmax(260px,1fr)); }
      .split-callout, .public-hero { display:grid; gap:16px; grid-template-columns: minmax(0,1.3fr) minmax(0,1fr); }
      input, textarea, select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid var(--line); color:var(--ink); background:var(--bg-elevated); font:inherit; font-family:'Jost',sans-serif; }
      input:focus, textarea:focus, select:focus { outline: 2px solid rgba(232,116,58,0.4); outline-offset: 1px; border-color: var(--accent); }
      code, pre { background: rgba(232,116,58,0.06); color:var(--ink); border-radius:8px; font-family:'JetBrains Mono',monospace; }
      pre { padding:14px; overflow:auto; }
      .pill,.checkmark { border-radius:999px; padding:5px 10px; font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; font-weight:600; font-family:'JetBrains Mono',monospace; }
      .pill-accent { background: rgba(232,116,58,0.14); color:var(--accent); }
      .pill-warn,.checkmark.pending { background: rgba(212,168,75,0.14); color:var(--warn); }
      .pill-danger { background: rgba(207,92,92,0.14); color:var(--danger); }
      .pill-neutral,.checkmark.ready { background: rgba(110,200,155,0.14); color:var(--success); }
      .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:14px 18px; margin:0; }
      .facts div, .checklist li, .activity-list li { border-top:1px solid var(--line); padding-top:12px; }
      .action-row,.nav-actions,.filter-row,.industry-tabs { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
      .checklist,.activity-list,.timeline,.faq-list,.stack,.overview-shell,.attention-list,.page-intro { list-style:none; padding:0; margin:0 0 18px; display:grid; gap:12px; }
      .checklist li { display:grid; grid-template-columns:auto 1fr; gap:12px; }
      .public-shell { min-height:100vh; background: radial-gradient(circle at top, rgba(232,116,58,.08), transparent 30%), var(--bg); }
      .public-nav { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px; }
      .logo-strip { grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); }
      .step-grid, .proof-grid, .comparison-grid { grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); }
      a { color: var(--accent); }
      a:visited { color: var(--accent-strong); }
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
            ${slug ? `<a href="/ui/${slug}">Dashboard</a>` : `<a href="/ui">Dashboard</a>`}
            ${slug ? `<a href="/ui/${slug}/accounts">Accounts</a>` : ""}
            ${slug ? `<a href="/ui/${slug}/calls">Calls</a>` : ""}
            ${slug ? `<a href="/ui/${slug}/callbacks">Callbacks</a>` : ""}
            ${slug ? `<a href="/ui/${slug}/sync">Sync Failures</a>` : ""}
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
  const brandAccent = escapeHtml(account.brandTheme?.accent ?? "#e8743a");
  const brandName = escapeHtml(account.brandName ?? account.name);
  const industryLabel = account.brandName?.includes("HVAC")
    ? "HVAC"
    : account.brandName?.includes("Electric")
      ? "Electrical"
      : "Home Services";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${brandName} — AI Reception</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Jost:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#0d0b09;--surface:#1a1611;--surface-raised:#262017;--ink:#ede4d3;--ink-strong:#faf5eb;--muted:#8a7d6b;--line:#342c21;--accent:${brandAccent};--accent-glow:#ff9960;--success:#5aad6b;--warn:#d4a843;--danger:#d44848;--radius:14px}
*{box-sizing:border-box;margin:0}
html{scroll-behavior:smooth}
body{font-family:'Jost',sans-serif;background:var(--bg);color:var(--ink);overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");pointer-events:none;z-index:9999}
@keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideIn{from{opacity:0;transform:translateX(-16px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.top-nav{position:fixed;top:0;left:0;right:0;z-index:100;padding:16px 40px;display:flex;justify-content:space-between;align-items:center;background:rgba(13,11,9,0.8);backdrop-filter:blur(16px);border-bottom:1px solid rgba(52,44,33,0.5)}
.top-nav .brand{font-family:'Bodoni Moda',serif;font-size:1.1rem;font-weight:700;color:var(--ink-strong);letter-spacing:0.04em}
.top-nav nav{display:flex;gap:24px;align-items:center}
.top-nav nav a{color:var(--muted);text-decoration:none;font-size:0.88rem;font-weight:500;transition:color 0.2s}
.top-nav nav a:hover{color:var(--ink-strong)}
.cta-btn{display:inline-flex;padding:9px 22px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#c4602e);color:#fff;text-decoration:none;font-weight:600;font-size:0.88rem;transition:all 0.2s;border:none;cursor:pointer}
.cta-btn:hover{filter:brightness(1.15);transform:translateY(-1px)}
.ghost-btn{display:inline-flex;padding:9px 22px;border-radius:8px;border:1px solid var(--line);color:var(--ink);text-decoration:none;font-weight:500;font-size:0.88rem;transition:all 0.2s}
.ghost-btn:hover{border-color:var(--accent);color:var(--accent)}
.hero{min-height:100vh;display:grid;grid-template-columns:1.2fr 0.8fr;gap:40px;align-items:center;padding:120px 60px 80px;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-20%;right:-10%;width:60%;height:70%;background:radial-gradient(ellipse,rgba(232,116,58,0.08) 0%,transparent 65%);pointer-events:none}
.hero-text{animation:fadeUp 0.6s ease-out both}
.hero-eyebrow{font-family:'JetBrains Mono',monospace;font-size:0.72rem;text-transform:uppercase;letter-spacing:0.14em;color:var(--accent);margin-bottom:16px;animation:fadeUp 0.5s ease-out 0.1s both}
.hero h1{font-family:'Bodoni Moda',serif;font-style:italic;font-size:clamp(2.4rem,5vw,4rem);line-height:1.08;color:var(--ink-strong);margin-bottom:20px;letter-spacing:-0.02em;animation:fadeUp 0.6s ease-out 0.2s both}
.hero-sub{font-size:1.1rem;color:var(--muted);line-height:1.6;max-width:520px;margin-bottom:28px;animation:fadeUp 0.5s ease-out 0.35s both}
.hero-actions{display:flex;gap:14px;flex-wrap:wrap;animation:fadeUp 0.5s ease-out 0.45s both}
.proof-timeline{display:flex;flex-direction:column;gap:0;position:relative;animation:fadeIn 0.8s ease-out 0.6s both}
.proof-timeline::before{content:'';position:absolute;left:7px;top:20px;bottom:20px;width:2px;background:linear-gradient(to bottom,var(--accent),var(--line))}
.timeline-item{display:flex;gap:16px;padding:14px 0;position:relative}
.timeline-item:nth-child(1){animation:slideIn 0.4s ease-out 0.7s both}
.timeline-item:nth-child(2){animation:slideIn 0.4s ease-out 0.85s both}
.timeline-item:nth-child(3){animation:slideIn 0.4s ease-out 1.0s both}
.timeline-item:nth-child(4){animation:slideIn 0.4s ease-out 1.15s both}
.timeline-dot{width:16px;height:16px;border-radius:50%;background:var(--accent);flex-shrink:0;margin-top:2px;box-shadow:0 0 12px rgba(232,116,58,0.3)}
.timeline-time{font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:var(--accent);min-width:65px}
.timeline-desc{font-size:0.88rem;color:var(--ink);line-height:1.5}
.trust-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:60px;background:var(--surface);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.trust-card{text-align:center;padding:24px}
.trust-card .trust-num{font-family:'Bodoni Moda',serif;font-size:2rem;color:var(--accent);font-weight:700;margin-bottom:6px}
.trust-card p{color:var(--muted);font-size:0.88rem}
section.pub-section{padding:80px 60px;max-width:1200px;margin:0 auto}
.pub-section h2{font-family:'Bodoni Moda',serif;font-size:clamp(1.6rem,3vw,2.4rem);color:var(--ink-strong);margin-bottom:12px;font-weight:700}
.pub-section .section-sub{color:var(--muted);margin-bottom:36px;font-size:1rem}
.step-flow{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;position:relative}
.step-flow::before{content:'';position:absolute;top:28px;left:10%;right:10%;height:2px;background:linear-gradient(to right,var(--line),var(--accent),var(--line))}
.step-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;position:relative;text-align:center;transition:all 0.25s ease}
.step-card:hover{border-color:var(--accent);transform:translateY(-4px);box-shadow:0 8px 30px rgba(0,0,0,0.3)}
.step-num{font-family:'Bodoni Moda',serif;font-size:2.4rem;color:var(--accent);font-weight:700;line-height:1;margin-bottom:10px}
.step-card h3{font-family:'Bodoni Moda',serif;font-size:1.1rem;margin-bottom:8px;color:var(--ink-strong)}
.step-card p{font-size:0.85rem;color:var(--muted);line-height:1.5}
.angled-section{padding:80px 60px;background:var(--surface);clip-path:polygon(0 4%,100% 0,100% 96%,0 100%);margin:40px 0}
.angled-inner{max-width:1200px;margin:0 auto}
.industry-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.ind-card{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:20px;transition:all 0.25s ease}
.ind-card:hover{border-color:var(--accent);box-shadow:0 0 20px rgba(232,116,58,0.06)}
.ind-card h3{font-family:'Bodoni Moda',serif;font-size:1rem;margin-bottom:6px;color:var(--ink-strong)}
.ind-card p{font-size:0.83rem;color:var(--muted);line-height:1.5}
.compare{display:grid;grid-template-columns:0.9fr 1.1fr;gap:24px}
.compare-card{border-radius:var(--radius);padding:28px;position:relative}
.compare-card.before{background:var(--surface);border:1px solid var(--line);opacity:0.8}
.compare-card.after{background:var(--surface);border:1px solid var(--accent);box-shadow:0 0 30px rgba(232,116,58,0.08)}
.compare-card h3{font-family:'Bodoni Moda',serif;font-size:1.2rem;margin-bottom:10px}
.compare-card.after h3{color:var(--accent)}
.compare-card p{font-size:0.9rem;color:var(--muted);line-height:1.6}
details{border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--surface);transition:all 0.2s}
details[open]{border-color:rgba(232,116,58,0.3)}
summary{padding:16px 20px;cursor:pointer;font-weight:600;font-size:0.95rem;color:var(--ink-strong);list-style:none;display:flex;justify-content:space-between;align-items:center}
summary::after{content:'+';color:var(--accent);font-size:1.2rem;transition:transform 0.2s}
details[open] summary::after{transform:rotate(45deg)}
details p{padding:0 20px 16px;color:var(--muted);font-size:0.9rem;line-height:1.6}
.cta-section{padding:100px 60px;text-align:center;position:relative;overflow:hidden}
.cta-section::before{content:'';position:absolute;top:50%;left:50%;width:600px;height:600px;transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(232,116,58,0.08),transparent 60%);pointer-events:none}
.cta-section h2{font-family:'Bodoni Moda',serif;font-style:italic;font-size:clamp(1.8rem,4vw,2.8rem);color:var(--ink-strong);margin-bottom:12px}
.cta-form{display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:560px;margin:32px auto 0;text-align:left}
.cta-form label{font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;display:flex;flex-direction:column;gap:5px}
.cta-form input{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font-family:'Jost',sans-serif;font-size:0.9rem;transition:border-color 0.2s}
.cta-form input:focus{outline:none;border-color:var(--accent)}
.cta-submit{grid-column:1/-1;display:flex;justify-content:center;margin-top:8px}
.pub-footer{text-align:center;padding:40px;border-top:1px solid var(--line);color:var(--muted);font-size:0.78rem}
.pub-footer span{font-family:'Bodoni Moda',serif;font-weight:600;color:var(--ink)}
.scroll-reveal{opacity:0;transform:translateY(20px);transition:opacity 0.6s ease-out,transform 0.6s ease-out}
.scroll-reveal.visible{opacity:1;transform:none}
@media(max-width:768px){.hero{grid-template-columns:1fr;padding:100px 24px 60px}.trust-strip{grid-template-columns:1fr;padding:40px 24px}.step-flow{grid-template-columns:1fr 1fr}.step-flow::before{display:none}section.pub-section,.angled-section,.cta-section{padding:50px 24px}.compare{grid-template-columns:1fr}.top-nav{padding:14px 20px}.top-nav nav{gap:12px}.cta-form{grid-template-columns:1fr}.angled-section{clip-path:none}}
</style>
</head>
<body>
<div class="top-nav">
  <div class="brand">${brandName}</div>
  <nav>
    <a href="#how-it-works">How It Works</a>
    <a href="#industries">Industries</a>
    <a href="#proof">Proof</a>
    <a href="#faq">FAQ</a>
    <a class="cta-btn" href="#book-demo">Book a Demo</a>
  </nav>
</div>

<section class="hero">
  <div class="hero-text">
    <div class="hero-eyebrow">${escapeHtml(industryLabel)} AI Reception</div>
    <h1>Never miss the call that becomes revenue.</h1>
    <p class="hero-sub">${brandName} answers overflow and after-hours calls, captures structured lead data, routes urgent jobs, and hands everything back to the team already running dispatch.</p>
    <div class="hero-actions">
      <a class="cta-btn" href="#book-demo">Book a demo</a>
      <a class="ghost-btn" href="#how-it-works">See how it works</a>
    </div>
  </div>
  <div class="proof-timeline">
    <div class="timeline-item"><div class="timeline-dot"></div><div><div class="timeline-time">8:42 PM</div><div class="timeline-desc">Caller reports no heat for a family home.</div></div></div>
    <div class="timeline-item"><div class="timeline-dot"></div><div><div class="timeline-time">8:43 PM</div><div class="timeline-desc">AI confirms address, urgency, and callback number.</div></div></div>
    <div class="timeline-item"><div class="timeline-dot"></div><div><div class="timeline-time">8:43 PM</div><div class="timeline-desc">Urgency tagged high. Callback created. On-call SMS sent.</div></div></div>
    <div class="timeline-item"><div class="timeline-dot"></div><div><div class="timeline-time">8:44 PM</div><div class="timeline-desc">CRM sync confirms lead creation for dispatch.</div></div></div>
  </div>
</section>

<div class="trust-strip scroll-reveal">
  <div class="trust-card"><div class="trust-num">24/7</div><p>After-hours and overflow coverage</p></div>
  <div class="trust-card"><div class="trust-num">&lt; 3</div><p>Ring pickup on every call</p></div>
  <div class="trust-card"><div class="trust-num">100%</div><p>Structured leads, never voicemails</p></div>
</div>

<section id="how-it-works" class="pub-section scroll-reveal">
  <h2>How it works</h2>
  <p class="section-sub">Four steps from ring to resolution — no dispatchers, no voicemail black holes.</p>
  <div class="step-flow">
    <div class="step-card"><div class="step-num">01</div><h3>Answer</h3><p>Pick up overflow and after-hours calls with brand-safe language and consent copy.</p></div>
    <div class="step-card"><div class="step-num">02</div><h3>Qualify</h3><p>Capture job type, urgency, location, and callback details in repeatable structure.</p></div>
    <div class="step-card"><div class="step-num">03</div><h3>Decide</h3><p>Apply routing rules for emergency escalation, callback creation, or booking handoff.</p></div>
    <div class="step-card"><div class="step-num">04</div><h3>Hand Off</h3><p>Deliver a usable callback record and sync status instead of another voicemail.</p></div>
  </div>
</section>

<div id="industries" class="angled-section">
  <div class="angled-inner scroll-reveal">
    <h2 style="font-family:'Bodoni Moda',serif;font-size:clamp(1.6rem,3vw,2.4rem);color:var(--ink-strong);margin-bottom:24px">Built for real service workflows</h2>
    <div class="industry-grid">
      <div class="ind-card"><h3>Plumbing</h3><p>Leak triage, water shutoff cues, and burst-pipe urgency classification.</p></div>
      <div class="ind-card"><h3>HVAC</h3><p>No-heat and no-cooling urgency routing with seasonal priority flags.</p></div>
      <div class="ind-card"><h3>Electrical</h3><p>Outage and sparking escalation paths for safety-critical intake.</p></div>
      <div class="ind-card"><h3>General</h3><p>Overflow capture and callback scheduling for any home service operation.</p></div>
    </div>
  </div>
</div>

<section id="proof" class="pub-section scroll-reveal">
  <h2>Before and after</h2>
  <p class="section-sub">What changes when every call leaves a structured trail.</p>
  <div class="compare">
    <div class="compare-card before"><h3>Before</h3><p>Missed calls hit generic voicemail. Dispatchers piece together urgency from fragments. Leads fall through cracks between shifts. No audit trail.</p></div>
    <div class="compare-card after"><h3>After</h3><p>Every captured call leaves a structured trail: transcript, disposition, callback task, and integration sync outcome. Dispatchers start with context, not guesswork.</p></div>
  </div>
</section>

<section id="faq" class="pub-section scroll-reveal">
  <h2>FAQ</h2>
  <div style="max-width:720px">
    <details><summary>Does this replace my dispatch software?</summary><p>No. It sits in front of the stack you already use and pushes cleaner, structured intake into it.</p></details>
    <details><summary>Can it vary by trade?</summary><p>Yes. The same system supports trade-specific urgency rules, escalation paths, and consent language through account-level configuration.</p></details>
    <details><summary>What does the team see internally?</summary><p>An operator console for call review, callback queue management, sync failure triage, and launch readiness tracking.</p></details>
    <details><summary>How fast is setup?</summary><p>Most accounts go live within a day. Configure your hours, escalation number, SMS template, and consent script — then deploy routing.</p></details>
  </div>
</section>

<section id="book-demo" class="cta-section">
  <h2>Ready to stop missing calls?</h2>
  <p style="color:var(--muted);margin-bottom:8px">Tell us about your operation and we will show you the console live.</p>
  <form class="cta-form">
    <label>Name<input name="name" placeholder="Alex Rivera"/></label>
    <label>Company<input name="company" placeholder="Northside Service Co."/></label>
    <label>Work Email<input name="email" type="email" placeholder="alex@northside.example"/></label>
    <label>Phone<input name="phone" placeholder="+15551234567"/></label>
    <div class="cta-submit"><button class="cta-btn" type="submit">Request Demo</button></div>
  </form>
</section>

<footer class="pub-footer"><span>Paperclip</span> — AI reception for home services &copy; ${new Date().getFullYear()}</footer>

<script>
const observer=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting)e.target.classList.add('visible')})},{threshold:0.15});
document.querySelectorAll('.scroll-reveal').forEach(el=>observer.observe(el));
</script>
</body>
</html>`;
}

function renderReactShell(accountSlug: string, accountName: string, viewer?: { userId?: string; email?: string }): string {
  const safeSlug = escapeHtml(accountSlug);
  const safeName = escapeHtml(accountName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeName} — Paperclip Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Jost:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{--bg:#0d0b09;--surface:#1a1611;--surface-raised:#262017;--surface-glass:rgba(26,22,17,0.85);--ink:#ede4d3;--ink-strong:#faf5eb;--muted:#8a7d6b;--line:#342c21;--line-subtle:#2a2319;--accent:#e8743a;--accent-glow:#ff9960;--accent-dim:rgba(232,116,58,0.15);--success:#5aad6b;--success-dim:rgba(90,173,107,0.15);--warn:#d4a843;--warn-dim:rgba(212,168,67,0.15);--danger:#d44848;--danger-dim:rgba(212,72,72,0.15);--radius:14px;--radius-sm:8px;--shadow:0 8px 32px rgba(0,0,0,0.4);--shadow-hover:0 12px 40px rgba(0,0,0,0.5)}
*{box-sizing:border-box;margin:0}
body{font-family:'Jost',sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");pointer-events:none;z-index:9999}
body::after{content:'';position:fixed;top:-20%;left:-10%;width:50%;height:60%;background:radial-gradient(ellipse,rgba(232,116,58,0.05) 0%,transparent 70%);pointer-events:none;z-index:0}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideIn{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes pulseGlow{0%,100%{box-shadow:0 0 0 0 rgba(232,116,58,0)}50%{box-shadow:0 0 20px 2px rgba(232,116,58,0.15)}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
.shell{display:grid;grid-template-columns:260px 1fr;min-height:100vh;position:relative;z-index:1}
.rail{background:var(--surface);border-right:1px solid var(--line);padding:28px 20px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.rail-brand{font-family:'Bodoni Moda',serif;font-size:1.1rem;font-weight:600;letter-spacing:0.04em;color:var(--ink-strong);margin-bottom:6px}
.rail-tenant{font-size:0.78rem;color:var(--muted);margin-bottom:32px;font-weight:400}
.rail-nav{display:flex;flex-direction:column;gap:4px;flex:1}
.rail-link{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:var(--radius-sm);color:var(--muted);text-decoration:none;font-size:0.92rem;font-weight:500;transition:all 0.2s ease;border-left:3px solid transparent;cursor:pointer}
.rail-link:hover{color:var(--ink);background:var(--surface-raised)}
.rail-link.active{color:var(--accent-glow);background:var(--accent-dim);border-left-color:var(--accent)}
.rail-link svg{width:18px;height:18px;flex-shrink:0;opacity:0.7}
.rail-link.active svg{opacity:1}
.rail-footer{margin-top:auto;padding-top:20px;border-top:1px solid var(--line-subtle);font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--muted);letter-spacing:0.08em;text-transform:uppercase}
.main{padding:36px 40px;min-height:100vh;animation:fadeUp 0.4s ease-out both}
.page-title{font-family:'Bodoni Moda',serif;font-size:clamp(1.6rem,3vw,2.2rem);font-weight:700;color:var(--ink-strong);margin-bottom:4px;letter-spacing:-0.02em}
.page-sub{color:var(--muted);font-size:0.88rem;margin-bottom:28px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:32px}
.stat-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px;transition:all 0.2s ease;animation:fadeUp 0.5s ease-out both}
.stat-card:nth-child(1){animation-delay:0s}.stat-card:nth-child(2){animation-delay:0.07s}.stat-card:nth-child(3){animation-delay:0.14s}.stat-card:nth-child(4){animation-delay:0.21s}
.stat-card:hover{border-color:var(--accent);box-shadow:0 0 24px rgba(232,116,58,0.06);transform:translateY(-2px)}
.stat-label{font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:600;margin-bottom:8px}
.stat-value{font-family:'Bodoni Moda',serif;font-size:2rem;color:var(--accent);font-weight:700;letter-spacing:-0.03em}
.section-title{font-family:'Bodoni Moda',serif;font-size:1.3rem;color:var(--ink-strong);margin-bottom:16px;font-weight:600}
.attention-grid{display:grid;gap:12px;margin-bottom:32px}
.att-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;display:flex;justify-content:space-between;align-items:center;gap:16px;transition:all 0.2s ease;animation:fadeUp 0.5s ease-out both}
.att-card:hover{border-color:var(--line);background:var(--surface-raised)}
.att-card .att-info{flex:1}
.att-card h4{font-size:0.88rem;font-weight:600;color:var(--ink);margin-bottom:4px}
.att-card p{font-size:0.8rem;color:var(--muted)}
.pill{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;font-size:0.68rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;font-family:'JetBrains Mono',monospace}
.pill-accent{background:var(--accent-dim);color:var(--accent-glow)}
.pill-warn{background:var(--warn-dim);color:var(--warn)}
.pill-danger{background:var(--danger-dim);color:var(--danger)}
.pill-success{background:var(--success-dim);color:var(--success)}
.pill-muted{background:rgba(138,125,107,0.15);color:var(--muted)}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:var(--radius-sm);font-family:'Jost',sans-serif;font-size:0.85rem;font-weight:600;border:1px solid var(--line);background:var(--surface-raised);color:var(--ink);cursor:pointer;transition:all 0.2s ease;text-decoration:none}
.btn:hover{border-color:var(--accent);transform:translateY(-1px)}
.btn-primary{background:linear-gradient(135deg,var(--accent),#c4602e);color:#fff;border:none}
.btn-primary:hover{filter:brightness(1.15);transform:translateY(-1px)}
.btn-danger{background:var(--danger-dim);color:var(--danger);border-color:var(--danger)}
.btn-sm{padding:5px 12px;font-size:0.78rem}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin-bottom:24px}
th{padding:12px 16px;text-align:left;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--muted);font-weight:600;background:rgba(0,0,0,0.15);border-bottom:1px solid var(--line)}
td{padding:12px 16px;border-bottom:1px solid var(--line-subtle);font-size:0.88rem;vertical-align:top}
tr:last-child td{border-bottom:none}
tbody tr{transition:background 0.15s ease;cursor:pointer}
tbody tr:hover{background:var(--surface-raised)}
.mono{font-family:'JetBrains Mono',monospace;font-size:0.8rem;color:var(--muted)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.split{display:grid;grid-template-columns:1.2fr 0.8fr;gap:20px;margin-bottom:24px}
.facts-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px 20px}
.fact-item{padding-top:10px;border-top:1px solid var(--line-subtle)}
.fact-label{font-size:0.68rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:4px;font-weight:600}
.fact-value{font-size:0.92rem;color:var(--ink)}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px}
.field{display:flex;flex-direction:column;gap:5px}
.field-label{font-size:0.78rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em}
.field-hint{font-size:0.72rem;color:var(--muted);opacity:0.7}
input,textarea,select{width:100%;padding:10px 14px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--bg);color:var(--ink);font-family:'Jost',sans-serif;font-size:0.9rem;transition:border-color 0.2s ease}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-dim)}
textarea{min-height:80px;resize:vertical}
select{cursor:pointer}
.toggle-row{display:flex;align-items:center;gap:10px;padding:6px 0}
.toggle{position:relative;width:40px;height:22px;border-radius:11px;background:var(--line);cursor:pointer;transition:background 0.2s ease}
.toggle.on{background:var(--accent)}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--ink-strong);transition:transform 0.2s ease}
.toggle.on::after{transform:translateX(18px)}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:var(--radius-sm);font-size:0.85rem;font-weight:500;z-index:10000;animation:fadeUp 0.3s ease-out both;pointer-events:none}
.toast-success{background:var(--success);color:#fff}
.toast-error{background:var(--danger);color:#fff}
.skeleton{background:linear-gradient(90deg,var(--surface) 25%,var(--surface-raised) 50%,var(--surface) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:var(--radius-sm);height:20px}
.skeleton-card{height:100px;border-radius:var(--radius)}
.skeleton-row{height:44px;margin-bottom:4px}
.back-link{display:inline-flex;align-items:center;gap:6px;color:var(--muted);text-decoration:none;font-size:0.85rem;margin-bottom:16px;transition:color 0.2s}
.back-link:hover{color:var(--accent)}
.checklist{list-style:none;padding:0;display:grid;gap:8px}
.check-item{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line-subtle)}
.check-dot{width:8px;height:8px;border-radius:50%}
.check-dot.ready{background:var(--success)}
.check-dot.pending{background:var(--warn)}
.transcript-block{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:16px 20px;font-family:'JetBrains Mono',monospace;font-size:0.8rem;line-height:1.7;color:var(--ink);white-space:pre-wrap;max-height:400px;overflow-y:auto}
.json-block{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:14px 18px;font-family:'JetBrains Mono',monospace;font-size:0.75rem;line-height:1.6;color:var(--muted);white-space:pre-wrap;overflow-x:auto;max-height:300px;overflow-y:auto}
.detail-section{margin-bottom:24px}
.detail-section h3{font-family:'Bodoni Moda',serif;font-size:1.1rem;color:var(--ink-strong);margin-bottom:12px}
.review-banner{padding:16px 20px;border-radius:var(--radius);margin-bottom:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.review-banner.warn{background:var(--warn-dim);border:1px solid rgba(212,168,67,0.3)}
.review-banner.clear{background:var(--success-dim);border:1px solid rgba(90,173,107,0.3)}
.review-banner h3{font-size:0.95rem;font-weight:600}
.inline-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}
.inline-form .field{min-width:120px;flex:1}
.hamburger{display:none;background:none;border:none;color:var(--ink);font-size:1.5rem;cursor:pointer;padding:8px}
@media(max-width:900px){.shell{grid-template-columns:1fr}.rail{display:none;position:fixed;inset:0;z-index:100;width:280px}.rail.open{display:flex}.hamburger{display:block;position:fixed;top:12px;left:12px;z-index:101}.main{padding:20px 16px;padding-top:56px}.split{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.stat-grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
import htm from 'https://esm.sh/htm@3.1.1';
import React,{useState,useEffect,useCallback,useRef} from 'https://esm.sh/react@18.3.1';
import{createRoot}from 'https://esm.sh/react-dom@18.3.1/client';
const html=htm.bind(React.createElement);const ce=React.createElement;
function css(s){const o={};s.split(';').forEach(p=>{const[k,...v]=p.split(':');if(k&&v.length){const prop=k.trim().replace(/-([a-z])/g,(_,c)=>c.toUpperCase());o[prop]=v.join(':').trim()}});return o}
const SLUG='${safeSlug}';
const ACCT_NAME='${safeName}';
const VIEWER_ID='${escapeHtml(viewer?.userId ?? "")}';
const VIEWER_EMAIL='${escapeHtml(viewer?.email ?? "")}';
const AUTH_HEADERS=VIEWER_ID?{'x-viewer-user-id':VIEWER_ID,'x-viewer-email':VIEWER_EMAIL}:{};
const API='/api/app/'+SLUG;

function fmtDate(v){if(!v)return'—';const d=new Date(v);return isNaN(d)?v:new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(d)}
function Pill({tone,children}){return html\`<span class="pill pill-\${tone}">\${children}</span>\`}
function Btn({primary,danger,sm,onClick,type,children,...rest}){const c='btn'+(primary?' btn-primary':'')+(danger?' btn-danger':'')+(sm?' btn-sm':'');return html\`<button class=\${c} type=\${type||'button'} onClick=\${onClick} ...\${rest}>\${children}</button>\`}
function Skeleton({type}){if(type==='card')return html\`<div class="skeleton skeleton-card"/>\`;if(type==='row')return html\`<div>\${[1,2,3,4].map(i=>html\`<div key=\${i} class="skeleton skeleton-row"/>\`)}</div>\`;return html\`<div class="skeleton" style=\${{width:(60+Math.random()*30)+'%'}}/>\`}

function useApi(path){
  const[state,set]=useState({loading:true,data:null,err:null});
  const load=useCallback(()=>{set(s=>({...s,loading:true,err:null}));fetch(API+path,{headers:AUTH_HEADERS}).then(r=>{if(!r.ok)throw new Error(r.status+' '+r.statusText);return r.json()}).then(data=>set({loading:false,data,err:null})).catch(err=>set({loading:false,data:null,err:err.message}))},[path]);
  useEffect(()=>{load()},[load]);
  return{...state,reload:load}
}

function Toast({msg,tone,onDone}){useEffect(()=>{const t=setTimeout(onDone,3000);return()=>clearTimeout(t)},[]);return html\`<div class="toast toast-\${tone}">\${msg}</div>\`}

function useToast(){
  const[t,setT]=useState(null);
  const show=useCallback((msg,tone='success')=>setT({msg,tone,key:Date.now()}),[]);
  const el=t?html\`<\${Toast} key=\${t.key} msg=\${t.msg} tone=\${t.tone} onDone=\${()=>setT(null)}/>\`:null;
  return{show,el}
}

// SVG icon helpers
const icons={
  overview:html\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>\`,
  account:html\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M19 21v-2a4 4 0 00-4-4H9a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>\`,
  routing:html\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>\`,
  calls:html\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>\`,
  callbacks:html\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><polyline points="12 6 12 12 16 14"/></svg>\`,
  sync:html\`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>\`
};

function Nav({route,setRoute,open,setOpen}){
  const links=[['overview','Overview',icons.overview],['account','Account Config',icons.account],['routing','Routing',icons.routing],['calls','Calls',icons.calls],['callbacks','Callbacks',icons.callbacks],['sync','Sync Failures',icons.sync]];
  return html\`<aside class="rail \${open?'open':''}">
    <div class="rail-brand">Paperclip</div>
    <div class="rail-tenant">\${ACCT_NAME}</div>
    <nav class="rail-nav">
      \${links.map(([id,label,icon])=>html\`<a key=\${id} class="rail-link \${route===id?'active':''}" href="/ui/\${SLUG}/\${id}" onClick=\${e=>{e.preventDefault();setRoute(id);setOpen(false);history.replaceState(null,'','/ui/'+SLUG+'/'+id)}}>\${icon} \${label}</a>\`)}
    </nav>
    <div class="rail-footer">Paperclip v1 Pilot</div>
  </aside>\`
}

function Overview(){
  const acct=useApi('/account');
  const calls=useApi('/calls');
  const cbs=useApi('/callbacks');
  const sf=useApi('/sync-failures');
  const callCount=calls.data?.calls?.length??0;
  const cbList=cbs.data?.callbacks??[];
  const sfList=sf.data?.syncFailures??[];
  const openCbs=cbList.filter(c=>c.status!=='resolved'&&c.status!=='closed_lost');
  const pendingSf=sfList.filter(f=>f.status==='pending'||f.status==='retrying');
  const flaggedCalls=(calls.data?.calls??[]).filter(c=>c.requiresHumanReview);
  const loading=acct.loading||calls.loading;

  return html\`<div>
    <h1 class="page-title">\${ACCT_NAME}</h1>
    <p class="page-sub">Operator command center — what needs attention right now</p>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Calls Today</div><div class="stat-value">\${loading?'—':callCount}</div></div>
      <div class="stat-card"><div class="stat-label">Open Callbacks</div><div class="stat-value">\${loading?'—':openCbs.length}</div></div>
      <div class="stat-card"><div class="stat-label">Sync Failures</div><div class="stat-value">\${loading?'—':pendingSf.length}</div></div>
      <div class="stat-card"><div class="stat-label">Account Status</div><div class="stat-value" style=\${{fontSize:'1.2rem'}}>\${acct.data?.status??'—'}</div></div>
    </div>
    \${flaggedCalls.length>0?html\`<div>
      <h2 class="section-title">Needs Attention</h2>
      <div class="attention-grid">
        \${flaggedCalls.slice(0,5).map((c,i)=>html\`<div key=\${c.callSid} class="att-card" style=\${{animationDelay:i*0.06+'s'}}>
          <div class="att-info"><h4>Call review required</h4><p>\${c.from??'Unknown'} — \${fmtDate(c.startedAt)}</p></div>
          <\${Pill} tone="warn">confidence \${c.confidenceState??'unknown'}<//>
        </div>\`)}
      </div>
    </div>\`:''}
    \${openCbs.length>0?html\`<div>
      <h2 class="section-title">Callbacks Due</h2>
      <div class="attention-grid">
        \${openCbs.slice(0,3).map((c,i)=>html\`<div key=\${c.id} class="att-card" style=\${{animationDelay:i*0.06+'s'}}>
          <div class="att-info"><h4>\${c.customerName}</h4><p>\${c.requestedService} — due \${fmtDate(c.dueAt)}</p></div>
          <\${Pill} tone="accent">\${c.status}<//>
        </div>\`)}
      </div>
    </div>\`:''}
    \${pendingSf.length>0?html\`<div>
      <h2 class="section-title">Pending Sync Failures</h2>
      <div class="attention-grid">
        \${pendingSf.slice(0,3).map((f,i)=>html\`<div key=\${f.id} class="att-card" style=\${{animationDelay:i*0.06+'s'}}>
          <div class="att-info"><h4>\${f.targetSystem}</h4><p>\${f.failureReason}</p></div>
          <\${Pill} tone="danger">\${f.status}<//>
        </div>\`)}
      </div>
    </div>\`:''}
  </div>\`
}

function AccountConfig(){
  const{loading,data,reload}=useApi('/account');
  const routing=useApi('/routing');
  const{show,el}=useToast();
  const[form,setForm]=useState(null);
  const[saving,setSaving]=useState(false);
  useEffect(()=>{if(data&&!form)setForm({name:data.name||'',slug:data.slug||'',publicHost:data.publicHost||'',brandName:data.brandName||'',timezone:data.timezone||'',primaryPhoneNumber:data.primaryPhoneNumber||'',emergencyEscalationPhone:data.emergencyEscalationPhone||'',status:data.status||'active',smsAckTemplate:data.smsAckTemplate||'',consentScript:data.consentScript||'',overflowModeEnabled:!!data.overflowModeEnabled,afterHoursScheduleEnabled:!!data.afterHoursScheduleEnabled})},[data]);

  if(loading||!form)return html\`<div><h1 class="page-title">Account Config</h1><\${Skeleton} type="card"/><\${Skeleton} type="card"/></div>\`;

  const rule=routing.data;
  const checks=[
    {label:'Hours configured',ok:rule&&Object.values(rule.businessHours||{}).some(s=>s.length>0)},
    {label:'Escalation number',ok:(data.emergencyEscalationPhone||'').trim().length>0},
    {label:'SMS template',ok:(data.smsAckTemplate||'').trim().length>0},
    {label:'Consent copy',ok:(data.consentScript||'').trim().length>0},
    {label:'Routing deployed',ok:!!rule?.versionId}
  ];

  const upd=(k,v)=>setForm(f=>({...f,[k]:v}));
  const save=async()=>{setSaving(true);try{const r=await fetch(API+'/account',{method:'PATCH',headers:{...AUTH_HEADERS,'Content-Type':'application/json'},body:JSON.stringify(form)});if(!r.ok)throw new Error('Save failed');show('Account saved','success');reload()}catch(e){show(e.message,'error')}finally{setSaving(false)}};

  return html\`<div>
    <h1 class="page-title">Account Config</h1>
    <p class="page-sub">\${data.name} — \${data.slug}</p>
    <div class="split">
      <div class="card">
        <h3 class="section-title">Current Config</h3>
        <div class="facts-grid">
          <div class="fact-item"><div class="fact-label">Name</div><div class="fact-value">\${data.name}</div></div>
          <div class="fact-item"><div class="fact-label">Slug</div><div class="fact-value mono">\${data.slug}</div></div>
          <div class="fact-item"><div class="fact-label">Status</div><div class="fact-value"><\${Pill} tone=\${data.status==='active'?'success':'muted'}>\${data.status}<//></div></div>
          <div class="fact-item"><div class="fact-label">Timezone</div><div class="fact-value">\${data.timezone}</div></div>
          <div class="fact-item"><div class="fact-label">Phone</div><div class="fact-value mono">\${data.primaryPhoneNumber}</div></div>
          <div class="fact-item"><div class="fact-label">Escalation</div><div class="fact-value mono">\${data.emergencyEscalationPhone}</div></div>
          <div class="fact-item"><div class="fact-label">Overflow</div><div class="fact-value">\${data.overflowModeEnabled?'Enabled':'Disabled'}</div></div>
          <div class="fact-item"><div class="fact-label">After Hours</div><div class="fact-value">\${data.afterHoursScheduleEnabled?'Enabled':'Disabled'}</div></div>
        </div>
      </div>
      <div class="card">
        <h3 class="section-title">Launch Readiness</h3>
        <ul class="checklist">
          \${checks.map(c=>html\`<li key=\${c.label} class="check-item"><span class="check-dot \${c.ok?'ready':'pending'}"/><span>\${c.label}</span></li>\`)}
        </ul>
        \${rule?html\`<div style=\${{marginTop:'12px'}} class="mono">Routing v\${rule.versionId} deployed \${fmtDate(rule.deployedAt)}</div>\`:''}
      </div>
    </div>
    <div class="card">
      <h3 class="section-title">Edit Account</h3>
      <div class="form-grid">
        <div class="field"><label class="field-label">Account Name</label><input value=\${form.name} onInput=\${e=>upd('name',e.target.value)}/></div>
        <div class="field"><label class="field-label">Slug</label><input value=\${form.slug} onInput=\${e=>upd('slug',e.target.value)}/></div>
        <div class="field"><label class="field-label">Public Host</label><input value=\${form.publicHost} onInput=\${e=>upd('publicHost',e.target.value)}/></div>
        <div class="field"><label class="field-label">Brand Name</label><input value=\${form.brandName} onInput=\${e=>upd('brandName',e.target.value)}/></div>
        <div class="field"><label class="field-label">Timezone</label><input value=\${form.timezone} onInput=\${e=>upd('timezone',e.target.value)}/><span class="field-hint">IANA format, e.g. America/Chicago</span></div>
        <div class="field"><label class="field-label">Primary Phone</label><input value=\${form.primaryPhoneNumber} onInput=\${e=>upd('primaryPhoneNumber',e.target.value)}/><span class="field-hint">E.164 format</span></div>
        <div class="field"><label class="field-label">Escalation Phone</label><input value=\${form.emergencyEscalationPhone} onInput=\${e=>upd('emergencyEscalationPhone',e.target.value)}/></div>
        <div class="field"><label class="field-label">Status</label><select value=\${form.status} onChange=\${e=>upd('status',e.target.value)}><option value="active">active</option><option value="inactive">inactive</option></select></div>
        <div class="field" style=\${{gridColumn:'1/-1'}}><label class="field-label">SMS Acknowledgement</label><textarea value=\${form.smsAckTemplate} onInput=\${e=>upd('smsAckTemplate',e.target.value)}/></div>
        <div class="field" style=\${{gridColumn:'1/-1'}}><label class="field-label">Consent Script</label><textarea value=\${form.consentScript} onInput=\${e=>upd('consentScript',e.target.value)}/><span class="field-hint">Recording and transcript consent language</span></div>
      </div>
      <div style=\${{display:'flex',gap:'20px',alignItems:'center',marginTop:'8px'}}>
        <div class="toggle-row"><div class="toggle \${form.overflowModeEnabled?'on':''}" onClick=\${()=>upd('overflowModeEnabled',!form.overflowModeEnabled)}/><span>Overflow mode</span></div>
        <div class="toggle-row"><div class="toggle \${form.afterHoursScheduleEnabled?'on':''}" onClick=\${()=>upd('afterHoursScheduleEnabled',!form.afterHoursScheduleEnabled)}/><span>After-hours schedule</span></div>
      </div>
      <div style=\${{marginTop:'16px'}}><\${Btn} primary onClick=\${save} disabled=\${saving}>\${saving?'Saving…':'Save Account'}<//></div>
    </div>
    \${el}
  </div>\`
}

function RoutingConfig(){
  const{loading,data,reload}=useApi('/routing');
  const{show,el}=useToast();
  const[form,setForm]=useState(null);
  const[saving,setSaving]=useState(false);
  const days=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  useEffect(()=>{if(data&&!form){const bh={};days.forEach(d=>{bh[d]=(data.businessHours?.[d]||[]).map(s=>s.start+'-'+s.end).join(', ')});setForm({...bh,maxActiveCalls:String(data.overflowThresholds?.maxActiveCalls??0),maxQueueDepth:String(data.overflowThresholds?.maxQueueDepth??0),defaultDisposition:data.defaultDisposition||'callback',versionId:data.versionId||'',serviceAreaZipCodes:(data.serviceAreaZipCodes||[]).join('\\n'),supportedServiceTypes:(data.supportedServiceTypes||[]).join('\\n'),emergencyKeywords:(data.emergencyKeywords||[]).join('\\n'),unsupportedIntents:(data.unsupportedIntents||[]).join('\\n')})}},[data]);

  if(loading)return html\`<div><h1 class="page-title">Routing</h1><\${Skeleton} type="card"/></div>\`;
  if(!data)return html\`<div><h1 class="page-title">Routing</h1><div class="card"><p>No routing rules configured yet.</p></div></div>\`;
  if(!form)return null;

  const upd=(k,v)=>setForm(f=>({...f,[k]:v}));
  const parseHours=(str)=>str.split(',').map(s=>s.trim()).filter(Boolean).map(s=>{const[a,b]=s.split('-').map(x=>x.trim());return{start:a||'',end:b||''}}).filter(s=>s.start&&s.end);
  const parseLines=(str)=>str.split(/\\n|,/).map(s=>s.trim()).filter(Boolean);

  const save=async()=>{setSaving(true);try{const bh={};days.forEach(d=>{bh[d]=parseHours(form[d]||'')});const body={businessHours:bh,overflowThresholds:{maxActiveCalls:Number(form.maxActiveCalls)||0,maxQueueDepth:Number(form.maxQueueDepth)||0},defaultDisposition:form.defaultDisposition,versionId:form.versionId,serviceAreaZipCodes:parseLines(form.serviceAreaZipCodes),supportedServiceTypes:parseLines(form.supportedServiceTypes),emergencyKeywords:parseLines(form.emergencyKeywords),unsupportedIntents:parseLines(form.unsupportedIntents)};const r=await fetch(API+'/routing',{method:'PATCH',headers:{...AUTH_HEADERS,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('Save failed');show('Routing saved','success');reload()}catch(e){show(e.message,'error')}finally{setSaving(false)}};

  return html\`<div>
    <h1 class="page-title">Routing Rules</h1>
    <p class="page-sub">Version \${data.versionId} — deployed \${fmtDate(data.deployedAt)}</p>
    <div class="split">
      <div class="card">
        <h3 class="section-title">Current Summary</h3>
        <div class="facts-grid">
          <div class="fact-item"><div class="fact-label">Default Disposition</div><div class="fact-value"><\${Pill} tone="accent">\${data.defaultDisposition}<//></div></div>
          <div class="fact-item"><div class="fact-label">Max Active Calls</div><div class="fact-value">\${data.overflowThresholds?.maxActiveCalls}</div></div>
          <div class="fact-item"><div class="fact-label">Max Queue Depth</div><div class="fact-value">\${data.overflowThresholds?.maxQueueDepth}</div></div>
          <div class="fact-item"><div class="fact-label">Service Zip Codes</div><div class="fact-value">\${(data.serviceAreaZipCodes||[]).join(', ')||'—'}</div></div>
        </div>
      </div>
      <div class="card">
        <h3 class="section-title">Coverage</h3>
        <div class="facts-grid">
          <div class="fact-item"><div class="fact-label">Services</div><div class="fact-value">\${(data.supportedServiceTypes||[]).join(', ')||'—'}</div></div>
          <div class="fact-item"><div class="fact-label">Emergency Keywords</div><div class="fact-value">\${(data.emergencyKeywords||[]).join(', ')||'—'}</div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <h3 class="section-title">Edit Routing</h3>
      <p style=\${{color:'var(--muted)',fontSize:'0.82rem',marginBottom:'16px'}}>Hours format: 08:00-12:00, 13:00-17:00 (comma-separated ranges)</p>
      <div class="form-grid">
        \${days.map(d=>html\`<div key=\${d} class="field"><label class="field-label">\${d[0].toUpperCase()+d.slice(1)}</label><input value=\${form[d]} onInput=\${e=>upd(d,e.target.value)}/></div>\`)}
        <div class="field"><label class="field-label">Max Active Calls</label><input type="number" min="0" value=\${form.maxActiveCalls} onInput=\${e=>upd('maxActiveCalls',e.target.value)}/></div>
        <div class="field"><label class="field-label">Max Queue Depth</label><input type="number" min="0" value=\${form.maxQueueDepth} onInput=\${e=>upd('maxQueueDepth',e.target.value)}/></div>
        <div class="field"><label class="field-label">Default Disposition</label><select value=\${form.defaultDisposition} onChange=\${e=>upd('defaultDisposition',e.target.value)}><option value="callback">callback</option><option value="book">book</option></select></div>
        <div class="field"><label class="field-label">Version ID</label><input value=\${form.versionId} onInput=\${e=>upd('versionId',e.target.value)}/></div>
        <div class="field"><label class="field-label">Service Area Zip Codes</label><textarea value=\${form.serviceAreaZipCodes} onInput=\${e=>upd('serviceAreaZipCodes',e.target.value)}/></div>
        <div class="field"><label class="field-label">Supported Services</label><textarea value=\${form.supportedServiceTypes} onInput=\${e=>upd('supportedServiceTypes',e.target.value)}/></div>
        <div class="field"><label class="field-label">Emergency Keywords</label><textarea value=\${form.emergencyKeywords} onInput=\${e=>upd('emergencyKeywords',e.target.value)}/></div>
        <div class="field"><label class="field-label">Unsupported Intents</label><textarea value=\${form.unsupportedIntents} onInput=\${e=>upd('unsupportedIntents',e.target.value)}/></div>
      </div>
      <div style=\${{marginTop:'16px'}}><\${Btn} primary onClick=\${save} disabled=\${saving}>\${saving?'Saving…':'Save Routing'}<//></div>
    </div>
    \${el}
  </div>\`
}

function CallsList({onSelect}){
  const{loading,data}=useApi('/calls');
  const calls=data?.calls||[];
  const dispTone=(d)=>d==='completed'?'success':d==='failed'?'danger':'accent';

  if(loading)return html\`<div><h1 class="page-title">Call Review</h1><\${Skeleton} type="row"/></div>\`;
  return html\`<div>
    <h1 class="page-title">Call Review</h1>
    <p class="page-sub">Review calls by confidence and operator flags</p>
    \${calls.length===0?html\`<div class="card"><p>No calls recorded yet.</p></div>\`:html\`<table>
      <thead><tr><th>Started</th><th>Caller</th><th>Disposition</th><th>Review</th><th>Confidence</th><th>Sync</th></tr></thead>
      <tbody>\${calls.map((c,i)=>html\`<tr key=\${c.callSid} onClick=\${()=>onSelect(c.callSid)} style=\${{animation:'fadeUp 0.4s ease-out '+i*0.03+'s both'}}>
        <td class="mono">\${fmtDate(c.startedAt)}</td>
        <td>\${c.from??'unknown'}</td>
        <td><\${Pill} tone=\${dispTone(c.disposition)}>\${c.disposition}<//></td>
        <td>\${c.requiresHumanReview?ce(Pill,{tone:'warn'},'needs review'):ce(Pill,{tone:'success'},'clear')}</td>
        <td><\${Pill} tone="muted">\${c.confidenceState??'unknown'}<//></td>
        <td>\${c.syncStatus??'not started'}</td>
      </tr>\`)}</tbody>
    </table>\`}
  </div>\`
}

function CallDetail({callSid,onBack}){
  const{loading,data}=useApi('/calls/'+callSid);
  if(loading)return html\`<div><a class="back-link" onClick=\${onBack}>← Back to calls</a><\${Skeleton} type="card"/></div>\`;
  if(!data)return html\`<div><a class="back-link" onClick=\${onBack}>← Back to calls</a><div class="card"><p>Call not found.</p></div></div>\`;
  const c=data;
  return html\`<div>
    <a class="back-link" onClick=\${onBack}>← Back to calls</a>
    <h1 class="page-title">Call \${callSid}</h1>
    \${c.requiresHumanReview?html\`<div class="review-banner warn"><h3>Review Required</h3><\${Pill} tone="warn">confidence \${c.confidenceState??'unknown'}<//><\${Pill} tone="accent">callback \${c.callbackStatus??'n/a'}<//><\${Pill} tone=\${c.syncStatus==='failed'?'danger':'muted'}>sync \${c.syncStatus??'not started'}<//></div>\`:html\`<div class="review-banner clear"><h3>No Review Needed</h3><\${Pill} tone="success">clear<//></div>\`}
    <div class="split">
      <div class="card">
        <h3 class="section-title">Outcome</h3>
        <div class="facts-grid">
          <div class="fact-item"><div class="fact-label">Call SID</div><div class="fact-value mono">\${c.callSid}</div></div>
          <div class="fact-item"><div class="fact-label">Disposition</div><div class="fact-value"><\${Pill} tone="accent">\${c.disposition}<//></div></div>
          <div class="fact-item"><div class="fact-label">Started</div><div class="fact-value">\${fmtDate(c.startedAt)}</div></div>
          <div class="fact-item"><div class="fact-label">Caller</div><div class="fact-value">\${c.from??'unknown'}</div></div>
          <div class="fact-item"><div class="fact-label">Prompt Version</div><div class="fact-value mono">\${c.promptVersionId??'prompt-v1'}</div></div>
          <div class="fact-item"><div class="fact-label">Routing Version</div><div class="fact-value mono">\${c.routingRuleVersionId??'rules-v1'}</div></div>
          <div class="fact-item"><div class="fact-label">Sync</div><div class="fact-value">\${c.syncStatus??'not started'}</div></div>
          <div class="fact-item"><div class="fact-label">Callback</div><div class="fact-value">\${c.callbackStatus??'not required'}</div></div>
        </div>
      </div>
      <div class="card">
        <h3 class="section-title">SMS & Context</h3>
        <div class="fact-item"><div class="fact-label">SMS Copy Sent</div><div class="fact-value">\${c.sentSmsCopy??'Not sent'}</div></div>
        \${c.fallbackReason?html\`<div class="fact-item" style=\${{marginTop:'10px'}}><div class="fact-label">Fallback Reason</div><div class="fact-value" style=\${{color:'var(--warn)'}}>\${c.fallbackReason}</div></div>\`:''}
      </div>
    </div>
    <div class="detail-section"><h3>Transcript</h3><div class="transcript-block">\${(c.transcript||[]).join('\\n')||'Transcript not captured yet.'}</div></div>
    \${c.structuredIntake?html\`<div class="detail-section"><h3>Structured Intake</h3><div class="json-block">\${JSON.stringify(c.structuredIntake,null,2)}</div></div>\`:''}
    \${c.leadRecord?html\`<div class="detail-section"><h3>Lead Record</h3><div class="json-block">\${JSON.stringify(c.leadRecord,null,2)}</div></div>\`:''}
    \${c.events?.length?html\`<div class="detail-section"><h3>Events</h3><div class="json-block">\${JSON.stringify(c.events,null,2)}</div></div>\`:''}
  </div>\`
}

function Callbacks(){
  const{loading,data,reload}=useApi('/callbacks');
  const{show,el}=useToast();
  const cbs=data?.callbacks||[];
  const[editing,setEditing]=useState(null);
  const[form,setForm]=useState({});
  const startEdit=(cb)=>{setEditing(cb.id);setForm({ownerName:cb.ownerName||'',status:cb.status,notes:cb.notes||'',dueAt:cb.dueAt?cb.dueAt.slice(0,16):''})};
  const save=async(id)=>{try{const body={...form};if(body.dueAt)body.dueAt=new Date(body.dueAt).toISOString();const r=await fetch(API+'/callbacks/'+id,{method:'PATCH',headers:{...AUTH_HEADERS,'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error('Update failed');show('Callback updated','success');setEditing(null);reload()}catch(e){show(e.message,'error')}};

  if(loading)return html\`<div><h1 class="page-title">Callback Queue</h1><\${Skeleton} type="row"/></div>\`;
  const urgTone=(u)=>u==='emergency'?'danger':u==='high'?'warn':u==='medium'?'accent':'muted';

  return html\`<div>
    <h1 class="page-title">Callback Queue</h1>
    <p class="page-sub">Manage follow-up tasks from captured calls</p>
    \${cbs.length===0?html\`<div class="card"><p>No callbacks in queue.</p></div>\`:html\`<table>
      <thead><tr><th>Due</th><th>Customer</th><th>Service</th><th>Urgency</th><th>Owner</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>\${cbs.map(c=>html\`<tr key=\${c.id}>
        <td class="mono">\${fmtDate(c.dueAt)}</td>
        <td>\${c.customerName}<br/><span class="mono" style=\${{fontSize:'0.75rem'}}>\${c.phone}</span></td>
        <td>\${c.requestedService}</td>
        <td><\${Pill} tone=\${urgTone(c.urgency)}>\${c.urgency}<//></td>
        <td>\${editing===c.id?ce('input',{style:{width:'120px'},value:form.ownerName,onInput:e=>setForm(f=>({...f,ownerName:e.target.value}))}):c.ownerName||'Unassigned'}</td>
        <td>\${editing===c.id?ce('select',{style:{width:'120px'},value:form.status,onChange:e=>setForm(f=>({...f,status:e.target.value}))},['new','assigned','contacted','resolved','closed_lost'].map(s=>ce('option',{key:s,value:s},s))):ce(Pill,{tone:c.status==='resolved'?'success':c.status==='closed_lost'?'muted':'accent'},c.status)}</td>
        <td>\${editing===c.id?ce('div',{style:{display:'flex',gap:'6px'}},ce(Btn,{sm:true,primary:true,onClick:()=>save(c.id)},'Save'),ce(Btn,{sm:true,onClick:()=>setEditing(null)},'Cancel')):ce(Btn,{sm:true,onClick:()=>startEdit(c)},'Edit')}</td>
      </tr>\`)}</tbody>
    </table>\`}
    \${el}
  </div>\`
}

function SyncFailures(){
  const{loading,data,reload}=useApi('/sync-failures');
  const{show,el}=useToast();
  const failures=data?.syncFailures||[];
  const retry=async(id)=>{try{const r=await fetch(API+'/sync-failures/'+id+'/retry',{method:'POST',headers:AUTH_HEADERS});if(!r.ok)throw new Error('Retry failed');show('Retry initiated','success');reload()}catch(e){show(e.message,'error')}};

  if(loading)return html\`<div><h1 class="page-title">Sync Failures</h1><\${Skeleton} type="row"/></div>\`;
  return html\`<div>
    <h1 class="page-title">Sync Failures</h1>
    <p class="page-sub">Diagnose and retry failed integration syncs</p>
    \${failures.length===0?html\`<div class="card"><p style=\${{color:'var(--success)'}}>No sync failures. All integrations healthy.</p></div>\`:html\`<table>
      <thead><tr><th>Target</th><th>Reason</th><th>Retries</th><th>Last Attempt</th><th>Payload</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>\${failures.map(f=>html\`<tr key=\${f.id}>
        <td style=\${{fontWeight:'600'}}>\${f.targetSystem}</td>
        <td>\${f.failureReason}</td>
        <td class="mono">\${f.retryCount}</td>
        <td class="mono">\${fmtDate(f.lastAttemptAt)}</td>
        <td style=\${{maxWidth:'200px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>\${f.payloadSummary}</td>
        <td><\${Pill} tone=\${f.status==='resolved'?'success':f.status==='pending'?'danger':'warn'}>\${f.status}<//></td>
        <td>\${f.status!=='resolved'?ce(Btn,{sm:true,primary:true,onClick:()=>retry(f.id)},'Retry'):ce('span',{className:'mono'},'done')}</td>
      </tr>\`)}</tbody>
    </table>\`}
    \${el}
  </div>\`
}

function App(){
  const parts=location.pathname.split('/').filter(Boolean);
  const initial=parts[2]||'overview';
  const[route,setRoute]=useState(initial);
  const[selectedCall,setCall]=useState(null);
  const[navOpen,setNavOpen]=useState(false);

  let page;
  if(route==='account')page=html\`<\${AccountConfig}/>\`;
  else if(route==='routing')page=html\`<\${RoutingConfig}/>\`;
  else if(route==='calls'&&selectedCall)page=html\`<\${CallDetail} callSid=\${selectedCall} onBack=\${()=>setCall(null)}/>\`;
  else if(route==='calls')page=html\`<\${CallsList} onSelect=\${sid=>setCall(sid)}/>\`;
  else if(route==='callbacks')page=html\`<\${Callbacks}/>\`;
  else if(route==='sync')page=html\`<\${SyncFailures}/>\`;
  else page=html\`<\${Overview}/>\`;

  return html\`<div class="shell">
    <button class="hamburger" onClick=\${()=>setNavOpen(!navOpen)}>☰</button>
    <\${Nav} route=\${route} setRoute=\${r=>{setRoute(r);setCall(null)}} open=\${navOpen} setOpen=\${setNavOpen}/>
    <main class="main" key=\${route}>\${page}</main>
  </div>\`
}

createRoot(document.getElementById('root')).render(html\`<\${App}/>\`);
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
      location: `/ui/${encodeURIComponent(chosenMembership.account.slug)}`,
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

  app.get("/ui", async (request, reply) => {
    const viewer = getViewer(request);
    if (!viewer.userId || !viewer.email) {
      reply.code(303).header("location", "/login").send();
      return;
    }
    const resolution = resolveLogin(adminStore, { userId: viewer.userId, email: viewer.email });
    reply.code(303).header("location", resolution.location).send();
  });

  app.get("/ui/:accountSlug", async (request, reply) => {
    const { accountSlug } = request.params as { accountSlug: string };
    const account = adminStore.getAccountBySlug(accountSlug);
    if (!account || account.status !== "active") {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const viewer = getViewer(request);
    reply.type("text/html").send(renderReactShell(account.slug, account.brandName ?? account.name, viewer));
  });

  app.get("/ui/:accountSlug/*", async (request, reply) => {
    const { accountSlug } = request.params as { accountSlug: string };
    const account = adminStore.getAccountBySlug(accountSlug);
    if (!account || account.status !== "active") {
      reply.code(404).send({ error: "Account not found" });
      return;
    }
    const viewer = getViewer(request);
    reply.type("text/html").send(renderReactShell(account.slug, account.brandName ?? account.name, viewer));
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
      .send(scopeTenantMarkup(renderPage(`${access.account.name} Account`, renderAccountDetail(access.account, adminStore.getRoutingRule(access.account.id)), { accountSlug: access.account.slug }), access.account));
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
      .send(scopeTenantMarkup(renderPage(`${access.account.name} Routing`, renderRoutingRule(access.account, adminStore.getRoutingRule(access.account.id)), { accountSlug: access.account.slug }), access.account));
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
      .send(scopeTenantMarkup(renderPage("Call Review", renderCallList(scopedCalls, new Map([[access.account.id, access.account]])), { accountSlug: access.account.slug }), access.account));
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
      .send(scopeTenantMarkup(renderPage(`Call ${callSid}`, renderCallDetail(session, access.account, adminStore.getRoutingRule(access.account.id), callback, syncFailures), { accountSlug: access.account.slug }), access.account));
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
      .send(scopeTenantMarkup(renderPage("Callback Queue", renderCallbacks(callbacks, new Map([[access.account.id, access.account]]), new Map(calls.map((call) => [call.callSid, call]))), { accountSlug: access.account.slug }), access.account));
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
      .send(scopeTenantMarkup(renderPage("Failed Sync Review", renderSyncFailures(failures, new Map([[access.account.id, access.account]]), new Map(calls.map((call) => [call.callSid, call]))), { accountSlug: access.account.slug }), access.account));
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
    callbacks: adminStore.listCallbackTasks().length,
    syncFailures: adminStore.listSyncFailures().length,
  }));

  app.get("/api/ui/calls", async () =>
    store.list().map((session) => ({
      callSid: session.callSid,
      accountId: session.accountId,
      status: session.disposition,
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
      provider: failure.targetSystem,
      status: failure.status,
      errorMessage: failure.failureReason,
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
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/accounts", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/accounts/new", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/accounts/:accountId", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/accounts/:accountId/routing", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/calls", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/calls/:callSid", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/callbacks", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  app.get("/sync-failures", async (_request, reply) => {
    reply.code(303).header("location", "/ui").send();
  });

  return app;
}
