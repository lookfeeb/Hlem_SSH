import { lazy } from "react";

export const BackupModal = lazy(() => import("../components/BackupModal").then((module) => ({ default: module.BackupModal })));
export const SettingsModal = lazy(() => import("../components/SettingsModal").then((module) => ({ default: module.SettingsModal })));
export const TransferCenter = lazy(() => import("../components/TransferCenter").then((module) => ({ default: module.TransferCenter })));
export const TunnelDrawer = lazy(() => import("../components/TunnelDrawer").then((module) => ({ default: module.TunnelDrawer })));
