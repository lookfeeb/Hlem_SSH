import type { ServerTelemetry } from "../types";

export function createEmptyTelemetry(ip: string): ServerTelemetry {
  return {
    ip,
    uptime: "-",
    cpu: 0,
    memory: { used: 0, total: 0 },
    swap: { used: 0, total: 0 },
    processes: [],
    network: {
      interfaceName: "-",
      uploadKbps: 0,
      downloadKbps: 0,
      latencyMs: 0,
      interfaces: [],
    },
    disks: [],
  };
}
