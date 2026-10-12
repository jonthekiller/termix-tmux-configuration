import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";

let client: PluginApiClient | null = null;

/** Set from activate with app.api, cleared on deactivate. */
export function setTmuxConfigurationApi(api: PluginApiClient | null): void {
  client = api;
}

function api(): PluginApiClient {
  if (!client) throw new Error("The Tmux Configuration plugin is not active");
  return client;
}

export interface TmuxEffectiveConfig {
  historyLimit: number;
  mouse: string;
  renumberWindows: string;
  setClipboard: string;
  remainOnExit: string;
  exitEmpty: string;
  customOptions: Record<string, string>;
  environment: Record<string, string>;
  configSnippet: string;
}

export interface HostRow {
  id: number;
  name: string | null;
  ip: string;
  folder: string | null;
  tags: string | null;
  enabled: boolean;
  config: TmuxEffectiveConfig;
}

export interface ApplyResult {
  hostId: number;
  hostName: string;
  ok: boolean;
  reason: string;
  sessionsTouched: number;
}

export interface ConfigPreviewResponse {
  config: TmuxEffectiveConfig;
  file: string;
  fileCommand: string;
  globalCommand: string;
  perSessionCommands: Array<{ sessionName: string; command: string }>;
}

export interface ProfileRow {
  id: number;
  name: string;
  options: string;
  createdAt: string;
}

export interface ApplyRunRow {
  id: number;
  hostId: number;
  hostName: string;
  ok: number | boolean;
  reason: string | null;
  sessionsTouched: number;
  createdAt: string;
}

export const listHosts = () => api().get<{ hosts: HostRow[] }>("/hosts");

export const applyTo = (body: {
  hostIds?: number[];
  tag?: string;
  folder?: string;
  all?: boolean;
  force?: boolean;
  profileId?: number;
}) => api().post<{ results: ApplyResult[] }>("/apply", body);

export const preview = (hostId: number) =>
  api().get<ConfigPreviewResponse>(`/preview/${hostId}`);

export const saveHostOptions = (
  hostId: number,
  body: { values?: Record<string, unknown>; inheritKeys?: string[] },
) => api().put(`/host/${hostId}/options`, body);

export const listProfiles = () =>
  api().get<{ profiles: ProfileRow[] }>("/profiles");

export const createProfile = (name: string, options: Record<string, unknown>) =>
  api().post("/profiles", { name, options });

export const deleteProfile = (id: number) => api().delete(`/profiles/${id}`);

export const listHistory = () => api().get<{ runs: ApplyRunRow[] }>("/history");

export interface IntegrationStatus {
  providesTmuxSessions: boolean;
  conflictWith: string | null;
}

export const getIntegration = () =>
  api().get<IntegrationStatus>("/integration");

// --- Tmux Monitor (ported from the tmux-monitor plugin) ----------------------

/** Alias kept for the monitor's own call sites. */
export const setTmuxMonitorApi = setTmuxConfigurationApi;

export interface TmuxPane {
  id: string;
  index: number;
  pid: number;
  active: boolean;
  width: number;
  height: number;
  command: string;
  path: string;
  title: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPane[];
}

export interface TmuxSessionOverview {
  name: string;
  created: number;
  lastActivity: number;
  attachedClients: number;
  windows: TmuxWindow[];
  tags: string[];
}

export interface TmuxOverview {
  available: boolean;
  sessions: TmuxSessionOverview[];
}

export interface TmuxSearchMatch {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  line: number;
  text: string;
}

export interface TmuxPaneMetrics {
  paneId: string;
  sessionName: string;
  pid: number;
  processCount: number;
  cpuPercent: number;
  memRssKb: number;
  gpuMemMb: number;
  topCommand: string | null;
}

export async function getTmuxOverview(hostId: number): Promise<TmuxOverview> {
  const response = await api().get<TmuxOverview>(`/${hostId}/overview`);
  return response.data;
}

/** Select a pane's window+pane on the server so the attached terminal
 * (and any other attached client) switches to it. */
export async function focusTmuxPane(
  hostId: number,
  paneId: string,
): Promise<void> {
  await api().post(`/${hostId}/focus`, { paneId });
}

/** Create a new detached session on the host. Starts the tmux server if
 * none is running yet. */
export async function createTmuxSession(
  hostId: number,
  name: string,
): Promise<string> {
  // An empty name asks the backend to name the session from the host's
  // sessionNamePattern; the response carries the name actually created.
  const response = await api().post<{ name?: string }>(`/${hostId}/sessions`, {
    name,
  });
  return response.data.name ?? name;
}

/** Create a new window in an existing session. */
export async function createTmuxWindow(
  hostId: number,
  sessionName: string,
): Promise<void> {
  await api().post(`/${hostId}/windows`, { sessionName });
}

/** Rename a session. Saved tags follow the session to its new name. */
export async function renameTmuxSession(
  hostId: number,
  sessionName: string,
  newName: string,
): Promise<void> {
  await api().post(`/${hostId}/rename`, { sessionName, newName });
}

/** Kill a session (terminates all of its windows and processes). */
export async function killTmuxSession(
  hostId: number,
  sessionName: string,
): Promise<void> {
  await api().post(`/${hostId}/kill`, { sessionName });
}

/** Kill a window and every pane in it. */
export async function killTmuxWindow(
  hostId: number,
  sessionName: string,
  windowIndex: number,
): Promise<void> {
  await api().post(`/${hostId}/kill-window`, { sessionName, windowIndex });
}

/** Kill a single pane (last pane of a window closes the window). */
export async function killTmuxPane(
  hostId: number,
  paneId: string,
): Promise<void> {
  await api().post(`/${hostId}/kill-pane`, { paneId });
}

/** Split the window containing a pane: "h" adds a pane to the right,
 * "v" below (tmux -h/-v semantics). */
export async function splitTmuxPane(
  hostId: number,
  paneId: string,
  direction: "h" | "v",
): Promise<void> {
  await api().post(`/${hostId}/split`, { paneId, direction });
}

export interface TmuxSearchResult {
  matches: TmuxSearchMatch[];
  /** True when a search limit was hit and the results are partial. */
  truncated: boolean;
  searchedLines: number;
  maxPanes: number;
}

export async function searchTmux(
  hostId: number,
  query: string,
): Promise<TmuxSearchResult> {
  const response = await api().get<Partial<TmuxSearchResult>>(
    `/${hostId}/search`,
    { params: { q: query } },
  );
  return {
    matches: response.data.matches ?? [],
    truncated: response.data.truncated ?? false,
    searchedLines: response.data.searchedLines ?? 0,
    maxPanes: response.data.maxPanes ?? 0,
  };
}

export async function getTmuxMetrics(
  hostId: number,
): Promise<TmuxPaneMetrics[]> {
  const response = await api().get<{ panes?: TmuxPaneMetrics[] }>(
    `/${hostId}/metrics`,
  );
  return response.data.panes ?? [];
}

export async function setTmuxSessionTags(
  hostId: number,
  sessionName: string,
  tags: string[],
): Promise<string[]> {
  const response = await api().put<{ tags?: string[] }>(`/${hostId}/tags`, {
    sessionName,
    tags,
  });
  return response.data.tags ?? [];
}
