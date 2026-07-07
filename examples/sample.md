# Service Readiness Review

**Date:** July 7, 2026
**Author:** Platform Team
**Classification:** Internal — Draft

This sample exercises every construct md2gd supports. Running it end to end is the fixture behind acceptance criterion AC-3: each element must render correctly or degrade gracefully, with no crash.

## Summary

The service is **broadly ready** for launch, with two *blocking* issues and several ***minor*** follow-ups. Configuration is read from `config.json` at boot; secrets such as `sk_test_` keys must never appear in logs. The staging host is `staging-api.internal.example.com` and responds within budget.

Note the typography that must survive intact: em-dashes (—), en-dashes (2020–2026), arrows (request → response), and curly quotes ("ready", 'draft').

## Findings

**Customer journey**

| Status | Area | Notes |
| --- | --- | --- |
| ✅ Working | Sign-up | **Solid** — email + OAuth both verified, including `POST /api/auth/resend-confirmation`. |
| 🟠 High | Sessions | **Cookie flags** — set `HttpOnly; SameSite=Strict`; currently missing on the refresh cookie. |
| 🔴 Blocker | Billing | **Webhook secret** — `WebhookSecret` is hard-coded; rotate and move to config before launch. |
| 🕐 Pending | Exports | Long-running report jobs are not yet cancellable; see the note below. |

**Ownership**

| Team | On call |
| --- | --- |
| Platform | Yes |
| Billing | No |

## Priorities

Blocking work, in order:

1. Rotate the billing webhook secret
2. Add session cookie flags
   1. Refresh cookie
   2. CSRF cookie
3. Ship cancellable exports

Supporting areas:

- Observability
  - Metrics
    - Request latency histograms
    - Error-rate alerts
  - Structured logs
- Documentation

## Launch checklist

- [x] Load test passed
- [x] Rollback plan documented
- [ ] Billing webhook secret rotated
- [ ] Session cookie flags shipped
- [ ] Runbook linked in the on-call channel

## Configuration

Fenced block with a language hint:

```ts
const config = {
  retries: 3,
  timeoutMs: 5_000, // keep under the 8s gateway budget
};
```

Indented block:

    GET /healthz
    200 OK

## Rollout

> Ship the blockers first, then measure for a week before enabling exports.
> A partial rollout is fine; a silent one is not.

Progress so far has been ~~slow~~ steady. Full details live in the [runbook](https://example.com/runbook) and the dashboard at grafana.internal.example.com.

The architecture is summarized in an inline diagram[^1].

![Rollout timeline](https://placehold.co/600x200/png)

---

Reviewed by the Platform Team.

[^1]: Diagram embedding is a superset feature; if unsupported it degrades to readable text rather than failing the run.
