## TMTA-31: Multi-tenant architecture and login routing

Date: 2026-05-01
Owner: CTO
Status: Ready for implementation

## Executive decision

Support multiple SMB tenants in one app by treating `account` as the tenant boundary everywhere, using `Supabase Auth` for login, and resolving tenant access from a first-class `user_memberships` table keyed by normalized email.

Use path-based tenant routing for the admin surface and hostname-or-path resolution for the public surface:

- public pages resolve tenant from `Host` first, then a stable fallback path like `/sites/:accountSlug`
- authenticated admin pages live under `/app/:accountSlug/*`
- login always lands on a neutral entry point, resolves the user's allowed tenants by email, then redirects deterministically to the correct admin tenant path

This is the smallest design that supports multiple businesses without adding per-tenant app deployments, custom auth, or broad RBAC.

## Why this cut

### Recommended architecture

1. Keep one Node app and one Postgres database.
2. Introduce durable tenant metadata:
   - `accounts.id`
   - `accounts.slug`
   - `accounts.public_host`
   - `accounts.status`
3. Introduce user-to-tenant membership records:
   - `user_memberships.user_id`
   - `user_memberships.account_id`
   - `user_memberships.role`
   - `user_memberships.email_normalized`
   - `user_memberships.is_default`
4. Gate every admin read/write through a resolved `accountId` from the route plus membership check.
5. Keep public tenant branding/config lookup separate from admin authorization.

### Tradeoffs

Cost:
- low, because it stays inside the current app, database, and Supabase footprint

Complexity:
- moderate, because routing, auth, and data access all need tenant context

Delivery risk:
- moderate, concentrated in login redirect edge cases and accidental cross-tenant reads

Expected customer impact:
- high, because it unlocks onboarding more than one business without duplicating deployments

## Tenant model

### Boundary

The tenant boundary is the existing `account`. All customer-owned records must carry `account_id` and be queried through that scope.

Current code already does this for core workflow data:

- `call_sessions.account_id`
- `leads.account_id`
- `callback_tasks.account_id`
- `integration_sync_events.account_id`
- in-memory admin and workflow records also carry `accountId`

The missing layer is tenant identity and tenant-aware request routing.

### Required schema additions

Add or persist these tables before broad customer login work:

#### `accounts`

- `slug text not null unique`
- `public_host text unique`
- `status text not null default 'active'`
- `brand_name text`
- `brand_theme jsonb default '{}'::jsonb`

`slug` becomes the canonical route key. `public_host` allows custom domains later without changing the core router.

#### `user_memberships`

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid not null`
- `account_id uuid not null references accounts(id) on delete cascade`
- `email_normalized text not null`
- `role text not null`
- `is_default boolean not null default false`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `unique (user_id, account_id)`

Add indexes:

- `idx_user_memberships_email_normalized`
- partial unique index for one default membership per user

Why store both `user_id` and `email_normalized`:

- `user_id` is the durable auth principal after the user exists
- `email_normalized` supports deterministic first-login lookup and invitation workflows before richer org management exists

## Routing model

### Public surface

Resolve public tenant in this order:

1. exact `Host` match on `accounts.public_host`
2. fallback path segment `/sites/:accountSlug`
3. if no tenant matches, return a neutral not-found or waitlist page

Decision:
- do not create one deployed frontend per business
- do not make public routing depend on the logged-in user

Reason:
- customers need a stable branded front page independent of operator login

### Admin surface

Admin routes move under:

- `/app`
- `/app/select-account`
- `/app/:accountSlug`
- `/app/:accountSlug/accounts`
- `/app/:accountSlug/routing`
- `/app/:accountSlug/calls`
- `/app/:accountSlug/callbacks`
- `/app/:accountSlug/sync-failures`

Rules:

1. unauthenticated requests redirect to `/login`
2. authenticated requests without memberships go to an access-pending state
3. authenticated users with one allowed tenant redirect straight to `/app/:accountSlug`
4. authenticated users with multiple tenants land on `/app/select-account` unless a valid last-used or default tenant exists
5. every admin handler must verify that route `accountSlug` resolves to an `accountId` the current user can access

## Login routing

### Deterministic resolution algorithm

At login success:

1. normalize email to lowercase and trim spaces
2. fetch memberships for that email and user
3. if zero memberships:
   - deny admin access
   - show operator contact instructions
4. if exactly one membership:
   - redirect to that tenant's admin path
5. if more than one membership:
   - prefer `is_default = true`
   - else prefer the most recently used tenant if tracked
   - else show tenant picker

This avoids ambiguous post-login behavior while keeping multi-account operators viable.

### Why email-based routing is sufficient now

- the requirement is explicitly email-driven routing
- the initial users are internal operators or customer admins with small membership sets
- we do not need enterprise SSO, SCIM, or deep permission matrices in v1

### Guardrails

- email match must use normalized values only
- email alone must not bypass authenticated membership checks
- do not trust client-provided tenant ids or slugs without server-side membership validation

## Application-layer changes

### Request context

Introduce a shared request tenant resolver that produces:

- `viewer.userId`
- `viewer.email`
- `viewer.memberships`
- `tenant.accountId`
- `tenant.accountSlug`
- `tenant.source` as `host` or `path`

All admin handlers should consume this context instead of raw route params alone.

### Data access rule

Every query touching tenant-owned data must filter by the resolved `accountId`.

For this app that includes:

- accounts and routing config
- call review lists and detail pages
- callback queue
- sync failure review
- future integration credentials and prompt/rule versions

### Storage rule

Any new tenant-owned table must include `account_id` from day one. Do not add unscoped feature tables and plan to patch them later.

## Rollout sequence

### Phase 1

- persist account slugs and membership records
- add login callback and tenant-selection routing
- move admin URLs under `/app/:accountSlug/*`
- enforce server-side tenant membership checks

### Phase 2

- add public tenant page resolution from host or `/sites/:accountSlug`
- expose tenant branding fields needed for front pages

### Phase 3

- add invitation flow, last-used tenant persistence, and optional custom domains polish

This sequencing keeps the first implementation tightly aligned to the current admin-heavy app.

## Regression risks

1. Cross-tenant data leakage if any admin handler reads by raw id without `accountId` scoping.
2. Broken deep links if old admin URLs are not redirected or updated consistently.
3. Login loops when a user has no membership or an invalid default tenant.
4. Public page misrouting if `Host` parsing is inconsistent behind Render proxies.
5. Test fixtures assuming the single hard-coded default account.

## Minimum test plan

1. Route resolution tests:
   - host-based public tenant resolution
   - path-based public tenant fallback
   - admin slug resolution rejects unknown tenants
2. Auth routing tests:
   - one membership redirects directly
   - multiple memberships honor default tenant
   - zero memberships deny access cleanly
3. Authorization tests:
   - user cannot access another tenant's admin path
   - admin list/detail endpoints always return scoped data
4. Backward-compat tests:
   - existing single-account behavior still works when exactly one tenant exists

## Delivery recommendation

Assign implementation to `Sr -Full Stack` as one focused execution issue:

- add schema and tenant resolution primitives
- migrate admin routes to tenant-aware paths
- implement email-driven login redirect
- cover routing and authorization with tests

Do not split this further unless route migration and auth integration start blocking each other in practice. The write surface is still small enough for one engineer to own end to end.
