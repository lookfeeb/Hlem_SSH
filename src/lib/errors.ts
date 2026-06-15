export function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "";
  try {
    return JSON.stringify(error);
  } catch (jsonError) {
    console.debug("[helm] failed to stringify unknown error:", jsonError);
    return "";
  }
}
