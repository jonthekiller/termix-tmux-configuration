import type { PluginHostRecord } from "@termix-ssh/plugin-sdk/frontend";

/** Whether the monitor is enabled for this host, as the host payload's
 * pluginSettings carries it. The exported name keeps the monitor's own
 * call sites unchanged. */
export function tmuxMonitorEnabled(
  host: PluginHostRecord | null | undefined,
): boolean {
  const settings = (
    host?.pluginSettings as Record<string, Record<string, unknown>> | undefined
  )?.["tmux-configuration"];
  return settings?.enableTmuxConfiguration === true;
}
