import { useState } from "react";
import { getErrorMessage } from "../lib/configMapping";
import { getBaseName as getRemoteBaseName, getParentPath as getRemoteParentPath } from "../lib/path";
import type { FileSaveRecord } from "../types";

type UseFileSaveRecordsOptions = {
  writeRemoteTextRaw: (path: string, content: string, sessionId?: string) => Promise<void>;
  onSaveFailed: () => void;
};

export function useFileSaveRecords({ writeRemoteTextRaw, onSaveFailed }: UseFileSaveRecordsOptions) {
  const [fileSaveRecords, setFileSaveRecords] = useState<FileSaveRecord[]>([]);

  async function writeRemoteText(path: string, content: string, sessionId?: string) {
    const recordId = crypto.randomUUID();
    upsertFileSaveRecord({
      id: recordId,
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
      updateFileSaveRecord(recordId, { status: "success", error: null, savedAt: new Date().toISOString() });
    } catch (error) {
      updateFileSaveRecord(recordId, { status: "failed", error: getErrorMessage(error), savedAt: new Date().toISOString() });
      onSaveFailed();
      throw error;
    }
  }

  async function retryFileSaveRecord(recordId: string) {
    const record = fileSaveRecords.find((item) => item.id === recordId);
    if (!record) return;
    updateFileSaveRecord(recordId, { status: "saving", error: null, savedAt: new Date().toISOString() });
    try {
      await writeRemoteTextRaw(record.path, record.content, record.sessionId ?? undefined);
      updateFileSaveRecord(recordId, { status: "success", error: null, savedAt: new Date().toISOString() });
    } catch (error) {
      updateFileSaveRecord(recordId, { status: "failed", error: getErrorMessage(error), savedAt: new Date().toISOString() });
    }
  }

  function removeFileSaveRecord(recordId: string) {
    setFileSaveRecords((current) => current.filter((record) => record.id !== recordId));
  }

  function clearFileSaveRecords() {
    setFileSaveRecords([]);
  }

  function upsertFileSaveRecord(record: FileSaveRecord) {
    setFileSaveRecords((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, 30));
  }

  function updateFileSaveRecord(recordId: string, patch: Partial<FileSaveRecord>) {
    setFileSaveRecords((current) => current.map((record) => (record.id === recordId ? { ...record, ...patch } : record)));
  }

  return {
    fileSaveRecords,
    writeRemoteText,
    retryFileSaveRecord,
    removeFileSaveRecord,
    clearFileSaveRecords,
  };
}
