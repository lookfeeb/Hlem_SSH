import { lazy, useRef } from "react";

// Keep a panel mounted after its first use so close/reopen preserves local state.
export function useOpenedPanel(open: boolean) {
  const opened = useRef(false);
  opened.current ||= open;
  return opened.current;
}

export const SessionConfigModal = lazy(() => import("../components/SessionConfigModal").then((module) => ({ default: module.SessionConfigModal })));

export const BackupModal = lazy(() => import("../components/BackupModal").then((module) => ({ default: module.BackupModal })));
export const SettingsModal = lazy(() => import("../components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
export const TransferCenter = lazy(() => import("../components/TransferCenter").then((module) => ({ default: module.TransferCenter })));
export const TunnelDrawer = lazy(() => import("../components/TunnelDrawer").then((module) => ({ default: module.TunnelDrawer })));
export const SessionWorkspace = lazy(() => import("../components/SessionWorkspace").then((module) => ({ default: module.SessionWorkspace })));
export const MigrationGate = lazy(() => import("../components/MigrationGate").then((module) => ({ default: module.MigrationGate })));
