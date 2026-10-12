import { useEffect, useMemo, useState } from "react";
import { useTranslation, type TabProps } from "@termix-ssh/plugin-sdk/frontend";
import {
  applyTo,
  createProfile,
  deleteProfile,
  getIntegration,
  listHistory,
  listHosts,
  listProfiles,
  preview,
  type ApplyResult,
  type ApplyRunRow,
  type HostRow,
  type IntegrationStatus,
  type ProfileRow,
} from "./api";

/** Effective-config keys shown in the matrix, in display order. */
const OPTION_KEYS = [
  "historyLimit",
  "mouse",
  "renumberWindows",
  "setClipboard",
  "remainOnExit",
  "exitEmpty",
] as const;

function hostLabel(host: HostRow): string {
  return host.name ?? host.ip;
}

function tagsOf(host: HostRow): string[] {
  return (host.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function TmuxConfiguration({ isVisible }: TabProps) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRow[]>([]);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [profileName, setProfileName] = useState("");
  const [runs, setRuns] = useState<ApplyRunRow[]>([]);
  const [previewHost, setPreviewHost] = useState<HostRow | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(
    null,
  );

  const folders = useMemo(
    () =>
      Array.from(
        new Set(
          hosts.map((host) => host.folder).filter((f): f is string => !!f),
        ),
      ).sort(),
    [hosts],
  );
  const tags = useMemo(
    () => Array.from(new Set(hosts.flatMap((host) => tagsOf(host)))).sort(),
    [hosts],
  );

  const load = async () => {
    try {
      const [
        { data: hostData },
        { data: profileData },
        { data: runData },
        { data: integrationData },
      ] = await Promise.all([
        listHosts(),
        listProfiles(),
        listHistory(),
        getIntegration(),
      ]);
      setHosts(hostData.hosts);
      setProfiles(profileData.profiles);
      setRuns(runData.runs);
      setIntegration(integrationData);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => {
    if (isVisible) void load();
  }, [isVisible]);

  const toggle = (hostId: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });

  const selectBy = (predicate: (host: HostRow) => boolean) =>
    setSelected(new Set(hosts.filter(predicate).map((host) => host.id)));

  const doApply = async (body: {
    hostIds?: number[];
    tag?: string;
    folder?: string;
    all?: boolean;
    force?: boolean;
  }) => {
    setApplying(true);
    setApplyMessage(t("tab.applyStarted"));
    setResults(null);
    try {
      const { data } = await applyTo(body);
      const ok = data.results.filter((result) => result.ok).length;
      const failedCount = data.results.length - ok;
      setResults(data.results);
      setApplyMessage(t("tab.applyDone", { ok, failed: failedCount }));
      await load();
    } catch {
      setApplyMessage(t("common.error"));
    } finally {
      setApplying(false);
    }
  };

  const applySelection = () => {
    if (selected.size === 0) return;
    void doApply({ hostIds: Array.from(selected) });
  };

  const showPreview = async (host: HostRow) => {
    setPreviewHost(host);
    setPreviewText(null);
    try {
      const { data } = await preview(host.id);
      const parts = [
        `# ${t("preview.fileHeading")}`,
        data.file,
        "",
        `# ${t("preview.commandsHeading")}`,
        data.globalCommand,
        ...data.perSessionCommands.map((command) => command.command),
      ];
      setPreviewText(parts.join("\n"));
    } catch {
      setPreviewText(t("preview.error"));
    }
  };

  const saveProfile = async () => {
    if (!profileName.trim()) return;
    // A profile stores the effective configuration of the selection's first
    // host: the values the user reviewed and is happy to reuse elsewhere.
    const source = hosts.find((host) => selected.has(host.id));
    if (!source) return;
    const options = { ...source.config } as Record<string, unknown>;
    try {
      await createProfile(profileName.trim(), options);
      setProfileName("");
      await load();
    } catch {
      setApplyMessage(t("common.error"));
    }
  };

  const applyProfile = async (profile: ProfileRow) => {
    if (selected.size === 0) return;
    setApplying(true);
    setResults(null);
    try {
      // The profile's stored values ride along as the override for this run:
      // per-host settings on disk stay untouched.
      const { data } = await applyTo({
        hostIds: Array.from(selected),
        force: true,
        profileId: profile.id,
      });
      const ok = data.results.filter((result) => result.ok).length;
      setResults(data.results);
      setApplyMessage(
        t("tab.applyDone", { ok, failed: data.results.length - ok }),
      );
      await load();
    } catch {
      setApplyMessage(t("common.error"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div>
        <h2 className="text-lg font-semibold">{t("tab.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("tab.subtitle")}</p>
      </div>

      {failed && (
        <p className="text-sm text-destructive">{t("tab.loadError")}</p>
      )}

      {integration && !integration.providesTmuxSessions && (
        <div className="rounded border border-border bg-muted/40 p-3 text-sm">
          {integration.conflictWith
            ? t("integration.conflict", { plugin: integration.conflictWith })
            : t("integration.serviceInactive")}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="border border-border px-3 py-1 disabled:opacity-50"
          disabled={applying || selected.size === 0}
          onClick={applySelection}
        >
          {t("common.applyToSelection")} ({selected.size})
        </button>
        <button
          type="button"
          className="border border-border px-3 py-1 disabled:opacity-50"
          disabled={applying || hosts.length === 0}
          onClick={() => void doApply({ all: true })}
        >
          {t("common.applyToAll")}
        </button>
        {folders.map((folder) => (
          <button
            key={folder}
            type="button"
            className="border border-border px-3 py-1 disabled:opacity-50"
            disabled={applying}
            onClick={() => void doApply({ folder })}
          >
            {t("common.folder")}: {folder}
          </button>
        ))}
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="border border-border px-3 py-1 disabled:opacity-50"
            disabled={applying}
            onClick={() => void doApply({ tag })}
          >
            {t("common.tag")}: {tag}
          </button>
        ))}
        <button
          type="button"
          className="border border-border px-3 py-1 disabled:opacity-50"
          disabled={applying}
          onClick={() => selectBy(() => true)}
        >
          {t("common.allHosts")}
        </button>
      </div>

      {applyMessage && (
        <p className="text-sm text-muted-foreground">{applyMessage}</p>
      )}
      {results && (
        <ul className="flex flex-col gap-1 text-sm">
          {results.map((result) => (
            <li key={result.hostId} className="border-b border-border py-1">
              {result.ok ? "✓" : "✗"} {result.hostName} — {result.reason}
              {result.sessionsTouched > 0 ? ` (${result.sessionsTouched})` : ""}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-2 font-medium">{t("tab.hostsHeading")}</h3>
      {hosts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("tab.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-2 py-1"> </th>
                <th className="px-2 py-1">{t("hosts.name")}</th>
                <th className="px-2 py-1">{t("common.folder")}</th>
                <th className="px-2 py-1">{t("hosts.tmux")}</th>
                {OPTION_KEYS.map((key) => (
                  <th key={key} className="px-2 py-1">
                    {t(`hostEditor.${key}`)}
                  </th>
                ))}
                <th className="px-2 py-1">{t("common.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => (
                <tr key={host.id} className="border-b border-border">
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      checked={selected.has(host.id)}
                      onChange={() => toggle(host.id)}
                    />
                  </td>
                  <td className="px-2 py-1">{hostLabel(host)}</td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {host.folder ?? "—"}
                  </td>
                  <td className="px-2 py-1">{host.enabled ? "✓" : "—"}</td>
                  {OPTION_KEYS.map((key) => (
                    <td key={key} className="px-2 py-1 font-mono text-xs">
                      {String(host.config[key])}
                    </td>
                  ))}
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      className="border border-border px-2 py-0.5 text-xs disabled:opacity-50"
                      disabled={applying || !host.enabled}
                      onClick={() =>
                        void doApply({ hostIds: [host.id], force: true })
                      }
                    >
                      {t("common.apply")}
                    </button>{" "}
                    <button
                      type="button"
                      className="border border-border px-2 py-0.5 text-xs"
                      onClick={() => void showPreview(host)}
                    >
                      {t("common.preview")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-2 font-medium">{t("tab.profilesHeading")}</h3>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="border border-border bg-transparent px-2 py-1 text-sm"
          value={profileName}
          placeholder={t("tab.profilePlaceholder")}
          onChange={(event) => setProfileName(event.target.value)}
        />
        <button
          type="button"
          className="border border-border px-3 py-1 text-sm disabled:opacity-50"
          disabled={selected.size !== 1 || !profileName.trim()}
          onClick={() => void saveProfile()}
        >
          {t("tab.saveProfile")}
        </button>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {profiles.map((profile) => (
          <li
            key={profile.id}
            className="flex items-center gap-2 border-b border-border py-1"
          >
            <span className="flex-1">{profile.name}</span>
            <button
              type="button"
              className="border border-border px-2 py-0.5 text-xs disabled:opacity-50"
              disabled={applying || selected.size === 0}
              onClick={() => void applyProfile(profile)}
            >
              {t("common.applyToSelection")}
            </button>
            <button
              type="button"
              className="border border-border px-2 py-0.5 text-xs"
              onClick={() => void deleteProfile(profile.id).then(load)}
            >
              {t("common.delete")}
            </button>
          </li>
        ))}
      </ul>

      <h3 className="mt-2 font-medium">{t("tab.historyHeading")}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {runs.map((run) => (
          <li key={run.id} className="border-b border-border py-1">
            {run.ok ? "✓" : "✗"} {run.hostName} — {run.reason ?? ""}{" "}
            <span className="text-muted-foreground">
              ({new Date(run.createdAt).toLocaleString()})
            </span>
          </li>
        ))}
        {runs.length === 0 && (
          <li className="text-muted-foreground">{t("common.none")}</li>
        )}
      </ul>

      {previewHost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="flex max-h-[80vh] w-full max-w-3xl flex-col gap-2 overflow-auto rounded border border-border bg-background p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">
                {t("preview.title")} — {hostLabel(previewHost)}
              </h3>
              <button
                type="button"
                className="border border-border px-2 py-0.5 text-sm"
                onClick={() => setPreviewHost(null)}
              >
                {t("common.close")}
              </button>
            </div>
            <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">
              {previewText ?? t("common.loading")}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
