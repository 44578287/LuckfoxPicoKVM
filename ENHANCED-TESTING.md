# PicoKVM Enhanced — Real-device validation

This document tracks application-layer tests for `enhanced/dev`. The enhanced build intentionally keeps the official PicoKVM System firmware, kernel, DTS and bootloader unchanged.

## Service map

| Service | Address | Notes |
| --- | --- | --- |
| Normal PicoKVM Web | normal device URL | Existing controller/UI |
| Enhanced LAN API | `http://DEVICE:8080` | API-key protected |
| MCP + raw encoded video | `http://DEVICE:8081` | API-key protected |
| Read-only multi-viewer | `http://DEVICE:8082/` | Up to 8 WebRTC viewers |
| RTP multicast control | `http://DEVICE:8082/rtp/*` | Optional LAN multicast |
| RTSP | `rtsp://DEVICE:8554/live` | H.264/H.265, TCP or UDP unicast |

## Authentication

The enhanced HTTP/MCP/viewer endpoints reuse the PicoKVM API key.

RTSP uses Basic authentication when an API key exists. The username is ignored; the password must be the PicoKVM API key.

## Already validated on real hardware

- Official System 0.1.8 boots the enhanced `kvm_app` OTA normally.
- HDMI input: 1920×1080 @ 60 fps, AVC/H.264.
- Normal PicoKVM WebRTC controller remains active.
- Two simultaneous independent read-only WebRTC viewers work while the normal controller remains connected.
- The two viewers share the same `VideoBroadcaster`; no additional hardware encode is created.

## Multi-viewer test

Open the normal PicoKVM Web UI, then open at least two independent browser windows at:

```text
http://DEVICE:8082/
```

After both connect, query:

```bash
curl -H "Authorization: Bearer API_KEY" http://DEVICE:8082/status
```

Expected key values for two viewers:

```json
{
  "viewers": 2,
  "max_viewers": 8,
  "subscribers": 2
}
```

## RTSP test

Preferred first test is RTP-over-TCP because it avoids LAN UDP/firewall variables:

```bash
ffplay -rtsp_transport tcp rtsp://USER:API_KEY@DEVICE:8554/live
```

Then test normal UDP transport:

```bash
ffplay rtsp://USER:API_KEY@DEVICE:8554/live
```

For VLC, open:

```text
rtsp://DEVICE:8554/live
```

and enter any username plus the PicoKVM API key as password when prompted.

Test RTSP concurrently with the normal controller and two read-only viewers. The encoder must remain single-instance and all consumers must continue receiving video.

## RTP multicast test

Start from the Streaming settings page or with the authenticated HTTP endpoint. Default destination is:

```text
239.255.42.42:5004
TTL 1
```

The SDP is available while multicast is active:

```text
http://DEVICE:8082/rtp.sdp
```

## Zero-reencode recording

The Streaming settings page and MCP can start/stop recording of the existing encoded bitstream. Recording does not decode or re-encode video.

Files are stored in the normal PicoKVM shared folder as:

- `.h264` for AVC/H.264
- `.h265` for HEVC/H.265

The recorder keeps a 128 MiB free-space reserve and stops automatically if the codec changes or the reserve is reached.

Example playback after downloading a recording:

```bash
ffplay recording-YYYYMMDD-HHMMSS.h264
```

or:

```bash
ffplay recording-YYYYMMDD-HHMMSS.h265
```

## Diagnostics

Settings → Streaming → **Download Diagnostics** exports a JSON snapshot containing:

- app/system version
- uptime/load/memory
- `/userdata` storage
- network addresses
- USB gadget state
- host extension-board input state
- current virtual media
- video/fan-out/RTP state
- RTSP state
- read-only RV1106 MCU probe

The same snapshot is exposed through MCP as `get_diagnostics`.

## MCU policy

The MCU probe is read-only. It does not execute `mcuload`, write `/dev/mem`, change pinmux, or claim extension-board GPIOs. Runtime MCU firmware experiments start only after the real-device probe result is collected.
