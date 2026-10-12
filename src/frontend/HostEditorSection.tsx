import {
  useTranslation,
  type HostEditorSectionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { FakeSwitch, SectionCard, SettingRow } from "@termix-ssh/plugin-sdk/ui";
import { saveHostOptions } from "./api";

const SettingsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-3.5"
  >
    <path d="M20 7h-9M14 17H5" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="7" cy="7" r="3" />
  </svg>
);

type PluginSettingsForm = Record<string, Record<string, unknown>>;

const PLUGIN_ID = "tmux-configuration";

const SELECTS: Record<string, Array<{ value: string; labelKey: string }>> = {
  mouse: [
    { value: "on", labelKey: "settings.host.mouse.on" },
    { value: "off", labelKey: "settings.host.mouse.off" },
  ],
  renumberWindows: [
    { value: "on", labelKey: "common.on" },
    { value: "off", labelKey: "common.off" },
  ],
  setClipboard: [
    { value: "external", labelKey: "settings.host.setClipboard.external" },
    { value: "internal", labelKey: "settings.host.setClipboard.internal" },
    { value: "off", labelKey: "settings.host.setClipboard.off" },
  ],
  remainOnExit: [
    { value: "on", labelKey: "common.on" },
    { value: "off", labelKey: "common.off" },
  ],
  exitEmpty: [
    { value: "on", labelKey: "common.on" },
    { value: "off", labelKey: "common.off" },
  ],
};

const TEXTAREAS = new Set(["customOptions", "environment", "configSnippet"]);
const NUMBERS = new Set(["historyLimit"]);

/**
 * The host editor's Tmux Configuration section. Writes into the form's
 * pluginSettings for this plugin, which the editor saves through the
 * plugin's host settings route after the host itself. A key left unset
 * follows the folder, user or server default; the reset button hands a
 * saved key back to the defaults immediately.
 */
export function TmuxConfigurationSection({
  form,
  updateForm,
  host,
}: HostEditorSectionProps) {
  const { t } = useTranslation();

  const settings = ((form?.pluginSettings as PluginSettingsForm | undefined)?.[
    PLUGIN_ID
  ] ?? {}) as Record<string, unknown>;

  const setSetting = (key: string, value: unknown) =>
    updateForm((current) => {
      const all = (current.pluginSettings ?? {}) as PluginSettingsForm;
      return {
        ...current,
        pluginSettings: {
          ...all,
          [PLUGIN_ID]: { ...all[PLUGIN_ID], [key]: value },
        },
      };
    });

  const resetToDefault = (key: string) => {
    if (!host) return;
    void saveHostOptions(Number(host.id), { inheritKeys: [key] });
    updateForm((current) => {
      const all = (current.pluginSettings ?? {}) as PluginSettingsForm;
      const next = { ...(all[PLUGIN_ID] ?? {}) };
      delete next[key];
      return { ...current, pluginSettings: { ...all, [PLUGIN_ID]: next } };
    });
  };

  const renderControl = (key: string) => {
    if (key in SELECTS) {
      return (
        <select
          className="border border-border bg-transparent px-2 py-1 text-sm"
          value={String(settings[key] ?? "")}
          onChange={(event) => setSetting(key, event.target.value)}
        >
          <option value="">{t("common.none")} (default)</option>
          {SELECTS[key].map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
      );
    }
    if (NUMBERS.has(key)) {
      return (
        <input
          type="number"
          className="w-32 border border-border bg-transparent px-2 py-1 text-sm"
          value={settings[key] === undefined ? "" : String(settings[key])}
          onChange={(event) =>
            setSetting(
              key,
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
            )
          }
        />
      );
    }
    if (key === "sessionNamePattern") {
      return (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            className="w-72 border border-border bg-transparent px-2 py-1 font-mono text-xs"
            placeholder="termix-{user}-{host}"
            value={String(settings[key] ?? "")}
            onChange={(event) => setSetting(key, event.target.value)}
          />
          <span className="font-mono text-[10px] text-muted-foreground">
            {t("hostEditor.sessionNamePatternVariables")}
          </span>
        </div>
      );
    }
    if (TEXTAREAS.has(key)) {
      const isJson = key !== "configSnippet";
      const display = isJson
        ? settings[key] === undefined
          ? ""
          : JSON.stringify(settings[key], null, 2)
        : String(settings[key] ?? "");
      return (
        <textarea
          className="min-h-20 w-72 border border-border bg-transparent px-2 py-1 font-mono text-xs"
          value={display}
          onChange={(event) => {
            if (!isJson) {
              setSetting(key, event.target.value);
              return;
            }
            try {
              setSetting(
                key,
                event.target.value.trim() === ""
                  ? {}
                  : JSON.parse(event.target.value),
              );
            } catch {
              // Keep the previous value; the validator refuses invalid JSON
              // on save with a per-field message.
            }
          }}
        />
      );
    }
    return null;
  };

  const fields = [
    "historyLimit",
    "mouse",
    "renumberWindows",
    "setClipboard",
    "remainOnExit",
    "exitEmpty",
    "sessionNamePattern",
    "customOptions",
    "environment",
    "configSnippet",
  ];

  return (
    <SectionCard title={t("hostEditor.title")} icon={<SettingsIcon />}>
      <p className="text-xs text-muted-foreground">
        {t("hostEditor.description")}
      </p>
      <div className="flex flex-col gap-4 py-3">
        <SettingRow
          label={t("hosts.enable")}
          defaultKey="enableTmuxConfiguration"
          description={t("hosts.enableDesc")}
        >
          <FakeSwitch
            checked={settings.enableTmuxConfiguration === true}
            onChange={(value) => setSetting("enableTmuxConfiguration", value)}
          />
        </SettingRow>
        {fields.map((key) => (
          <div key={key} className="flex items-start gap-2">
            <div className="flex-1">
              <SettingRow label={t(`hostEditor.${key}`)} defaultKey={key}>
                {renderControl(key)}
              </SettingRow>
            </div>
            {host && settings[key] !== undefined && (
              <button
                type="button"
                title={t("common.cancel")}
                className="border border-border px-2 py-0.5 text-xs"
                onClick={() => resetToDefault(key)}
              >
                ↺
              </button>
            )}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
