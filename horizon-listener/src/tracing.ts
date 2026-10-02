/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * OpenTelemetry-compatible tracing for horizon-listener.
 *
 * The generic tracer machinery lives in `@compliance-adapters/tracing`
 * (shared with sanctions-oracle). See that package for the full design
 * rationale.
 *
 * Phases instrumented
 * ────────────────────
 * rpc_poll    — each call to `eventSource.getEvents()`
 * event_relay — each call to the `onEvent` handler
 * webhook     — each call to a `WebhookSender.send()`
 */


export {
  DefaultTracer,
  NoopTracer,
  type AnyTracer,
  type Tracer,
  type Span,
  type SpanData,
  type SpanStatus,
  type SpanAttributes,
  type SpanExporter,
  type TracingContext,
  type TracingOptions,
} from '@compliance-adapters/tracing';
