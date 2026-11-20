import type { ApiServerInfo } from "../api/appApi";

export function buildAiApiSessionCommand(
  info: Pick<ApiServerInfo, "port" | "apiKey">,
  session: { id: string; name: string; host: string },
) {
  const hostLabel = [session.name, session.host].filter(Boolean).join(" ");
  return [
    `"http://127.0.0.1:${info.port}/api/fields"`,
    `curl -H "Authorization: Bearer ${info.apiKey}"`,
    "",
    `会话ID: ${session.id}`,
    ...(hostLabel ? [`会话主机: ${hostLabel}`] : []),
  ].join("\n");
}
