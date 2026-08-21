# PicoKVM Enhanced

This branch is an application-layer enhancement of Luckfox PicoKVM. The current goal is to keep the vendor System firmware, kernel, DTS and bootloader untouched while extending media distribution, automation/MCP, remote provisioning/recovery and RV1106 MCU experimentation.

## Current additions

### Encoded video fan-out

The existing `VideoBroadcaster` now exposes a lock-free subscriber count for status/automation.

The fan-out path is deliberately low-latency: each consumer has a small bounded queue (8 encoded frames by default). Slow consumers drop frames instead of blocking the native capture/encoder path, and queued frame references are explicitly released when a consumer disconnects.

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

The status contains codec, normal WebRTC session count, read-only viewer count, encoded fan-out subscriber count, control-session presence, RTP multicast state and HDMI input state.

### Independent multi-client WebRTC viewer

TCP 8082 provides an experimental **read-only** WebRTC viewer:

```text
http://PICOKVM_IP:8082/
```

Open the page, enter the same API key used by MCP/LAN API, then press **Connect**.

This viewer is deliberately separate from the normal PicoKVM Web UI:

- up to 8 viewer PeerConnections may coexist in the current device-local design
- pending/abandoned viewer offers are also counted against that bound and automatically reclaimed
- viewers receive video only
- no HID/RPC/disk/serial control DataChannels are created
- the normal PicoKVM Web page remains the single controller
- viewers and raw HTTP clients share the same `VideoBroadcaster`
- the RV1106 hardware encoder still runs only once

Authenticated viewer status is available at:

```text
GET http://PICOKVM_IP:8082/status
```

This is the first safe step toward a full viewer/operator ownership model without removing the vendor session lock and accidentally allowing multiple browsers to fight over keyboard/mouse input.

### RTP multicast for large LAN viewer counts

The same TCP 8082 service can start one RTP/UDP multicast stream sourced from the hardware encoded fan-out. This is intended for many viewers on the same LAN: PicoKVM sends one network stream and the switch/network replicates it instead of PicoKVM sending one WebRTC copy per viewer.

Default multicast destination:

```text
239.255.42.42:5004, TTL 1
```

Authenticated control endpoints:

- `POST /rtp/start`
- `POST /rtp/stop`
- `GET /rtp/status`

The generated SDP is available while multicast is running:

- `GET /rtp.sdp`

Start with defaults:

```bash
curl -X POST -H "Authorization: Bearer YOUR_API_KEY" http://PICOKVM_IP:8082/rtp/start
```

Or select another IPv4 multicast group/port and TTL:

```bash
curl -X POST -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"address":"239.255.42.42:5004","ttl":1}' \
  http://PICOKVM_IP:8082/rtp/start
```

Then a LAN client can open the SDP, for example:

```bash
ffplay -fflags nobuffer -flags low_delay http://PICOKVM_IP:8082/rtp.sdp
```

RTP uses the existing H.264/H.265 hardware bitstream and Pion packetizers; it does not re-encode. The sender uses a 1200-byte RTP MTU, dynamic payload type 96 and a 90 kHz video clock. If the PicoKVM encoder changes between AVC and HEVC while multicast is active, the RTP sender stops automatically and reports an error so incompatible codec data is never mixed into one RTP session.

Multicast is intentionally opt-in. TTL defaults to 1 so it stays on the local routed segment unless explicitly changed.

### Service layout

| Port | Service | Purpose |
|---:|---|---|
| vendor | Normal PicoKVM Web | KVM control/UI |
| 8080 | Enhanced LAN API | automation API |
| 8081 | Enhanced MCP + raw video | MCP SSE, raw H.264/H.265, media status |
| 8082 | Enhanced Viewer + RTP control | read-only multi-client WebRTC and optional LAN multicast |

## MCP 1.3 enhanced tools

In addition to the upstream HID/screenshot/video-state tools, MCP now exposes:

### Media distribution / status

- `get_stream_status`
- `get_rtp_multicast_status`
- `start_rtp_multicast`
- `stop_rtp_multicast`

### Host power / extension board

- `get_host_power_state`
- `trigger_power`
- `trigger_reset`
- `send_wol`

Power/reset and host LED state reuse the existing PicoKVM extension-board RPC/GPIO implementation; no duplicate GPIO mapping is introduced.

### USB and virtual-media recovery

- `get_usb_state`
- `usb_wakeup`
- `get_virtual_media_state`
- `list_virtual_media`
- `mount_virtual_media`
- `mount_virtual_media_url`
- `unmount_virtual_media`

These tools wrap the existing PicoKVM USB gadget and virtual-media implementation. They do not introduce a second mass-storage stack.

`mount_virtual_media` can mount an existing image from internal PicoKVM storage or the SD card. `mode=auto` treats `.iso` as a CD-ROM and other images as disks.

`mount_virtual_media_url` uses the existing HTTP range-reader/NBD path, so an ISO or disk image can be attached to the target host without first copying the full image onto PicoKVM storage. This is useful for unattended OS installation and rescue media workflows.

A typical remote recovery sequence is:

1. inspect `get_usb_state` and `get_virtual_media_state`
2. list existing media with `list_virtual_media`, or mount a remote image URL
3. reboot/power the attached host using the existing KVM controls
4. interact with BIOS/boot menu through screenshot + HID tools
5. unmount virtual media when finished

Destructive media deletion/formatting is intentionally not exposed through MCP in this phase.

### MCU capability probe

- `probe_mcu`

`mcu_probe.go` is intentionally non-invasive. `probe_mcu` only checks whether the running System exposes:

- `mcuload`
- `/sys/class/remoteproc/remoteproc*`
- `/dev/rpmsg*`
- `/dev/mem`
- the live device tree

It does **not** load MCU firmware, write `/dev/mem`, change pinmux or claim extension-board GPIOs.

The next MCU phase will only be implemented after collecting these probe results from real PicoKVM hardware. Candidate uses are hardware event logging, Linux/application heartbeat, precise power/reset timing and an independent supervisor watchdog.

## Multi-client roadmap

The upstream code already has a multi-subscriber encoded-frame broadcaster, but its normal WebRTC control path still routes video through `currentSession` and explicitly closes the previous peer when a new control session connects.

The new port-8082 viewer bypasses that control-session limitation safely. The next step is to fold the same model into the main UI:

- many WebRTC viewers
- exactly one active HID/control owner
- explicit take/release-control action
- one hardware encode shared by all viewers
- optional RTP multicast for efficient large LAN audiences
- RTSP unicast gateway if needed for legacy players/NVRs
- optional external relay/SFU for large remote viewer counts where multicast is unavailable

## Validation

`.github/workflows/enhanced-ci.yml` validates:

- `go test ./...`
- `npm ci`
- `npm run build:device`
- ARMv7 PicoKVM application build and artifact packaging

Real-device validation should cover the normal vendor control UI first, then two or more read-only viewers, raw HTTP video, RTP multicast, USB state, virtual-media mount/unmount and finally the read-only MCU probe.

Do not merge `enhanced/dev` into `luckfox` until CI and real-device tests pass.
