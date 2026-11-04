type Samples = { durations: Float64Array; failures: Uint8Array; cursor: number; count: number };
const samples = new Map<string, Samples>();
const MAX_SAMPLES = 128;
const MAX_OPERATIONS = 128;

/** Bounded diagnostics: command names/timings only, never arguments or results. */
export function recordPerformance(operation: string, started: number, ok = true) {
  if (!samples.has(operation) && samples.size >= MAX_OPERATIONS) return;
  let values = samples.get(operation);
  if (!values) {
    values = { durations: new Float64Array(MAX_SAMPLES), failures: new Uint8Array(MAX_SAMPLES), cursor: 0, count: 0 };
    samples.set(operation, values);
  }
  values.durations[values.cursor] = Math.max(0, performance.now() - started);
  values.failures[values.cursor] = ok ? 0 : 1;
  values.cursor = (values.cursor + 1) % MAX_SAMPLES;
  values.count = Math.min(MAX_SAMPLES, values.count + 1);
}

export function performanceSnapshot() {
  return Object.fromEntries([...samples].map(([operation, values]) => {
    const sorted = values.durations.slice(0, values.count).sort();
    return [operation, {
      samples: values.count,
      errors: values.failures.subarray(0, values.count).reduce((sum, value) => sum + value, 0),
      p50Ms: sorted[Math.ceil(sorted.length * .5) - 1],
      p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
      maxMs: sorted[sorted.length - 1],
    }];
  }));
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "__HELM_PERFORMANCE__", {
    configurable: true,
    value: { snapshot: performanceSnapshot, reset: () => samples.clear() },
  });
}
