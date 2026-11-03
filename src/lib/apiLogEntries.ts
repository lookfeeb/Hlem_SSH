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

const MAX_RESPONSE_LENGTH = 2 * 1024 * 1024;

function parseResponse(response: string): unknown {
  if (response.length > MAX_RESPONSE_LENGTH) return undefined;
  try { return JSON.parse(response); } catch { return undefined; }
}

function decodeXmlText(text: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (original, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity] ?? original;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original;
  }).replace(/_x([\da-f]{4})_/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

export function decodePowerShellOutput(text: string): string {
  if (!/^\s*#< CLIXML\s/.test(text) || /<!DOCTYPE|<!ENTITY/i.test(text)) return text;
  const records = [...text.matchAll(/<S(?:\s[^>]*)?>([^<]*)<\/S>/g)].map((match) => decodeXmlText(match[1]));
  if (!records.length) return text;
  return records.reduce((result, record) => result + (result && !result.endsWith("\n") ? "\n" : "") + record, "");
}

function decodeBase64Text(value: string): string | undefined {
  const compact = value.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) return undefined;
  try {
    const bytes = Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return undefined;
    return decodePowerShellOutput(decoded);
  } catch { return undefined; }
}

// This is a readable display, not a JSON document. Keep numeric tokens intact
// while expanding only JSON string values; literal backslashes stay literal.
export function formatApiLogReadableResponse(response: string): string {
  const formatted = formatApiLogResponse(response);
  if (parseResponse(response) === undefined) return decodePowerShellOutput(response);
  return formatted.replace(/"(?:\\.|[^"\\])*"/g, (token: string, offset: number) => {
    if (/^\s*:/.test(formatted.slice(offset + token.length))) return token;
    const value: string = JSON.parse(token);
    if (!/[\r\n]/.test(value)) return token;
    const lineStart = formatted.lastIndexOf("\n", offset) + 1;
    const indent = formatted.slice(lineStart, offset).match(/^ */)?.[0] ?? "";
    return `|\n${value.split(/\r?\n/).map((line) => `${indent}  ${line}`).join("\n")}`;
  });
}

export function apiLogCommand(log: ApiLogLike): string {
  const record = parseResponse(log.response ?? "") as Record<string, unknown> | undefined;
  return record?.logFormat === "exec-v1" && typeof record.command === "string" ? record.command : log.detail;
}

export function extractApiLogOutputs(response: string): ApiLogOutput[] {
  const parsed = parseResponse(response);
  if (typeof parsed === "string") return [{ label: "文本输出", text: parsed }];
  const outputs: ApiLogOutput[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (!value || typeof value !== "object" || depth > 8 || outputs.length >= 64) return;
    if (Array.isArray(value)) {
      value.slice(0, 64).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.logFormat === "exec-v1") {
      const facts = [
        `退出码: ${object.exitStatus ?? "未提供"}`,
        `超时: ${object.timedOut ? "是" : "否"}`,
        ...(typeof object.status === "string" ? [`任务状态: ${object.status}`] : []),
        ...(typeof object.stdoutBytes === "number" ? [`标准输出: ${object.stdoutBytes} 字节`] : []),
        ...(typeof object.stderrBytes === "number" ? [`错误输出: ${object.stderrBytes} 字节`] : []),
      ];
      outputs.push({ label: "执行结果", text: facts.join("\n") });
    }
    for (const [key, label] of [["output", "文本输出"], ["stdout", "标准输出"], ["stderr", "错误输出"]]) {
      if (typeof object[key] === "string") {
        const text = object[key] as string;
        if (!text && object.logFormat === "exec-v1") continue;
        const nested = depth < 8 ? extractNested(text, path ? `${path}.${key}` : key, depth + 1) : false;
        if (!nested) outputs.push({ label: path ? `${label} · ${path}.${key}` : label, text: formatApiLogReadableResponse(decodePowerShellOutput(text)) });
      }
    }
    if (typeof object["out-data"] === "string" || typeof object["err-data"] === "string" || (typeof object.exited === "boolean" && "exitcode" in object)) {
      if ("exitcode" in object || "exited" in object) outputs.push({ label: `虚拟机执行结果${path ? ` · ${path}` : ""}`, text: `状态: ${object.exited === false ? "执行中" : typeof object.exitcode === "number" ? object.exitcode === 0 ? "成功" : "失败" : "未提供"}\n退出码: ${object.exitcode ?? "未提供"}\n已结束: ${object.exited === true ? "是" : object.exited === false ? "否" : "未提供"}` });
      for (const [key, label] of [["out-data", "标准输出"], ["err-data", "错误输出"]]) {
        if (typeof object[key] !== "string") continue;
        const decoded = decodeBase64Text(object[key] as string);
        outputs.push({ label: `${label} · ${path ? `${path}.` : ""}${key}${decoded === undefined ? "（原始 Base64，非文本或数据不完整）" : "（已解码）"}`, text: decoded === undefined ? object[key] as string : formatApiLogReadableResponse(decoded) });
      }
    }
    for (const [key, child] of Object.entries(object)) {
      if (child && typeof child === "object") visit(child, path ? `${path}.${key}` : key, depth + 1);
    }
  }
  function extractNested(text: string, path: string, depth: number): boolean {
    const nested = parseResponse(text);
    const before = outputs.length;
    visit(nested, path, depth);
    return outputs.length > before;
  }
  visit(parsed, "", 0);
  return outputs;
}

export function apiLogResponseNotices(response: string): string[] {
  const parsed = parseResponse(response);
  if (parsed === undefined) return /^\s*[\[{]/.test(response) ? ["此响应不是完整 JSON，可能为历史日志截断或非 JSON 文本；仅显示已保存内容。"] : [];
  const notices = new Set<string>();
  function visit(value: unknown, depth: number) {
    if (!value || typeof value !== "object" || depth > 8) return;
    const record = value as Record<string, unknown>;
    for (const [key, text] of [["stdoutTruncated", "标准输出超过日志保存上限，仅保留前 65536 个字符。"], ["stderrTruncated", "错误输出超过日志保存上限，仅保留前 65536 个字符。"], ["errorTruncated", "错误详情超过日志保存上限。"], ["commandTruncated", "命令超过日志保存上限。"], ["outputTruncated", "执行时输出已被截断。"], ["out-truncated", "虚拟机标准输出已被截断。"], ["err-truncated", "虚拟机错误输出已被截断。"]]) {
      if (record[key] === true) notices.add(text);
    }
    if (record.logFormat === "exec-v1" && typeof record.error === "string" && record.error) notices.add(`执行错误: ${record.error}`);
    for (const [key, child] of Object.entries(record).slice(0, 64)) {
      if ((key === "stdout" || key === "output") && typeof child === "string") visit(parseResponse(child), depth + 1);
      else if (child && typeof child === "object") visit(child, depth + 1);
    }
  }
  visit(parsed, 0);
  return [...notices];
}

export function formatApiLogDecodedResponse(response: string): string {
  const outputs = extractApiLogOutputs(response);
  return [...apiLogResponseNotices(response), outputs.length ? outputs.map((output) => `--- ${output.label} ---\n${output.text}`).join("\n\n") : formatApiLogReadableResponse(response)].join("\n\n");
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
  if (response.length > MAX_RESPONSE_LENGTH) return response;
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
    if (formatted.length > 2 * MAX_RESPONSE_LENGTH) return response;
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
