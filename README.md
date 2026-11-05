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

## Tests

```bash
npm test        # 181 tests
npm run lint
npm run build
```

Coverage: the open default policy and the restricted policy, argument and schema
validation, SOQL/SOSL parsing and limit clamping, multi-endpoint discovery,
routing and name collisions, partial endpoint failure, MCP response parsing, SSE
framing and parsing, PKCE and OAuth state handling, setup-route access control,
and the Gemini tool-calling loop with both Salesforce and Gemini mocked.

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
| Setup route returns `403` | Not reached from localhost. The route is intentionally local-only. |
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
- **Single-process token store.** Tokens live in an unencrypted local JSON file.
  A real deployment needs a secret manager.
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

- Build, lint and the 181 automated tests pass.
- The OAuth flow completes and refreshes; expired refresh tokens are detected,
  cleared, and reported as `configuration_required` rather than as connected.
- A live MCP handshake against `platform/sobject-all`, with dynamic discovery
  returning 11 tools, all 11 offered to Gemini under the open default policy.
- Real tool calls returning real records: Account, Contact, and Opportunity with
  an `Owner.Name` traversal — the last two of which the previous restricted
  policy refused, so the delegation change is confirmed working.
- The row cap is applied to queries on the way to Salesforce.
- With Salesforce unreachable, the assistant reports the failure and does not
  invent records.

**Not verified:**

- **Write and action tools have not been executed.** `createSobjectRecord`,
  `updateSobjectRecord` and `deleteSobjectRecord` are discovered and offered to
  Gemini, and the routing path they would take is the same one the read tools
  were verified on, but no write was performed against a real org.
- **Multiple simultaneous endpoints have only been tested with mocks.** The
  fan-out, routing, name-collision and partial-failure behaviour is covered by
  `tests/mcp-session.test.ts`; live verification needs a second activated MCP
  server, which the test org does not have.
- Gemini is pinned to `gemini-3.6-flash` because `gemini-3.8-flash` was
  returning `503 high demand`. Revert `GEMINI_MODEL` when that clears.
