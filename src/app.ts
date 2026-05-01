import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket, { type WebSocket } from "@fastify/websocket";
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
  timezone: z.string().min(1),
  primaryPhoneNumber: z.string().min(1),
  overflowModeEnabled: z.boolean(),
  afterHoursScheduleEnabled: z.boolean(),
  emergencyEscalationPhone: z.string().min(1),
  smsAckTemplate: z.string().min(1),
  consentScript: z.string().min(1),
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

function renderPage(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #efe1cb;
        --bg-deep: #d6b894;
        --panel: rgba(255, 251, 245, 0.9);
        --panel-strong: #fffdf9;
        --ink: #231710;
        --muted: #65584d;
        --line: rgba(115, 81, 56, 0.22);
        --accent: #8e2f1c;
        --accent-strong: #60180d;
        --accent-soft: rgba(233, 200, 181, 0.7);
        --gold: #8e6b28;
        --olive: #465445;
        --danger: #8b1e3f;
        --shadow: 0 28px 60px rgba(64, 36, 11, 0.16);
        --radius: 24px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
        background:
          linear-gradient(135deg, rgba(255,255,255,0.28), transparent 34%),
          radial-gradient(circle at top left, #f9efe0 0, var(--bg) 46%, var(--bg-deep) 100%);
        background-attachment: fixed;
        color: var(--ink);
        position: relative;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          linear-gradient(90deg, rgba(96, 24, 13, 0.04), transparent 18%, transparent 82%, rgba(96, 24, 13, 0.04)),
          repeating-linear-gradient(0deg, rgba(96, 24, 13, 0.035), rgba(96, 24, 13, 0.035) 1px, transparent 1px, transparent 5px);
        mix-blend-mode: multiply;
        opacity: 0.55;
      }
      header, main {
        max-width: 1240px;
        margin: 0 auto;
        padding: 28px;
        position: relative;
      }
      header {
        padding-top: 36px;
      }
      .masthead {
        display: grid;
        gap: 18px;
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: calc(var(--radius) + 8px);
        background:
          linear-gradient(125deg, rgba(255,255,255,0.72), rgba(255,248,239,0.86)),
          linear-gradient(180deg, rgba(142, 47, 28, 0.08), transparent 60%);
        box-shadow: var(--shadow);
      }
      .eyebrow {
        display: inline-flex;
        width: fit-content;
        align-items: center;
        gap: 10px;
        padding: 7px 14px;
        border: 1px solid rgba(142, 47, 28, 0.18);
        border-radius: 999px;
        background: rgba(255, 247, 239, 0.84);
        color: var(--accent-strong);
        font-family: "Courier New", monospace;
        font-size: 0.74rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      .title-row {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
      }
      .title-block {
        display: grid;
        gap: 8px;
        max-width: 760px;
      }
      .title-block p {
        margin: 0;
        max-width: 62ch;
      }
      nav {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 6px;
      }
      nav a, .button {
        border: 1px solid var(--line);
        background: rgba(255, 252, 247, 0.92);
        color: var(--ink);
        padding: 10px 14px;
        text-decoration: none;
        border-radius: 999px;
        transition: transform 140ms ease, background 140ms ease, border-color 140ms ease;
      }
      nav a:hover, .button:hover {
        transform: translateY(-1px);
        background: #fff;
        border-color: rgba(142, 47, 28, 0.28);
      }
      .button.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .button.secondary {
        background: rgba(233, 200, 181, 0.45);
        color: var(--accent-strong);
      }
      .hero-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 14px;
      }
      .hero-stats div {
        padding: 16px 18px;
        border-radius: 20px;
        border: 1px solid var(--line);
        background: rgba(255, 252, 247, 0.84);
      }
      .hero-label {
        margin: 0 0 6px;
        color: var(--muted);
        font-size: 0.78rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .hero-value {
        margin: 0;
        font-family: "Didot", "Bodoni 72", serif;
        font-size: 1.7rem;
      }
      section, table, form, .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        backdrop-filter: blur(8px);
      }
      section, .card, form { padding: 22px; margin-bottom: 22px; }
      h1, h2, h3 { margin-top: 0; }
      h1 {
        margin-bottom: 0;
        font-family: "Didot", "Bodoni 72", serif;
        font-size: clamp(2.8rem, 5vw, 5rem);
        line-height: 0.96;
        letter-spacing: -0.05em;
      }
      h2 {
        font-family: "Didot", "Bodoni 72", serif;
        font-size: clamp(1.4rem, 2vw, 2rem);
        letter-spacing: -0.03em;
      }
      h3 {
        font-size: 1rem;
        text-transform: uppercase;
        letter-spacing: 0.14em;
      }
      p, li {
        color: var(--muted);
        line-height: 1.58;
      }
      table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        overflow: hidden;
        margin-bottom: 20px;
        background: var(--panel-strong);
      }
      th, td {
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      th {
        background: linear-gradient(180deg, var(--accent-soft), rgba(255,255,255,0.7));
        color: var(--accent-strong);
        font-size: 0.78rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      tbody tr:hover td {
        background: rgba(255, 248, 239, 0.58);
      }
      tr:last-child td { border-bottom: none; }
      .grid {
        display: grid;
        gap: 20px;
      }
      .grid.two {
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }
      .split-callout {
        display: grid;
        gap: 18px;
        grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr);
      }
      label { display: grid; gap: 6px; font-weight: 600; }
      input, textarea, select {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid rgba(115, 81, 56, 0.26);
        border-radius: 14px;
        font: inherit;
        background: rgba(255,255,255,0.9);
      }
      textarea { min-height: 110px; }
      code, pre {
        font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
        background: #f9f3ea;
        border-radius: 12px;
      }
      pre { padding: 16px; overflow: auto; }
      .pill {
        display: inline-block;
        padding: 5px 10px;
        border-radius: 999px;
        background: rgba(31, 25, 20, 0.07);
        color: var(--ink);
        font-size: 0.76rem;
        font-family: "Courier New", monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .pill-accent {
        background: rgba(142, 47, 28, 0.12);
        color: var(--accent-strong);
      }
      .pill-warn {
        background: rgba(142, 107, 40, 0.16);
        color: #6d5115;
      }
      .pill-danger {
        background: rgba(139, 30, 63, 0.12);
        color: var(--danger);
      }
      .pill-neutral {
        background: rgba(70, 84, 69, 0.12);
        color: var(--olive);
      }
      .muted { color: var(--muted); }
      .lede {
        font-size: 1.04rem;
      }
      .entity-link, .entity-static {
        display: grid;
        gap: 4px;
        text-decoration: none;
        color: inherit;
        margin-bottom: 10px;
      }
      .entity-link strong, .entity-static strong {
        color: var(--accent-strong);
      }
      .entity-eyebrow {
        color: var(--muted);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }
      .entity-sublabel {
        color: var(--muted);
        font-size: 0.93rem;
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 14px 18px;
        margin: 0;
      }
      .facts div {
        padding: 14px 0 0;
        border-top: 1px solid var(--line);
      }
      .facts dt {
        color: var(--muted);
        font-size: 0.75rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-bottom: 4px;
      }
      .facts dd {
        margin: 0;
        color: var(--ink);
      }
      .banner {
        border-left: 4px solid var(--accent);
        background: rgba(255, 248, 239, 0.78);
      }
      .banner.warn {
        border-left-color: var(--gold);
      }
      .action-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .table-note {
        margin-top: -6px;
        margin-bottom: 16px;
      }
      @media (max-width: 780px) {
        header, main { padding: 18px; }
        .masthead, section, .card, form { padding: 18px; }
        .split-callout { grid-template-columns: 1fr; }
        h1 { font-size: 2.4rem; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="masthead">
        <div class="eyebrow">Operator Product / Internal Pilot Console</div>
        <div class="title-row">
          <div class="title-block">
            <h1>${escapeHtml(title)}</h1>
            <p class="lede">A tightly linked operations ledger for pilot setup, call QA, and exception recovery.</p>
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
    </header>
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

function renderAccountList(accounts: Account[]): string {
  return `
    <section>
      <h2>Configured Accounts</h2>
      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Timezone</th>
            <th>Primary Phone</th>
            <th>Escalation</th>
          </tr>
        </thead>
        <tbody>
          ${accounts
            .map(
              (account) => `
                <tr>
                  <td><a href="/accounts/${encodeURIComponent(account.id)}">${escapeHtml(account.name)}</a></td>
                  <td>${escapeHtml(account.timezone)}</td>
                  <td>${escapeHtml(account.primaryPhoneNumber)}</td>
                  <td>${escapeHtml(account.emergencyEscalationPhone)}</td>
                </tr>`,
            )
            .join("")}
        </tbody>
      </table>
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
          Timezone
          <input name="timezone" value="America/Chicago" required />
        </label>
        <label>
          Primary phone number
          <input name="primaryPhoneNumber" placeholder="+15551234567" required />
        </label>
        <label>
          Emergency escalation phone
          <input name="emergencyEscalationPhone" placeholder="+15557654321" required />
        </label>
        <label>
          SMS acknowledgement template
          <textarea name="smsAckTemplate" required>Thanks for calling. We captured your request and the on-call team will call you shortly.</textarea>
        </label>
        <label>
          Consent script
          <textarea name="consentScript" required>This call may be recorded and transcribed to help us schedule your callback.</textarea>
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

function renderAccountDetail(account: Account, routingRule?: RoutingRule): string {
  return `
    <div class="grid two">
      <section>
        <h2>Account Config</h2>
        ${renderDefinitionList([
          { label: "Account name", value: escapeHtml(account.name) },
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
          Timezone
          <input name="timezone" value="${encodeFormValue(account.timezone)}" required />
        </label>
        <label>
          Primary phone number
          <input name="primaryPhoneNumber" value="${encodeFormValue(account.primaryPhoneNumber)}" required />
        </label>
        <label>
          Emergency escalation phone
          <input name="emergencyEscalationPhone" value="${encodeFormValue(account.emergencyEscalationPhone)}" required />
        </label>
        <label>
          SMS acknowledgement template
          <textarea name="smsAckTemplate" required>${encodeFormValue(account.smsAckTemplate)}</textarea>
        </label>
        <label>
          Consent script
          <textarea name="consentScript" required>${encodeFormValue(account.consentScript)}</textarea>
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
    timezone: "America/Chicago",
    primaryPhoneNumber: "+15551230000",
    overflowModeEnabled: true,
    afterHoursScheduleEnabled: true,
    emergencyEscalationPhone: "+15559870000",
    smsAckTemplate: "Thanks for calling Pilot Plumbing. We logged your request and an on-call tech will call back soon.",
    consentScript: config.TWILIO_RECORDING_CONSENT_LINE,
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
      timezone: body.timezone,
      primaryPhoneNumber: body.primaryPhoneNumber,
      overflowModeEnabled: parseCheckbox(body.overflowModeEnabled),
      afterHoursScheduleEnabled: parseCheckbox(body.afterHoursScheduleEnabled),
      emergencyEscalationPhone: body.emergencyEscalationPhone,
      smsAckTemplate: body.smsAckTemplate,
      consentScript: body.consentScript,
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
      timezone: body.timezone,
      primaryPhoneNumber: body.primaryPhoneNumber,
      overflowModeEnabled: parseCheckbox(body.overflowModeEnabled),
      afterHoursScheduleEnabled: parseCheckbox(body.afterHoursScheduleEnabled),
      emergencyEscalationPhone: body.emergencyEscalationPhone,
      smsAckTemplate: body.smsAckTemplate,
      consentScript: body.consentScript,
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
    const accounts = adminStore.listAccounts();
    const callbacks = adminStore.listCallbackTasks();
    const syncFailures = adminStore.listSyncFailures();
    const calls = store.list();
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    reply
      .type("text/html")
      .send(
        renderPage(
          "Pilot Operations Console",
          `
            <section class="banner">
              <div class="hero-stats">
                <div><p class="hero-label">Accounts</p><p class="hero-value">${accounts.length}</p></div>
                <div><p class="hero-label">Calls</p><p class="hero-value">${calls.length}</p></div>
                <div><p class="hero-label">Callbacks</p><p class="hero-value">${callbacks.length}</p></div>
                <div><p class="hero-label">Sync Failures</p><p class="hero-value">${syncFailures.length}</p></div>
              </div>
            </section>
            <div class="grid two">
              <section>
                <h2>Launch readiness</h2>
                <p>Use this console to configure a pilot account, inspect call outcomes, and resolve callback or sync exceptions without database access.</p>
                <ul>
                  <li>${accounts.length} configured account(s)</li>
                  <li>${calls.length} call record(s)</li>
                  <li>${callbacks.length} callback task(s)</li>
                  <li>${syncFailures.length} failed sync event(s)</li>
                  <li>Sentry ${config.SENTRY_DSN ? `enabled for ${escapeHtml(config.SENTRY_ENVIRONMENT)}` : "not configured"}</li>
                </ul>
              </section>
              <section>
                <h2>Recent audit log</h2>
                <pre>${escapeHtml(JSON.stringify(adminStore.listAuditEntries(), null, 2))}</pre>
              </section>
            </div>
            ${renderAccountList(accounts)}
            ${renderCallList(calls, accountsById)}
          `,
        ),
      );
  });

  app.get("/accounts", async (_request, reply) => {
    reply.type("text/html").send(renderPage("Accounts", renderAccountList(adminStore.listAccounts())));
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
    const accounts = adminStore.listAccounts();
    reply
      .type("text/html")
      .send(renderPage("Call Review", renderCallList(store.list(), new Map(accounts.map((account) => [account.id, account])))));
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
    const accounts = adminStore.listAccounts();
    const calls = store.list();
    reply
      .type("text/html")
      .send(
        renderPage(
          "Callback Queue",
          renderCallbacks(
            adminStore.listCallbackTasks(),
            new Map(accounts.map((account) => [account.id, account])),
            new Map(calls.map((call) => [call.callSid, call])),
          ),
        ),
      );
  });

  app.get("/sync-failures", async (_request, reply) => {
    const accounts = adminStore.listAccounts();
    const calls = store.list();
    reply
      .type("text/html")
      .send(
        renderPage(
          "Failed Sync Review",
          renderSyncFailures(
            adminStore.listSyncFailures(),
            new Map(accounts.map((account) => [account.id, account])),
            new Map(calls.map((call) => [call.callSid, call])),
          ),
        ),
      );
  });

  return app;
}
