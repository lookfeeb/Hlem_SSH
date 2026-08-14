import { useRef, useState } from "react";
import { remoteApi } from "../api/remoteApi";
import { useMountedRef } from "../lib/reactLifecycle";
import { loadStableSnapshot } from "../lib/stableSnapshot";
import { mergeClearedTransferSnapshot } from "../lib/transferRecords";
import type { TransferHistorySnapshot, TransferInfo } from "../types";

const TRANSFER_HISTORY_LIMIT = 100;

export function useTransferHistory() {
  const [transfers, setTransfersState] = useState<TransferInfo[]>([]);
  const transfersRef = useRef(transfers);
  const mountedRef = useMountedRef();
  const eventVersionRef = useRef(0);
  const stateEpochRef = useRef(0);
  const refreshRequestRef = useRef(0);

  function setTransfers(nextTransfers: TransferInfo[]) {
    const next = limitTransferHistory(nextTransfers);
    transfersRef.current = next;
    if (!mountedRef.current) return;
    setTransfersState(next);
  }

  function applyTransferHistorySnapshot(snapshot: TransferHistorySnapshot) {
    setTransfers(snapshot.transfers);
  }

  async function refreshTransferHistory() {
    const requestId = ++refreshRequestRef.current;
    const epoch = stateEpochRef.current;
    const snapshot = await loadStableSnapshot(
      remoteApi.transferHistorySnapshot,
      () => eventVersionRef.current,
      () => (
        mountedRef.current &&
        requestId === refreshRequestRef.current &&
        epoch === stateEpochRef.current
      ),
    );
    if (snapshot) applyTransferHistorySnapshot(snapshot);
  }

  function setPersistedTransfers(updater: TransferInfo[] | ((current: TransferInfo[]) => TransferInfo[])) {
    eventVersionRef.current += 1;
    setTransfers(typeof updater === "function" ? updater(transfersRef.current) : updater);
  }

  function resetTransferHistory(nextTransfers: TransferInfo[] = []) {
    stateEpochRef.current += 1;
    eventVersionRef.current += 1;
    refreshRequestRef.current += 1;
    setTransfers(nextTransfers);
  }

  async function clearFinishedTransferHistory() {
    const eventVersion = eventVersionRef.current;
    const snapshot = await remoteApi.clearFinishedTransferHistory();
    if (!mountedRef.current) return;
    if (eventVersion === eventVersionRef.current) {
      applyTransferHistorySnapshot(snapshot);
      return;
    }
    // 清理期间可能有新任务或完成事件，旧响应只负责删除后端已清掉的历史项。
    setTransfers(mergeClearedTransferSnapshot(transfersRef.current, snapshot.transfers));
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
