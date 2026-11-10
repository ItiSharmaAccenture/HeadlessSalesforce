# Salesforce AI Sales Assistant

A proof of concept showing how an external Next.js application can answer questions
about live Salesforce CRM data using **Google Gemini** for reasoning and
**Salesforce Hosted MCP** for data access.

Access is delegated to Salesforce: the dedicated user's profile, permission sets
and sharing rules decide what is reachable, and the application does not impose
a narrower list of its own. Several MCP endpoints can be configured at once, so
custom MCP servers activated in the org work alongside the standard ones.

Sales reps open `http://localhost:3000` and start chatting. There is no login.
Salesforce authentication happens once, server-side, for one dedicated Salesforce
user — the application never sees or stores a rep's Salesforce identity.

```
Sales rep (no login)
        │
        ▼
  Next.js chat UI ──── SSE progress events ────┐
        │                                      │
        ▼                                      │
  Next.js backend ─────────────────────────────┘
        ├── Google Gemini Flash      (tool selection + answer generation)
        └── MCP client               (OAuth access token, server-side only)
                 │
                 ▼
         Salesforce Hosted MCP  →  whatever the dedicated user may access
         (one or more endpoints, incl. custom MCP servers)
```

Gemini never receives Salesforce credentials, and the browser never receives a
token of any kind.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 20+ | Developed and verified on Node 24. |
| Salesforce org | With Hosted MCP enabled and the `sobject-all` server **activated**. |
| External Client App | Configured as described below. |
| Dedicated Salesforce user | Read-only permissions. All queries run as this user. |
| Gemini API key | Free tier is sufficient. <https://aistudio.google.com/apikey> |

---

## Salesforce configuration

### 1. Enable and activate the Hosted MCP server

In Setup, find the Salesforce Hosted MCP servers and **activate**
`platform/sobject-all` for your org. An inactive server returns `404` or `405`
after an otherwise successful OAuth flow — this is the single most common setup
failure.

Custom MCP servers activated in your org are added the same way: append their
URLs to `SALESFORCE_MCP_URLS`.

If you want read-only behaviour, `platform/sobject-reads` enforces it at the
server. The application no longer blocks writes on its own (see
[Access control](#access-control)), so a read-only server — or a read-only
dedicated user — is how you get that guarantee.

### 2. Create an External Client App

Setup → **External Client App Manager** → **New External Client App**.

Enable OAuth and set:

- **Callback URL** — `http://localhost:3000/api/auth/callback/salesforce`
  (must match `SALESFORCE_REDIRECT_URI` character for character)
- **Require Proof Key for Code Exchange (PKCE)** — enabled
- **Enable Client Credentials Flow** — not needed

### 3. OAuth scopes

Select:

- `mcp_api` — **required.** The generic `api` scope does *not* work with Hosted MCP.
- `refresh_token` — keeps the dedicated user authorized without repeating setup.
- `offline_access` — requested alongside `refresh_token`.

Adjust `SALESFORCE_SCOPES` if your org's MCP documentation lists others.

### 4. Enable JWT-based access tokens

In the app's token settings, enable **Issue JSON Web Token (JWT)-based access
tokens**. Without it OAuth appears to succeed but every MCP call fails with
`INVALID_AUTH_HEADER` or `INVALID_JWT_FORMAT`.

> If the same app is also used for the SOAP API or the Salesforce CLI, create a
> **separate** app for those: they require opaque session-ID tokens and reject JWTs.

### 5. Choose a public or confidential client

- **Public client (recommended here).** PKCE only. Leave
  `SALESFORCE_CLIENT_SECRET` blank — the app will not send one.
- **Confidential client.** Set `SALESFORCE_CLIENT_SECRET` to the consumer secret.

### 6. Permit the dedicated user

Give the dedicated Salesforce user:

- Permission to use each MCP server (via a permission set, which also limits who
  else can connect).
- Exactly the object and field permissions the demo should have — **no more**.
  This is the only access control in play: the application passes requests
  through and lets Salesforce accept or refuse them. If the demo should not be
  able to write, make the user read-only here.

Salesforce recommends refresh tokens valid for 30 days or less, with rotation on.

### 7. Wait for propagation

A newly created External Client App can take **up to 30 minutes** to become
usable. An immediate `invalid_client_id` often just means "not ready yet".

---

## Configuration

```bash
cp .env.example .env.local
```

Fill in `.env.local` (git-ignored). The required values:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key. |
| `GEMINI_MODEL` | Defaults to `gemini-flash-latest`, an alias that tracks the current free-tier Flash model. |
| `SALESFORCE_CLIENT_ID` | External Client App consumer key. |
| `SALESFORCE_CLIENT_SECRET` | Leave blank for a public PKCE client. |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com`, `https://test.salesforce.com` for sandboxes, or your My Domain URL. |
| `SALESFORCE_REDIRECT_URI` | Must match the app's callback URL exactly. |
| `SALESFORCE_MCP_URLS` | Comma-separated endpoint list. See the table below. `SALESFORCE_MCP_URL` still works for a single endpoint. |
| `TOKEN_STORE` | `file` locally, `redis` on a serverless host. Detected automatically from the Redis credentials. |
| `SETUP_SECRET` | Gates the OAuth setup route. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |

### MCP endpoints

| Org type | URL |
|---|---|
| Production / Developer Edition | `https://api.salesforce.com/platform/mcp/v1/platform/sobject-all` |
| Sandbox | `https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-all` |
| My Domain (**required** if login.salesforce.com is disabled) | `https://api.salesforce.com/platform/mcp/v1/d/<mydomain>/platform/sobject-all` |

`.env.example` documents the policy variables (`SALESFORCE_ALLOWED_OBJECTS`,
`SALESFORCE_TOOL_ALLOWLIST`, `SALESFORCE_TOOL_BLOCKLIST`) and the limits
(`MAX_RECORDS`, rate limits, …). The policy variables default to `*` — open —
and the limits default to conservative values.

### Multiple endpoints

```bash
SALESFORCE_MCP_URLS=https://api.salesforce.com/platform/mcp/v1/d/<mydomain>/platform/sobject-all,https://api.salesforce.com/platform/mcp/v1/d/<mydomain>/<namespace>/<custom-server>
```

Each endpoint is connected, discovered and called independently. One unreachable
endpoint degrades the tool list and is reported by `/api/health`; it does not
fail the request. If two endpoints publish the same tool name, both are exposed
with their endpoint id prefixed (`sobject_all__find`) rather than one shadowing
the other.

---

## Running

```bash
npm install
npm run dev
```

Then complete the **one-time** authorization, as an operator, on this machine:

```
http://localhost:3000/api/auth/salesforce?secret=<SETUP_SECRET>
```

Sign in as the **dedicated** Salesforce user and approve. Tokens are written to
`.local/salesforce-tokens.json` and refreshed automatically from then on.

Confirm the connection:

```bash
curl http://localhost:3000/api/health
```

`"status": "connected"` is only reported after a real MCP handshake and tool
discovery have succeeded. Then open:

```
http://localhost:3000
```

### Deploying to Vercel

The same build runs locally and on Vercel; what changes is where tokens live.

> **Read this first.** The chat has no authentication, and with the default
> policy every tool the MCP servers expose — including create, update and delete
> — is reachable, as are the status buttons on `/my-day`. On a public URL anyone
> who finds it can read and modify your CRM. Turn on **Vercel Deployment
> Protection** (Project → Settings → Deployment Protection → Vercel
> Authentication, or a password) *before* the first deploy. Nothing in the code
> enforces this.

**1. Token storage.** The file backend cannot work on Vercel: the filesystem is
read-only, and the one writable path (`/tmp`) is per-instance and cleared on a
cold start. That would strand the tokens *and* an in-flight authorization —
the authorize request and the Salesforce callback can land on different
instances, so the PKCE state has to be somewhere both can see.

Provision Redis from the **Vercel Marketplace** (Storage → Upstash; `@vercel/kv`
itself is deprecated). The app switches backend as soon as it sees the
credentials — no code change and no `TOKEN_STORE` needed. Confirm with
`/api/health`, which reports `checks.salesforceOAuth.storage` as `file` or
`redis`.

The integration lets you set an **environment variable prefix**, which is
prepended to the standard names, so a provisioned instance can arrive as
`MYAPP_KV_REST_API_URL` rather than `KV_REST_API_URL`. Any prefix is handled:
exact names are tried first, then a suffix match where both halves share a
prefix, so two provisioned instances cannot be spliced together.

Of the five variables Upstash typically creates, only two are usable, and the
app deliberately ignores the rest:

| Variable | Used |
|---|---|
| `…KV_REST_API_URL` | yes — the HTTPS REST endpoint |
| `…KV_REST_API_TOKEN` | yes — read/write |
| `…KV_REST_API_READ_ONLY_TOKEN` | no — cannot write the token record |
| `…REDIS_URL`, `…KV_URL` | no — `rediss://` TCP strings the REST client cannot use |

Pointing the app at a `rediss://` URL is reported at startup with an
explanation, rather than failing on the first Redis call.

**2. Environment variables.** Set the same values as `.env.local`, with two
changes:

| Variable | Value on Vercel |
|---|---|
| `SALESFORCE_REDIRECT_URI` | `https://<your-app>.vercel.app/api/auth/callback/salesforce` |
| `ALLOW_REMOTE_SETUP` | `true`, only if you intend to authorize from the deployed app |

Add the production callback URL to the External Client App as well, alongside
the localhost one — Salesforce matches it exactly.

**3. Authorize once.** Two ways, both ending with the tokens in Redis:

- *From the deployed app* — set `ALLOW_REMOTE_SETUP=true` and visit
  `https://<your-app>.vercel.app/api/auth/salesforce?secret=<SETUP_SECRET>`.
  The setup routes are otherwise localhost-only, so this is opt-in.
- *From your machine* — put the Upstash variables in `.env.local` too and run
  the authorization locally. It writes to the same Redis the deployment reads,
  and the localhost restriction stays in force. Remember the redirect URI must
  match whichever host you start the flow from.

**4. Function duration.** Nothing to configure: Vercel Functions now default to
300s on Hobby and Pro, and a chat turn here takes around ten seconds.

Still true of a deployment, and unchanged by any of the above: rate limiting is
per-instance in memory, and the token store is unencrypted either way. See
[Known limitations](#known-limitations).

### Production build

```bash
npm run build
npm start
```

---

## Access control

The application does not decide what the assistant may reach. Salesforce does.

Tools are discovered dynamically via `tools/list` across every configured
endpoint, and by default all of them are offered to Gemini — including
`createSobjectRecord`, `updateSobjectRecord` and `deleteSobjectRecord` on the
`sobject-all` server. Whether a given call succeeds is decided by the dedicated
user's profile, permission sets, field-level security and sharing rules.

> **This means the chat box can write to your CRM.** The interface has no login.
> Make the dedicated Salesforce user read-only, or point `SALESFORCE_MCP_URLS`
> at a read-only server, if that is not what you want.

Gemini is told which tools can modify data and instructed to call them only on
an explicit request, but a system prompt is a guideline, not a control. The
enforceable controls are the three below.

### What still applies unconditionally

| Control | Why it is not access control |
|---|---|
| **Schema validation** | Arguments are checked against the schema the server published, and undeclared arguments are dropped. A malformed call fails here rather than at Salesforce. |
| **Row cap** | Every SOQL and SOSL statement is rewritten with a `LIMIT` of `MAX_RECORDS`. This protects Gemini's context window, not the org. |
| **Single statement** | Stacked statements (`SELECT …; DELETE …`) are refused. No legitimate single tool call needs them. |

### Re-imposing an application-side restriction

Set either variable to something other than `*` and the original fail-closed
behaviour returns, in full:

```bash
SALESFORCE_ALLOWED_OBJECTS=Account,Opportunity
SALESFORCE_ALLOWED_RELATIONSHIPS=Account,Opportunity,Opportunities
SALESFORCE_TOOL_ALLOWLIST=getObjectSchema,soqlQuery,find,listRecentSobjectRecords,getRelatedRecords
```

With objects restricted, every tool call must positively identify a permitted
object or it is refused rather than run org-wide; SOQL is parsed to check the
`FROM` clause, every subquery and every relationship traversal; `TYPEOF` is
refused because it can return unlisted objects; and SOSL without a `RETURNING`
clause is refused because it would search the whole org.

To remove individual tools without enumerating every tool you want to keep:

```bash
SALESFORCE_TOOL_BLOCKLIST=deleteSobjectRecord,deleteRelatedRecord
```

## My Day technician dashboard

`/my-day` is **ADT My Day — AI Field Technician Workspace**: a route- and
map-centric dashboard (sidebar, welcome banner, exactly two KPI tiles — *Jobs
Today* and *Total Route* — an appointment timeline, an interactive map, a job
workspace) with the ADT Technician Copilot docked on the right. It does not
affect `/api/chat`.

It has two independent data paths, with separate loading and error states:

```
Dashboard:  browser → /api/dashboard* → Salesforce REST (Named Query + bounded SOQL)   no AI
Copilot:    browser → /api/copilot    → Gemini + Salesforce MCP                        unchanged
```

| Route | Returns |
|---|---|
| `GET /api/dashboard?view=today\|week\|date&date=YYYY-MM-DD` | Appointments from the `ADTTechnicianAppointments` Named Query, deduplicated, with customer names from a separate query |
| `GET /api/dashboard/technician` | ServiceResource profile (name, territory, skills, time zone); missing fields are null |
| `GET /api/dashboard/route?view=…` | Driving route in scheduled order from Mapbox Directions, per-leg distance/time, warnings |
| `GET /api/appointments/[id]` | Job workspace: overview, customer, work order, line items, required parts, van stock |

All four are read-only GETs. Each resolves the ServiceResource from the signed
session — a browser can never choose whose appointments are read — and
`/api/appointments/[id]` checks `AssignedResource` before reading anything.

### Requirements

1. **`api` OAuth scope.** The dashboard calls the REST API, which an
   `mcp_api`-only token cannot: Salesforce answers `401 INVALID_SCOPES`. Add
   *Manage user data via APIs (api)* to the External Client App, add `api` to
   `SALESFORCE_SCOPES`, and re-run the one-time authorization.
2. **The Named Query saved** as `ADTTechnicianAppointments` (v68.0) with
   parameters `serviceresourceid`, `startutc`, `endutc`, and the integration
   user allowed to run it. A 404/403 is reported with the exact Salesforce error.
   `ADT_APPOINTMENT_SOURCE=rest_query` is the documented fallback; it is never
   switched on silently.
3. **Technician mapping** (demo mode, below).
4. **Mapbox tokens** for the map and route distance. Without them the tiles say
   *Routing not configured*; no distance is ever estimated.

The Named Query has `LIMIT 100`. A full page is treated as possibly incomplete:
a `COUNT()` query confirms the total, and if that fails the count is shown as a
lower bound (`100+`).

### Sign-in and technician mapping

The app talks to Salesforce as **one shared integration user**, which is never
treated as the technician. The sign-in collects a name and technician ID (the
Copilot still looks the schedule up by name, as before). The **dashboard** is
scoped to a ServiceResource id that the server assigns only when:

- `ADT_DEMO_MODE=true`, and
- the technician ID is in `ADT_TECHNICIAN_DIRECTORY`.

There is no password or access code, so anyone who signs in with a mapped
technician ID sees that technician's appointments. That is acceptable for a
controlled POC only.

The mapping is written into an httpOnly cookie **HMAC-signed** with
`SESSION_SECRET` (or `SETUP_SECRET`), so it cannot be edited to claim another
technician. It is not production authentication. A sign-in without a mapping still gets
the Copilot, and the dashboard explains why it has no appointments.

Appointments are remembered per technician so a job stays reachable after it
leaves the Scheduled list; that memory is keyed by identity, so one technician
cannot open another's appointment.

### How tools are chosen

The Copilot needs to know which tool lists appointments, which sets a status and
which closes an appointment. It works these out from the **published input
schemas**, so no Apex class name appears anywhere in the code:

| Capability | Recognised by |
|---|---|
| Status change | a status-like property carrying an `enum`; the enum values are the literals sent, so the buttons follow the org's own picklist wording |
| Close | acts on one appointment and takes no status at all |
| Schedule | takes a technician identifier and no appointment identifier — a per-technician list rather than a single-job lookup |

Rename an Apex class, or move to another org, and the feature keeps working.
A capability nothing provides simply does not appear: `GET /api/copilot` returns
only the status actions that are actually achievable, and the card renders only
those buttons. `COPILOT_TOOL_SCHEDULE` / `_STATUS` / `_CLOSE` override the
inference if an org publishes too little to infer from.

### Status changes do not go through Gemini

The tools that change a status are withheld from the model; status changes run
from the card buttons, so a confirmation step cannot be skipped. The model sees
the read tools only.

> Note: this filtering is driven by capability resolution and the MCP
> `destructiveHint`, **not** by the generic `mutating` flag. Salesforce publishes
> `readOnlyHint: false` on every invocable Apex action, read-only ones included,
> so filtering on that flag would withhold the entire toolset.

## Tests

```bash
npm test        # 310 tests
npm run lint
npm run build
```

Coverage: the open default policy and the restricted policy, argument and schema
validation, SOQL/SOSL parsing and limit clamping, multi-endpoint discovery,
routing and name collisions, partial endpoint failure, MCP response parsing, SSE
framing and parsing, PKCE and OAuth state handling, setup-route access control,
the Gemini tool-calling loop with both Salesforce and Gemini mocked, Copilot
capability resolution from schemas, the capability overrides, the sign-in cookie,
per-technician isolation, and token-store backend selection including the
one-shot PKCE state on Redis.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `invalid_client_id` | Consumer key wrong, or the app has not finished propagating (wait up to 30 minutes). |
| `redirect_uri_mismatch` | `SALESFORCE_REDIRECT_URI` and the app's callback URL differ. They must match exactly. |
| OAuth succeeds, MCP returns `404` / `405` | The MCP server is not activated for the org, or the URL is wrong for the org type. |
| A custom MCP server's tools never appear | Check `/api/health` → `checks.salesforceMcp.endpoints` for that endpoint's own error. Each endpoint reports separately. |
| `INVALID_AUTH_HEADER` / `INVALID_JWT_FORMAT` | JWT-based access tokens are not enabled on the External Client App. |
| `Invalid token` on every call | Usually the `api` scope instead of `mcp_api`. |
| "state did not match a pending authorization request" | The callback was reloaded, or took over 10 minutes. Restart from the setup route. |
| "refresh token is no longer valid" | Revoked or expired. Re-run the setup authorization. |
| "all discovered tools were filtered out by policy" | You have set `SALESFORCE_TOOL_ALLOWLIST` or `SALESFORCE_TOOL_BLOCKLIST` to something that excludes everything. The server log lists the discovered names. |
| "Connected, but no tools were returned" | The MCP server is activated but the dedicated user has no permission to use it. |
| Gemini "rate limit reached" | Free-tier quota. Wait, or set `GEMINI_MODEL` to a model with more quota. |
| Gemini "could not find the model" | Set `GEMINI_MODEL` to a model your key can access. |
| Setup route returns `403` | Not reached from localhost. Intentionally local-only; set `ALLOW_REMOTE_SETUP=true` to authorize from a deployed host. |
| Deployed app loses its authorization after a while | It is on the file backend. `/api/health` reports `checks.salesforceOAuth.storage`; it must be `redis` on Vercel. |
| Redis provisioned but `/api/health` still says `storage: file` | Only the read-only token is present, or the two halves carry different prefixes. The app needs a `…KV_REST_API_URL` and a matching `…KV_REST_API_TOKEN` sharing one prefix. |
| "state did not match a pending authorization request" on Vercel | The authorize request and the callback hit different instances. Only the Redis backend shares the PKCE state between them. |
| Setup route returns `503` | `SETUP_SECRET` is not set. |

Server logs carry diagnostics with tokens, codes, secrets and keys redacted.

---

## Known limitations

This is a POC and is **not** production-ready.

- **No authentication, and no application-side access control.** The chat is
  deliberately open, and by default every tool the MCP servers expose — writes
  and deletes included — is reachable from it. The dedicated Salesforce user's
  permissions are the only thing limiting what the demo can do. Do not deploy
  this to a publicly reachable environment with real CRM data.
- **Unencrypted token store.** Neither backend encrypts anything: the file
  backend is a plain JSON file, and the Redis backend stores plain JSON in
  Upstash. A real deployment needs a secret manager.
- **Process-local rate limiting.** Counters are in memory and reset on restart.
- **No persistence.** Chat history lives in the browser tab only.
- **Anonymous users.** "My opportunities" cannot be resolved to a person; the
  assistant says so and reports what the dedicated user can see.
- **Field-level data is only as complete as the dedicated user's permissions.**
- **Writes are not confirmed with the user before execution.** Gemini is
  instructed to ask first, but nothing in the backend enforces a confirmation
  step. Use `SALESFORCE_TOOL_BLOCKLIST` or Salesforce permissions if you need
  that guarantee.

### Client Credentials as an alternative

Client Credentials would remove the interactive setup step, but this POC does
**not** use it: whether it satisfies Hosted MCP's JWT access-token requirements
was not verified. Confirm against your org's documentation before adopting it.

---

## Verification status

Verified by running it, against a live Developer Edition org and a live Gemini key:

- Build, lint and the 232 automated tests pass.
- OAuth completes and refreshes; expired refresh tokens are detected, cleared and
  reported as `configuration_required` rather than as connected.
- Live MCP handshake with dynamic discovery; every discovered tool offered to
  Gemini under the open default policy.
- Real tool calls returning real records: Account, Contact and Opportunity with
  an `Owner.Name` traversal.
- With Salesforce unreachable, the assistant reports the failure and invents nothing.
- **My Day sign-in**: `/my-day` shows the sign-in screen with no cookie and the
  Copilot routes return `401`; after signing in, the header, greeting, mission
  card and technician ID all reflect the entered identity.
- **Identity reaches Salesforce**: the appointment action is called with the
  signed-in name under the key its own schema publishes, and real appointments
  come back with `ownerName` matching. Signing in as a different name returns
  that technician's (empty) schedule, with no leakage from the first.
- **Capability resolution against the real org**: with all three Apex class-name
  regexes deleted, the schedule and close actions are still resolved from their
  schemas, and `GET /api/copilot` correctly offers only `complete` — the org has
  no status-update action.
- Both Copilot paths: the deterministic schedule answer and a Gemini-routed
  question that called the schedule tool and answered from its data.
- Sign-out clears the cookie and both surfaces return to the signed-out state.

**Not verified:**

- **Write and action tools have not been executed.** `createSobjectRecord`,
  `updateSobjectRecord`, `deleteSobjectRecord` and the close action are
  discovered and reachable, but no write was performed against a real org. The
  card's status buttons therefore remain untested end to end.
- **Multiple simultaneous endpoints are only mock-verified.** Fan-out, routing,
  name collisions and partial failure are covered by `tests/mcp-session.test.ts`;
  live testing needs two activated MCP servers at once.
- **Status-change capability detection is untested against a real status tool.**
  The org exposes no action with an enum'd status property, so that branch is
  only covered by unit tests with synthetic schemas.
- Gemini is pinned to `gemini-3.6-flash` because `gemini-3.8-flash` was
  returning `503 high demand`. Revert `GEMINI_MODEL` when that clears.
