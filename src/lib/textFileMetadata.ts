// 远端读取接口会拒绝非 UTF-8 字节；前端这里只需区分是否带 UTF-8 BOM。
export function detectTextEncoding(content: string) {
  return content.charCodeAt(0) === 0xfeff ? "UTF-8 BOM" : "UTF-8";
}

export function detectLineEnding(content: string) {
  if (content.includes("\r\n")) return "CRLF";
  if (content.includes("\n")) return "LF";
  if (content.includes("\r")) return "CR";
  return "无";
}
