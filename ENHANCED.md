# PicoKVM Enhanced

This branch is an application-layer enhancement of Luckfox PicoKVM. The initial goal is to keep the vendor System firmware, kernel, DTS and bootloader untouched while extending media distribution, automation/MCP and RV1106 MCU experimentation.

## Current additions

### Encoded video fan-out

The existing `VideoBroadcaster` now exposes a lock-free subscriber count for status/automation.

The MCP listener on TCP 8081 also exposes the existing hardware-encoded elementary video stream:

- `GET /video/stream`
- `GET /video/status`

Both endpoints use the same Bearer API key middleware as the network MCP service. Localhost remains exempt, matching the existing MCP behavior.

The stream is not transcoded or re-encoded. It fans out frames already produced by `kvm_video` through `/var/run/kvm_video.sock`.

Content type is selected from the configured encoder:

- AVC: `video/x-h264`
- HEVC: `video/x-h265`

Example with ffplay:

```bash
ffplay -fflags nobuffer -flags low_delay -headers "Authorization: Bearer YOUR_API_KEY\r\n" -f h264 http://PICOKVM_IP:8081/video/stream
```

For HEVC replace `-f h264` with `-f hevc`.

Status example:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" http://PICOKVM_IP:8081/video/status
```

The status contains codec, WebRTC session count, raw-stream subscriber count, control-session presence and HDMI input state.

## MCP 1.1 enhanced tools

In addition to the upstream HID/screenshot/video-state tools:

- `get_stream_status`
- `get_host_power_state`
- `trigger_power`
- `trigger_reset`
- `send_wol`
- `probe_mcu`

Power/reset and host LED state reuse the existing PicoKVM extension-board RPC/GPIO implementation; no duplicate GPIO mapping is introduced.

## RV1106 MCU work

`mcu_probe.go` is intentionally non-invasive. `probe_mcu` only checks whether the running System exposes:

- `mcuload`
- `/sys/class/remoteproc/remoteproc*`
- `/dev/rpmsg*`
- `/dev/mem`
- the live device tree

It does **not** load MCU firmware, write `/dev/mem`, change pinmux or claim extension-board GPIOs.

The next MCU phase will only be implemented after collecting these probe results from real PicoKVM hardware. Candidate uses are hardware event logging, Linux/application heartbeat, precise power/reset timing and an independent supervisor watchdog.

## Multi-client plan

The upstream code already has a multi-subscriber encoded-frame broadcaster, but WebRTC still routes video through `currentSession` and explicitly closes the previous peer when a new control session connects. Therefore true multi-WebRTC requires separating **viewer sessions** from **control ownership** rather than simply removing the disconnect.

Planned model:

- many WebRTC viewers
- exactly one active HID/control owner
- explicit take/release-control action
- one hardware encode shared by all viewers
- RTSP/RTP sinks fed from the same encoded-frame fan-out

## Validation

`.github/workflows/enhanced-ci.yml` validates:

- `go test ./...`
- `npm ci`
- `npm run build:device`

Do not merge `enhanced/dev` into `luckfox` until CI and device tests pass.
