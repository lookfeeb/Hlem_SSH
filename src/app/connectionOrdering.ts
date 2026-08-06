interface ConnectionCountRecord {
  connectionCount?: number | null;
}

interface CreatedAtRecord {
  createdAt?: string | null;
}

export function sortConnectionsByCount<T extends ConnectionCountRecord>(connections: readonly T[]): T[] {
  return connections
    .map((connection, index) => ({ connection, index }))
    .sort((left, right) => {
      const countDifference = normalizedConnectionCount(right.connection.connectionCount)
        - normalizedConnectionCount(left.connection.connectionCount);
      return countDifference || left.index - right.index;
    })
    .map(({ connection }) => connection);
}

export function sortConnectionsByCreatedAt<T extends CreatedAtRecord>(connections: readonly T[]): T[] {
  return connections
    .map((connection, index) => ({
      connection,
      index,
      createdAt: parsedCreatedAt(connection.createdAt),
    }))
    .sort((left, right) => {
      const timeDifference = left.createdAt - right.createdAt;
      return timeDifference || left.index - right.index;
    })
    .map(({ connection }) => connection);
}

function normalizedConnectionCount(value?: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

function parsedCreatedAt(value?: string | null) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}
