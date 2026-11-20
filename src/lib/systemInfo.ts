import type { RemoteSystemInfo } from "../types";

// Query once per connection; these values do not need telemetry polling.
export const SYSTEM_INFO_COMMAND = String.raw`sh -c '
export LC_ALL=C;
os_name=$(
  unset PRETTY_NAME NAME VERSION VERSION_ID;
  if [ -r /etc/os-release ]; then
    . /etc/os-release;
  elif [ -r /usr/lib/os-release ]; then
    . /usr/lib/os-release;
  fi;
  if [ -n "$PRETTY_NAME" ]; then
    printf "%s" "$PRETTY_NAME";
  elif [ -n "$NAME" ]; then
    printf "%s" "$NAME";
    version="$VERSION";
    [ -n "$version" ] || version="$VERSION_ID";
    [ -z "$version" ] || printf " %s" "$version";
  fi;
);
if [ -z "$os_name" ] && command -v sw_vers >/dev/null 2>&1; then
  product=$(sw_vers -productName 2>/dev/null);
  version=$(sw_vers -productVersion 2>/dev/null);
  [ -z "$product" ] || os_name="$product $version";
fi;
[ -n "$os_name" ] || os_name=$(uname -s 2>/dev/null);
kernel=$(uname -sr 2>/dev/null);
printf "__HELM_OS__ %s\n__HELM_KERNEL__ %s\n" "$os_name" "$kernel";
'`;

export function parseSystemInfo(output: string): RemoteSystemInfo | null {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(__HELM_OS__|__HELM_KERNEL__)\s+(.*)$/);
    if (match && match[2].trim()) values.set(match[1], match[2].trim());
  }
  const operatingSystem = values.get("__HELM_OS__") ?? "";
  const kernel = values.get("__HELM_KERNEL__") ?? "";
  return operatingSystem || kernel ? { operatingSystem, kernel } : null;
}
