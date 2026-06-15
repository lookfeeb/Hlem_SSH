export async function writeClipboardText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.debug("[helm] navigator clipboard write failed, using fallback:", error);
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch (error) {
    console.debug("[helm] document.execCommand clipboard fallback failed:", error);
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function readClipboardText(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch (error) {
    console.debug("[helm] navigator clipboard read failed:", error);
  }
  return "";
}
