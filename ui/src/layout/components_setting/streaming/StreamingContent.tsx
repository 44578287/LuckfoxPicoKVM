import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, InputNumber, Tag } from "antd";
import { useReactAt } from "i18n-auto-extractor/react";

import { SettingsPageHeader } from "@components/Settings/SettingsPageheader";
import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import notifications from "@/notifications";

type VideoState = {
  ready: boolean;
  width: number;
  height: number;
  frame_per_second: number;
  error?: string;
};

type RTPStatus = {
  running: boolean;
  address: string;
  ttl: number;
  codec: string;
  packets: number;
  bytes: number;
  last_error?: string;
};

type StreamStatus = {
  codec: string;
  webrtc_sessions: number;
  read_only_viewers: number;
  raw_stream_subscribers: number;
  controller_active: boolean;
  video: VideoState;
  rtp_multicast: RTPStatus;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export default function StreamingContent() {
  const { $at } = useReactAt();
  const [send] = useJsonRpc();
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [rtpAddress, setRtpAddress] = useState("239.255.42.42:5004");
  const [rtpTTL, setRtpTTL] = useState(1);

  const viewerURL = useMemo(() => `http://${window.location.hostname}:8082/`, []);
  const sdpURL = useMemo(() => `http://${window.location.hostname}:8082/rtp.sdp`, []);

  const refresh = useCallback(() => {
    send("getEnhancedStreamStatus", {}, resp => {
      if ("error" in resp) return;
      const next = resp.result as StreamStatus;
      setStatus(next);
      if (next?.rtp_multicast?.address) setRtpAddress(next.rtp_multicast.address);
      if (next?.rtp_multicast?.ttl) setRtpTTL(next.rtp_multicast.ttl);
    });
  }, [send]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const startRTP = useCallback(() => {
    setLoading(true);
    send("startRTPMulticast", { address: rtpAddress, ttl: rtpTTL }, resp => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`Failed to start RTP multicast: ${resp.error.data || "Unknown error"}`);
        return;
      }
      notifications.success("RTP multicast started");
      refresh();
    });
  }, [send, rtpAddress, rtpTTL, refresh]);

  const stopRTP = useCallback(() => {
    setLoading(true);
    send("stopRTPMulticast", {}, resp => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`Failed to stop RTP multicast: ${resp.error.data || "Unknown error"}`);
        return;
      }
      notifications.success("RTP multicast stopped");
      refresh();
    });
  }, [send, refresh]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notifications.success(`${label} copied`);
    } catch {
      notifications.error(`Failed to copy ${label.toLowerCase()}`);
    }
  }, []);

  const videoLabel = status?.video?.ready
    ? `${status.video.width}×${status.video.height} @ ${status.video.frame_per_second} FPS`
    : "No HDMI signal";

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={$at("Streaming")}
        description={$at("Multi-viewer video distribution and LAN multicast")}
      />

      <div className="space-y-4">
        <SettingsItem
          title={$at("Video input")}
          description={$at("Current HDMI capture state")}
        >
          <div className="flex items-center gap-2">
            <Tag color={status?.video?.ready ? "green" : "default"}>{videoLabel}</Tag>
            <Tag>{(status?.codec || "avc").toUpperCase()}</Tag>
          </div>
        </SettingsItem>

        <SettingsItem
          title={$at("Controller")}
          description={$at("Normal PicoKVM WebRTC control session")}
        >
          <Tag color={status?.controller_active ? "green" : "default"}>
            {status?.controller_active ? $at("Active") : $at("Inactive")}
          </Tag>
        </SettingsItem>

        <SettingsItem
          title={$at("Read-only viewers")}
          description={$at("Independent WebRTC viewers sharing the same hardware encoder")}
        >
          <div className="flex items-center gap-2">
            <Tag color={(status?.read_only_viewers || 0) > 0 ? "blue" : "default"}>
              {status?.read_only_viewers || 0} / 8
            </Tag>
            <Button type="primary" onClick={() => window.open(viewerURL, "_blank", "noopener,noreferrer")}>
              {$at("Open Viewer")}
            </Button>
            <Button onClick={() => copyText(viewerURL, "Viewer URL")}>{$at("Copy URL")}</Button>
          </div>
        </SettingsItem>

        <SettingsItem
          title={$at("Video fan-out")}
          description={$at("Subscribers consuming the single RV1106 hardware-encoded stream")}
        >
          <div className="flex items-center gap-2">
            <Tag>{status?.raw_stream_subscribers || 0} {$at("subscribers")}</Tag>
            <Tag>{status?.webrtc_sessions || 0} {$at("control WebRTC")}</Tag>
          </div>
        </SettingsItem>

        <SettingsItem
          title={$at("RTP multicast")}
          description={$at("Send one H.264/H.265 RTP stream for many viewers on the same LAN")}
        >
          <Tag color={status?.rtp_multicast?.running ? "green" : "default"}>
            {status?.rtp_multicast?.running ? $at("Running") : $at("Stopped")}
          </Tag>
        </SettingsItem>

        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={rtpAddress}
              disabled={status?.rtp_multicast?.running}
              onChange={e => setRtpAddress(e.target.value)}
              style={{ maxWidth: 260 }}
              placeholder="239.255.42.42:5004"
            />
            <InputNumber
              min={1}
              max={255}
              value={rtpTTL}
              disabled={status?.rtp_multicast?.running}
              onChange={value => setRtpTTL(value || 1)}
              addonBefore="TTL"
            />
            {status?.rtp_multicast?.running ? (
              <Button danger loading={loading} onClick={stopRTP}>{$at("Stop Multicast")}</Button>
            ) : (
              <Button type="primary" loading={loading} onClick={startRTP}>{$at("Start Multicast")}</Button>
            )}
          </div>

          {status?.rtp_multicast?.running && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{status.rtp_multicast.packets.toLocaleString()} packets</span>
              <span>·</span>
              <span>{formatBytes(status.rtp_multicast.bytes)}</span>
              <Button size="small" onClick={() => copyText(sdpURL, "SDP URL")}>{$at("Copy SDP URL")}</Button>
            </div>
          )}

          {status?.rtp_multicast?.last_error && (
            <div className="text-sm text-red-500">{status.rtp_multicast.last_error}</div>
          )}
        </div>

        <SettingsItem
          title={$at("Diagnostics")}
          description={$at("Collect a read-only device snapshot for troubleshooting")}
        >
          <Button onClick={() => {
            send("getEnhancedDiagnostics", {}, resp => {
              if ("error" in resp) {
                notifications.error(`Diagnostics failed: ${resp.error.data || "Unknown error"}`);
                return;
              }
              const blob = new Blob([JSON.stringify(resp.result, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `picokvm-diagnostics-${Date.now()}.json`;
              link.click();
              URL.revokeObjectURL(url);
              notifications.success("Diagnostics downloaded");
            });
          }}>
            {$at("Download Diagnostics")}
          </Button>
        </SettingsItem>
      </div>
    </div>
  );
}
