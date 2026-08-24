import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Tag } from "antd";
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";

import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useSettingsStore } from "@/hooks/stores";
import notifications from "@/notifications";

type AuditEntry = {
  seq: number;
  timestamp: string;
  tool: string;
  arguments?: unknown;
  duration_ms: number;
  success: boolean;
  result?: unknown;
  error?: string;
  manual_takeover: boolean;
  local_input_locked: boolean;
};

type AuditSnapshot = {
  path: string;
  entries: AuditEntry[];
};

type DebugBundle = {
  filename: string;
  mime_type: string;
  data_base64: string;
};

function downloadBase64(bundle: DebugBundle) {
  const binary = window.atob(bundle.data_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: bundle.mime_type || "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = bundle.filename || "picokvm-mcp-debug.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MCPAuditPanel() {
  const language = useSettingsStore(state => state.language);
  const [send] = useJsonRpc();
  const [snapshot, setSnapshot] = useState<AuditSnapshot>({ path: "", entries: [] });
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const zh = language === "zh";
  const refresh = useCallback(() => {
    setLoading(true);
    send("getEnhancedMCPAudit", { limit: 100 }, resp => {
      setLoading(false);
      if ("error" in resp) return;
      setSnapshot(resp.result as AuditSnapshot);
    });
  }, [send]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const clear = () => {
    send("clearEnhancedMCPAudit", {}, resp => {
      if ("error" in resp) {
        notifications.error(String(resp.error.data || resp.error.message));
        return;
      }
      setSnapshot(resp.result as AuditSnapshot);
      notifications.success(zh ? "MCP 审计日志已清空" : "MCP audit log cleared");
    });
  };

  const download = () => {
    setDownloading(true);
    send("downloadEnhancedMCPDebugBundle", {}, resp => {
      setDownloading(false);
      if ("error" in resp) {
        notifications.error(String(resp.error.data || resp.error.message));
        return;
      }
      try {
        downloadBase64(resp.result as DebugBundle);
      } catch (error) {
        notifications.error(`${zh ? "下载 Debug 包失败" : "Failed to download debug bundle"}: ${String(error)}`);
      }
    });
  };

  const entries = [...snapshot.entries].reverse();

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700 dark:bg-white/[0.02]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">{zh ? "MCP 完整审计 / Debug" : "Full MCP Audit / Debug"}</div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {zh ? `设备日志：${snapshot.path || "/userdata/picokvm/mcp-audit.jsonl"}` : `Device log: ${snapshot.path || "/userdata/picokvm/mcp-audit.jsonl"}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={refresh}>{zh ? "刷新" : "Refresh"}</Button>
          <Button icon={<DownloadOutlined />} type="primary" loading={downloading} onClick={download}>{zh ? "下载完整 Debug ZIP" : "Download full Debug ZIP"}</Button>
          <Button danger icon={<DeleteOutlined />} onClick={clear}>{zh ? "清空审计" : "Clear audit"}</Button>
        </div>
      </div>

      <Alert
        type="warning"
        showIcon
        message={zh ? "完整审计会保存 MCP 输入的原始内容" : "Full audit stores raw MCP input payloads"}
        description={zh
          ? "为了审计与 Debug，type_text / inject_text 等参数不会脱敏，密码、Token、命令都可能出现在日志和下载的 Debug ZIP 中。右下角日常 Live Log 仍维持原本的脱敏设置。"
          : "For audit/debugging, type_text and inject_text arguments are not redacted. Passwords, tokens and commands may appear in the audit and downloaded Debug ZIP. The normal on-screen Live Log keeps its existing redaction setting."}
      />

      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <Tag>{entries.length}</Tag>
        <span>{zh ? "最近 100 次 MCP 调用；1.5 秒自动刷新" : "Latest 100 MCP calls; refreshed every 1.5 seconds"}</span>
      </div>

      {entries.length === 0 ? (
        <div className="py-4 text-sm text-slate-500">{zh ? "尚无完整 MCP 审计记录" : "No MCP audit records yet"}</div>
      ) : (
        <div className="max-h-[420px] space-y-2 overflow-auto">
          {entries.map(entry => (
            <details key={`${entry.seq}-${entry.timestamp}`} className="rounded border border-slate-200 p-2 dark:border-slate-700">
              <summary className="cursor-pointer select-none text-xs">
                <span className={entry.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-500"}>{entry.success ? "PASS" : "FAIL"}</span>
                <span className="ml-2 font-mono">{entry.tool}</span>
                <span className="ml-2 text-slate-400">{entry.duration_ms} ms</span>
                <span className="ml-2 text-slate-400">{new Date(entry.timestamp).toLocaleTimeString()}</span>
              </summary>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-black/5 p-2 text-[11px] dark:bg-black/30">
                {JSON.stringify(entry, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
