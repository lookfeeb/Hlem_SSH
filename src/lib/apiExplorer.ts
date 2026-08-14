export const OPENAPI_HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export type OpenApiHttpMethod = typeof OPENAPI_HTTP_METHODS[number];

export type OpenApiSchema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  minimum?: number;
  maximum?: number;
  anyOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
};

export type OpenApiParameter = {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
};

export type OpenApiOperation = {
  tags?: string[];
  summary?: string;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
};

export type OpenApiDocument = {
  openapi: string;
  info?: { title?: string; version?: string; description?: string };
  paths: Record<string, Partial<Record<OpenApiHttpMethod, OpenApiOperation>>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
};

export type ApiExplorerEndpoint = {
  id: string;
  method: OpenApiHttpMethod;
  path: string;
  category: string;
  summary: string;
  operation: OpenApiOperation;
};

export type ApiExplorerRequestDefaults = {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  contentType: string | null;
  binaryBody: boolean;
};

export type ApiExplorerRequestPlan = {
  method: string;
  url: string;
  contentType: string | null;
  body: unknown;
  stream: boolean;
};

export type ApiResponseTokenType =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "punctuation"
  | "plain";

export type ApiResponseToken = {
  type: ApiResponseTokenType;
  value: string;
};

export type ApiResponseDisplay = {
  kind: "json" | "text";
  text: string;
  tokens: ApiResponseToken[];
};

export type ApiSseEvent = {
  id?: string;
  event: string;
  data: unknown;
  retry?: number;
};

export type ApiSseChunkResult = {
  buffer: string;
  events: ApiSseEvent[];
};

export function listOpenApiEndpoints(document: OpenApiDocument): ApiExplorerEndpoint[] {
  const endpoints: ApiExplorerEndpoint[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of OPENAPI_HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      endpoints.push({
        id: `${method.toUpperCase()} ${path}`,
        method,
        path,
        category: operation.tags?.[0] ?? "其他",
        summary: operation.summary ?? path,
        operation,
      });
    }
  }
  return endpoints.sort((left, right) => (
    left.category.localeCompare(right.category, "zh-CN")
    || left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method)
  ));
}

export function createRequestDefaults(
  document: OpenApiDocument,
  endpoint: ApiExplorerEndpoint,
  sessionId = "",
): ApiExplorerRequestDefaults {
  const path: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const parameter of endpoint.operation.parameters ?? []) {
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    const value = sampleForSchema(document, parameter.schema, parameter.name);
    const target = parameter.in === "path" ? path : query;
    target[parameter.name] = parameter.name === "sessionId" && sessionId ? sessionId : value;
  }

  const content = endpoint.operation.requestBody?.content ?? {};
  const contentType = Object.keys(content)[0] ?? null;
  const binaryBody = contentType === "application/octet-stream";
  let body: unknown = null;
  if (contentType) {
    const schema = content[contentType]?.schema;
    body = binaryBody
      ? ""
      : sampleForSchema(document, schema, "body");
    if (endpoint.method === "patch" && isPlainRecord(body)) {
      body = samplePatchBody(document, schema);
    }
    if (sessionId && isPlainRecord(body) && "sessionId" in body) {
      body.sessionId = sessionId;
    }
  }

  return { path, query, body, contentType, binaryBody };
}

function samplePatchBody(
  document: OpenApiDocument,
  schema: OpenApiSchema | undefined,
): Record<string, unknown> {
  if (!schema) return {};
  const resolved = resolveSchema(document, schema);
  const properties = Object.entries(resolved.properties ?? {});
  const preferred = properties.find(([, property]) => (
    Object.prototype.hasOwnProperty.call(property, "example")
  )) ?? properties.find(([, property]) => (
    Object.prototype.hasOwnProperty.call(property, "default")
  )) ?? properties[0];
  if (!preferred) return {};
  const [name, property] = preferred;
  return { [name]: sampleForSchema(document, property, name) };
}

export function applyDefaultSession(
  defaults: ApiExplorerRequestDefaults,
  sessionId: string,
): ApiExplorerRequestDefaults {
  const path = { ...defaults.path };
  const query = { ...defaults.query };
  let body = defaults.body;
  if ("sessionId" in path) path.sessionId = sessionId;
  if ("sessionId" in query) query.sessionId = sessionId;
  if (isPlainRecord(body) && "sessionId" in body) body = { ...body, sessionId };
  return { ...defaults, path, query, body };
}

export function buildApiExplorerRequest(
  baseUrl: string,
  endpoint: ApiExplorerEndpoint,
  pathParameters: Record<string, unknown>,
  queryParameters: Record<string, unknown>,
  body: unknown,
  contentType: string | null,
): ApiExplorerRequestPlan {
  let path = endpoint.path;
  for (const parameter of endpoint.operation.parameters ?? []) {
    if (parameter.in !== "path") continue;
    const value = pathParameters[parameter.name];
    if (parameter.required && isEmptyValue(value)) {
      throw new Error(`缺少路径参数 ${parameter.name}`);
    }
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value ?? "")));
  }

  const url = new URL(path, ensureTrailingSlash(baseUrl));
  for (const parameter of endpoint.operation.parameters ?? []) {
    if (parameter.in !== "query") continue;
    const value = queryParameters[parameter.name];
    if (parameter.required && isEmptyValue(value)) {
      throw new Error(`缺少查询参数 ${parameter.name}`);
    }
    if (!isEmptyValue(value)) url.searchParams.set(parameter.name, String(value));
  }

  return {
    method: endpoint.method.toUpperCase(),
    url: url.toString(),
    contentType,
    body,
    stream: endpoint.path.endsWith("/events"),
  };
}

export function buildCurlCommand(plan: ApiExplorerRequestPlan, apiKey: string): string {
  const parts = [
    `curl.exe${plan.stream ? " -N" : ""} -X ${plan.method} '${escapePowerShellSingleQuoted(plan.url)}'`,
    `  -H 'Authorization: Bearer ${escapePowerShellSingleQuoted(apiKey)}'`,
  ];
  if (plan.stream) parts.push("  -H 'Accept: text/event-stream'");
  if (plan.contentType) parts.push(`  -H 'Content-Type: ${plan.contentType}'`);
  if (plan.body !== null && plan.body !== undefined && plan.method !== "GET") {
    const body = typeof plan.body === "string" ? plan.body : JSON.stringify(plan.body);
    parts.push(`  --data-raw '${escapePowerShellSingleQuoted(body)}'`);
  }
  return parts.join(" `\n");
}

export function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const value = JSON.parse(text) as unknown;
  if (!isPlainRecord(value)) throw new Error(`${label}必须是 JSON 对象`);
  return value;
}

export function parseJsonValue(text: string, label: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function stringifyRequestValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function formatApiResponseForClipboard(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
  } catch {
    return text;
  }
}

export function formatApiResponseForDisplay(text: string): ApiResponseDisplay {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "text", text, tokens: [{ type: "plain", value: text }] };
  try {
    const formatted = JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
    return { kind: "json", text: formatted, tokens: tokenizeJson(formatted) };
  } catch {
    return { kind: "text", text, tokens: [{ type: "plain", value: text }] };
  }
}

export function consumeApiSseChunk(
  buffer: string,
  chunk: string,
  flush = false,
): ApiSseChunkResult {
  let source = buffer + chunk;
  const events: ApiSseEvent[] = [];
  let separator = findSseFrameSeparator(source);
  while (separator) {
    const frame = source.slice(0, separator.index);
    source = source.slice(separator.index + separator.length);
    const event = parseSseFrame(frame);
    if (event) events.push(event);
    separator = findSseFrameSeparator(source);
  }
  if (flush && source.trim()) {
    const event = parseSseFrame(source);
    if (event) events.push(event);
    source = "";
  }
  return { buffer: source, events };
}

function tokenizeJson(text: string): ApiResponseToken[] {
  const tokens: ApiResponseToken[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor];
    if (/\s/.test(char)) {
      let end = cursor + 1;
      while (end < text.length && /\s/.test(text[end])) end += 1;
      pushResponseToken(tokens, "plain", text.slice(cursor, end));
      cursor = end;
      continue;
    }
    if (char === '"') {
      let end = cursor + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      let next = end;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      pushResponseToken(tokens, text[next] === ":" ? "key" : "string", text.slice(cursor, end));
      cursor = end;
      continue;
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      pushResponseToken(tokens, "number", number[0]);
      cursor += number[0].length;
      continue;
    }
    const keyword = text.slice(cursor).match(/^(true|false|null)\b/);
    if (keyword) {
      pushResponseToken(tokens, keyword[0] === "null" ? "null" : "boolean", keyword[0]);
      cursor += keyword[0].length;
      continue;
    }
    if ("{}[],:".includes(char)) {
      pushResponseToken(tokens, "punctuation", char);
      cursor += 1;
      continue;
    }
    pushResponseToken(tokens, "plain", char);
    cursor += 1;
  }
  return tokens;
}

function pushResponseToken(tokens: ApiResponseToken[], type: ApiResponseTokenType, value: string) {
  const previous = tokens[tokens.length - 1];
  if (previous?.type === type) {
    previous.value += value;
  } else {
    tokens.push({ type, value });
  }
}

function findSseFrameSeparator(source: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(source);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseSseFrame(frame: string): ApiSseEvent | null {
  let id: string | undefined;
  let event = "message";
  let retry: number | undefined;
  let hasData = false;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      hasData = true;
      data.push(value);
    } else if (field === "event") {
      event = value || "message";
    } else if (field === "id" && !value.includes("\0")) {
      id = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      retry = Number(value);
    }
  }
  if (!hasData) return null;
  const rawData = data.join("\n");
  let parsedData: unknown = rawData;
  try {
    parsedData = JSON.parse(rawData) as unknown;
  } catch {
    // SSE 允许任意文本；只有合法 JSON 才转换为结构化数据。
  }
  return {
    ...(id === undefined ? {} : { id }),
    event,
    data: parsedData,
    ...(retry === undefined ? {} : { retry }),
  };
}

function sampleForSchema(
  document: OpenApiDocument,
  schema: OpenApiSchema | undefined,
  fieldName: string,
  depth = 0,
): unknown {
  if (!schema || depth > 8) return null;
  const resolved = resolveSchema(document, schema);
  if (Object.prototype.hasOwnProperty.call(resolved, "example")) return resolved.example;
  if (Object.prototype.hasOwnProperty.call(resolved, "default")) return resolved.default;
  if (resolved.enum?.length) return resolved.enum[0];
  if (resolved.anyOf?.length) {
    const candidate = resolved.anyOf.find((item) => item.type !== "null") ?? resolved.anyOf[0];
    return sampleForSchema(document, candidate, fieldName, depth + 1);
  }
  const schemaType = Array.isArray(resolved.type)
    ? resolved.type.find((item) => item !== "null")
    : resolved.type;
  if (schemaType === "object" || resolved.properties) {
    const result: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(resolved.properties ?? {})) {
      result[name] = sampleForSchema(document, property, name, depth + 1);
    }
    return result;
  }
  if (schemaType === "array") return [];
  if (schemaType === "boolean") return false;
  if (schemaType === "number" || schemaType === "integer") {
    if (/timeout/i.test(fieldName)) return 30_000;
    if (/samples/i.test(fieldName)) return 5;
    return 0;
  }
  if (schemaType === "string") {
    if (fieldName === "command") return "uname -a";
    if (fieldName === "path") return "/";
    if (fieldName === "remotePath") return "/tmp/helm-upload.bin";
    if (/sessionId/i.test(fieldName)) return "";
    if (/host/i.test(fieldName)) return "127.0.0.1";
    return "";
  }
  return null;
}

function resolveSchema(document: OpenApiDocument, schema: OpenApiSchema): OpenApiSchema {
  if (!schema.$ref) return schema;
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) return schema;
  const name = schema.$ref.slice(prefix.length);
  return document.components?.schemas?.[name] ?? schema;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.split("'").join("''");
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
