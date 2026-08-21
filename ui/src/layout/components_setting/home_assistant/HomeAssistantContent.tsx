import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, InputNumber, Switch, Tag } from "antd";
import { CopyOutlined } from "@ant-design/icons";

import { SettingsPageHeader } from "@components/Settings/SettingsPageheader";
import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import notifications from "@/notifications";
import { useEnhancedAt } from "@/locales/enhanced";

type MQTTSettings = {
  enabled: boolean;
  broker: string;
  port: number;
  username: string;
  password: string;
  base_topic: string;
  use_tls: boolean;
  tls_insecure: boolean;
  enable_ha_discovery: boolean;
  enable_actions: boolean;
};

type MQTTStatus = {
  connected: boolean;
  error?: string;
  base_topic?: string;
};

type MQTTTestResult = {
  success: boolean;
  error?: string;
};

const defaults: MQTTSettings = {
  enabled: false,
  broker: "",
  port: 1883,
  username: "",
  password: "",
  base_topic: "picokvm",
  use_tls: false,
  tls_insecure: false,
  enable_ha_discovery: true,
  enable_actions: false,
};

export default function HomeAssistantContent() {
  const { $eat } = useEnhancedAt();
  const [send] = useJsonRpc();
  const [settings, setSettings] = useState<MQTTSettings>(defaults);
  const [status, setStatus] = useState<MQTTStatus>({ connected: false });
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  const rtspURL = useMemo(() => `rtsp://${window.location.hostname}:8554/live`, []);

  const refreshStatus = useCallback(() => {
    send("getEnhancedMQTTStatus", {}, resp => {
      if ("error" in resp) return;
      setStatus(resp.result as MQTTStatus);
    });
  }, [send]);

  useEffect(() => {
    send("getEnhancedMQTTSettings", {}, resp => {
      if ("error" in resp) {
        notifications.error($eat("Failed to load Home Assistant settings"));
        return;
      }
      setSettings({ ...defaults, ...(resp.result as MQTTSettings) });
    });
    refreshStatus();
  }, [send, refreshStatus, $eat]);

  useEffect(() => {
    const timer = window.setInterval(refreshStatus, 3000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const update = <K extends keyof MQTTSettings>(key: K, value: MQTTSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const save = useCallback(() => {
    setLoading(true);
    send("setEnhancedMQTTSettings", { settings }, resp => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`${$eat("Failed to save Home Assistant settings")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      setStatus(resp.result as MQTTStatus);
      notifications.success($eat("Home Assistant settings saved"));
    });
  }, [send, settings, $eat]);

  const testConnection = useCallback(() => {
    setTesting(true);
    send("testEnhancedMQTTConnection", { settings }, resp => {
      setTesting(false);
      if ("error" in resp) {
        notifications.error(`${$eat("MQTT connection test failed")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      const result = resp.result as MQTTTestResult;
      if (result.success) {
        notifications.success($eat("MQTT connection successful"));
      } else {
        notifications.error(`${$eat("MQTT connection test failed")}: ${result.error || $eat("Unknown error")}`);
      }
    });
  }, [send, settings, $eat]);

  const copyRTSP = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(rtspURL);
      notifications.success($eat("RTSP URL copied"));
    } catch {
      notifications.error($eat("Copy failed"));
    }
  }, [rtspURL, $eat]);

  return (
    <div className="space-y-4 pb-[50px]">
      <SettingsPageHeader
        title={$eat("Home Assistant")}
        description={$eat("Connect PicoKVM to Home Assistant using MQTT Discovery and the existing RTSP stream")}
      />

      <Alert
        type="info"
        showIcon
        message={$eat("MQTT carries control and status only. Video stays on the hardware-encoded RTSP path, so Home Assistant does not make PicoKVM encode the picture again.")}
      />

      <SettingsItem
        title={$eat("MQTT integration")}
        description={$eat("Enable the PicoKVM MQTT client and reconnect automatically after network or broker interruptions")}
      >
        <div className="flex items-center gap-2">
          <Switch checked={settings.enabled} onChange={value => update("enabled", value)} />
          <Tag color={status.connected ? "green" : "default"}>
            {status.connected ? $eat("Connected") : $eat("Disconnected")}
          </Tag>
        </div>
      </SettingsItem>

      <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-sm">{$eat("MQTT broker")}</div>
            <Input
              value={settings.broker}
              onChange={e => update("broker", e.target.value)}
              placeholder="10.1.0.10"
            />
          </div>
          <div>
            <div className="mb-1 text-sm">{$eat("Port")}</div>
            <InputNumber
              className="!w-full"
              min={1}
              max={65535}
              value={settings.port}
              onChange={value => update("port", value || (settings.use_tls ? 8883 : 1883))}
            />
          </div>
          <div>
            <div className="mb-1 text-sm">{$eat("Username")}</div>
            <Input value={settings.username} onChange={e => update("username", e.target.value)} />
          </div>
          <div>
            <div className="mb-1 text-sm">{$eat("Password")}</div>
            <Input.Password value={settings.password} onChange={e => update("password", e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <div className="mb-1 text-sm">{$eat("Base topic")}</div>
            <Input
              value={settings.base_topic}
              onChange={e => update("base_topic", e.target.value)}
              placeholder="picokvm"
            />
            {status.base_topic && (
              <div className="mt-1 break-all text-xs text-slate-500 dark:text-slate-400">
                {$eat("Effective topic")}: {status.base_topic}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-3 pt-1">
          <label className="flex items-center gap-2">
            <Switch checked={settings.use_tls} onChange={value => update("use_tls", value)} />
            <span>{$eat("Use TLS")}</span>
          </label>
          {settings.use_tls && (
            <label className="flex items-center gap-2">
              <Switch checked={settings.tls_insecure} onChange={value => update("tls_insecure", value)} />
              <span>{$eat("Allow unverified TLS certificate")}</span>
            </label>
          )}
        </div>

        {status.error && <div className="text-sm text-red-500">{status.error}</div>}

        <div className="flex flex-wrap gap-2">
          <Button loading={testing} onClick={testConnection}>{$eat("Test Connection")}</Button>
          <Button type="primary" loading={loading} onClick={save}>{$eat("Save")}</Button>
        </div>
      </div>

      <SettingsItem
        title={$eat("Home Assistant Discovery")}
        description={$eat("Automatically create PicoKVM sensors, status entities and controls in Home Assistant")}
      >
        <Switch
          checked={settings.enable_ha_discovery}
          onChange={value => update("enable_ha_discovery", value)}
        />
      </SettingsItem>

      <SettingsItem
        title={$eat("Allow Home Assistant actions")}
        description={$eat("Permit MQTT commands for host power/reset, USB recovery, recording, RTP and selected keyboard hotkeys")}
      >
        <Switch checked={settings.enable_actions} onChange={value => update("enable_actions", value)} />
      </SettingsItem>

      {settings.enable_actions && (
        <Alert
          type="warning"
          showIcon
          message={$eat("Home Assistant will be able to send real power, reset and keyboard actions to the attached host. Use a trusted MQTT broker account.")}
        />
      )}

      <div className="space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <div className="font-medium">{$eat("Entities published by Discovery")}</div>
        <div className="text-sm text-slate-600 dark:text-slate-300">
          {$eat("Online, HDMI signal, resolution, FPS, codec, controller/viewer counts, RTSP clients, USB, host LEDs, load, memory, storage, temperature, recording, RTP multicast and virtual media state.")}
        </div>
        <div className="text-sm text-slate-600 dark:text-slate-300">
          {$eat("With actions enabled: host power/reset, USB wake/reinitialize, recording start/stop, RTP start/stop, virtual-media eject, Enter/Esc/F2/F12/Ctrl+Alt+Delete and PicoKVM reboot.")}
        </div>
      </div>

      <SettingsItem
        title={$eat("Home Assistant camera")}
        description={$eat("Use the existing zero-reencode RTSP server as the camera stream source")}
      >
        <Button icon={<CopyOutlined />} onClick={copyRTSP}>{$eat("Copy RTSP URL")}</Button>
      </SettingsItem>

      <div className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700">
        <div className="break-all font-mono">{rtspURL}</div>
        <div className="text-slate-600 dark:text-slate-300">
          {$eat("In Home Assistant add a Generic Camera, use this RTSP URL as Stream Source, choose TCP, use any username and your PicoKVM API Key as the password.")}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          {$eat("The API Key is deliberately not copied into MQTT Discovery or shown on this page.")}
        </div>
      </div>
    </div>
  );
}
