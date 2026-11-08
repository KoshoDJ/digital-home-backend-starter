# CornerMan conversion contract v1

Digital Home accepts a signed CornerMan enrollment-conversion event, records
one durable receipt, marks the named lead converted, and exits only active
`prospect_nurture` enrollments. CornerMan owns the external identity map. This
Home never matches on email.

This member migration is additive (`900_cornerman_conversion.sql`). It is not
part of the official 19-file starter pair. Do not run hosted migrations, deploy,
or change CRM safe mode from this document.

## Endpoints

`POST /api/integrations/cornerman/v1/conversions`

```json
{
  "schema_version": 1,
  "event_id": "UUID",
  "source": "cornerman",
  "environment": "staging",
  "occurred_at": "ISO-8601 timestamp",
  "digital_home_lead_id": "UUID",
  "cornerman_enrollment_id": "UUID",
  "cornerman_enrollment_version": 1,
  "correlation_id": "UUID",
  "conversion_status": "enrolled"
}
```

Unknown fields, a source other than `cornerman`, a status other than
`enrolled`, or a schema version other than `1` are rejected. `environment` must
equal `DIGITAL_HOME_INTEGRATION_ENV`. If that variable is missing the route
fails closed with HTTP `503`. `occurred_at` must fall inside
`CORNERMAN_CONVERSION_REPLAY_WINDOW_SECONDS` (default 300). Caller-supplied
tenant identifiers are not used for authorization.

`GET /api/integrations/cornerman/v1/conversions/{event_id}` returns the stored
receipt for the configured environment, or a generic HTTP `404`.

Responses contain the receipt only: ids, hashes, counts, timestamps, and
`result_status`. They never include names, emails, phone numbers, message
bodies, API keys, or signing secrets.

## Authentication

Machine authentication only, using the existing minted-key and HMAC stack.

- Header `x-api-key`: a minted `bbk_...` key.
- Exact scope `cornerman:conversion`.
- Headers `x-timestamp` and `x-signature`, HMAC-SHA256 over
  `METHOD:pathname:timestamp:body`, compared in constant time.
- Timestamp TTL is `API_REQUEST_SIGNATURE_TTL_SECONDS` (default 300).

Browser sessions, master keys, legacy environment keys, and wildcard `*` keys
are refused. There is no second authentication system.

### Signing example (placeholders only)

```
METHOD=POST
PATH=/api/integrations/cornerman/v1/conversions
TIMESTAMP=1730000000
BODY={"schema_version":1,...}
KEY=bbk_cornerman_<32-hex>
SIGNATURE=$(printf '%s:%s:%s:%s' "$METHOD" "$PATH" "$TIMESTAMP" "$BODY" | openssl dgst -sha256 -hmac "$KEY" | awk '{print $2}')

curl -X POST "https://backend.example.test$PATH" \
  -H "content-type: application/json" \
  -H "x-api-key: $KEY" \
  -H "x-timestamp: $TIMESTAMP" \
  -H "x-signature: $SIGNATURE" \
  --data "$BODY"
```

Never paste live credentials into this file, logs, or tickets.

## Identity

CornerMan stores the Digital Home lead UUID in its own mapping. Digital Home
identifies the lead only by `digital_home_lead_id`. An unknown lead returns a
generic `404`. Email is not an identity key.

## Idempotency and acknowledgments

Uniqueness is `(producer, environment, event_id)`.

| Delivery | Result |
|---|---|
| First valid event | Apply conversion in one PostgreSQL function and return the receipt (`applied` or `needs_review`). |
| Same event, same canonical hash | Return the original receipt without reapplying (`code: replay`). |
| Same event, different hash | HTTP `409`. |
| Concurrent identical events | One receipt, one application. |
| Database failure | HTTP `500`. Never a false success. |

Canonical hash is SHA-256 of the ten contract fields in fixed order.

`applied` means conversion completed and no relevant dispatch was already
reserved. `needs_review` means one or more prospect-nurture email dispatches
had already been reserved, so cancellation cannot be guaranteed.

The receipt, lead status change, nurture exits, and the single timeline row are
written in `apply_cornerman_conversion_v1`. Replay does not insert a second
activity.

## Workflow purpose

`workflows.purpose` is one of `general`, `prospect_nurture`,
`customer_onboarding`, `transactional`. Existing workflows remain `general`.
Operators set purpose on create or edit. Conversion exits only active
enrollments whose workflow purpose is `prospect_nurture`. Other enrollments,
including completed, failed, and already exited rows, are left unchanged.

Exit evidence on the enrollment: `exited_at`, `exit_reason`, `exit_event_id`,
status `exited`.

## Send-race protection

Closing an enrollment is not enough if the engine already selected it. Before
the provider or safe-mode simulator is called, `reserve_workflow_dispatch_v1`
locks the enrollment and lead, confirms the lead is not converted, confirms the
enrollment is still active at the expected step, and inserts or recovers a
durable reservation.

- Conversion first: reservation fails; no provider or simulator call.
- Reservation first: conversion still applies and reports `needs_review` plus
  the in-flight count.
- A later engine write uses `status = 'active'`, so it cannot reactivate,
  advance, or overwrite an enrollment conversion already exited.
- Duplicate ticks still use the existing `next_run_at` compare-and-swap.
- A reserved row expires (default 10 minutes). The next tick may recover it.
  This is not distributed exactly-once delivery.

## Staging key provisioning

1. Set `DIGITAL_HOME_INTEGRATION_ENV=staging` on the backend Worker.
2. Mint a key named for this integration with only `cornerman:conversion`.
3. Store the plaintext once in CornerMan. Digital Home keeps the hash.
4. Sign requests with that plaintext. Do not use the master or env-var keys.

## Synthetic staging validation

Use disposable local PostgreSQL or PGlite fixtures. Never a live project.

1. Insert a synthetic lead UUID and four workflows (one of each purpose).
2. POST a signed conversion for that UUID.
3. Confirm only `prospect_nurture` exited and the receipt is `applied`.
4. Replay the same body; confirm the same receipt id.
5. Replay with a mutated field; confirm `409`.
6. GET the event id; confirm the receipt and the absence of PII.

## Retry and reconciliation

Retry a failed POST with the same body. If Digital Home already applied it, the
response is the original receipt. Use GET by `event_id` when the POST
acknowledgement was lost. Treat `needs_review` as applied-with-follow-up: a
nurture send may already be in flight.

## Rollback

The migration is additive. Aborting its transaction leaves the official 19-file
schema unchanged. After it has been applied, rolling back code without dropping
columns is safe: unused purpose, receipt, and reservation tables do not change
CRM behavior. Do not drop applied member history to make a fresh install pass;
use `UPGRADE.md`.

## Deferred production work

- Hosted application of `900_cornerman_conversion.sql`
- Production Worker deploy and production key mint
- Breaking `@anthropic-ai/sdk` 1.x upgrade (remaining moderate)
- CornerMan production identity mapping and live enrollment traffic
- Connecting a custom media domain or changing CRM safe mode
