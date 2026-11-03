type Sample = { durationMs: number; ok: boolean };
const samples = new Map<string, Sample[]>();
const MAX_SAMPLES = 128;
const MAX_OPERATIONS = 128;

/** Bounded diagnostics: command names/timings only, never arguments or results. */
export function recordPerformance(operation: string, started: number, ok = true) {
  if (!samples.has(operation) && samples.size >= MAX_OPERATIONS) return;
  const values = samples.get(operation) ?? [];
  if (values.length === MAX_SAMPLES) values.shift();
  values.push({ durationMs: Math.max(0, performance.now() - started), ok });
  samples.set(operation, values);
}

export function performanceSnapshot() {
  return Object.fromEntries([...samples].map(([operation, values]) => {
    const sorted = values.map((value) => value.durationMs).sort((a, b) => a - b);
    return [operation, {
      samples: values.length,
      errors: values.filter((value) => !value.ok).length,
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
