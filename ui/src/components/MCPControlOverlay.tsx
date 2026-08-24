import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Tag } from "antd";
import { PauseCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";

import { useJsonRpc } from "@/hooks/useJsonRpc";
import { useSettingsStore } from "@/hooks/stores";

type MCPSettings = {
  lock_local_input_during_action: boolean;
  show_virtual_cursor: boolean;
  show_action_hud: boolean;
  show_live_log: boolean;
};
type MCPLog = { seq: number; timestamp: string; kind: string; summary: string; success?: boolean };
type MCPStatus = {
  settings: MCPSettings;
  active: boolean;
  current_action?: string;
  local_input_locked: boolean;
  lock_remaining_ms: number;
  manual_takeover: boolean;
  pointer_hid_x: number;
  pointer_hid_y: number;
  pointer_visible: boolean;
  logs?: MCPLog[];
};

export default function MCPControlOverlay({
  videoRef,
  containerRef,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  containerRef: React.RefObject<HTMLDivElement>;
}) {
  const [send] = useJsonRpc();
  const language = useSettingsStore(state => state.language);
  const [status, setStatus] = useState<MCPStatus | null>(null);
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    send("getEnhancedMCPControlStatus", {}, resp => {
      if ("error" in resp) return;
      setStatus(resp.result as MCPStatus);
    });
  }, [send]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 150);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onResize = () => setTick(v => v + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Capture browser keyboard events before the normal PicoKVM document-level
  // HID handlers while preserving normal typing in settings/input fields.
  useEffect(() => {
    if (!status?.local_input_locked) return;
    const blockKeyboard = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", blockKeyboard, true);
    window.addEventListener("keyup", blockKeyboard, true);
    return () => {
      window.removeEventListener("keydown", blockKeyboard, true);
      window.removeEventListener("keyup", blockKeyboard, true);
    };
  }, [status?.local_input_locked]);

  const cursor = useMemo(() => {
    if (!status?.pointer_visible || !status.settings?.show_virtual_cursor) return null;
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || !container || video.clientWidth <= 0 || video.clientHeight <= 0) return null;
    const vr = video.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const x = vr.left - cr.left + (Math.max(0, Math.min(32767, status.pointer_hid_x)) / 32767) * vr.width;
    const y = vr.top - cr.top + (Math.max(0, Math.min(32767, status.pointer_hid_y)) / 32767) * vr.height;
    return { x, y };
  }, [status, videoRef, containerRef]);

  const takeover = (enabled: boolean) => {
    send("setEnhancedMCPManualTakeover", { enabled }, resp => {
      if (!("error" in resp)) setStatus(resp.result as MCPStatus);
    });
  };

  const isZh = language === "zh";
  const logs = [...(status?.logs || [])].reverse().slice(0, 6);
  if (!status) return null;

  return (
    <>
      {/* Mouse shield blocks only the video interaction surface, not settings or takeover controls. */}
      {status.local_input_locked && (
        <div
          className="absolute inset-0 z-[35] cursor-not-allowed"
          onContextMenu={e => e.preventDefault()}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); }}
          onMouseUp={e => { e.preventDefault(); e.stopPropagation(); }}
          onMouseMove={e => { e.preventDefault(); e.stopPropagation(); }}
          onWheel={e => { e.preventDefault(); e.stopPropagation(); }}
        />
      )}

      {cursor && (
        <div className="pointer-events-none absolute z-[45]" style={{ left: cursor.x, top: cursor.y, transform: "translate(-4px,-4px)" }}>
          <div className="relative h-5 w-5">
            <div className="absolute left-0 top-0 h-4 w-4 rotate-45 rounded-tl-[2px] border-l-2 border-t-2 border-white bg-blue-500 shadow-[0_0_0_1px_rgba(0,0,0,.8)]" />
            <div className="absolute left-4 top-3 rounded bg-blue-600 px-1 py-[1px] text-[9px] font-bold leading-none text-white shadow">AI</div>
          </div>
        </div>
      )}

      {status.settings?.show_action_hud && (status.active || status.local_input_locked || status.manual_takeover) && (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-lg border border-white/20 bg-black/75 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-md">
          <Tag color={status.manual_takeover ? "orange" : status.active ? "blue" : "default"} className="!m-0">
            {status.manual_takeover ? (isZh ? "人工接管" : "Manual") : status.active ? (isZh ? "AI 操作中" : "AI active") : (isZh ? "AI 缓冲" : "AI lease")}
          </Tag>
          <span className="max-w-[42vw] truncate">{status.manual_takeover ? (isZh ? "MCP 输入已暂停" : "MCP input paused") : status.current_action || (isZh ? "正在等待动作结束" : "waiting for action release")}</span>
          {status.local_input_locked && <span className="text-amber-300">{Math.max(0, status.lock_remaining_ms)}ms</span>}
          {status.manual_takeover
            ? <Button size="small" type="text" icon={<PlayCircleOutlined />} className="!text-white" onClick={() => takeover(false)}>{isZh ? "允许 AI" : "Resume"}</Button>
            : <Button size="small" danger type="text" icon={<PauseCircleOutlined />} className="!text-red-300" onClick={() => takeover(true)}>{isZh ? "接管" : "Take over"}</Button>}
        </div>
      )}

      {status.settings?.show_live_log && logs.length > 0 && (
        <div className="pointer-events-none absolute bottom-3 right-3 z-[50] w-[min(440px,42vw)] rounded-lg border border-white/15 bg-black/70 p-2 text-[11px] text-white shadow-lg backdrop-blur-md">
          <div className="mb-1 font-semibold text-white/80">{isZh ? "AI 操作日志" : "AI action log"}</div>
          <div className="space-y-[2px] font-mono">{logs.map(log => (
            <div key={log.seq} className="flex gap-2 overflow-hidden">
              <span className="shrink-0 text-white/45">{new Date(log.timestamp).toLocaleTimeString()}</span>
              <span className="shrink-0 uppercase text-blue-300">{log.kind}</span>
              <span className="truncate text-white/90">{log.summary}</span>
              {log.success === false && <span className="shrink-0 text-red-400">FAIL</span>}
            </div>
          ))}</div>
        </div>
      )}
    </>
  );
}
