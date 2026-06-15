import { remoteApi } from "../api/remoteApi";
import { getErrorCode, getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import type { MutableRefObject } from "react";
import type { RemoteSession, TransferHistorySnapshot, TransferInfo } from "../types";

type TransferStateApi = {
  transfersRef: MutableRefObject<TransferInfo[]>;
  setPersistedTransfers: (updater: TransferInfo[] | ((current: TransferInfo[]) => TransferInfo[])) => void;
  applyTransferHistorySnapshot: (snapshot: TransferHistorySnapshot) => void;
};

type UseTransferActionsOptions = TransferStateApi & {
  sessionsRef: MutableRefObject<RemoteSession[]>;
  activeSessionId: string;
  appendTerminal: (sessionId: string, kind: "error", content: string) => void;
};

export function useTransferActions({
  sessionsRef,
  transfersRef,
  setPersistedTransfers,
  applyTransferHistorySnapshot,
  activeSessionId,
  appendTerminal,
}: UseTransferActionsOptions) {
  const mountedRef = useMountedRef();

  function upsertTransfer(payload: TransferInfo) {
    if (!mountedRef.current) return;
    setPersistedTransfers((current) => {
      const existing = current.findIndex((transfer) => transfer.transferId === payload.transferId);
      if (existing === -1) return [payload, ...current];
      const next = [...current];
      next[existing] = payload;
      return next;
    });
  }

  function sessionForTransfer(transfer: TransferInfo) {
    return (
      sessionsRef.current.find((session) => session.sftpId === transfer.sftpId) ??
      sessionsRef.current.find((session) => session.id === transfer.sessionId) ??
      null
    );
  }

  async function pauseTransfer(transferId: string) {
    setPersistedTransfers((current) =>
      current.map((transfer) =>
        transfer.transferId === transferId ? { ...transfer, status: "paused", speedKbps: 0 } : transfer,
      ),
    );
    try {
      const transfer = await remoteApi.pauseTransfer(transferId);
      if (mountedRef.current) upsertTransfer(transfer);
    } catch (error) {
      if (mountedRef.current) appendTerminal(activeSessionId, "error", getErrorMessage(error));
    }
  }

  async function resumeTransfer(transferId: string) {
    setPersistedTransfers((current) =>
      current.map((transfer) =>
        transfer.transferId === transferId ? { ...transfer, status: "running" } : transfer,
      ),
    );
    try {
      const transfer = await remoteApi.resumeTransfer(transferId);
      if (mountedRef.current) upsertTransfer(transfer);
    } catch (error) {
      if (mountedRef.current) appendTerminal(activeSessionId, "error", getErrorMessage(error));
    }
  }

  async function cancelTransfer(transferId: string) {
    try {
      await remoteApi.cancelTransfer(transferId);
    } catch (error) {
      if (mountedRef.current) appendTerminal(activeSessionId, "error", getErrorMessage(error));
    }
  }

  async function retryTransfer(transferId: string) {
    const transfer = transfersRef.current.find((item) => item.transferId === transferId);
    if (!transfer) return;
    const targetSession = sessionForTransfer(transfer);
    if (!targetSession?.sftpId || targetSession.state !== "connected") {
      appendTerminal(targetSession?.id ?? activeSessionId, "error", "目标终端未连接，无法重试传输");
      return;
    }
    try {
      const next =
        targetSession.sftpId === transfer.sftpId
          ? await retryExistingTransfer(transfer)
          : await restartTransferOnSession(transfer, targetSession.sftpId);
      if (!mountedRef.current) return;
      setPersistedTransfers((current) => [next, ...current.filter((transfer) => transfer.transferId !== transferId)]);
    } catch (error) {
      if (mountedRef.current) appendTerminal(targetSession.id, "error", getErrorMessage(error));
    }
  }

  async function retryExistingTransfer(transfer: TransferInfo) {
    try {
      return await remoteApi.retryTransfer(transfer.transferId);
    } catch (error) {
      if (!isMissingTransferError(error)) throw error;
      const targetSession = sessionForTransfer(transfer);
      if (!targetSession?.sftpId) throw error;
      return restartTransferOnSession(transfer, targetSession.sftpId);
    }
  }

  function restartTransferOnSession(transfer: TransferInfo, sftpId: string) {
    return transfer.direction === "upload"
      ? remoteApi.upload(sftpId, transfer.localPath, transfer.remotePath, true, true, true)
      : remoteApi.download(sftpId, transfer.remotePath, transfer.localPath, true);
  }

  function isMissingTransferError(error: unknown) {
    return getErrorCode(error) === "notFound" && /传输任务/.test(getErrorMessage(error));
  }

  async function removeTransfer(transferId: string) {
    setPersistedTransfers((current) => current.filter((transfer) => transfer.transferId !== transferId));
    try {
      const snapshot = await remoteApi.removeTransfer(transferId);
      if (mountedRef.current) applyTransferHistorySnapshot(snapshot);
    } catch (error) {
      if (mountedRef.current) console.warn("[helm] failed to remove transfer from runtime:", getErrorMessage(error));
    }
  }

  return {
    upsertTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    retryTransfer,
    removeTransfer,
  };
}
