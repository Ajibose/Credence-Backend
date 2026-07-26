# Structured Logging Guide

**Audience: contributors** — engineers writing or reviewing code in this repository.

This document covers when to use each log level, how PII redaction works, the reserved key schema, request-lifecycle tracing, and the ESLint rules that enforce these conventions.

Related docs:
- [Observability & Request Tracing](observability.md) — `req.log`, request-scoped context, metrics
- [OBSERVABILITY.md](OBSERVABILITY.md) — Prometheus metrics, Grafana dashboard, alert PromQL

---

## Table of Contents

1. [Core principles](#1-core-principles)
2. [Log levels — when to use each](#2-log-levels--when-to-use-each)
3. [Request lifecycle tracing](#3-request-lifecycle-tracing)
4. [Reserved keys](#4-reserved-keys)
5. [PII redaction rules](#5-pii-redaction-rules)
6. [Schema-aware logging (LogEventType)](#6-schema-aware-logging-logeventtype)
7. [ESLint enforcement](#7-eslint-enforcement)
8. [LOG_LEVEL environment variable](#8-log_level-environment-variable)
9. [Adding a new event type](#9-adding-a-new-event-type)
10. [Quick reference — do / do not](#10-quick-reference--do--do-not)

---

## 1. Core principles

1. **Use the structured logger.** Never use `console.log` / `console.error` directly in application code; they bypass redaction and schema validation.
2. **Log context, not prose.** The `message` field should be a stable, searchable event name (e.g. `bond_withdrawal_initiated`). Put variable data in the JSON payload, not in the message string.
3. **Redact before you serialize.** Redaction runs _before_ `JSON.stringify()` so PII never appears in serialized logs or Node.js heap dumps.
4. **Fail-secure.** Unknown fields are _dropped_, not passed through. If a field must appear in the log, add it explicitly to the schema for its `LogEventType`.

---

## 2. Log levels — when to use each

### `debug`

Use `debug` for verbose, developer-facing information that is only useful when actively investigating a problem. Debug lines are silenced in production by default (see [LOG_LEVEL](#8-log_level-environment-variable)).

**Use `debug` when:**
- Tracing the internal state of a complex algorithm step-by-step
- Logging every retry attempt during local development
- Dumping intermediate values while chasing a race condition
- Showing which cache branch was taken

**Do not use `debug` when:**
- The information is useful in production incidents — use `info` or `warn`
- It would emit on every request in the hot path — add a feature flag or sample rate

```typescript
// Good: step-by-step tracing of cursor pagination logic
logger.debug({ message: "cursor_page_resolved", cursor, offset, limit });

// Good: cache internals during local debugging
logger.debug({ message: "cache_miss", key: cacheKey, ttl });
```

---

### `info`

Use `info` for normal, observable business events. Info logs should read like an audit trail of what the system did: one line per meaningful action, always at the outermost boundary of that action.

**Use `info` when:**
- A request was received and handled successfully
- A background job started, completed, or was skipped
- A Horizon listener picked up an on-chain event
- A webhook was delivered
- A migration ran successfully

**Do not use `info` when:**
- The event happens dozens of times per second per request (e.g. every SQL statement) — that is `debug` territory
- Something went wrong — use `warn` or `error`

```typescript
// In a route handler — use req.log so request context is automatic
app.post("/api/attestations", async (req, res) => {
  req.log.info(
    { message: "attestation_create_requested", subjectAddress: req.body.subject },
    { eventType: LogEventType.GENERIC_INFO }
  );
  // ... handler logic ...
  req.log.info(
    { message: "attestation_created", attestationId: result.id },
    { eventType: LogEventType.GENERIC_INFO }
  );
  res.status(201).json(result);
});

// In a background job — use module-level logger
logger.info(
  { message: "score_snapshot_job_completed", snapshotCount: 42, durationMs: 310 },
  { eventType: LogEventType.GENERIC_INFO }
);
```

---

### `warn`

Use `warn` for recoverable problems that the system handled but that an operator should be aware of. A warn does not mean the request failed; it means something unexpected happened and the system compensated.

**Use `warn` when:**
- A retry was needed (first or second attempt; escalate to `error` on exhaustion)
- A feature flag was missing and a default was applied
- A dependency returned a non-fatal degraded response
- A rate-limit threshold was approached (not yet breached)
- A config value was out of the recommended range
- A request carried a deprecated header or API version

**Do not use `warn` when:**
- The situation is fully expected behavior — use `info`
- The system cannot continue without human intervention — use `error`

```typescript
// Soroban RPC retry — warn on attempts, error on exhaustion
logger.warn(
  {
    message: "soroban_rpc_retry",
    provider: "horizon-mainnet",
    attempt: 2,
    maxAttempts: 5,
    delayMs: 800,
    code: "NETWORK_ERROR",
  },
  { eventType: LogEventType.SOROBAN_RETRY }
);

// Deprecated header still accepted
req.log.warn(
  { message: "deprecated_header_received", header: "x-legacy-tenant-id" },
  { eventType: LogEventType.GENERIC_WARN }
);
```

---

### `error`

Use `error` for failures that require operator attention or that caused a request to fail. Every `error` line should ideally map to an on-call alert or ticket.

**Use `error` when:**
- A request returned 500
- A background job failed after all retries were exhausted
- A database query threw an unrecoverable error
- A webhook delivery was exhausted
- An unexpected exception was caught at the top-level error handler

**Do not use `error` when:**
- The failure is a client mistake (400-level) — use `warn` or `info`
- Retries are still available — use `warn` until the final attempt

```typescript
// Caught exception in the error handler middleware
logger.error(
  { message: "unhandled_request_error", method: req.method, path: req.path, statusCode: 500 },
  err,                                   // second argument: the Error object
  { eventType: LogEventType.HTTP_ERROR }
);

// Webhook exhausted
logger.error(
  {
    message: "webhook_delivery_exhausted",
    provider: subscription.url,
    attempts: 5,
    errorCode: "TIMEOUT",
  },
  { eventType: LogEventType.WEBHOOK_DELIVERY_EXHAUSTED }
);
```

The `logger.error()` signature accepts an optional second `Error` argument which is serialized to `{ error: string, stack: string }` — both fields are included in the `GENERIC_ERROR` and `HTTP_ERROR` schemas.

---

### Level summary table

| Level   | Visible in production (default) | Who cares? | Example events |
|---------|----------------------------------|------------|----------------|
| `debug` | No (`LOG_LEVEL=info`)            | Developer actively debugging | cursor resolved, cache branch taken |
| `info`  | Yes                              | Operator, auditor | request handled, job completed, event received |
| `warn`  | Yes                              | On-call engineer (no page) | retry attempt, deprecated header, degraded dependency |
| `error` | Yes                              | On-call engineer (page) | 500 response, job exhausted, DB failure |

---

## 3. Request lifecycle tracing

Every inbound HTTP request is assigned three IDs by `requestIdMiddleware` (`src/middleware/requestId.ts`):

| ID | Header | Purpose |
|----|--------|---------|
| `requestId` | `X-Request-ID` | Unique per HTTP call; returned in the response header |
| `correlationId` | `X-Correlation-ID` | Persists across service calls; propagated downstream |
| `traceId` | `X-Trace-ID` | End-to-end trace across all hops |

These IDs are stored in an `AsyncLocalStorage` context (`tracingContext` in `src/utils/logger.ts`) and are automatically appended to every log line emitted during that request — including logs inside services, repositories, and jobs that are called from the handler.

### Using `req.log` inside handlers and middleware

Inside Express route handlers and middleware, always use `req.log` instead of the module-level `logger`. `req.log` is a `RequestLogger` pre-bound to the request's `AsyncLocalStorage` context, so `requestId`, `correlationId`, `tenant`, and `actor` appear in the output without any extra work.

```typescript
import { Request, Response } from "express";
import { LogEventType } from "../observability/logSchemas.js";

export async function getBondHandler(req: Request, res: Response) {
  const { address } = req.params;

  req.log.info(
    { message: "bond_read_requested", address },
    { eventType: LogEventType.GENERIC_INFO }
  );

  try {
    const bond = await bondService.getByAddress(address);

    req.log.info(
      { message: "bond_read_success", address, bondId: bond.id },
      { eventType: LogEventType.GENERIC_INFO }
    );

    res.json(bond);
  } catch (err) {
    req.log.error(
      { message: "bond_read_failed", address, statusCode: 500 },
      err as Error,
      { eventType: LogEventType.HTTP_ERROR }
    );
    res.status(500).json({ error: "internal_error" });
  }
}
```

### What a log line looks like

```json
{
  "level": "INFO",
  "timestamp": "2025-07-26T14:00:00.000Z",
  "requestId": "req_abc123",
  "correlationId": "cor_xyz789",
  "traceId": "trc_def456",
  "route": "/api/bond/GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "tenant": "org_tenantA",
  "actor": "user_operatorB",
  "message": "bond_read_requested",
  "address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
}
```

### Using the module-level `logger` in services and jobs

Outside of an HTTP request context (background jobs, listeners, startup code), use the module-level `logger` from `src/utils/logger.ts`. The `AsyncLocalStorage` store will contain `"N/A"` for the request-scoped fields, which is expected.

```typescript
import { logger } from "../utils/logger.js";
import { LogEventType } from "../observability/logSchemas.js";

// In a background job
export async function runScoreSnapshotJob() {
  logger.info(
    { message: "score_snapshot_job_started" },
    { eventType: LogEventType.GENERIC_INFO }
  );

  try {
    const count = await snapshotService.run();
    logger.info(
      { message: "score_snapshot_job_completed", snapshotCount: count },
      { eventType: LogEventType.GENERIC_INFO }
    );
  } catch (err) {
    logger.error(
      { message: "score_snapshot_job_failed" },
      err as Error,
      { eventType: LogEventType.GENERIC_ERROR }
    );
  }
}
```

---

## 4. Reserved keys

These keys are written automatically by the logger framework. Never write them manually in a payload — the framework's value takes precedence, and writing them manually is confusing.

| Key | Type | Set by | Description |
|-----|------|--------|-------------|
| `level` | `string` | logger | `INFO` / `WARN` / `ERROR` / `DEBUG` |
| `timestamp` | `ISO 8601` | logger | UTC timestamp at log time |
| `requestId` | `string` | `AsyncLocalStorage` | Unique per HTTP request; `"N/A"` outside a request |
| `correlationId` | `string` | `AsyncLocalStorage` | Cross-service correlation ID; `"N/A"` outside a request |
| `traceId` | `string` | `AsyncLocalStorage` | End-to-end trace ID; `"N/A"` outside a request |
| `route` | `string` | `AsyncLocalStorage` | `req.originalUrl`; `"N/A"` outside a request |
| `tenant` | `string` | `AsyncLocalStorage` | Tenant ID from auth or `X-Tenant-ID` header |
| `actor` | `string` | `AsyncLocalStorage` | User / service-account / API-key ID |

Do not add custom fields named `level`, `timestamp`, `requestId`, `correlationId`, `traceId`, `route`, `tenant`, or `actor` to your log payload.

---

## 5. PII redaction rules

### How redaction works

The redaction system (`src/observability/redaction.ts`) uses an **allowlist** strategy:

1. **Schema allowlist** — only fields explicitly listed in the `LogEventType` schema pass through. All other fields are silently dropped.
2. **PII pattern matching** — fields whose names match a known PII pattern are replaced with `"[REDACTED]"`, even if the schema would otherwise allow them. Matching is case-insensitive.
3. **Stellar memo fields** — a separate set of Stellar-specific field names is always redacted.
4. **Before serialization** — redaction runs _before_ `JSON.stringify()`, so PII never appears in serialized output or heap dumps.

### Fields that are always redacted

The following field names are matched case-insensitively. Any field whose name matches — anywhere in the object, including nested objects — is replaced with `"[REDACTED]"`.

#### Authentication & credentials

| Pattern | Matches (examples) |
|---------|-------------------|
| `password` | `password`, `Password`, `userPassword` |
| `secret` | `secret`, `clientSecret`, `client_secret` |
| `token` | `token`, `authToken`, `auth_token` |
| `authorization` | `authorization`, `Authorization` |
| `cookie` / `cookies` | `cookie`, `cookies` |
| `bearer` | `bearer` |
| `credential` / `credentials` | `credential`, `credentials` |
| `pin` / `passcode` | `pin`, `passcode` |

#### API & signing keys

| Pattern | Matches (examples) |
|---------|-------------------|
| `api_key` / `apikey` | `api_key`, `apiKey`, `APIKEY` |
| `private_key` / `privatekey` | `private_key`, `privateKey` |
| `public_key` / `publickey` | `public_key`, `publicKey` |
| `signing_key` / `signingkey` | `signing_key`, `signingKey` |
| `encryption_key` / `encryptionkey` | `encryption_key`, `encryptionKey` |
| `secret_key` / `secretkey` | `secret_key`, `secretKey` |
| `access_token` / `accesstoken` | `access_token`, `accessToken` |
| `refresh_token` / `refreshtoken` | `refresh_token`, `refreshToken` |
| `id_token` / `idtoken` | `id_token`, `idToken` |

#### Personal identifiers

| Pattern | Matches (examples) |
|---------|-------------------|
| `email` / `email_address` / `emailaddress` | `email`, `emailAddress`, `userEmail` |
| `phone` / `phone_number` / `phonenumber` | `phone`, `phoneNumber` |
| `ssn` / `social_security_number` | `ssn`, `socialSecurityNumber` |
| `date_of_birth` / `dateofbirth` / `dob` | `dob`, `dateOfBirth` |
| `national_id` / `nationalid` | `nationalId`, `national_id` |
| `tax_id` / `taxid` | `taxId`, `tax_id` |
| `drivers_license` / `driverslicense` | `driversLicense` |
| `passport_number` / `passportnumber` | `passportNumber` |
| `user_id` / `userid` | `userId`, `user_id` |
| `account_id` / `accountid` | `accountId`, `account_id` |
| `sub` / `jti` | `sub`, `jti` (JWT claims) |

#### Payment data

| Pattern | Matches (examples) |
|---------|-------------------|
| `creditcard` / `credit_card` | `creditCard`, `credit_card` |
| `ccv` / `cvv` | `ccv`, `cvv` |
| `bankaccount` / `bank_account` | `bankAccount`, `bank_account` |
| `routingnumber` / `routing_number` | `routingNumber`, `routing_number` |

#### Stellar memo fields (always redacted)

Stellar memo fields can carry arbitrary user-supplied data and must never appear in logs.

`memo`, `memoValue`, `memoData`, `memoHash`, `memoText`, `memo_id`, `memo_return`, `memo_type`, `memoType`

### What redaction produces

```typescript
import { redact } from "../observability/redaction.js";
import { LogEventType } from "../observability/logSchemas.js";

const payload = {
  message: "user_profile_updated",
  userId: "user_abc",        // redacted: matches 'userid' pattern
  email: "alice@example.com",// redacted: matches 'email' pattern
  displayName: "Alice",      // dropped: not in schema
  updatedAt: "2025-07-26",   // dropped: not in schema
};

const safe = redact(payload, { eventType: LogEventType.GENERIC_INFO });
// Result: { message: "user_profile_updated" }
// userId and email are replaced with "[REDACTED]"
// displayName and updatedAt are silently dropped (not in schema)
```

### Manual redaction pattern (when you must)

If you receive a payload that contains PII and must pass it to a function that logs internally, redact it yourself before passing it along:

```typescript
import { logger } from "../utils/logger.js";
import { LogEventType } from "../observability/logSchemas.js";

function processWebhookBody(body: Record<string, unknown>, reqId: string) {
  // Strip PII fields before logging
  const safeBody = { ...body };
  delete safeBody.email;
  delete safeBody.password;

  logger.info(
    { message: "webhook_body_received", body: safeBody },
    { eventType: LogEventType.GENERIC_INFO }
  );
}
```

### IP addresses

IP addresses are PII in most jurisdictions. Do not log raw IP addresses unless:
- The log event is a dedicated security audit event stored in the audit log, **and**
- The IP is hashed or truncated (e.g. log only the `/24` prefix)

If you need to track request origin for abuse detection, record the hashed form and store the mapping separately with appropriate access controls.

---

## 6. Schema-aware logging (LogEventType)

The project uses a per-event-type schema system to enforce the allowlist at the point of logging. Schemas are defined in `src/observability/logSchemas.ts`.

### Passing an event type

```typescript
import { logger } from "../utils/logger.js";
import { LogEventType } from "../observability/logSchemas.js";

// String message — always safe, no schema needed
logger.info("service_started");

// Structured object — always pass an eventType so the allowlist is enforced
logger.info(
  {
    message: "horizon_listener_started",
    cursor: "now",
    network: "testnet",
  },
  { eventType: LogEventType.HORIZON_LISTENER_STARTED }
);
```

### Available event types (selected)

| `LogEventType` | Use for |
|----------------|---------|
| `HTTP_REQUEST` | Successful HTTP request completion |
| `HTTP_ERROR` | HTTP 5xx or unhandled exceptions |
| `AUTH_LOGIN` | Auth attempt (success or failure combined) |
| `AUTH_FAILURE` | Dedicated auth denial event |
| `HORIZON_LISTENER_STARTED` | Horizon listener startup |
| `HORIZON_LISTENER_EVENT` | On-chain event received |
| `HORIZON_LISTENER_ERROR` | Horizon listener error |
| `STELLAR_TX_SUBMITTED` | Transaction submitted to the network |
| `STELLAR_TX_FAILED` | Transaction submission failure |
| `WEBHOOK_DELIVERY_RETRY` | Webhook delivery retry attempt |
| `WEBHOOK_DELIVERY_EXHAUSTED` | All webhook retries exhausted |
| `SOROBAN_RETRY` | Soroban RPC retry attempt |
| `OUTBOX_PUBLISHER_PUBLISHED_EVENT` | Outbox event published successfully |
| `OUTBOX_PUBLISHER_FAILED_PUBLISH` | Outbox publish failed |
| `OUTBOX_PUBLISHER_EVENT_QUARANTINED` | Outbox event quarantined |
| `DB_SLOW_QUERY` | Query exceeded slow-query threshold |
| `AUDIT_CHAIN_VERIFICATION` | Audit chain integrity check result |
| `GENERIC_INFO` | Catch-all for info events without a dedicated type |
| `GENERIC_WARN` | Catch-all for warn events without a dedicated type |
| `GENERIC_ERROR` | Catch-all for error events without a dedicated type |
| `GENERIC_DEBUG` | Catch-all for debug events without a dedicated type |

For the full list and each schema's allowed fields, see `src/observability/logSchemas.ts`.

### Fallback to generic types

When no dedicated `LogEventType` exists for your event, use one of the `GENERIC_*` types. The generic schemas use `type: "any"` for the `message` field, which allows any non-PII content through. Unknown fields at the root are still dropped (fail-secure), so pass all data under `message` if you need it to survive redaction:

```typescript
logger.warn(
  { message: { event: "feature_flag_missing", flag: "trustScoring", defaultUsed: false } },
  { eventType: LogEventType.GENERIC_WARN }
);
```

---

## 7. ESLint enforcement

Two ESLint rules in `src/observability/eslint-plugin-logger-schema.ts` catch logging mistakes at lint time:

### `loggerSchemaValidation` (recommended: `error`)

Flags any `logger.X()` or `req.log.X()` call where the first argument is an inline object literal **without** a second `redactionContext` argument. This catches logs that would bypass schema-aware redaction.

```typescript
// ✗ Flagged: inline object, no redaction context
logger.info({ message: "foo", bar: "baz" });

// ✓ Correct: provides eventType context
logger.info({ message: "foo", bar: "baz" }, { eventType: LogEventType.GENERIC_INFO });
```

### `loggerCallWithObjectRule` (recommended: `warn`)

A more permissive variant that flags all inline object logger calls regardless of whether a context is provided. Use this on files that have not been migrated yet to the schema system.

### Bypassing the lint rule (not recommended)

If you have a genuine reason to pass an inline object without a schema (e.g. a test fixture or a migration script), suppress the rule with a comment:

```typescript
// eslint-disable-next-line -- test-only, redaction not required
logger.debug({ raw: payload });
```

---

## 8. LOG_LEVEL environment variable

`LOG_LEVEL` controls the minimum severity emitted. The value is read from the environment at startup via the config module (`src/config/index.ts`).

| Value | `debug` | `info` | `warn` | `error` |
|-------|---------|--------|--------|---------|
| `debug` | ✓ | ✓ | ✓ | ✓ |
| `info` (default) | — | ✓ | ✓ | ✓ |
| `warn` | — | — | ✓ | ✓ |
| `error` | — | — | — | ✓ |

> Note: `debug` output is also gated on `process.env.DEBUG === "true"` or `NODE_ENV === "development"` — both conditions must effectively allow it. In production, set `LOG_LEVEL=info` and leave `DEBUG` unset.

**Example `.env` configuration:**

```dotenv
# .env
LOG_LEVEL=debug   # development / active incident investigation
# LOG_LEVEL=info  # production default
# LOG_LEVEL=warn  # suppress routine info in very high-traffic environments
# LOG_LEVEL=error # alert-only mode (not recommended for normal operation)
```

`LOG_LEVEL` is an optional variable; it defaults to `info`. See the [Environment Variables](../README.md#environment-variables) table in the root README and `.env.example` for the authoritative list.

---

## 9. Adding a new event type

1. **Add the enum member** to `LogEventType` in `src/observability/logSchemas.ts`:

   ```typescript
   export enum LogEventType {
     // ... existing ...
     SETTLEMENT_COMPLETED = "settlement:completed",
   }
   ```

2. **Define the allowed fields** in `LOG_SCHEMAS`:

   ```typescript
   [LogEventType.SETTLEMENT_COMPLETED]: {
     message:          { type: "string" },
     settlementId:     { type: "string" },
     amountSettled:    { type: "number" },
     currency:         { type: "string" },
     durationMs:       { type: "number" },
   },
   ```

   - Only list fields you actually emit.
   - Never list fields from the [PII patterns table](#fields-that-are-always-redacted) — they would be redacted anyway and listing them creates confusion.
   - For nested objects, define a `nested` sub-schema rather than using `type: "any"`.

3. **Run the redaction tests** to confirm the schema behaves as expected:

   ```bash
   npx vitest run --reporter=verbose src/__tests__/redaction.test.ts
   ```

4. **Use the new type** when logging:

   ```typescript
   logger.info(
     { message: "settlement_completed", settlementId: "sett_001", amountSettled: 200, currency: "USDC", durationMs: 120 },
     { eventType: LogEventType.SETTLEMENT_COMPLETED }
   );
   ```

5. **Document the event** — add a row to the event-type table in this document (step 6 in the table above) and reference it in `docs/observability.md`.

---

## 10. Quick reference — do / do not

| ✓ Do | ✗ Do not |
|------|----------|
| `req.log.info(...)` inside handlers | `console.log(...)` anywhere in app code |
| Pass `{ eventType: LogEventType.X }` with every structured log | Pass an inline object without a redaction context |
| Use a stable event name string as `message` | Interpolate variables into `message` strings |
| Use `logger.error(msg, err, ctx)` for exceptions | Log `err.message` manually and forget the `stack` |
| Add new fields to the schema before logging them | Rely on `GENERIC_*` types for every event |
| Redact or delete PII before passing a payload to a function that logs | Log raw request/response bodies |
| Use `warn` for the first retry, `error` for exhaustion | Use `error` for client errors (4xx) |
| Gate expensive debug payloads behind a log-level check | Emit multi-KB debug objects on every request |

---

*For questions about this policy, open an issue or ping the `#engineering` channel.*
