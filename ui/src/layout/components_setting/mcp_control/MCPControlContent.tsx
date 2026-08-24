import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, InputNumber, Switch, Tag } from "antd";
import { CopyOutlined, DeleteOutlined, PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";

import { SettingsPageHeader } from "@components/Settings/SettingsPageheader";
import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useSettingsStore } from "@/hooks/stores";
import notifications from "@/notifications";
import MCPAuditPanel from "./MCPAuditPanel";

type MCPSettings = {
  lock_local_input_during_action: boolean;
  lock_release_delay_ms: number;
  show_virtual_cursor: boolean;
  cursor_hide_delay_ms: number;
  show_action_hud: boolean;
  show_live_log: boolean;
  log_limit: number;
  redact_typed_text: boolean;
};

type MCPLog = { seq: number; timestamp: string; kind: string; summary: string; success?: boolean };
type MCPStatus = {
  settings: MCPSettings;
  active: boolean;
  current_action?: string;
  local_input_locked: boolean;
  lock_remaining_ms: number;
  manual_takeover: boolean;
  pointer_visible: boolean;
  logs?: MCPLog[];
};

const defaults: MCPSettings = {
  lock_local_input_during_action: true,
  lock_release_delay_ms: 450,
  show_virtual_cursor: true,
  cursor_hide_delay_ms: 1800,
  show_action_hud: true,
  show_live_log: true,
  log_limit: 100,
  redact_typed_text: true,
};

const zh: Record<string, string> = {
  "MCP / AI Control": "MCP / AI 控制",
  "Configure how AI control coexists with a human using the normal PicoKVM Web UI": "配置 AI 控制如何与正在使用 PicoKVM Web 的本地用户协同工作",
  "MCP endpoint": "MCP 连接地址",
  "Use this SSE endpoint with Authorization: Bearer <API key>": "MCP 客户端使用此 SSE 地址，并携带 Authorization: Bearer <API Key>",
  "Copy endpoint": "复制地址",
  "Local input lease": "MCP 操作时暂时锁定本地输入",
  "Only blocks local KVM keyboard/mouse while MCP is actively changing the host; read-only MCP activity does not lock you out": "只有 MCP 正在实际操作键盘/鼠标/电源时才暂时阻止本地 KVM 输入；截图、读取状态等不会锁定你",
  "Release delay": "动作结束后的解锁延迟",
  "Small grace period that prevents the human and AI from colliding between consecutive actions": "连续 AI 动作之间保留一小段缓冲，避免人与 AI 同时操作",
  "AI virtual cursor": "显示 AI 虚拟鼠标",
  "Show a separate AI cursor over the KVM video while MCP mouse operations are occurring": "MCP 操作鼠标时，在 KVM 画面上显示一个与真实鼠标分离的 AI 光标",
  "Cursor hide delay": "AI 光标自动隐藏时间",
  "Action HUD": "显示 AI 操作状态条",
  "Show the current MCP action and whether local input is temporarily leased": "显示当前 MCP 动作以及本地输入是否被暂时锁定",
  "Live action log": "显示实时 AI 操作日志",
  "Show recent keyboard, mouse, power and recovery actions over the KVM view": "在 KVM 画面上实时显示最近的键盘、鼠标、电源与恢复操作",
  "History size": "操作历史条数",
  "Redact typed text": "日志隐藏输入文字内容",
  "Record only text length instead of the actual payload; recommended for passwords and secrets": "日志只记录输入字符数，不记录具体文字；密码和敏感信息场景建议开启",
  "Save MCP settings": "保存 MCP 设置",
  "MCP settings saved": "MCP 设置已保存",
  "Failed to load MCP control state": "读取 MCP 控制状态失败",
  "Failed to save MCP settings": "保存 MCP 设置失败",
  "Manual Takeover": "人工紧急接管",
  "Pause MCP input immediately": "立即暂停 MCP 输入",
  "Resume MCP input": "允许 AI 继续",
  "When Manual Takeover is active, state-changing MCP mouse/keyboard/power actions are rejected until you resume AI control.": "人工接管开启后，MCP 的鼠标、键盘和电源等状态修改操作会被直接拒绝，直到你允许 AI 继续。",
  "Clear log": "清空日志",
  "AI active": "AI 正在操作",
  "AI idle": "AI 空闲",
  "Local input locked": "本地输入暂时锁定",
  "Local input available": "本地输入可用",
  "Recent activity": "最近操作",
  "No MCP actions recorded yet": "尚无 MCP 操作记录",
};

export default function MCPControlContent() {
  const language = useSettingsStore(state => state.language);
  const t = useCallback((s: string) => language === "zh" ? (zh[s] ?? s) : s, [language]);
  const [send] = useJsonRpc();
  const [settings, setSettings] = useState<MCPSettings>(defaults);
  const [status, setStatus] = useState<MCPStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const endpoint = useMemo(() => `http://${window.location.hostname}:8081/sse`, []);

  const refresh = useCallback(() => {
    send("getEnhancedMCPControlStatus", {}, resp => {
      if ("error" in resp) return;
      const next = resp.result as MCPStatus;
      setStatus(next);
      setSettings(current => status === null ? { ...defaults, ...next.settings } : current);
    });
  }, [send, status]);

  useEffect(() => {
    send("getEnhancedMCPControlStatus", {}, resp => {
      if ("error" in resp) {
        notifications.error(`${t("Failed to load MCP control state")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      const next = resp.result as MCPStatus;
      setStatus(next);
      setSettings({ ...defaults, ...next.settings });
    });
  }, [send, t]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const save = () => {
    setSaving(true);
    send("setEnhancedMCPControlSettings", settings, resp => {
      setSaving(false);
      if ("error" in resp) {
        notifications.error(`${t("Failed to save MCP settings")}: ${resp.error.data || resp.error.message}`);
        return;
      }
      const next = resp.result as MCPStatus;
      setStatus(next);
      setSettings(next.settings);
      notifications.success(t("MCP settings saved"));
    });
  };

  const takeover = (enabled: boolean) => {
    send("setEnhancedMCPManualTakeover", { enabled }, resp => {
      if ("error" in resp) {
        notifications.error(String(resp.error.data || resp.error.message));
        return;
      }
      setStatus(resp.result as MCPStatus);
    });
  };

  const clearLog = () => send("clearEnhancedMCPControlLog", {}, resp => {
    if (!("error" in resp)) setStatus(resp.result as MCPStatus);
  });

  const logs = [...(status?.logs || [])].reverse().slice(0, 30);

  return (
    <div className="space-y-4 pb-[50px] text-slate-900 dark:text-slate-100">
      <SettingsPageHeader title={t("MCP / AI Control")} description={t("Configure how AI control coexists with a human using the normal PicoKVM Web UI")} />

      <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700 dark:bg-white/[0.02]">
        <div className="mb-2 font-medium">{t("MCP endpoint")}</div>
        <div className="mb-3 text-xs text-slate-500 dark:text-slate-400">{t("Use this SSE endpoint with Authorization: Bearer <API key>")}</div>
        <div className="flex gap-2"><Input readOnly value={endpoint} /><Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(endpoint); notifications.success(t("Copy endpoint")); }}>{t("Copy endpoint")}</Button></div>
      </div>

      <Alert type={status?.manual_takeover ? "warning" : status?.active ? "info" : "success"} showIcon
        message={status?.manual_takeover ? t("Manual Takeover") : status?.active ? `${t("AI active")}: ${status.current_action || "MCP"}` : t("AI idle")}
        description={status?.local_input_locked ? `${t("Local input locked")} · ${Math.max(0, status.lock_remaining_ms)} ms` : t("Local input available")} />

      <SettingsItem title={t("Local input lease")} description={t("Only blocks local KVM keyboard/mouse while MCP is actively changing the host; read-only MCP activity does not lock you out")}>
        <Switch checked={settings.lock_local_input_during_action} onChange={v => setSettings(s => ({ ...s, lock_local_input_during_action: v }))} />
      </SettingsItem>
      <SettingsItem title={t("Release delay")} description={t("Small grace period that prevents the human and AI from colliding between consecutive actions")}>
        <InputNumber min={0} max={10000} addonAfter="ms" value={settings.lock_release_delay_ms} onChange={v => setSettings(s => ({ ...s, lock_release_delay_ms: v ?? 450 }))} />
      </SettingsItem>
      <SettingsItem title={t("AI virtual cursor")} description={t("Show a separate AI cursor over the KVM video while MCP mouse operations are occurring")}>
        <Switch checked={settings.show_virtual_cursor} onChange={v => setSettings(s => ({ ...s, show_virtual_cursor: v }))} />
      </SettingsItem>
      <SettingsItem title={t("Cursor hide delay")} description="">
        <InputNumber min={100} max={30000} addonAfter="ms" value={settings.cursor_hide_delay_ms} onChange={v => setSettings(s => ({ ...s, cursor_hide_delay_ms: v ?? 1800 }))} />
      </SettingsItem>
      <SettingsItem title={t("Action HUD")} description={t("Show the current MCP action and whether local input is temporarily leased")}>
        <Switch checked={settings.show_action_hud} onChange={v => setSettings(s => ({ ...s, show_action_hud: v }))} />
      </SettingsItem>
      <SettingsItem title={t("Live action log")} description={t("Show recent keyboard, mouse, power and recovery actions over the KVM view")}>
        <Switch checked={settings.show_live_log} onChange={v => setSettings(s => ({ ...s, show_live_log: v }))} />
      </SettingsItem>
      <SettingsItem title={t("History size")} description="">
        <InputNumber min={10} max={500} value={settings.log_limit} onChange={v => setSettings(s => ({ ...s, log_limit: v ?? 100 }))} />
      </SettingsItem>
      <SettingsItem title={t("Redact typed text")} description={t("Record only text length instead of the actual payload; recommended for passwords and secrets")}>
        <Switch checked={settings.redact_typed_text} onChange={v => setSettings(s => ({ ...s, redact_typed_text: v }))} />
      </SettingsItem>

      <div className="flex flex-wrap gap-2">
        <Button type="primary" loading={saving} onClick={save}>{t("Save MCP settings")}</Button>
        {status?.manual_takeover
          ? <Button icon={<PlayCircleOutlined />} onClick={() => takeover(false)}>{t("Resume MCP input")}</Button>
          : <Button danger icon={<PauseCircleOutlined />} onClick={() => takeover(true)}>{t("Pause MCP input immediately")}</Button>}
        <Button icon={<DeleteOutlined />} onClick={clearLog}>{t("Clear log")}</Button>
      </div>
      <Alert type="warning" showIcon message={t("Manual Takeover")} description={t("When Manual Takeover is active, state-changing MCP mouse/keyboard/power actions are rejected until you resume AI control.")} />

      <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-700 dark:bg-white/[0.02]">
        <div className="mb-3 flex items-center justify-between"><span className="font-medium">{t("Recent activity")}</span><Tag>{logs.length}</Tag></div>
        {logs.length === 0 ? <div className="text-sm text-slate-500">{t("No MCP actions recorded yet")}</div> :
          <div className="max-h-64 space-y-1 overflow-auto font-mono text-xs">{logs.map(log => <div key={log.seq} className="flex gap-2 rounded px-2 py-1 odd:bg-slate-100 dark:odd:bg-white/[0.04]"><span className="shrink-0 text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</span><span className="shrink-0 uppercase text-slate-500">{log.kind}</span><span className="break-all">{log.summary}</span>{log.success === false && <span className="text-red-500">FAIL</span>}</div>)}</div>}
      </div>

      <MCPAuditPanel />
    </div>
  );
}
