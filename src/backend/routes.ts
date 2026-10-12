/**
 * HTTP surface under /plugin-api/tmux-configuration/.
 *
 * Everything reads or writes through ctx (settings, hosts, ssh, db), so the
 * routes are thin: resolve targets, call apply.ts, shape the answer.
 */

import type { Request, Response, Router } from "express";
import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  DEFAULT_CONFIG,
  effectiveConfig,
  HOST_KEYS,
} from "./option-catalog.js";
import { globalArgs, perSessionArgs } from "./config-builder.js";
import {
  applyToSelection,
  previewHost,
  type ApplyResult,
  type HostSelector,
} from "./apply.js";
import { tmuxServiceState } from "./service-state.js";

type AnyTable = any;

function selectorFrom(body: Record<string, unknown>): HostSelector | null {
  if (Array.isArray(body.hostIds) && body.hostIds.length > 0) {
    return { hostIds: body.hostIds.map(Number) };
  }
  if (typeof body.tag === "string" && body.tag) return { tag: body.tag };
  if (typeof body.folder === "string" && body.folder)
    return { folder: body.folder };
  if (body.all === true) return { all: true };
  return null;
}

/** The per-session chain as a human-readable `tmux -u ...` command. */
function displayTmux(args: string): string {
  return `tmux -u ${args.replace(/ \\; /g, " ; ")}`;
}

export function registerRoutes(
  router: Router,
  ctx: PluginContext,
  profilesTable: AnyTable,
  applyRunsTable: AnyTable,
): void {
  router.use(ctx.rbac.require("use") as never);

  const client = () => ctx.db.client<BetterSQLite3Database>();
  const actor = () => ctx.currentActor() as string;

  /**
   * @openapi
   * /plugin-api/tmux-configuration/hosts:
   *   get:
   *     summary: Every visible host with its effective tmux configuration
   *     tags: [Tmux Configuration]
   *     responses:
   *       200:
   *         description: Hosts with their resolved settings and enable flag
   */
  router.get("/hosts", async (_req: Request, res: Response) => {
    const hosts = await ctx.hosts.list();
    const enriched = await Promise.all(
      hosts.map(async (host) => {
        const stored: Record<string, unknown> = {};
        for (const key of HOST_KEYS) {
          stored[key] = await ctx.settings.getHost(host.id, key);
        }
        const enabled = await ctx.settings.getHost<boolean>(
          host.id,
          "enableTmuxConfiguration",
        );
        return {
          id: Number(host.id),
          name: host.name,
          ip: host.ip,
          folder: host.folder,
          tags: host.tags,
          enabled: enabled === true,
          config: effectiveConfig(stored),
        };
      }),
    );
    res.json({ hosts: enriched });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/host/{id}/options:
   *   put:
   *     summary: Write (or hand back to the defaults) one host's options
   *     tags: [Tmux Configuration]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: number }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               values: { type: object }
   *               inheritKeys: { type: array, items: { type: string } }
   *     responses:
   *       200:
   *         description: Saved
   *       400:
   *         description: Nothing to save
   */
  router.put("/host/:id/options", async (req: Request, res: Response) => {
    const hostId = Number(req.params.id);
    if (!Number.isFinite(hostId)) {
      return res.status(400).json({ error: "Invalid host id" });
    }
    const values = (req.body?.values ?? {}) as Record<string, unknown>;
    const inheritKeys = Array.isArray(req.body?.inheritKeys)
      ? (req.body.inheritKeys as string[])
      : [];
    if (inheritKeys.length === 0 && Object.keys(values).length === 0) {
      return res.status(400).json({ error: "Nothing to save" });
    }
    try {
      for (const [key, value] of Object.entries(values)) {
        await ctx.settings.setHost(hostId, key, value);
      }
      for (const key of inheritKeys) {
        await ctx.settings.setHost(hostId, key, null, { inherit: true });
      }
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/preview/{id}:
   *   get:
   *     summary: What an apply would push and run on one host, without running it
   *     tags: [Tmux Configuration]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: number }
   *     responses:
   *       200:
   *         description: The generated file and commands
   */
  router.get("/preview/:id", async (req: Request, res: Response) => {
    const hostId = Number(req.params.id);
    if (!Number.isFinite(hostId)) {
      return res.status(400).json({ error: "Invalid host id" });
    }
    const preview = await previewHost(ctx, hostId);
    if (!preview) {
      return res.status(502).json({ error: "Could not reach the host" });
    }
    res.json({
      config: preview.config,
      file: preview.file,
      fileCommand: preview.fileCommand,
      globalCommand: displayTmux(globalArgs(preview.config)),
      perSessionCommands: preview.sessions.map((sessionName) => ({
        sessionName,
        command: displayTmux(perSessionArgs(preview.config, sessionName)),
      })),
    });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/apply:
   *   post:
   *     summary: Apply the effective configuration to a selection of hosts
   *     tags: [Tmux Configuration]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               hostIds: { type: array, items: { type: number } }
   *               tag: { type: string }
   *               folder: { type: string }
   *               all: { type: boolean }
   *               force: { type: boolean }
   *     responses:
   *       200:
   *         description: One result per host
   *       400:
   *         description: No usable selector
   */
  router.post("/apply", async (req: Request, res: Response) => {
    const selector = selectorFrom(req.body ?? {});
    if (!selector) {
      return res
        .status(400)
        .json({ error: "Pass hostIds, tag, folder or all" });
    }
    const parallelism =
      typeof req.body?.parallelism === "number"
        ? req.body.parallelism
        : undefined;

    // An optional profile rides along as a config override for this run:
    // the per-host hierarchy stays untouched on disk, the profile's values
    // are what reaches the hosts. Only the owner's profile resolves.
    let configOverride: Record<string, unknown> | undefined;
    const profileId = Number(req.body?.profileId);
    if (Number.isFinite(profileId)) {
      const db = await client();
      const rows = await db
        .select()
        .from(profilesTable)
        .where(eq(profilesTable.id, profileId));
      const profile = rows[0];
      if (!profile || profile.userId !== actor()) {
        return res.status(404).json({ error: "Profile not found" });
      }
      try {
        configOverride = JSON.parse(profile.options);
      } catch {
        return res
          .status(400)
          .json({ error: "Profile options are not valid JSON" });
      }
    }

    const results = await applyToSelection(ctx, selector, {
      force: req.body?.force === true,
      parallelism,
      configOverride,
    });

    // History is best-effort: an apply must not fail because the row did not.
    try {
      const db = await client();
      await db.insert(applyRunsTable).values(
        results.map((result: ApplyResult) => ({
          userId: actor(),
          hostId: result.hostId,
          hostName: result.hostName,
          ok: result.ok,
          reason: result.reason,
          sessionsTouched: result.sessionsTouched,
        })),
      );
    } catch (error) {
      ctx.log.warn(
        `Could not record the apply run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    res.json({ results });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/profiles:
   *   get:
   *     summary: The signed-in user's saved profiles
   *     tags: [Tmux Configuration]
   *     responses:
   *       200:
   *         description: Profiles, newest first
   */
  router.get("/profiles", async (_req: Request, res: Response) => {
    const db = await client();
    const rows = await db
      .select()
      .from(profilesTable)
      .where(eq(profilesTable.userId, actor()))
      .orderBy(desc(profilesTable.id));
    res.json({ profiles: rows });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/profiles:
   *   post:
   *     summary: Save a named preset of options
   *     tags: [Tmux Configuration]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               name: { type: string }
   *               options: { type: object }
   *     responses:
   *       201:
   *         description: Profile saved
   */
  router.post("/profiles", async (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const options = req.body?.options;
    if (!name || name.length > 100) {
      return res
        .status(400)
        .json({ error: "A name of 100 characters or fewer is required" });
    }
    if (typeof options !== "object" || options === null) {
      return res.status(400).json({ error: "options must be an object" });
    }
    // Normalized through the same path a host read takes, so a profile can
    // only ever contain the keys and shapes the catalog knows.
    const normalized = effectiveConfig(options as Record<string, unknown>);
    const db = await client();
    await db.insert(profilesTable).values({
      userId: actor(),
      name,
      options: JSON.stringify(normalized),
    });
    res.status(201).json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/profiles/{id}:
   *   delete:
   *     summary: Delete one of the user's profiles
   *     tags: [Tmux Configuration]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: number }
   *     responses:
   *       200:
   *         description: Deleted
   */
  router.delete("/profiles/:id", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "Invalid profile id" });
    }
    const db = await client();
    await db.delete(profilesTable).where(eq(profilesTable.id, id));
    res.json({ success: true });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/history:
   *   get:
   *     summary: Recent apply runs, newest first
   *     tags: [Tmux Configuration]
   *     responses:
   *       200:
   *         description: Apply runs
   */
  router.get("/history", async (_req: Request, res: Response) => {
    const db = await client();
    const rows = await db
      .select()
      .from(applyRunsTable)
      .where(eq(applyRunsTable.userId, actor()))
      .orderBy(desc(applyRunsTable.id))
      .limit(50);
    res.json({ runs: rows });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/defaults:
   *   get:
   *     summary: The catalog defaults, for empty-state UI
   *     tags: [Tmux Configuration]
   *     responses:
   *       200:
   *         description: Default effective configuration
   */
  router.get("/defaults", async (_req: Request, res: Response) => {
    res.json({ defaults: DEFAULT_CONFIG });
  });

  /**
   * @openapi
   * /plugin-api/tmux-configuration/integration:
   *   get:
   *     summary: Whether this plugin drives session creation for the terminal
   *     tags: [Tmux Configuration]
   *     responses:
   *       200:
   *         description: The tmux.sessions provider state
   */
  router.get("/integration", async (_req: Request, res: Response) => {
    res.json({
      providesTmuxSessions: tmuxServiceState.provided,
      conflictWith: tmuxServiceState.conflictWith,
    });
  });
}
