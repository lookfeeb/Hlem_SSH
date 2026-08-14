import { useRef, useState } from "react";
import { getErrorMessage } from "../lib/configMapping";
import { getBaseName as getRemoteBaseName, getParentPath as getRemoteParentPath } from "../lib/path";
import {
  applyFileSaveResult,
  beginFileSaveRetry,
  clearFinishedFileSaveRecords,
} from "../lib/transferRecords";
import { commitRefState } from "../lib/stateRef";
import type { FileSaveRecord } from "../types";

type UseFileSaveRecordsOptions = {
  writeRemoteTextRaw: (path: string, content: string, sessionId?: string) => Promise<void>;
  onSaveFailed: () => void;
};

export function useFileSaveRecords({ writeRemoteTextRaw, onSaveFailed }: UseFileSaveRecordsOptions) {
  const [fileSaveRecords, setFileSaveRecords] = useState<FileSaveRecord[]>([]);
  const fileSaveRecordsRef = useRef<FileSaveRecord[]>([]);

  function setRecords(action: React.SetStateAction<FileSaveRecord[]>) {
    return commitRefState(fileSaveRecordsRef, setFileSaveRecords, action);
  }

  async function writeRemoteText(path: string, content: string, sessionId?: string) {
    const recordId = crypto.randomUUID();
    upsertFileSaveRecord({
      id: recordId,
      attempt: 1,
      sessionId: sessionId ?? null,
      path,
      directory: getRemoteParentPath(path),
      name: getRemoteBaseName(path),
      content,
      status: "saving",
      error: null,
      savedAt: new Date().toISOString(),
    });
    try {
      await writeRemoteTextRaw(path, content, sessionId);
      applySaveResult(recordId, 1, { status: "success", error: null, savedAt: new Date().toISOString() });
    } catch (error) {
      applySaveResult(recordId, 1, { status: "failed", error: getErrorMessage(error), savedAt: new Date().toISOString() });
      onSaveFailed();
      throw error;
    }
  }

  async function retryFileSaveRecord(recordId: string) {
    const { records, retry } = beginFileSaveRetry(
      fileSaveRecordsRef.current,
      recordId,
      new Date().toISOString(),
    );
    if (!retry) return;
    setRecords(records);
    try {
      await writeRemoteTextRaw(retry.path, retry.content, retry.sessionId ?? undefined);
      applySaveResult(recordId, retry.attempt, { status: "success", error: null, savedAt: new Date().toISOString() });
    } catch (error) {
      applySaveResult(recordId, retry.attempt, { status: "failed", error: getErrorMessage(error), savedAt: new Date().toISOString() });
    }
  }

  function removeFileSaveRecord(recordId: string) {
    setRecords((current) => current.filter((record) => (
      record.id !== recordId || record.status === "saving"
    )));
  }

  function clearFileSaveRecords() {
    setRecords(clearFinishedFileSaveRecords);
  }

  function upsertFileSaveRecord(record: FileSaveRecord) {
    setRecords((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, 30));
  }

  function applySaveResult(recordId: string, attempt: number, patch: Partial<FileSaveRecord>) {
    setRecords((current) => applyFileSaveResult(current, recordId, attempt, patch));
  }

  return {
    fileSaveRecords,
    writeRemoteText,
    retryFileSaveRecord,
    removeFileSaveRecord,
    clearFileSaveRecords,
  };
}
