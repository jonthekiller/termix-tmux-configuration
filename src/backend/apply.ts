/**
 * Applying a configuration to one or many hosts.
 *
 * Hosts resolve through ctx (the acting user's, or the host's owner for
 * background work) and every SSH connection borrows core's pooled connect
 * pipeline, so credentials, jump hosts and host keys all behave like the
 * rest of Termix. Per-host failures are collected, never thrown across the
 * fan-out.
 */

import type { Client } from "ssh2";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  effectiveConfig,
  HOST_KEYS,
  type TmuxEffectiveConfig,
} from "./option-catalog.js";
import {
  buildConfigFile,
  globalArgs as buildGlobalArgs,
  perSessionArgs,
  pushFileCommand,
  CONFIG_FILE_PATH,
} from "./config-builder.js";
import { applyOnHost } from "./tmux-exec.js";

export type HostSelector =
  { hostIds: number[] } | { tag: string } | { folder: string } | { all: true };

export interface ApplyResult {
  hostId: number;
  hostName: string;
  ok: boolean;
  /** "applied" | "tmux-missing" | "disabled" | an error message. */
  reason: string;
  sessionsTouched: number;
}

/** The host's effective configuration, from its resolved settings. */
export async function readHostConfig(
  ctx: PluginContext,
  hostId: number,
): Promise<TmuxEffectiveConfig> {
  const stored: Record<string, unknown> = {};
  for (const key of HOST_KEYS) {
    stored[key] = await ctx.settings.getHost(hostId, key);
  }
  return effectiveConfig(stored);
}

/** One host: connect, push the file, apply to live sessions. Never throws. */
async function applyToHost(
  ctx: PluginContext,
  hostId: number,
  hostName: string,
  config: TmuxEffectiveConfig,
): Promise<ApplyResult> {
  const file = buildConfigFile(config);
  const fileCommand = pushFileCommand(file);
  const global = buildGlobalArgs(config);
  const perSession = (sessionName: string) =>
    perSessionArgs(config, sessionName);

  try {
    return await ctx.ssh.withConnection<ApplyResult, Client>(
      hostId,
      { pool: "tmux-configuration", purpose: "tmux-config" },
      async (client) => {
        const { sessionsTouched } = await applyOnHost(
          client,
          config,
          file,
          fileCommand,
          global,
          perSession,
        );
        return {
          hostId,
          hostName,
          ok: true,
          reason: "applied",
          sessionsTouched,
        };
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A missing tmux binary exits the `/bin/sh -c` with a non-zero code and
    // empty stdout, surfacing here as a failed exec rather than a clean
    // detection result; recognise the common shapes.
    const missing =
      /not found|command not found|exit(ed)? with code 127/i.test(message) ||
      /tmux.*not found/i.test(message);
    return {
      hostId,
      hostName,
      ok: false,
      reason: missing ? "tmux-missing" : message,
      sessionsTouched: 0,
    };
  }
}

export async function resolveHostIds(
  ctx: PluginContext,
  selector: HostSelector,
): Promise<Array<{ id: number; name: string; enabled: boolean | null }>> {
  const hosts = await ctx.hosts.list();
  if ("hostIds" in selector) {
    const wanted = new Set(selector.hostIds.map(Number));
    return hosts
      .filter((host) => wanted.has(Number(host.id)))
      .map((host) => ({
        id: Number(host.id),
        name: host.name ?? host.ip,
        enabled: null,
      }));
  }

  const matches =
    "tag" in selector
      ? (host: { tags: string | null }) =>
          (host.tags ?? "")
            .split(",")
            .map((tag) => tag.trim())
            .includes(selector.tag)
      : "folder" in selector
        ? (host: { folder: string | null }) => host.folder === selector.folder
        : () => true;

  return hosts.filter(matches).map((host) => ({
    id: Number(host.id),
    name: host.name ?? host.ip,
    enabled: true,
  }));
}

/**
 * Applies the per-host effective configuration to every selected host, at a
 * bounded parallelism, skipping hosts the plugin is disabled on (unless the
 * selector is an explicit host list, which acts like the host editor's own
 * save-then-apply).
 */
export async function applyToSelection(
  ctx: PluginContext,
  selector: HostSelector,
  options?: {
    force?: boolean;
    parallelism?: number;
    configOverride?: Record<string, unknown>;
  },
): Promise<ApplyResult[]> {
  const targets = await resolveHostIds(ctx, selector);
  const selected = targets.filter((target) => target.enabled !== false);
  const parallelism = Math.max(1, Math.min(20, options?.parallelism ?? 5));

  const results: ApplyResult[] = [];
  let index = 0;
  const worker = async () => {
    while (index < selected.length) {
      const current = selected[index++];
      const hostId = current.id;

      let config: TmuxEffectiveConfig;
      if (options?.configOverride) {
        config = effectiveConfig(options.configOverride);
      } else {
        config = await readHostConfig(ctx, hostId);
      }

      if (!options?.force) {
        const enabled = await ctx.settings.getHost<boolean>(
          hostId,
          "enableTmuxConfiguration",
        );
        if (enabled !== true) {
          results.push({
            hostId,
            hostName: current.name,
            ok: false,
            reason: "disabled",
            sessionsTouched: 0,
          });
          continue;
        }
      }

      results.push(await applyToHost(ctx, hostId, current.name, config));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallelism, selected.length) }, worker),
  );
  return results;
}

/** The generated file for one host, for the preview route. */
export async function previewHost(
  ctx: PluginContext,
  hostId: number,
): Promise<{
  config: TmuxEffectiveConfig;
  file: string;
  fileCommand: string;
  globalCommand: string;
  sessions: string[];
} | null> {
  const config = await readHostConfig(ctx, hostId);
  const file = buildConfigFile(config);
  let sessions: string[] = [];
  try {
    sessions = await ctx.ssh.withConnection<string[], Client>(
      hostId,
      { pool: "tmux-configuration", purpose: "tmux-config" },
      async (client) => {
        const { detectTmux } = await import("./tmux-exec.js");
        const detection = await detectTmux(client);
        return detection.available
          ? detection.sessions.map((session) => session.name)
          : [];
      },
    );
  } catch {
    return null;
  }
  return {
    config,
    file,
    fileCommand: pushFileCommand(file),
    globalCommand: buildGlobalArgs(config),
    sessions,
  };
}

export { CONFIG_FILE_PATH };
