import { remoteApi } from "../api/remoteApi";
import { getErrorCode, getErrorMessage } from "../lib/configMapping";
import { useMountedRef } from "../lib/reactLifecycle";
import { mergeTransferInfo, replaceRetriedTransfer } from "../lib/transferRecords";
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
      const merged = mergeTransferInfo(next[existing], payload);
      if (merged === next[existing]) return current;
      next[existing] = merged;
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
    const previous = transfersRef.current.find((transfer) => transfer.transferId === transferId);
    if (!previous) return;
    setPersistedTransfers((current) =>
      current.map((transfer) =>
        transfer.transferId === transferId ? { ...transfer, status: "paused", speedKbps: 0 } : transfer,
      ),
    );
    try {
      const transfer = await remoteApi.pauseTransfer(transferId);
      if (mountedRef.current) upsertTransfer(transfer);
    } catch (error) {
      if (!mountedRef.current) return;
      setPersistedTransfers((current) =>
        current.map((transfer) =>
          transfer.transferId === transferId && transfer.status === "paused" ? previous : transfer,
        ),
      );
      appendTransferError(previous, error);
    }
  }

  async function resumeTransfer(transferId: string) {
    const previous = transfersRef.current.find((transfer) => transfer.transferId === transferId);
    if (!previous) return;
    setPersistedTransfers((current) =>
      current.map((transfer) =>
        transfer.transferId === transferId ? { ...transfer, status: "running" } : transfer,
      ),
    );
    try {
      const transfer = await remoteApi.resumeTransfer(transferId);
      if (mountedRef.current) upsertTransfer(transfer);
    } catch (error) {
      if (!mountedRef.current) return;
      setPersistedTransfers((current) =>
        current.map((transfer) =>
          transfer.transferId === transferId && transfer.status === "running" ? previous : transfer,
        ),
      );
      appendTransferError(previous, error);
    }
  }

  async function cancelTransfer(transferId: string) {
    const transfer = transfersRef.current.find((item) => item.transferId === transferId);
    try {
      await remoteApi.cancelTransfer(transferId);
    } catch (error) {
      if (mountedRef.current) appendTransferError(transfer, error);
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
      setPersistedTransfers((current) => replaceRetriedTransfer(current, transferId, next));
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
      : remoteApi.download(sftpId, transfer.remotePath, transfer.localPath, true, true);
  }

  function isMissingTransferError(error: unknown) {
    return getErrorCode(error) === "notFound" && /传输任务/.test(getErrorMessage(error));
  }

  async function removeTransfer(transferId: string) {
    const previous = transfersRef.current.find((transfer) => transfer.transferId === transferId);
    if (!previous) return;
    setPersistedTransfers((current) => current.filter((transfer) => transfer.transferId !== transferId));
    try {
      const snapshot = await remoteApi.removeTransfer(transferId);
      if (mountedRef.current) applyTransferHistorySnapshot(snapshot);
    } catch (error) {
      if (!mountedRef.current) return;
      setPersistedTransfers((current) =>
        current.some((transfer) => transfer.transferId === transferId) ? current : [previous, ...current],
      );
      appendTransferError(previous, error);
    }
  }

  function appendTransferError(transfer: TransferInfo | undefined, error: unknown) {
    const sessionId = transfer ? sessionForTransfer(transfer)?.id : null;
    appendTerminal(sessionId ?? activeSessionId, "error", getErrorMessage(error));
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
