import { useCallback, useEffect, useState } from "react";
import { Alert, Button, InputNumber, Popconfirm, Switch, Tag } from "antd";

import { SettingsPageHeader } from "@components/Settings/SettingsPageheader";
import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useSettingsStore } from "@/hooks/stores";
import notifications from "@/notifications";

type SupervisorSettings = {
  enabled: boolean;
  auto_recover_video: boolean;
  video_stall_seconds: number;
  recovery_cooldown_seconds: number;
  max_video_recoveries_per_hour: number;
};

type SupervisorStatus = {
  running: boolean;
  healthy: boolean;
  video_expected: boolean;
  subscribers: number;
  control_sessions: number;
  last_frame_at?: string;
  last_frame_age_ms: number;
  total_frames: number;
  video_recoveries: number;
  recoveries_last_hour: number;
  last_recovery_at?: string;
  last_recovery_reason?: string;
  last_error?: string;
};

const defaults: SupervisorSettings = {
  enabled: true,
  auto_recover_video: true,
  video_stall_seconds: 8,
  recovery_cooldown_seconds: 30,
  max_video_recoveries_per_hour: 6,
};

const zh: Record<string, string> = {
  Supervisor: "监控与自愈",
  "Monitor critical PicoKVM runtime health and perform bounded recovery without automatically rebooting the device": "监控 PicoKVM 关键运行状态，并在不自动重启整机的前提下进行有限自愈",
  "Supervisor service": "自愈监控服务",
  "Continuously evaluate active video sessions and the native encoded-frame heartbeat": "持续检查正在使用的视频会话与原生编码帧心跳",
  Healthy: "正常",
  "Video stalled": "视频异常",
  Idle: "空闲",
  "Automatic video recovery": "自动恢复视频",
  "If HDMI is ready and clients are active but encoded frames stop, restart only the native video pipeline": "当 HDMI 正常且存在活动客户端，但编码帧停止时，仅重启原生视频管线",
  "Video stall threshold": "视频卡死判定时间",
  "Continuous frame silence required before recovery": "连续多久没有编码帧后才执行恢复",
  "Recovery cooldown": "恢复冷却时间",
  "Minimum delay between automatic video recovery attempts": "两次自动视频恢复之间的最短间隔",
  "Maximum recoveries per hour": "每小时最大恢复次数",
  "Rate limit that prevents a persistent fault from causing a recovery loop": "防止持续故障导致无限恢复循环",
  "Save supervisor settings": "保存自愈设置",
  "Force video recovery": "手动恢复视频",
  "Force native video recovery?": "确定手动恢复原生视频？",
  "This performs one stop/start cycle of the native video pipeline. PicoKVM itself will not reboot.": "这会对原生视频管线执行一次停止/启动；PicoKVM 本身不会重启。",
  "Supervisor settings saved": "自愈设置已保存",
  "Failed to load supervisor settings": "读取自愈设置失败",
  "Failed to save supervisor settings": "保存自愈设置失败",
  "Video recovery triggered": "已触发视频恢复",
  "Video recovery failed": "视频恢复失败",
  "Encoded frame heartbeat": "编码帧心跳",
  "Last frame age": "最后编码帧距今",
  "Fan-out subscribers": "视频分发订阅者",
  "Control sessions": "控制会话",
  "Automatic recoveries": "自动恢复次数",
  "Last recovery": "上次恢复",
  Never: "从未",
  "No automatic device reboot is performed in Supervisor Phase 1.": "Supervisor 第一阶段不会自动重启 PicoKVM 整机。",
  "Last recovery reason": "上次恢复原因",
  "Last error": "上次错误",
};

export default function SupervisorContent() {
  const language = useSettingsStore(state => state.language);
  const t = useCallback((text: string) => language === "zh" ? (zh[text] ?? text) : text, [language]);
  const [send] = useJsonRpc();
  const [settings, setSettings] = useState<SupervisorSettings>(defaults);
  const [status, setStatus] = useState<SupervisorStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const refreshStatus = useCallback(() => {
    send("getEnhancedSupervisorStatus", {}, resp => {
      if ("error" in resp) return;
      setStatus(resp.result as SupervisorStatus);
    });
  }, [send]);

  useEffect(() => {
    send("getEnhancedSupervisorSettings", {}, resp => {
      if ("error" in resp) {
        notifications.error(`${t("Failed to load supervisor settings")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      setSettings({ ...defaults, ...(resp.result as SupervisorSettings) });
    });
    refreshStatus();
  }, [send, refreshStatus, t]);

  useEffect(() => {
    const timer = window.setInterval(refreshStatus, 2000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const save = useCallback(() => {
    setSaving(true);
    send("setEnhancedSupervisorSettings", { settings }, resp => {
      setSaving(false);
      if ("error" in resp) {
        notifications.error(`${t("Failed to save supervisor settings")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      setSettings(resp.result as SupervisorSettings);
      notifications.success(t("Supervisor settings saved"));
      refreshStatus();
    });
  }, [send, settings, refreshStatus, t]);

  const recover = useCallback(() => {
    setRecovering(true);
    send("forceEnhancedVideoRecovery", {}, resp => {
      setRecovering(false);
      if ("error" in resp) {
        notifications.error(`${t("Video recovery failed")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      notifications.success(t("Video recovery triggered"));
      window.setTimeout(refreshStatus, 500);
    });
  }, [send, refreshStatus, t]);

  const stateLabel = !status?.video_expected
    ? t("Idle")
    : status?.healthy
      ? t("Healthy")
      : t("Video stalled");

  const lastRecovery = status?.last_recovery_at && !status.last_recovery_at.startsWith("0001-")
    ? new Date(status.last_recovery_at).toLocaleString()
    : t("Never");

  return (
    <div className="space-y-4 pb-[50px] text-slate-900 dark:text-slate-100">
      <SettingsPageHeader
        title={t("Supervisor")}
        description={t("Monitor critical PicoKVM runtime health and perform bounded recovery without automatically rebooting the device")}
      />

      <Alert
        type="info"
        showIcon
        message={t("No automatic device reboot is performed in Supervisor Phase 1.")}
      />

      <SettingsItem
        title={t("Supervisor service")}
        description={t("Continuously evaluate active video sessions and the native encoded-frame heartbeat")}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={settings.enabled}
            onChange={enabled => setSettings(current => ({ ...current, enabled }))}
          />
          <Tag color={status?.video_expected && !status?.healthy ? "red" : status?.running ? "green" : "default"}>
            {stateLabel}
          </Tag>
        </div>
      </SettingsItem>

      <div className="grid gap-3 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700 dark:bg-white/[0.02] md:grid-cols-2">
        <div><span className="text-slate-500 dark:text-slate-400">{t("Encoded frame heartbeat")}</span><div className="font-medium">{status?.total_frames?.toLocaleString() || "0"}</div></div>
        <div><span className="text-slate-500 dark:text-slate-400">{t("Last frame age")}</span><div className="font-medium">{status?.video_expected ? `${Math.max(0, status?.last_frame_age_ms || 0)} ms` : "—"}</div></div>
        <div><span className="text-slate-500 dark:text-slate-400">{t("Fan-out subscribers")}</span><div className="font-medium">{status?.subscribers || 0}</div></div>
        <div><span className="text-slate-500 dark:text-slate-400">{t("Control sessions")}</span><div className="font-medium">{status?.control_sessions || 0}</div></div>
        <div><span className="text-slate-500 dark:text-slate-400">{t("Automatic recoveries")}</span><div className="font-medium">{status?.video_recoveries || 0} ({status?.recoveries_last_hour || 0}/h)</div></div>
        <div><span className="text-slate-500 dark:text-slate-400">{t("Last recovery")}</span><div className="font-medium">{lastRecovery}</div></div>
      </div>

      {status?.last_recovery_reason && (
        <Alert type="warning" showIcon message={`${t("Last recovery reason")}: ${status.last_recovery_reason}`} />
      )}
      {status?.last_error && (
        <Alert type="error" showIcon message={`${t("Last error")}: ${status.last_error}`} />
      )}

      <SettingsItem
        title={t("Automatic video recovery")}
        description={t("If HDMI is ready and clients are active but encoded frames stop, restart only the native video pipeline")}
      >
        <Switch
          checked={settings.auto_recover_video}
          disabled={!settings.enabled}
          onChange={auto_recover_video => setSettings(current => ({ ...current, auto_recover_video }))}
        />
      </SettingsItem>

      <div className="grid gap-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700 dark:bg-white/[0.02] md:grid-cols-3">
        <label className="space-y-1 text-sm">
          <div className="font-medium">{t("Video stall threshold")}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{t("Continuous frame silence required before recovery")}</div>
          <InputNumber
            min={3}
            max={120}
            addonAfter="s"
            className="!w-full"
            value={settings.video_stall_seconds}
            onChange={value => setSettings(current => ({ ...current, video_stall_seconds: value || 8 }))}
          />
        </label>
        <label className="space-y-1 text-sm">
          <div className="font-medium">{t("Recovery cooldown")}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{t("Minimum delay between automatic video recovery attempts")}</div>
          <InputNumber
            min={10}
            max={600}
            addonAfter="s"
            className="!w-full"
            value={settings.recovery_cooldown_seconds}
            onChange={value => setSettings(current => ({ ...current, recovery_cooldown_seconds: value || 30 }))}
          />
        </label>
        <label className="space-y-1 text-sm">
          <div className="font-medium">{t("Maximum recoveries per hour")}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">{t("Rate limit that prevents a persistent fault from causing a recovery loop")}</div>
          <InputNumber
            min={1}
            max={30}
            className="!w-full"
            value={settings.max_video_recoveries_per_hour}
            onChange={value => setSettings(current => ({ ...current, max_video_recoveries_per_hour: value || 6 }))}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="primary" loading={saving} onClick={save}>{t("Save supervisor settings")}</Button>
        <Popconfirm
          title={t("Force native video recovery?")}
          description={t("This performs one stop/start cycle of the native video pipeline. PicoKVM itself will not reboot.")}
          okText={t("Force video recovery")}
          cancelText={language === "zh" ? "取消" : "Cancel"}
          onConfirm={recover}
        >
          <Button loading={recovering}>{t("Force video recovery")}</Button>
        </Popconfirm>
      </div>
    </div>
  );
}
