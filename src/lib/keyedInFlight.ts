export type KeyedInFlightCache<Key, Value> = {
  run(key: Key, load: () => Promise<Value>): Promise<Value>;
  invalidate(key: Key): void;
  clear(): void;
};

export type LatestRequestTracker<Key> = {
  begin(key: Key): number;
  invalidate(key: Key): void;
  isCurrent(key: Key, version: number): boolean;
  complete(key: Key, version: number): boolean;
  clear(): void;
};

export function createKeyedInFlightCache<Key, Value>(): KeyedInFlightCache<Key, Value> {
  const requests = new Map<Key, Promise<Value>>();

  return {
    run(key, load) {
      const existing = requests.get(key);
      if (existing) return existing;

      let request: Promise<Value>;
      request = Promise.resolve().then(load).finally(() => {
        if (requests.get(key) === request) requests.delete(key);
      });
      requests.set(key, request);
      return request;
    },
    invalidate(key) {
      requests.delete(key);
    },
    clear() {
      requests.clear();
    },
  };
}

export function createLatestRequestTracker<Key>(): LatestRequestTracker<Key> {
  const currentVersions = new Map<Key, number>();
  let nextVersion = 0;

  return {
    begin(key) {
      nextVersion += 1;
      currentVersions.set(key, nextVersion);
      return nextVersion;
    },
    invalidate(key) {
      currentVersions.delete(key);
    },
    isCurrent(key, version) {
      return currentVersions.get(key) === version;
    },
    complete(key, version) {
      if (currentVersions.get(key) !== version) return false;
      currentVersions.delete(key);
      return true;
    },
    clear() {
      currentVersions.clear();
    },
  };
}
