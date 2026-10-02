/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import {
  MetricsRegistry,
  NoopMetricsRegistry,
  DEFAULT_HISTOGRAM_BUCKETS,
} from '../src/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

type TestPhase = 'fetch' | 'parse' | 'emit';
const PHASES: TestPhase[] = ['fetch', 'parse', 'emit'];
const PREFIX = 'test_svc';

function makeRegistry(
  overrides: Partial<{ phases: TestPhase[]; prefix: string; histogramBuckets: number[] }> = {},
) {
  return new MetricsRegistry<TestPhase>({
    phases: overrides.phases ?? PHASES,
    prefix: overrides.prefix ?? PREFIX,
    histogramBuckets: overrides.histogramBuckets,
  });
}

// ── DefaultCounter ────────────────────────────────────────────────────────────

describe('DefaultCounter', () => {
  it('returns 0 for any unseen phase/outcome combination', () => {
    const reg = makeRegistry();
    expect(reg.counter.get('fetch', 'success')).toBe(0);
    expect(reg.counter.get('parse', 'failure')).toBe(0);
    expect(reg.counter.get('emit', 'cancelled')).toBe(0);
  });

  it('increments by exactly 1 on each call', () => {
    const reg = makeRegistry();
    reg.counter.inc('fetch', 'success');
    expect(reg.counter.get('fetch', 'success')).toBe(1);
    reg.counter.inc('fetch', 'success');
    expect(reg.counter.get('fetch', 'success')).toBe(2);
  });

  it('isolates counts per phase — incrementing one does not affect another', () => {
    const reg = makeRegistry();
    reg.counter.inc('fetch', 'success');
    reg.counter.inc('fetch', 'success');
    reg.counter.inc('parse', 'success');

    expect(reg.counter.get('fetch', 'success')).toBe(2);
    expect(reg.counter.get('parse', 'success')).toBe(1);
    expect(reg.counter.get('emit', 'success')).toBe(0);
  });

  it('isolates counts per outcome — incrementing one does not affect another', () => {
    const reg = makeRegistry();
    reg.counter.inc('fetch', 'success');
    reg.counter.inc('fetch', 'failure');
    reg.counter.inc('fetch', 'failure');

    expect(reg.counter.get('fetch', 'success')).toBe(1);
    expect(reg.counter.get('fetch', 'failure')).toBe(2);
    expect(reg.counter.get('fetch', 'cancelled')).toBe(0);
  });

  it('all three outcomes are tracked independently for the same phase', () => {
    const reg = makeRegistry();
    for (let i = 0; i < 3; i++) reg.counter.inc('emit', 'success');
    for (let i = 0; i < 2; i++) reg.counter.inc('emit', 'failure');
    reg.counter.inc('emit', 'cancelled');

    expect(reg.counter.get('emit', 'success')).toBe(3);
    expect(reg.counter.get('emit', 'failure')).toBe(2);
    expect(reg.counter.get('emit', 'cancelled')).toBe(1);
  });

  it('is monotonically increasing — never decrements', () => {
    const reg = makeRegistry();
    for (let i = 1; i <= 100; i++) {
      reg.counter.inc('fetch', 'success');
      expect(reg.counter.get('fetch', 'success')).toBe(i);
    }
  });

  it('multiple registries are fully independent (no shared state)', () => {
    const a = makeRegistry();
    const b = makeRegistry();
    a.counter.inc('fetch', 'success');
    expect(b.counter.get('fetch', 'success')).toBe(0);
  });
});

// ── DefaultHistogram ──────────────────────────────────────────────────────────

describe('DefaultHistogram', () => {
  it('snapshot of a phase with no observations returns zero count/sum and +Inf=0', () => {
    const reg = makeRegistry({ histogramBuckets: [10, 100] });
    const snap = reg.histogram.snapshot('parse');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    expect(snap.buckets.get('+Inf')).toBe(0);
  });

  it('count and sum are correct after several observations', () => {
    const reg = makeRegistry({ histogramBuckets: [10, 100, 1000] });
    reg.histogram.observe('fetch', 5);
    reg.histogram.observe('fetch', 50);
    reg.histogram.observe('fetch', 500);

    const snap = reg.histogram.snapshot('fetch');
    expect(snap.count).toBe(3);
    expect(snap.sum).toBe(555);
  });

  it('bucket counts are cumulative — each le includes all smaller values', () => {
    const reg = makeRegistry({ histogramBuckets: [10, 100, 1000] });
    // 5 falls in le=10, le=100, le=1000
    // 50 falls in le=100, le=1000
    // 500 falls in le=1000
    // 2000 falls in no finite bucket
    reg.histogram.observe('fetch', 5);
    reg.histogram.observe('fetch', 50);
    reg.histogram.observe('fetch', 500);
    reg.histogram.observe('fetch', 2000);

    const snap = reg.histogram.snapshot('fetch');
    expect(snap.buckets.get(10)).toBe(1);
    expect(snap.buckets.get(100)).toBe(2);
    expect(snap.buckets.get(1000)).toBe(3);
    expect(snap.buckets.get('+Inf')).toBe(4); // all observations
  });

  it('value exactly on a bucket edge is counted in that bucket (≤ boundary)', () => {
    const reg = makeRegistry({ histogramBuckets: [100, 500] });
    reg.histogram.observe('emit', 100); // exactly on le=100 boundary
    reg.histogram.observe('emit', 500); // exactly on le=500 boundary

    const snap = reg.histogram.snapshot('emit');
    expect(snap.buckets.get(100)).toBe(1);
    expect(snap.buckets.get(500)).toBe(2);
    expect(snap.buckets.get('+Inf')).toBe(2);
  });

  it('value just above a bucket edge falls into the next bucket only', () => {
    const reg = makeRegistry({ histogramBuckets: [100, 500] });
    reg.histogram.observe('emit', 101); // just above le=100, so only in le=500 and +Inf

    const snap = reg.histogram.snapshot('emit');
    expect(snap.buckets.get(100)).toBe(0);
    expect(snap.buckets.get(500)).toBe(1);
    expect(snap.buckets.get('+Inf')).toBe(1);
  });

  it('value above all finite buckets only increments +Inf', () => {
    const reg = makeRegistry({ histogramBuckets: [10, 50] });
    reg.histogram.observe('parse', 9999);

    const snap = reg.histogram.snapshot('parse');
    expect(snap.buckets.get(10)).toBe(0);
    expect(snap.buckets.get(50)).toBe(0);
    expect(snap.buckets.get('+Inf')).toBe(1);
  });

  it('+Inf bucket always equals total count regardless of values', () => {
    const reg = makeRegistry({ histogramBuckets: [1] });
    // All values are far above the only bucket
    [1000, 2000, 3000].forEach((v) => reg.histogram.observe('fetch', v));

    const snap = reg.histogram.snapshot('fetch');
    expect(snap.buckets.get('+Inf')).toBe(snap.count);
    expect(snap.buckets.get('+Inf')).toBe(3);
  });

  it('snapshot is independent per phase', () => {
    const reg = makeRegistry({ histogramBuckets: [100] });
    reg.histogram.observe('fetch', 50);
    reg.histogram.observe('parse', 200);

    expect(reg.histogram.snapshot('fetch').count).toBe(1);
    expect(reg.histogram.snapshot('parse').count).toBe(1);
    expect(reg.histogram.snapshot('emit').count).toBe(0);
  });

  it('buckets are always sorted ascending in the snapshot Map iteration order', () => {
    // Provide buckets out of order — impl should sort them
    const reg = makeRegistry({ histogramBuckets: [500, 10, 100] });
    reg.histogram.observe('fetch', 1);

    const snap = reg.histogram.snapshot('fetch');
    // Collect finite keys (exclude '+Inf')
    const finiteKeys = [...snap.buckets.keys()].filter(
      (k): k is number => k !== '+Inf',
    );
    for (let i = 1; i < finiteKeys.length; i++) {
      expect(finiteKeys[i]).toBeGreaterThan(finiteKeys[i - 1]);
    }
  });

  it('DEFAULT_HISTOGRAM_BUCKETS is sorted ascending and covers sub-ms to 10 s', () => {
    for (let i = 1; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
      expect(DEFAULT_HISTOGRAM_BUCKETS[i]).toBeGreaterThan(DEFAULT_HISTOGRAM_BUCKETS[i - 1]);
    }
    expect(DEFAULT_HISTOGRAM_BUCKETS[0]).toBeLessThanOrEqual(10);
    expect(DEFAULT_HISTOGRAM_BUCKETS[DEFAULT_HISTOGRAM_BUCKETS.length - 1]).toBeGreaterThanOrEqual(
      10000,
    );
  });
});

// ── MetricsRegistry.expose() ──────────────────────────────────────────────────

describe('MetricsRegistry.expose()', () => {
  it('emits # HELP and # TYPE lines for counter and histogram', () => {
    const reg = makeRegistry();
    const out = reg.expose();

    expect(out).toContain(`# HELP ${PREFIX}_requests_total Total requests by phase and outcome`);
    expect(out).toContain(`# TYPE ${PREFIX}_requests_total counter`);
    expect(out).toContain(`# HELP ${PREFIX}_duration_ms_bucket Histogram of phase durations in milliseconds`);
    expect(out).toContain(`# TYPE ${PREFIX}_duration_ms histogram`);
  });

  it('emits zero-value counter lines for every phase×outcome combination', () => {
    const reg = makeRegistry();
    const out = reg.expose();
    const outcomes = ['success', 'failure', 'cancelled'] as const;

    for (const phase of PHASES) {
      for (const outcome of outcomes) {
        expect(out).toContain(
          `${PREFIX}_requests_total{phase="${phase}",outcome="${outcome}"} 0`,
        );
      }
    }
  });

  it('reflects incremented counter values correctly', () => {
    const reg = makeRegistry();
    reg.counter.inc('fetch', 'success');
    reg.counter.inc('fetch', 'success');
    reg.counter.inc('parse', 'failure');

    const out = reg.expose();
    expect(out).toContain(`${PREFIX}_requests_total{phase="fetch",outcome="success"} 2`);
    expect(out).toContain(`${PREFIX}_requests_total{phase="parse",outcome="failure"} 1`);
    expect(out).toContain(`${PREFIX}_requests_total{phase="emit",outcome="success"} 0`);
  });

  it('emits histogram bucket lines with correct le= labels', () => {
    const reg = makeRegistry({ histogramBuckets: [50, 200] });
    reg.histogram.observe('fetch', 30);

    const out = reg.expose();
    expect(out).toContain(`${PREFIX}_duration_ms_bucket{phase="fetch",le="50"} 1`);
    expect(out).toContain(`${PREFIX}_duration_ms_bucket{phase="fetch",le="200"} 1`);
    expect(out).toContain(`${PREFIX}_duration_ms_bucket{phase="fetch",le="+Inf"} 1`);
  });

  it('emits _sum and _count lines for each phase', () => {
    const reg = makeRegistry({ histogramBuckets: [100] });
    reg.histogram.observe('parse', 40);
    reg.histogram.observe('parse', 80);

    const out = reg.expose();
    expect(out).toContain(`${PREFIX}_duration_ms_sum{phase="parse"} 120`);
    expect(out).toContain(`${PREFIX}_duration_ms_count{phase="parse"} 2`);
  });

  it('emits zero _sum and _count for a phase with no observations', () => {
    const reg = makeRegistry({ histogramBuckets: [100] });
    const out = reg.expose();
    expect(out).toContain(`${PREFIX}_duration_ms_sum{phase="fetch"} 0`);
    expect(out).toContain(`${PREFIX}_duration_ms_count{phase="fetch"} 0`);
  });

  it('uses the configured prefix — no cross-prefix contamination', () => {
    const a = makeRegistry({ prefix: 'svc_a' });
    const b = makeRegistry({ prefix: 'svc_b' });

    expect(a.expose()).toContain('svc_a_requests_total');
    expect(a.expose()).not.toContain('svc_b_requests_total');
    expect(b.expose()).toContain('svc_b_requests_total');
    expect(b.expose()).not.toContain('svc_a_requests_total');
  });

  it('only emits lines for phases declared at construction time', () => {
    const reg = new MetricsRegistry<'only'>({
      phases: ['only'],
      prefix: 'narrow',
    });
    const out = reg.expose();
    expect(out).toContain('phase="only"');
    expect(out).not.toContain('phase="fetch"');
    expect(out).not.toContain('phase="parse"');
  });

  it('output ends with a newline (Prometheus text format requirement)', () => {
    const reg = makeRegistry();
    expect(reg.expose().endsWith('\n')).toBe(true);
  });

  it('matches a known-good Prometheus text fixture', () => {
    const reg = new MetricsRegistry<'p'>({
      phases: ['p'],
      prefix: 'fixture',
      histogramBuckets: [100],
    });
    reg.counter.inc('p', 'success');
    reg.histogram.observe('p', 80);

    const expected = [
      '# HELP fixture_requests_total Total requests by phase and outcome',
      '# TYPE fixture_requests_total counter',
      'fixture_requests_total{phase="p",outcome="success"} 1',
      'fixture_requests_total{phase="p",outcome="failure"} 0',
      'fixture_requests_total{phase="p",outcome="cancelled"} 0',
      '# HELP fixture_duration_ms_bucket Histogram of phase durations in milliseconds',
      '# TYPE fixture_duration_ms histogram',
      'fixture_duration_ms_bucket{phase="p",le="100"} 1',
      'fixture_duration_ms_bucket{phase="p",le="+Inf"} 1',
      'fixture_duration_ms_sum{phase="p"} 80',
      'fixture_duration_ms_count{phase="p"} 1',
      '',
    ].join('\n');

    expect(reg.expose()).toBe(expected);
  });
});

// ── NoopMetricsRegistry ───────────────────────────────────────────────────────

describe('NoopMetricsRegistry', () => {
  it('expose() returns exactly an empty string', () => {
    const noop = new NoopMetricsRegistry<TestPhase>();
    expect(noop.expose()).toBe('');
  });

  it('counter.inc() is a no-op — get() always returns 0', () => {
    const noop = new NoopMetricsRegistry<TestPhase>();
    noop.counter.inc('fetch', 'success');
    noop.counter.inc('fetch', 'success');
    noop.counter.inc('parse', 'failure');
    expect(noop.counter.get('fetch', 'success')).toBe(0);
    expect(noop.counter.get('parse', 'failure')).toBe(0);
  });

  it('histogram.observe() is a no-op — snapshot returns zeros', () => {
    const noop = new NoopMetricsRegistry<TestPhase>();
    noop.histogram.observe('emit', 999);
    const snap = noop.histogram.snapshot('emit');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
  });

  it('histogram.snapshot() returns an empty buckets Map (no finite or +Inf entries)', () => {
    const noop = new NoopMetricsRegistry<TestPhase>();
    const snap = noop.histogram.snapshot('fetch');
    expect(snap.buckets.size).toBe(0);
  });

  it('is safe to call expose() multiple times and always returns empty string', () => {
    const noop = new NoopMetricsRegistry<TestPhase>();
    for (let i = 0; i < 5; i++) {
      expect(noop.expose()).toBe('');
    }
  });
});
