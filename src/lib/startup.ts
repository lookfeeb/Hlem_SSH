import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../api/runtime";
import { recordPerformance } from "./performanceMetrics";

type StartupPhase = "shell-committed" | "app-committed" | "listeners-ready" | "workspace-ready";
const phases = new Set<StartupPhase>();
let readyRequest: Promise<void> | undefined;

export function recordStartupPhase(phase: StartupPhase) {
  if (phases.has(phase)) return;
  phases.add(phase);
  // Absolute time from this document's navigation, separate from IPC duration.
  recordPerformance(`startup:${phase}`, 0);
  if (isTauriRuntime()) {
    void invoke("startup_phase", { phase, navigationMs: performance.now() })
      .catch((error) => console.warn("[helm] failed to record startup phase:", error));
  }
}

export function showMainWindow() {
  if (!isTauriRuntime()) return Promise.resolve();
  if (!readyRequest) {
    const started = performance.now();
    readyRequest = invoke<void>("frontend_ready", { navigationMs: started })
      .then(() => recordPerformance("ipc:frontend_ready", started))
      .catch((error) => {
        readyRequest = undefined;
        recordPerformance("ipc:frontend_ready", started, false);
        throw error;
      });
  }
  return readyRequest;
}
