import { normalizePath } from "./path";

export type SftpDirectoryInvalidation = {
  sftpId: string;
  directories: string[];
};

type Listener = (event: SftpDirectoryInvalidation) => void;

const listeners = new Set<Listener>();

export function emitSftpDirectoryInvalidation(sftpId: string, directories: Iterable<string>) {
  const normalizedDirectories = Array.from(new Set(Array.from(directories, normalizePath)));
  if (!sftpId || normalizedDirectories.length === 0) return;
  const event = { sftpId, directories: normalizedDirectories };
  for (const listener of [...listeners]) listener(event);
}

export function onSftpDirectoryInvalidation(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
