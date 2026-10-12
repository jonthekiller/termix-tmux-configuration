import { Layers, Settings2 } from "lucide-react";
import type {
  StandaloneViewProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { setTmuxConfigurationApi, setTmuxMonitorApi } from "./api";
import { tmuxMonitorEnabled } from "./host-gate";
import { TmuxConfiguration } from "./TmuxConfigurationApp";
import { TmuxConfigurationSection } from "./HostEditorSection";
import { TmuxMonitor } from "./TmuxMonitor";
import TmuxMonitorApp from "./TmuxMonitorApp";

const TAB_ID = "tmux_configuration";
const MONITOR_VIEW_ID = "tmux_monitor";

function TmuxConfigurationTab(props: TabProps) {
  return <TmuxConfiguration {...props} />;
}

function TmuxMonitorTab({ tab, isVisible }: TabProps) {
  const hostId = (tab.data?.hostId as number | undefined) ?? undefined;
  return (
    <TmuxMonitor
      initialHostId={hostId}
      initialHostRequest={tab.data?.hostRequest as number | undefined}
      isVisible={isVisible}
    />
  );
}

function TmuxMonitorStandalone(props: StandaloneViewProps) {
  return <TmuxMonitorApp {...props} />;
}

export function activate(app: TermixApp): void {
  setTmuxConfigurationApi(app.api);
  setTmuxMonitorApi(app.api);
  app.onDispose(() => {
    setTmuxConfigurationApi(null);
    setTmuxMonitorApi(null);
  });

  app.registerTab(TAB_ID, TmuxConfigurationTab, {
    icon: Settings2,
    titleKey: "tab.title",
    singleton: true,
    hostless: true,
    persistent: true,
    activityTypes: ["tmux_configuration"],
  });

  // The monitor: a single cross-host browser, like the tmux-monitor plugin's
  // own tab. Opening it from a host row points the already-open (or newly
  // opened) tab at that host.
  app.registerTab(MONITOR_VIEW_ID, TmuxMonitorTab, {
    icon: Layers,
    titleKey: "nav.tmuxMonitor",
    singleton: true,
    hostless: true,
    persistent: true,
    activityTypes: ["tmux_monitor"],
    standalone: TmuxMonitorStandalone,
  });

  app.registerHostAction({
    id: "tmux_monitor",
    titleKey: "nav.tmuxMonitor",
    icon: Layers,
    kind: "open",
    order: 70,
    copyUrlView: MONITOR_VIEW_ID,
    when: (host) => !!host.enableSsh && tmuxMonitorEnabled(host),
    run: (host, shell) =>
      shell.openSingletonTab(MONITOR_VIEW_ID, {
        data: { hostId: Number(host.id), hostRequest: Date.now() },
      }),
  });

  app.registerHostAction({
    id: "tmux_configuration",
    titleKey: "hosts.tabTmuxConfiguration",
    icon: Settings2,
    kind: "open",
    order: 71,
    copyUrlView: TAB_ID,
    when: (host) => host.enableSsh !== false,
    run: (_host, shell) => shell.openSingletonTab(TAB_ID),
  });

  // The host editor section: the enable switch rides in through the
  // manifest's hostCapability enableKey, the fields through this component.
  app.registerHostEditorSection({
    id: "tmux-configuration",
    group: "ssh",
    titleKey: "hosts.tabTmuxConfiguration",
    icon: Settings2,
    order: 46,
    component: TmuxConfigurationSection,
  });
}
