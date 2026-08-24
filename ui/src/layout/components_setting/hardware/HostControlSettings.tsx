import { useCallback, useEffect, useState } from "react";
import { Button, InputNumber, Popconfirm, Tag } from "antd";

import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import notifications from "@/notifications";
import { useEnhancedAt } from "@/locales/enhanced";

type HostControlSettings = {
  power_short_ms: number;
  power_long_ms: number;
  reset_ms: number;
};

const defaults: HostControlSettings = {
  power_short_ms: 500,
  power_long_ms: 6000,
  reset_ms: 500,
};

export default function EnhancedHostControlSettings() {
  const [send] = useJsonRpc();
  const { $eat } = useEnhancedAt();
  const [settings, setSettings] = useState<HostControlSettings>(defaults);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<"power" | "long" | "reset" | null>(null);

  useEffect(() => {
    send("getEnhancedHostControlSettings", {}, resp => {
      if ("error" in resp) {
        notifications.error(`${$eat("Failed to load host control settings")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      setSettings(resp.result as HostControlSettings);
    });
  }, [send, $eat]);

  const save = useCallback(() => {
    setSaving(true);
    send("setEnhancedHostControlSettings", { settings }, resp => {
      setSaving(false);
      if ("error" in resp) {
        notifications.error(`${$eat("Failed to save host control settings")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      notifications.success($eat("Host control timings saved"));
    });
  }, [send, settings, $eat]);

  const run = useCallback((kind: "power" | "long" | "reset") => {
    setAction(kind);
    const method = kind === "power" ? "triggerPower" : kind === "long" ? "triggerPowerLong" : "triggerReset";
    send(method, {}, resp => {
      setAction(null);
      if ("error" in resp) {
        notifications.error(`${$eat("Host control action failed")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      notifications.success(kind === "long" ? $eat("Forced power-off hold triggered") : $eat("Host button pulse triggered"));
    });
  }, [send, $eat]);

  return (
    <>
      <SettingsItem
        title={$eat("Host power / reset timing")}
        description={$eat("Tune the physical ATX power and reset button pulse widths for the connected motherboard")}
      >
        <Tag color="blue">Ext Board</Tag>
      </SettingsItem>

      <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm">
            <div>{$eat("Normal power press")}</div>
            <InputNumber
              min={100}
              max={2500}
              step={50}
              value={settings.power_short_ms}
              addonAfter="ms"
              className="w-full"
              onChange={value => setSettings(current => ({ ...current, power_short_ms: value || 500 }))}
            />
          </label>
          <label className="space-y-1 text-sm">
            <div>{$eat("Forced power-off hold")}</div>
            <InputNumber
              min={3000}
              max={15000}
              step={500}
              value={settings.power_long_ms}
              addonAfter="ms"
              className="w-full"
              onChange={value => setSettings(current => ({ ...current, power_long_ms: value || 6000 }))}
            />
          </label>
          <label className="space-y-1 text-sm">
            <div>{$eat("Reset pulse")}</div>
            <InputNumber
              min={100}
              max={2500}
              step={50}
              value={settings.reset_ms}
              addonAfter="ms"
              className="w-full"
              onChange={value => setSettings(current => ({ ...current, reset_ms: value || 500 }))}
            />
          </label>
        </div>

        <div className="text-xs text-slate-500 dark:text-slate-400">
          {$eat("The normal PicoKVM Web power/reset actions, Home Assistant and MCP all use these timings. The forced power-off action uses the long-hold value.")}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="primary" loading={saving} onClick={save}>{$eat("Save timings")}</Button>
          <Button loading={action === "power"} onClick={() => run("power")}>{$eat("Test normal power press")}</Button>
          <Button loading={action === "reset"} onClick={() => run("reset")}>{$eat("Test reset pulse")}</Button>
          <Popconfirm
            title={$eat("Force power off?")}
            description={$eat("This holds the motherboard power button for the configured long-press duration.")}
            okText={$eat("Force power off")}
            cancelText={$eat("Cancel")}
            onConfirm={() => run("long")}
          >
            <Button danger loading={action === "long"}>{$eat("Test forced power-off")}</Button>
          </Popconfirm>
        </div>
      </div>
    </>
  );
}
