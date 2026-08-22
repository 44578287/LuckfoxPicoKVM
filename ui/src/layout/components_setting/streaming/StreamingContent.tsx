import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, InputNumber, Tag } from "antd";

import { SettingsPageHeader } from "@components/Settings/SettingsPageheader";
import { SettingsItem } from "@components/Settings/SettingsView";
import { useJsonRpc } from "@/hooks/useJsonRpc";
import notifications from "@/notifications";
import { useEnhancedAt } from "@/locales/enhanced";
import WHEPSourceCard from "@/layout/components_setting/streaming/WHEPSourceCard";

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

type RTSPStatus = {
  running: boolean;
  address: string;
  path: string;
  codec: string;
  clients: number;
  max_clients: number;
  last_error?: string;
};

type RecordingStatus = {
  running: boolean;
  filename?: string;
  path?: string;
  codec?: string;
  started_at?: string;
  frames: number;
  bytes: number;
  last_error?: string;
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
  const { $eat } = useEnhancedAt();
  const [send] = useJsonRpc();
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [rtspStatus, setRtspStatus] = useState<RTSPStatus | null>(null);
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingFilename, setRecordingFilename] = useState("");
  const [rtpAddress, setRtpAddress] = useState("239.255.42.42:5004");
  const [rtpTTL, setRtpTTL] = useState(1);

  const viewerURL = useMemo(() => `http://${window.location.hostname}:8082/`, []);
  const sdpURL = useMemo(() => `http://${window.location.hostname}:8082/rtp.sdp`, []);
  const rtspURL = useMemo(() => `rtsp://${window.location.hostname}:8554/live`, []);

  const refresh = useCallback(() => {
    send("getEnhancedStreamStatus", {}, resp => {
      if ("error" in resp) return;
      const next = resp.result as StreamStatus;
      setStatus(next);
      if (next?.rtp_multicast?.address) setRtpAddress(next.rtp_multicast.address);
      if (next?.rtp_multicast?.ttl) setRtpTTL(next.rtp_multicast.ttl);
    });
    send("getRTSPStatus", {}, resp => {
      if ("error" in resp) return;
      setRtspStatus(resp.result as RTSPStatus);
    });
    send("getEncodedRecordingStatus", {}, resp => {
      if ("error" in resp) return;
      setRecordingStatus(resp.result as RecordingStatus);
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
        notifications.error(`${$eat("Failed to start RTP multicast")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      notifications.success($eat("RTP multicast started"));
      refresh();
    });
  }, [send, rtpAddress, rtpTTL, refresh, $eat]);

  const stopRTP = useCallback(() => {
    setLoading(true);
    send("stopRTPMulticast", {}, resp => {
      setLoading(false);
      if ("error" in resp) {
        notifications.error(`${$eat("Failed to stop RTP multicast")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      notifications.success($eat("RTP multicast stopped"));
      refresh();
    });
  }, [send, refresh, $eat]);

  const startRecording = useCallback(() => {
    setRecordingLoading(true);
    send("startEncodedRecording", { filename: recordingFilename }, resp => {
      setRecordingLoading(false);
      if ("error" in resp) {
        notifications.error(`${$eat("Failed to start recording")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      setRecordingStatus(resp.result as RecordingStatus);
      setRecordingFilename("");
      notifications.success($eat("Zero-reencode recording started"));
      refresh();
    });
  }, [send, recordingFilename, refresh, $eat]);

  const stopRecording = useCallback(() => {
    setRecordingLoading(true);
    send("stopEncodedRecording", {}, resp => {
      setRecordingLoading(false);
      if ("error" in resp) {
        notifications.error(`${$eat("Failed to stop recording")}: ${resp.error.data || $eat("Unknown error")}`);
        return;
      }
      setRecordingStatus(resp.result as RecordingStatus);
      notifications.success($eat("Recording flushed and stopped"));
      refresh();
    });
  }, [send, refresh, $eat]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notifications.success(`${$eat("Copied")}: ${$eat(label)}`);
    } catch {
      notifications.error(`${$eat("Copy failed")}: ${$eat(label)}`);
    }
  }, [$eat]);

  const videoLabel = status?.video?.ready
    ? `${status.video.width}×${status.video.height} @ ${status.video.frame_per_second} FPS`
    : $eat("No HDMI signal");

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={$eat("Streaming")}
        description={$eat("Multi-viewer video distribution, RTSP, recording and LAN multicast")}
      />

      <div className="space-y-4">
        <SettingsItem
          title={$eat("Video input")}
          description={$eat("Current HDMI capture state")}
        >
          <div className="flex items-center gap-2">
            <Tag color={status?.video?.ready ? "green" : "default"}>{videoLabel}</Tag>
            <Tag>{(status?.codec || "avc").toUpperCase()}</Tag>
          </div>
        </SettingsItem>

        <SettingsItem
          title={$eat("Controller")}
          description={$eat("Normal PicoKVM WebRTC control session")}
        >
          <Tag color={status?.controller_active ? "green" : "default"}>
            {status?.controller_active ? $eat("Active") : $eat("Inactive")}
          </Tag>
        </SettingsItem>

        <SettingsItem
          title={$eat("Read-only viewers")}
          description={$eat("Independent WebRTC viewers sharing the same hardware encoder")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={(status?.read_only_viewers || 0) > 0 ? "blue" : "default"}>
              {status?.read_only_viewers || 0} / 8
            </Tag>
            <Button type="primary" onClick={() => window.open(viewerURL, "_blank", "noopener,noreferrer")}>
              {$eat("Open Viewer")}
            </Button>
            <Button onClick={() => copyText(viewerURL, "Viewer URL")}>{$eat("Copy URL")}</Button>
          </div>
        </SettingsItem>

        <WHEPSourceCard />

        <SettingsItem
          title={$eat("RTSP")}
          description={$eat("Read-only H.264/H.265 stream for VLC, ffplay, OBS and NVR software")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={rtspStatus?.running ? "green" : "default"}>
              {rtspStatus?.running ? $eat("Running") : $eat("Stopped")}
            </Tag>
            <Tag>{rtspStatus?.clients || 0} / {rtspStatus?.max_clients || 8} {$eat("clients")}</Tag>
            <Button onClick={() => copyText(rtspURL, "RTSP URL")}>{$eat("Copy RTSP URL")}</Button>
          </div>
        </SettingsItem>

        <div className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-700">
          <div className="break-all font-mono">{rtspURL}</div>
          <div className="text-slate-500 dark:text-slate-400">
            {$eat("When an API key is configured, use any RTSP username and the PicoKVM API key as the password.")}
          </div>
          {rtspStatus?.last_error && (
            <div className="text-red-500">{rtspStatus.last_error}</div>
          )}
        </div>

        <SettingsItem
          title={$eat("Zero-reencode recording")}
          description={$eat("Write the existing RV1106 H.264/H.265 bitstream directly to local storage")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag color={recordingStatus?.running ? "red" : "default"}>
              {recordingStatus?.running ? $eat("Recording") : $eat("Stopped")}
            </Tag>
            {recordingStatus?.filename && <Tag>{recordingStatus.filename}</Tag>}
            {recordingStatus?.running && <Tag>{formatBytes(recordingStatus.bytes || 0)}</Tag>}
          </div>
        </SettingsItem>

        <div className="space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          {!recordingStatus?.running ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={recordingFilename}
                onChange={e => setRecordingFilename(e.target.value)}
                style={{ maxWidth: 280 }}
                placeholder={$eat("Optional recording filename")}
              />
              <Button type="primary" danger loading={recordingLoading} onClick={startRecording}>
                {$eat("Start Recording")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button danger loading={recordingLoading} onClick={stopRecording}>{$eat("Stop Recording")}</Button>
              <span className="text-sm">{(recordingStatus.frames || 0).toLocaleString()} {$eat("frames")} · {formatBytes(recordingStatus.bytes || 0)}</span>
            </div>
          )}
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {$eat("Recordings are elementary .h264/.h265 files in the PicoKVM shared storage. No video re-encoding is performed.")}
          </div>
          {recordingStatus?.last_error && (
            <div className="text-sm text-red-500">{recordingStatus.last_error}</div>
          )}
        </div>

        <SettingsItem
          title={$eat("Video fan-out")}
          description={$eat("Subscribers consuming the single RV1106 hardware-encoded stream")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{status?.raw_stream_subscribers || 0} {$eat("subscribers")}</Tag>
            <Tag>{status?.webrtc_sessions || 0} {$eat("control WebRTC")}</Tag>
          </div>
        </SettingsItem>

        <SettingsItem
          title={$eat("RTP multicast")}
          description={$eat("Send one H.264/H.265 RTP stream for many viewers on the same LAN")}
        >
          <Tag color={status?.rtp_multicast?.running ? "green" : "default"}>
            {status?.rtp_multicast?.running ? $eat("Running") : $eat("Stopped")}
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
              <Button danger loading={loading} onClick={stopRTP}>{$eat("Stop Multicast")}</Button>
            ) : (
              <Button type="primary" loading={loading} onClick={startRTP}>{$eat("Start Multicast")}</Button>
            )}
          </div>

          {status?.rtp_multicast?.running && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>{status.rtp_multicast.packets.toLocaleString()} {$eat("packets")}</span>
              <span>·</span>
              <span>{formatBytes(status.rtp_multicast.bytes)}</span>
              <Button size="small" onClick={() => copyText(sdpURL, "SDP URL")}>{$eat("Copy SDP URL")}</Button>
            </div>
          )}

          {status?.rtp_multicast?.last_error && (
            <div className="text-sm text-red-500">{status.rtp_multicast.last_error}</div>
          )}
        </div>

        <SettingsItem
          title={$eat("Diagnostics")}
          description={$eat("Collect a read-only device snapshot for troubleshooting")}
        >
          <Button onClick={() => {
            send("getEnhancedDiagnostics", {}, resp => {
              if ("error" in resp) {
                notifications.error(`${$eat("Diagnostics failed")}: ${resp.error.data || $eat("Unknown error")}`);
                return;
              }
              const blob = new Blob([JSON.stringify(resp.result, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `picokvm-diagnostics-${Date.now()}.json`;
              link.click();
              URL.revokeObjectURL(url);
              notifications.success($eat("Diagnostics downloaded"));
            });
          }}>
            {$eat("Download Diagnostics")}
          </Button>
        </SettingsItem>
      </div>
    </div>
  );
}
