import { useCallback } from "react";

import { useSettingsStore } from "@/hooks/stores";

const zh: Record<string, string> = {
  Streaming: "流媒体",
  "Multi-viewer video distribution, RTSP, recording and LAN multicast": "多观看者视频分发、RTSP、录制与局域网组播",
  "Video input": "视频输入",
  "Current HDMI capture state": "当前 HDMI 采集状态",
  Controller: "控制端",
  "Normal PicoKVM WebRTC control session": "PicoKVM 标准 WebRTC 控制会话",
  Active: "活动",
  Inactive: "未活动",
  "Read-only viewers": "只读观看者",
  "Independent WebRTC viewers sharing the same hardware encoder": "共享同一硬件编码器的独立 WebRTC 观看者",
  "Open Viewer": "打开观看器",
  "Copy URL": "复制链接",
  RTSP: "RTSP",
  "Read-only H.264/H.265 stream for VLC, ffplay, OBS and NVR software": "面向 VLC、ffplay、OBS 和 NVR 软件的只读 H.264/H.265 视频流",
  Running: "运行中",
  Stopped: "已停止",
  clients: "客户端",
  "Copy RTSP URL": "复制 RTSP 链接",
  "When an API key is configured, use any RTSP username and the PicoKVM API key as the password.": "配置 API Key 后，RTSP 用户名可任意填写，密码使用 PicoKVM API Key。",
  "Zero-reencode recording": "零重编码录制",
  "Write the existing RV1106 H.264/H.265 bitstream directly to local storage": "将现有 RV1106 H.264/H.265 编码码流直接写入本地存储",
  Recording: "录制中",
  "Optional recording filename": "可选录制文件名",
  "Start Recording": "开始录制",
  "Stop Recording": "停止录制",
  "Recordings are elementary .h264/.h265 files in the PicoKVM shared storage. No video re-encoding is performed.": "录制文件为 PicoKVM 共享存储中的 .h264/.h265 原始码流文件，不会进行视频重新编码。",
  "Video fan-out": "视频分发",
  "Subscribers consuming the single RV1106 hardware-encoded stream": "使用同一份 RV1106 硬件编码码流的订阅者",
  subscribers: "订阅者",
  "control WebRTC": "控制 WebRTC",
  "RTP multicast": "RTP 组播",
  "Send one H.264/H.265 RTP stream for many viewers on the same LAN": "在同一局域网内发送单路 H.264/H.265 RTP 组播供多个观看者使用",
  "Stop Multicast": "停止组播",
  "Start Multicast": "启动组播",
  "Copy SDP URL": "复制 SDP 链接",
  packets: "数据包",
  frames: "帧",
  Diagnostics: "诊断",
  "Collect a read-only device snapshot for troubleshooting": "收集只读设备状态快照用于故障排查",
  "Download Diagnostics": "下载诊断",
  "No HDMI signal": "无 HDMI 信号",
};

export function useEnhancedAt() {
  const language = useSettingsStore(state => state.language);
  const $eat = useCallback((text: string) => {
    if (language === "zh") return zh[text] ?? text;
    return text;
  }, [language]);

  return { $eat };
}
