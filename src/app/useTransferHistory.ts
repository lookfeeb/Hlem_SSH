import { useRef, useState } from "react";
import { remoteApi } from "../api/remoteApi";
import type { TransferHistorySnapshot, TransferInfo } from "../types";

const TRANSFER_HISTORY_LIMIT = 100;

export function useTransferHistory() {
  const [transfers, setTransfersState] = useState<TransferInfo[]>([]);
  const transfersRef = useRef(transfers);

  function setTransfers(nextTransfers: TransferInfo[]) {
    const next = limitTransferHistory(nextTransfers);
    transfersRef.current = next;
    setTransfersState(next);
  }

  function applyTransferHistorySnapshot(snapshot: TransferHistorySnapshot) {
    setTransfers(snapshot.transfers);
  }

  async function refreshTransferHistory() {
    applyTransferHistorySnapshot(await remoteApi.transferHistorySnapshot());
  }

  function setPersistedTransfers(updater: TransferInfo[] | ((current: TransferInfo[]) => TransferInfo[])) {
    setTransfers(typeof updater === "function" ? updater(transfersRef.current) : updater);
  }

  function resetTransferHistory(nextTransfers: TransferInfo[] = []) {
    setTransfers(nextTransfers);
  }

  async function clearFinishedTransferHistory() {
    applyTransferHistorySnapshot(await remoteApi.clearFinishedTransferHistory());
  }

  return {
    transfers,
    transfersRef,
    setPersistedTransfers,
    resetTransferHistory,
    refreshTransferHistory,
    applyTransferHistorySnapshot,
    clearFinishedTransferHistory,
  };
}

function limitTransferHistory(transfers: TransferInfo[]) {
  return [...transfers]
    .sort((left, right) => Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt))
    .slice(0, TRANSFER_HISTORY_LIMIT);
}
