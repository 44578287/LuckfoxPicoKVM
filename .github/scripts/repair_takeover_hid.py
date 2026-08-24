from __future__ import annotations

from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"anchor not found: {label}")
    return text.replace(old, new, 1)


def replace_exact_count(text: str, old: str, new: str, count: int, label: str) -> str:
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f"unexpected anchor count for {label}: expected {count}, got {actual}")
    return text.replace(old, new)


# ---------------------------------------------------------------------------
# 1. Explicit browser takeover must always create a NEW controller session.
# ---------------------------------------------------------------------------
# The old controller PC is intentionally kept alive by the backend for a short
# grace period after another browser takes ownership. Treating that stale PC as
# "healthy" made Use Here navigate away without actually reclaiming ownership;
# it then went black when the delayed close fired. A human click on Use Here is
# authoritative and must create exactly one replacement WebRTC controller.
other_path = Path("ui/src/layout/core/other-session.tsx")
other = other_path.read_text(encoding="utf-8")
other = replace_once(
    other,
    'import { useRTCStore, useSettingsStore, useUiStore } from "@/hooks/stores";',
    'import { useSettingsStore, useUiStore } from "@/hooks/stores";',
    "other-session unused RTC import",
)
other = replace_once(
    other,
    '  const peerConnection = useRTCStore(state => state.peerConnection);\n'
    '  const rpcDataChannel = useRTCStore(state => state.rpcDataChannel);\n',
    '',
    "other-session stale RTC state",
)
old_takeover = '''    const hasHealthyWebRTC =
      peerConnection?.connectionState === "connected" ||
      rpcDataChannel?.readyState === "open";

    if (hasHealthyWebRTC) {
      // The new tab can already own a healthy media/data path by the time the
      // delayed takeover notice is rendered. Rebuilding WebRTC here would kick
      // our own working session and can make the dialog recur.
      navigate("..");
      return;
    }

    // Only create a replacement session when this tab genuinely has no healthy
    // WebRTC path. setupPeerConnection closes a stale local PC before creating
    // exactly one replacement session.
    outletContext?.setupPeerConnection()
      .then(() => navigate(".."))
      .catch(() => setTakingOver(false));'''
new_takeover = '''    // Reaching this route means THIS tab was explicitly displaced by a newer
    // controller. The old PeerConnection may remain "connected" during the
    // backend grace period, but it no longer owns the controller lease. A human
    // click on Use Here is therefore an explicit reclaim transaction: always
    // create one fresh controller session instead of trusting stale RTC state.
    outletContext?.setupPeerConnection()
      .then(() => navigate(".."))
      .catch(() => setTakingOver(false));'''
other = replace_once(other, old_takeover, new_takeover, "explicit WebRTC takeover")
other_path.write_text(other, encoding="utf-8")


# ---------------------------------------------------------------------------
# 2. Coordinate all missing-HID recovery through ONE asynchronous task.
# ---------------------------------------------------------------------------
# UsbGadget already calls onHidDeviceMissing when /dev/hidg* disappears. The
# callback used to launch rpcReinitializeUsbGadget directly while MCP launched a
# second enhanced recovery task for the same error. Those two recovery paths can
# race while configfs is being recreated. Route both callbacks through the same
# serialized enhanced task instead.
usb_path = Path("usb.go")
usb = usb_path.read_text(encoding="utf-8")
old_missing_recovery = '''		go func() {
			usbLogger.Info().Str("device", device).Msg("Attempting to reinitialize USB gadget due to missing HID device")
			if err := rpcReinitializeUsbGadget(); err != nil {
				usbLogger.Error().Err(err).Msg("Failed to auto-reinitialize USB gadget")
			}
		}()'''
new_missing_recovery = '''		status := startUSBReinitializeAsync(
			"hard",
			fmt.Sprintf("automatic recovery after missing HID device %s: %v", device, err),
		)
		usbLogger.Info().
			Str("device", device).
			Str("task_id", status.ID).
			Str("recovery_state", status.State).
			Msg("queued coordinated USB gadget recovery for missing HID device")'''
usb = replace_exact_count(
    usb,
    old_missing_recovery,
    new_missing_recovery,
    2,
    "missing-HID coordinated recovery callbacks",
)
usb_path.write_text(usb, encoding="utf-8")


# ---------------------------------------------------------------------------
# 3. Recovery is not "succeeded" until the configured HID nodes are back.
# ---------------------------------------------------------------------------
async_path = Path("usb_reinit_async.go")
async_src = async_path.read_text(encoding="utf-8")
async_src = replace_once(
    async_src,
    'import (\n\t"fmt"\n\t"sync"\n\t"time"\n)',
    'import (\n\t"fmt"\n\t"os"\n\t"sync"\n\t"time"\n)',
    "USB recovery os import",
)
helper_anchor = 'func runUSBReinitializeTask(initial USBReinitializeStatus) {\n'
helper_code = '''func expectedRecoveredHIDPaths() []string {
	paths := make([]string, 0, 3)
	if config == nil || config.UsbDevices == nil {
		return paths
	}
	if config.UsbDevices.Keyboard {
		paths = append(paths, "/dev/hidg0")
	}
	if config.UsbDevices.AbsoluteMouse {
		paths = append(paths, "/dev/hidg1")
	}
	if config.UsbDevices.RelativeMouse {
		paths = append(paths, "/dev/hidg2")
	}
	return paths
}

func recoveredUSBHIDReady() (bool, string) {
	if gadget == nil {
		return false, "gadget=nil"
	}
	bound, bindErr := gadget.IsUDCBound()
	if bindErr != nil {
		return false, "UDC check failed: " + bindErr.Error()
	}
	if !bound {
		return false, "UDC not bound"
	}
	for _, path := range expectedRecoveredHIDPaths() {
		if _, err := os.Stat(path); err != nil {
			return false, fmt.Sprintf("%s unavailable: %v", path, err)
		}
	}
	state := rpcGetUSBState()
	switch state {
	case "configured", "suspended", "not attached":
		return true, state
	default:
		return false, "USB state=" + state
	}
}

func waitForRecoveredUSBHID(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	lastDetail := "not checked"
	for time.Now().Before(deadline) {
		ready, detail := recoveredUSBHIDReady()
		lastDetail = detail
		if ready {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("USB recovery did not restore configured HID endpoints before %s: %s", timeout, lastDetail)
}

'''
if "func expectedRecoveredHIDPaths()" not in async_src:
    async_src = replace_once(
        async_src,
        helper_anchor,
        helper_code + helper_anchor,
        "USB recovery HID readiness helpers",
    )
old_wait = '''	// A gadget rebind can return before the host-facing state sampler catches up.
	// Bound the wait so MCP never has to hold a request open for it.
	deadline := time.Now().Add(8 * time.Second)
	for err == nil && time.Now().Before(deadline) {
		state := rpcGetUSBState()
		if state == "configured" || state == "not attached" || state == "suspended" { break }
		time.Sleep(200 * time.Millisecond)
	}
'''
new_wait = '''	// A gadget/configfs rebuild can return before /dev/hidg0..2 have been
	// recreated. Do not publish a false "succeeded" state merely because the UDC
	// sampler says not-attached/suspended; wait for every configured HID node and
	// a bound UDC. This prevents the next MCP call from starting another recovery
	// while the previous one is still converging.
	if err == nil {
		err = waitForRecoveredUSBHID(12 * time.Second)
	}
'''
async_src = replace_once(async_src, old_wait, new_wait, "USB recovery readiness wait")
async_path.write_text(async_src, encoding="utf-8")


# ---------------------------------------------------------------------------
# 4. HID failures: reopen transient endpoints first, recover after a threshold.
# ---------------------------------------------------------------------------
# A 150 ms write timeout already causes UsbGadget to close that endpoint FD.
# Starting a full USB rebind on the very first transient error is unnecessarily
# destructive. The helper below gives the next request a chance to reopen the
# endpoint, then starts one coordinated recovery after repeated failures.
policy_path = Path("mcp_hid_recovery_policy.go")
policy_path.write_text('''package kvm

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	mcpHIDFailureWindow            = 5 * time.Second
	mcpHIDTransientRecoveryTrigger = 3
)

type mcpHIDFailureCounter struct {
	Count int
	Last  time.Time
}

var mcpHIDFailures = struct {
	sync.Mutex
	ByEndpoint map[string]mcpHIDFailureCounter
}{ByEndpoint: make(map[string]mcpHIDFailureCounter)}

func mcpHIDMarkSuccess(endpoint string) {
	mcpHIDFailures.Lock()
	delete(mcpHIDFailures.ByEndpoint, endpoint)
	mcpHIDFailures.Unlock()
}

func mcpHIDRecordFailure(endpoint string) int {
	now := time.Now()
	mcpHIDFailures.Lock()
	defer mcpHIDFailures.Unlock()
	entry := mcpHIDFailures.ByEndpoint[endpoint]
	if entry.Last.IsZero() || now.Sub(entry.Last) > mcpHIDFailureWindow {
		entry.Count = 0
	}
	entry.Count++
	entry.Last = now
	mcpHIDFailures.ByEndpoint[endpoint] = entry
	return entry.Count
}

func mcpHIDFailureError(endpoint, operation string, err error) error {
	if err == nil {
		return nil
	}
	if running := getUSBReinitializeStatus(); running.State == "running" {
		return fmt.Errorf(
			"%s failed: %w; USB recovery in progress (task=%s mode=%s), retry after it completes",
			operation, err, running.ID, running.Mode,
		)
	}

	lower := strings.ToLower(err.Error())
	hardFailure := strings.Contains(lower, "no such file") ||
		strings.Contains(lower, "no such device") ||
		strings.Contains(lower, "not initialized")
	transientFailure := strings.Contains(lower, "timed out") ||
		strings.Contains(lower, "deadline") ||
		strings.Contains(lower, "transport endpoint") ||
		strings.Contains(lower, "input/output error") ||
		strings.Contains(lower, "broken pipe") ||
		strings.Contains(lower, "device or resource busy")

	count := mcpHIDRecordFailure(endpoint)
	if !hardFailure && transientFailure && count < mcpHIDTransientRecoveryTrigger {
		return fmt.Errorf(
			"%s failed: %w; transient HID endpoint failure (%d/%d), descriptor was closed and will be reopened on retry",
			operation, err, count, mcpHIDTransientRecoveryTrigger,
		)
	}

	mode := "soft"
	if hardFailure || !transientFailure {
		mode = "hard"
	}
	status := startUSBReinitializeAsync(
		mode,
		fmt.Sprintf("automatic MCP HID recovery after %s on %s: %v", operation, endpoint, err),
	)
	mcpHIDMarkSuccess(endpoint)
	return fmt.Errorf(
		"%s failed: %w; coordinated USB %s recovery started (task=%s), retry after get_usb_reinitialize_status reports completion",
		operation, err, mode, status.ID,
	)
}
''', encoding="utf-8")


# Mouse wrappers use the shared threshold/coordination policy.
mouse_path = Path("mcp_final_reliability.go")
mouse = mouse_path.read_text(encoding="utf-8")
old_mouse = '''func mcpMouseFailureWithRecovery(operation string, result *mcp.CallToolResult, err error) (*mcp.CallToolResult, error) {
	if err == nil {
		return result, nil
	}
	lower := strings.ToLower(err.Error())
	if !strings.Contains(lower, "hidg1") && !strings.Contains(lower, "hidg2") && !strings.Contains(lower, "mouse hid") {
		return nil, err
	}
	mode := "soft"
	if strings.Contains(lower, "no such device") || strings.Contains(lower, "no such file") || strings.Contains(lower, "not initialized") {
		mode = "hard"
	}
	status := startUSBReinitializeAsync(mode, fmt.Sprintf("automatic MCP mouse recovery after %s: %v", operation, err))
	return nil, fmt.Errorf("%s failed: %w; USB %s recovery started (task=%s). Poll get_usb_reinitialize_status until complete, then retry", operation, err, mode, status.ID)
}'''
new_mouse = '''func mcpMouseFailureWithRecovery(operation string, result *mcp.CallToolResult, err error) (*mcp.CallToolResult, error) {
	if err == nil {
		mcpHIDMarkSuccess("hidg1")
		mcpHIDMarkSuccess("hidg2")
		return result, nil
	}
	lower := strings.ToLower(err.Error())
	endpoint := "mouse"
	switch {
	case strings.Contains(lower, "hidg1"), strings.Contains(lower, "absolute mouse"):
		endpoint = "hidg1"
	case strings.Contains(lower, "hidg2"), strings.Contains(lower, "relative mouse"):
		endpoint = "hidg2"
	default:
		return nil, err
	}
	return nil, mcpHIDFailureError(endpoint, operation, err)
}'''
mouse = replace_once(mouse, old_mouse, new_mouse, "MCP mouse recovery policy")
mouse_path.write_text(mouse, encoding="utf-8")


# Keyboard uses the same policy instead of launching hard gadget recreation on
# every EIO/ENOTCONN/transient write failure.
keyboard_path = Path("mcp_keyboard_extended.go")
keyboard = keyboard_path.read_text(encoding="utf-8")
old_keyboard = '''func mcpKeyboardReportV2(modifier uint8, keys []uint8) error {
	if gadget == nil {
		return fmt.Errorf("USB gadget is not initialized")
	}
	if err := rpcKeyboardReport(modifier, keys); err != nil {
		if task := startUSBReinitializeAsync("hard", "automatic HID recovery after keyboard error"); task.ID != "" {
			return fmt.Errorf("keyboard HID unavailable: %w; USB recovery started (task=%s), poll get_usb_reinitialize_status then retry", err, task.ID)
		}
		return fmt.Errorf("keyboard HID unavailable: %w", err)
	}
	return nil
}'''
new_keyboard = '''func mcpKeyboardReportV2(modifier uint8, keys []uint8) error {
	if gadget == nil {
		return fmt.Errorf("USB gadget is not initialized")
	}
	if err := rpcKeyboardReport(modifier, keys); err != nil {
		return mcpHIDFailureError("hidg0", "keyboard HID report", err)
	}
	mcpHIDMarkSuccess("hidg0")
	return nil
}'''
keyboard = replace_once(keyboard, old_keyboard, new_keyboard, "MCP keyboard recovery policy")
keyboard_path.write_text(keyboard, encoding="utf-8")

print("takeover/HID repair complete")
print(f"Other-session bytes: {other_path.stat().st_size}")
print(f"USB bytes: {usb_path.stat().st_size}")
print(f"USB async bytes: {async_path.stat().st_size}")
print(f"HID policy bytes: {policy_path.stat().st_size}")
