export type FileLanguageId =
  | "shell"
  | "dockerfile"
  | "makefile"
  | "nginx"
  | "json"
  | "javascript"
  | "typescript"
  | "markup"
  | "css"
  | "python"
  | "sql"
  | "yaml"
  | "configuration"
  | "toml"
  | "ruby"
  | "go"
  | "rust"
  | "lua"
  | "perl"
  | "c"
  | "cpp"
  | "java"
  | "csharp"
  | "kotlin"
  | "scala"
  | "text";

export interface FileLanguageInfo {
  id: FileLanguageId;
  short: string;
  label: string;
}

const LANGUAGE_INFO: Record<FileLanguageId, Omit<FileLanguageInfo, "id">> = {
  shell: { short: "SH", label: "Shell Script" },
  dockerfile: { short: "DK", label: "Dockerfile" },
  makefile: { short: "MK", label: "Makefile" },
  nginx: { short: "NG", label: "Nginx Config" },
  json: { short: "{}", label: "JSON" },
  javascript: { short: "JS", label: "JavaScript" },
  typescript: { short: "TS", label: "TypeScript" },
  markup: { short: "<>", label: "Markup" },
  css: { short: "CSS", label: "Stylesheet" },
  python: { short: "PY", label: "Python" },
  sql: { short: "SQL", label: "SQL" },
  yaml: { short: "YML", label: "YAML" },
  configuration: { short: "CFG", label: "Configuration" },
  toml: { short: "TOML", label: "TOML" },
  ruby: { short: "RB", label: "Ruby" },
  go: { short: "GO", label: "Go" },
  rust: { short: "RS", label: "Rust" },
  lua: { short: "LUA", label: "Lua" },
  perl: { short: "PL", label: "Perl" },
  c: { short: "C", label: "C" },
  cpp: { short: "C++", label: "C++" },
  java: { short: "JAVA", label: "Java" },
  csharp: { short: "C#", label: "C#" },
  kotlin: { short: "KT", label: "Kotlin" },
  scala: { short: "SC", label: "Scala" },
  text: { short: "TXT", label: "Text" },
};

const EXTENSION_LANGUAGES: Record<string, FileLanguageId> = {
  bash: "shell",
  c: "c",
  cc: "cpp",
  cfg: "configuration",
  conf: "configuration",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  env: "configuration",
  fish: "shell",
  go: "go",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  htm: "markup",
  html: "markup",
  hxx: "cpp",
  ini: "configuration",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  ksh: "shell",
  kt: "kotlin",
  kts: "kotlin",
  less: "css",
  lua: "lua",
  mjs: "javascript",
  cjs: "javascript",
  nginx: "nginx",
  perl: "perl",
  pl: "perl",
  pm: "perl",
  properties: "configuration",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "css",
  scala: "scala",
  scss: "css",
  sh: "shell",
  sql: "sql",
  svg: "markup",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  vue: "markup",
  xml: "markup",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const SHELL_FILE_NAMES = new Set([
  ".profile",
  ".bashrc",
  ".bash_profile",
  ".bash_aliases",
  ".bash_logout",
  ".bash_login",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".kshrc",
  ".inputrc",
  ".envrc",
  ".profile.local",
  ".aliases",
  ".functions",
]);

const BACKUP_SUFFIX_PATTERN = /(?:\.|[-_])(?:bak|backup|old|orig|original|save|saved|copy|tmp|swp)(?:[._-].*)?$/i;

function languageInfo(id: FileLanguageId): FileLanguageInfo {
  return { id, ...LANGUAGE_INFO[id] };
}

function pathFileName(path: string) {
  return path.toLowerCase().split(/[\\/]/).pop() ?? "";
}

function sourceFileName(path: string) {
  let fileName = pathFileName(path).replace(/~+$/, "");
  const backupSuffixIndex = fileName.search(BACKUP_SUFFIX_PATTERN);
  if (backupSuffixIndex > 0) fileName = fileName.slice(0, backupSuffixIndex);
  return fileName;
}

function contentLanguage(content: string): FileLanguageId | null {
  const sample = content.replace(/^\uFEFF/, "").slice(0, 16_384);
  const firstLine = sample.split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? "";

  if (/^#!.*\b(?:ba|da|z|k)?sh\b/.test(firstLine) || /^#!.*\bfish\b/.test(firstLine)) return "shell";
  if (/^#!.*\bpython(?:\d+(?:\.\d+)*)?\b/.test(firstLine)) return "python";
  if (/^#!.*\b(?:node|deno)\b/.test(firstLine)) return "javascript";
  if (/^#!.*\bruby\b/.test(firstLine)) return "ruby";
  if (/^#!.*\bperl\b/.test(firstLine)) return "perl";
  if (/^\s*#cloud-config\b/i.test(sample)) return "yaml";
  if (/^\s*(?:<\?xml\b|<!doctype\s+html\b|<html\b)/i.test(sample)) return "markup";

  const trimmed = sample.trim();
  if (content.length <= 1_000_000 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
    try {
      JSON.parse(content.replace(/^\uFEFF/, ""));
      return "json";
    } catch {
      // 编辑中的 JSON 可能暂时不完整，无法据此确定类型。
    }
  }
  return null;
}

export function detectFileLanguage(path: string, content = ""): FileLanguageInfo {
  const fileName = sourceFileName(path);
  const extension = fileName.includes(".") ? fileName.split(".").pop() ?? "" : "";

  if (SHELL_FILE_NAMES.has(fileName)) return languageInfo("shell");
  if (fileName === "dockerfile" || fileName.startsWith("dockerfile.") || fileName.endsWith(".dockerfile")) {
    return languageInfo("dockerfile");
  }
  if (fileName === "makefile" || fileName === "gnumakefile") return languageInfo("makefile");
  if (fileName === "nginx.conf" || fileName.endsWith(".nginx")) return languageInfo("nginx");

  const extensionLanguage = EXTENSION_LANGUAGES[extension];
  if (extensionLanguage) return languageInfo(extensionLanguage);

  return languageInfo(contentLanguage(content) ?? "text");
}
