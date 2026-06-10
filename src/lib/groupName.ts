export const GROUP_NAME_MAX_HAN_CHARS = 8;
export const GROUP_NAME_MAX_CHARS = 10;
export const GROUP_CUSTOM_MAX_COUNT = 10;
export const GROUP_NAME_LENGTH_ERROR = `分组名称不能超过 ${GROUP_NAME_MAX_HAN_CHARS} 个汉字或 ${GROUP_NAME_MAX_CHARS} 个字符`;
export const GROUP_COUNT_ERROR = `自定义分组最多 ${GROUP_CUSTOM_MAX_COUNT} 个`;

export function getGroupNameLengthError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const chars = Array.from(trimmed);
  const hanCount = chars.filter(isHanCharacter).length;
  if (hanCount > GROUP_NAME_MAX_HAN_CHARS || chars.length > GROUP_NAME_MAX_CHARS) {
    return GROUP_NAME_LENGTH_ERROR;
  }
  return null;
}

function isHanCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2ebef) ||
    (codePoint >= 0x30000 && codePoint <= 0x3134f)
  );
}
