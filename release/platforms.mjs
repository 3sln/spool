export const cliPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];

export function cliArchiveName(version, platform) {
  return `spool-mcp-${version}-${platform}.${platform.startsWith("win32-") ? "zip" : "tar.gz"}`;
}
