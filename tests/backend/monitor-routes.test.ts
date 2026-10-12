import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { type Router } from "express";
import {
  createMockCtx,
  createTestDb,
  type MockPluginContext,
  type TestDb,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import type { Client } from "ssh2";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";

const pluginDir = fileURLToPath(new URL("../..", import.meta.url));
const manifest = manifestJson as unknown as PluginManifest;
const SEP = "<<TMX>>";

const HOSTS = [
  {
    id: 1,
    userId: "user-1",
    name: "web-1",
    ip: "10.0.0.1",
    port: 22,
    username: "root",
    tags: "prod",
    folder: null,
    authType: "ssh",
  },
];

/**
 * An ssh2 Client look-alike that answers the monitor's per-command format
 * strings: one tmux session "web" with one window holding one pane, plus a
 * one-process ps output for the metrics aggregation.
 */
function monitorSshClient(): Client {
  return {
    exec(
      command: string,
      callback: (err: Error | null, stream?: unknown) => void,
    ) {
      const events = new Map<string, Array<(...args: unknown[]) => void>>();
      const on = (event: string, listener: (...args: unknown[]) => void) => {
        events.set(event, [...(events.get(event) ?? []), listener]);
      };
      const emit = (event: string, ...args: unknown[]) => {
        for (const listener of events.get(event) ?? []) listener(...args);
      };
      const stream = { on, stderr: { on } };
      callback(null, stream);

      let output = "";
      if (command.includes("-V")) output = "tmux 3.4\n";
      else if (command.includes("list-sessions"))
        output = `web${SEP}1000${SEP}2000${SEP}1\n`;
      else if (command.includes("list-windows -a"))
        output = `web${SEP}0${SEP}1${SEP}editor\n`;
      else if (command.includes("list-panes -a"))
        output =
          `web${SEP}0${SEP}%0${SEP}0${SEP}1234${SEP}1${SEP}120${SEP}40${SEP}` +
          `bash${SEP}/home/deploy${SEP}deploy@web\n`;
      else if (command.includes("ps -eo"))
        output = " 1234     1  0.5  0.1  10000 bash\n";
      if (output) emit("data", Buffer.from(output));
      setTimeout(() => emit("close", 0), 0);
    },
  } as unknown as Client;
}

let db: TestDb;
let mock: MockPluginContext;
let server: http.Server;
let port: number;

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  db.sqlite
    .prepare("INSERT INTO users (id, username) VALUES (?, ?)")
    .run("user-1", "user-1");
  // The session tags table references ssh_data (the hosts table).
  db.sqlite.prepare("INSERT INTO ssh_data (id) VALUES (1)").run();

  let router: Router | null = null;
  mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    db: db.database,
    router: () => (router = express.Router()),
    permissions: ["tmux-configuration.use", "tmux-configuration.sessions"],
    hosts: HOSTS,
    sshClient: monitorSshClient(),
  });
  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    mock.setActor("user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

async function request(method: string, path: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

describe("monitor routes", () => {
  it("refuses a host the plugin is disabled on", async () => {
    const { status } = await request("GET", "/1/overview");
    expect(status).toBe(403);
  });

  it("serves the session tree with windows, panes and metrics-ready fields", async () => {
    await mock.ctx.settings.setHost(1, "enableTmuxConfiguration", true);
    const { status, body } = await request("GET", "/1/overview");
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.sessions).toHaveLength(1);
    const session = body.sessions[0];
    expect(session).toMatchObject({
      name: "web",
      attachedClients: 1,
      tags: [],
    });
    expect(session.windows).toHaveLength(1);
    expect(session.windows[0].name).toBe("editor");
    expect(session.windows[0].panes).toHaveLength(1);
    expect(session.windows[0].panes[0]).toMatchObject({
      id: "%0",
      pid: 1234,
      path: "/home/deploy",
    });
  });

  it("saves and returns the acting user's session tags", async () => {
    await mock.ctx.settings.setHost(1, "enableTmuxConfiguration", true);
    const saved = await request("PUT", "/1/tags", {
      sessionName: "web",
      tags: ["prod", "prod", "  ", "deploy"],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.tags).toEqual(["prod", "deploy"]);

    const overview = await request("GET", "/1/overview");
    expect(overview.body.sessions[0].tags).toEqual(["prod", "deploy"]);
  });

  it("answers metrics with the pane's aggregated process tree", async () => {
    await mock.ctx.settings.setHost(1, "enableTmuxConfiguration", true);
    const { status, body } = await request("GET", "/1/metrics");
    expect(status).toBe(200);
    expect(body.panes).toHaveLength(1);
    expect(body.panes[0]).toMatchObject({
      paneId: "%0",
      pid: 1234,
      processCount: 1,
      topCommand: "bash",
    });
  });
});
