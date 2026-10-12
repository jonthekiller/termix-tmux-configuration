import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { applyRuns, profiles, sessionTags } from "./tables.js";
import { registerRoutes } from "./routes.js";
import { validateJsonFields } from "./option-catalog.js";
import { applyToSelection } from "./apply.js";
import { createTmuxSessionsService } from "./tmux-sessions.js";
import { createSessionTagRepository } from "./repository.js";
import { createTmuxMonitorRoutes } from "./monitor-routes.js";
import { tmuxServiceState } from "./service-state.js";

/** Debounce window for the session-open auto-apply, per host. */
const AUTO_APPLY_DEBOUNCE_MS = 30_000;
/** Delay after "online" before applying: the terminal's own tmux detection, */
/** and possibly the session creation, happen first. */
const AUTO_APPLY_DELAY_MS = 4_000;

function provideTmuxSessions(ctx: PluginContext): void {
  // Declared in the manifest, so ctx.services.providers is callable.
  const providers = ctx.services.providers("tmux.sessions");
  if (providers.length > 0) {
    tmuxServiceState.conflictWith = "tmux-monitor";
    ctx.log.warn(
      `tmux.sessions is already provided (${providers.filter(Boolean).join(", ") || "another plugin"}); ` +
        "the terminal keeps its provider. Disable Tmux Monitor to have Tmux Configuration drive session creation.",
    );
    return;
  }
  try {
    ctx.services.provide("tmux.sessions", createTmuxSessionsService(ctx));
    tmuxServiceState.provided = true;
    ctx.log.info(
      "Providing tmux.sessions: session creation follows the plugin's per-host configuration",
    );
  } catch (error) {
    // Activation order is not stable: if tmux-monitor won the race it is
    // already registered by now. Yield rather than fail.
    tmuxServiceState.conflictWith = "tmux-monitor";
    ctx.log.warn(
      `Could not provide tmux.sessions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function activate(ctx: PluginContext) {
  const profilesTable = await ctx.db.define(profiles);
  const applyRunsTable = await ctx.db.define(applyRuns);
  const sessionTagsTable = await ctx.db.define(sessionTags);
  // One router for everything: config routes, then the monitor's parametric
  // /:hostId/* routes under it.
  const router = ctx.http.router<Router>();
  registerRoutes(router, ctx, profilesTable, applyRunsTable);
  const tags = createSessionTagRepository(ctx.db, sessionTagsTable);
  router.use(createTmuxMonitorRoutes(ctx, tags));
  provideTmuxSessions(ctx);

  // Refuse a malformed customOptions/environment object on any save path
  // (settings screen, host editor, host defaults level) instead of silently
  // dropping the unknown keys at read time.
  ctx.settings.onValidate("host", (values) => validateJsonFields(values));

  // Auto-apply: when a terminal session opens on a host with the plugin
  // enabled, wait for its tmux session to exist, then apply the effective
  // configuration. Fire-and-forget: a failing host must never disturb the
  // terminal. Requires events:core, because the topic belongs to core.
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  ctx.events.on("host.session.status", (payload) => {
    const data = payload as { hostId?: number; online?: boolean };
    if (data?.online !== true || typeof data.hostId !== "number") return;
    const hostId = data.hostId;

    const previous = pending.get(hostId);
    if (previous) clearTimeout(previous);

    pending.set(
      hostId,
      setTimeout(() => {
        pending.delete(hostId);
        void (async () => {
          const enabled = await ctx.settings.getHost<boolean>(
            hostId,
            "enableTmuxConfiguration",
          );
          if (enabled !== true) return;
          ctx.log.info(`Auto-applying tmux configuration to host ${hostId}`);
          const results = await applyToSelection(
            ctx,
            { hostIds: [hostId] },
            { force: true },
          );
          if (!results[0]?.ok) {
            ctx.log.warn(
              `Auto-apply to host ${hostId} did not succeed: ${results[0]?.reason ?? "no result"}`,
            );
          }
        })().catch((error: unknown) => {
          ctx.log.warn(
            `Auto-apply to host ${hostId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, AUTO_APPLY_DELAY_MS),
    );
  });
  ctx.disposables.add(() => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  });
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}
