export type ApiLogLike = {
  timestamp: string;
  action: string;
  detail: string;
  success: boolean;
  durationMs: number;
  response?: string | null;
};

export type ApiLogStatusFilter = "all" | "success" | "error";

export type ApiLogOutput = { label: string; text: string };

export function extractApiLogOutputs(response: string): ApiLogOutput[] {
  if (response.length > 128 * 1024) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(response); } catch { return []; }
  if (typeof parsed === "string") return [{ label: "文本输出", text: parsed }];
  const outputs: ApiLogOutput[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return;
    const object = value as Record<string, unknown>;
    for (const [key, label] of [["output", "文本输出"], ["stdout", "标准输出"], ["stderr", "错误输出"]]) {
      if (typeof object[key] === "string") {
        outputs.push({ label: path ? `${label} · ${path}.${key}` : label, text: object[key] as string });
      }
    }
    for (const key of ["return", "result", "data"]) visit(object[key], path ? `${path}.${key}` : key, depth + 1);
  }
  visit(parsed, "", 0);
  return outputs;
}

export function filterApiLogEntries<T extends ApiLogLike>(logs: readonly T[], query: string, status: ApiLogStatusFilter, action: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return logs.filter((log) => {
    if (status !== "all" && log.success !== (status === "success")) return false;
    if (action && log.action !== action) return false;
    return !needle || [log.detail, log.response ?? "", log.action, log.success ? "成功" : "失败"]
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
}

export function formatApiLogResponse(response: string): string {
  if (response.length > 128 * 1024) return response;
  // A truncated preview or plain text must remain readable exactly as recorded.
  try {
    JSON.parse(response);
  } catch {
    return response;
  }
  // Format tokens instead of reserializing Numbers: request IDs and counters can
  // exceed JavaScript's safe integer range, and must retain their original bytes.
  const tokens = response.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? [];
  let depth = 0;
  let formatted = "";
  const newline = () => "\n" + "  ".repeat(depth);
  for (const [index, token] of tokens.entries()) {
    if (token === "{" || token === "[") {
      formatted += token;
      depth += 1;
      if (depth > 64) return response;
      if (tokens[index + 1] !== "}" && tokens[index + 1] !== "]") formatted += newline();
    } else if (token === "}" || token === "]") {
      depth -= 1;
      if (tokens[index - 1] !== "{" && tokens[index - 1] !== "[") formatted += newline();
      formatted += token;
    } else if (token === ",") {
      formatted += token + newline();
    } else {
      formatted += token === ":" ? ": " : token;
    }
    if (formatted.length > 256 * 1024) return response;
  }
  return formatted;
}

export function apiLogEntryKey(log: ApiLogLike) {
  return [
    log.timestamp,
    log.action,
    log.durationMs,
    log.success ? 1 : 0,
    log.detail,
    log.response ?? "",
  ].join("|");
}

export function mergeApiLogEntries<T extends ApiLogLike>(
  current: readonly T[],
  incoming: readonly T[],
  limit = 100,
): T[] {
  const byKey = new Map<string, T>();
  for (const log of [...current, ...incoming]) {
    byKey.set(apiLogEntryKey(log), log);
  }
  const merged = [...byKey.values()].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}
