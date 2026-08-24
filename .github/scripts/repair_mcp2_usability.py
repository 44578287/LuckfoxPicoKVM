from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"anchor not found: {label}")
    return text.replace(old, new, 1)


mcp_v2 = r'''package kvm

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

const mcpEnhancedProtocolVersion = "2.0.0-enhanced"

type MCPRuntimeV2Status struct {
	Timestamp        string                    `json:"timestamp"`
	ProtocolVersion  string                    `json:"protocol_version"`
	AppVersion       string                    `json:"app_version"`
	InputReady       bool                      `json:"input_ready"`
	VisualReady      bool                      `json:"visual_ready"`
	ControlReady     bool                      `json:"control_ready"`
	Blockers         []string                  `json:"blockers,omitempty"`
	HID              MCPHIDStatus              `json:"hid"`
	USBRecovery      USBReinitializeStatus     `json:"usb_recovery"`
	TextInjection    MCPTextInjectionStatus    `json:"text_injection"`
	Control          EnhancedMCPControlStatus  `json:"control"`
	Supervisor       interface{}               `json:"supervisor"`
	Video            VideoInputState           `json:"video"`
	ControllerActive bool                      `json:"web_controller_active"`
}

type MCPInputReleaseStatus struct {
	Success               bool                  `json:"success"`
	KeyboardReleased      bool                  `json:"keyboard_released"`
	AbsoluteMouseReleased bool                  `json:"absolute_mouse_released"`
	RelativeMouseReleased bool                  `json:"relative_mouse_released"`
	Errors                map[string]string     `json:"errors,omitempty"`
	Recovery              USBReinitializeStatus `json:"recovery"`
}

type MCPEnsureHIDStatus struct {
	State    string                 `json:"state"`
	Ready    bool                   `json:"ready"`
	Blockers []string               `json:"blockers,omitempty"`
	HID      MCPHIDStatus           `json:"hid"`
	Recovery USBReinitializeStatus  `json:"recovery"`
}

type MCPV2Capabilities struct {
	ProtocolVersion string                 `json:"protocol_version"`
	AppVersion      string                 `json:"app_version"`
	Tools           map[string][]string    `json:"tools"`
	Limits          map[string]interface{} `json:"limits"`
	RecoveryPolicy  []string               `json:"recovery_policy"`
	RecommendedFlow []string               `json:"recommended_flow"`
	Runtime         MCPRuntimeV2Status     `json:"runtime"`
}

func safeMCPHIDStatus() MCPHIDStatus {
	if gadget != nil {
		return getMCPHIDStatus()
	}
	st := MCPHIDStatus{
		USBState:   "unavailable",
		Configured: map[string]bool{},
		Recovery:   getUSBReinitializeStatus(),
	}
	if config != nil && config.UsbDevices != nil {
		st.Configured["keyboard"] = config.UsbDevices.Keyboard
		st.Configured["absolute_mouse"] = config.UsbDevices.AbsoluteMouse
		st.Configured["relative_mouse"] = config.UsbDevices.RelativeMouse
		st.Configured["mass_storage"] = config.UsbDevices.MassStorage
		st.Configured["mtp"] = config.UsbDevices.Mtp
		st.Configured["audio"] = config.UsbDevices.Audio
	}
	st.Endpoints = []MCPHIDEndpointStatus{
		hidEndpointStatus("keyboard", "/dev/hidg0", "hid.usb0"),
		hidEndpointStatus("absolute_mouse", "/dev/hidg1", "hid.usb1"),
		hidEndpointStatus("relative_mouse", "/dev/hidg2", "hid.usb2"),
	}
	return st
}

func mcpConfiguredEndpointProblem(st MCPHIDStatus, endpointName string) []string {
	if !st.Configured[endpointName] {
		return nil
	}
	for _, ep := range st.Endpoints {
		if ep.Name != endpointName {
			continue
		}
		var out []string
		if !ep.FunctionExists {
			out = append(out, endpointName+":configfs_function_missing")
		}
		if !ep.ConfigLinkExists {
			out = append(out, endpointName+":config_link_missing")
		}
		if !ep.DeviceExists {
			out = append(out, endpointName+":device_node_missing")
		}
		return out
	}
	return []string{endpointName + ":endpoint_status_missing"}
}

func mcpHIDStructuralProblems(st MCPHIDStatus) []string {
	var blockers []string
	if gadget == nil {
		blockers = append(blockers, "usb_gadget_unavailable")
	}
	if !st.UDCBound {
		blockers = append(blockers, "udc_not_bound")
	}
	for _, name := range []string{"keyboard", "absolute_mouse", "relative_mouse"} {
		blockers = append(blockers, mcpConfiguredEndpointProblem(st, name)...)
	}
	sort.Strings(blockers)
	return blockers
}

func mcpRuntimeStatusV2() MCPRuntimeV2Status {
	hid := safeMCPHIDStatus()
	control := getEnhancedMCPControlStatus()
	blockers := mcpHIDStructuralProblems(hid)

	inputReady := len(blockers) == 0 && hid.USBState == "configured"
	if len(blockers) == 0 && hid.USBState != "configured" {
		blockers = append(blockers, "usb_state:"+hid.USBState)
	}
	usbRecovery := getUSBReinitializeStatus()
	if usbRecovery.State == "running" {
		blockers = append(blockers, "usb_recovery_running:"+usbRecovery.ID)
		inputReady = false
	}
	text := getMCPTextInjectionStatus()
	if text.State == "running" {
		blockers = append(blockers, "text_injection_running:"+text.ID)
	}
	if control.ManualTakeover {
		blockers = append(blockers, "manual_takeover_active")
		inputReady = false
	}
	visualReady := lastVideoState.Ready && lastVideoState.Width > 0 && lastVideoState.Height > 0
	if !visualReady {
		blockers = append(blockers, "video_input_not_ready")
	}
	controlReady := inputReady && visualReady && !control.ManualTakeover
	sort.Strings(blockers)

	return MCPRuntimeV2Status{
		Timestamp:        time.Now().Format(time.RFC3339Nano),
		ProtocolVersion:  mcpEnhancedProtocolVersion,
		AppVersion:       builtAppVersion,
		InputReady:       inputReady,
		VisualReady:      visualReady,
		ControlReady:     controlReady,
		Blockers:         blockers,
		HID:              hid,
		USBRecovery:      usbRecovery,
		TextInjection:    text,
		Control:          control,
		Supervisor:       getEnhancedSupervisorStatus(),
		Video:            lastVideoState,
		ControllerActive: currentSession != nil,
	}
}

func handleGetMCPRuntimeStatusV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(mcpRuntimeStatusV2(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetMCPV2Capabilities(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	tools := map[string][]string{
		"bootstrap": {"get_mcp_capabilities", "get_mcp_runtime_status", "get_hid_status", "ensure_hid_ready", "get_diagnostics"},
		"vision": {"capture_screenshot", "get_video_state", "get_stream_status"},
		"mouse": {"mouse_move_screen", "mouse_click_screen", "mouse_double_click_screen", "mouse_drag_screen", "mouse_move_absolute", "mouse_move_relative", "mouse_button", "mouse_scroll"},
		"keyboard": {"keyboard_key", "keyboard_combo", "keyboard_event", "keyboard_release_all", "input_release_all", "type_text", "inject_text", "get_text_injection_status", "cancel_text_injection"},
		"usb_recovery": {"get_usb_state", "usb_wakeup", "usb_reinitialize_soft", "usb_reinitialize_hard", "get_usb_reinitialize_status", "ensure_hid_ready"},
		"host": {"get_host_power_state", "trigger_power", "trigger_power_long", "trigger_power_for", "trigger_reset", "trigger_reset_for", "send_wol"},
		"virtual_media": {"get_virtual_media_state", "list_virtual_media", "mount_virtual_media", "mount_virtual_media_url", "unmount_virtual_media"},
		"media": {"get_stream_codec", "set_stream_codec", "get_rtsp_status", "get_rtp_multicast_status", "start_rtp_multicast", "stop_rtp_multicast", "get_recording_status", "start_recording", "stop_recording"},
		"supervisor": {"get_supervisor_status", "get_supervisor_settings", "force_video_recovery"},
	}
	for _, names := range tools {
		sort.Strings(names)
	}
	caps := MCPV2Capabilities{
		ProtocolVersion: mcpEnhancedProtocolVersion,
		AppVersion:      builtAppVersion,
		Tools:           tools,
		Limits: map[string]interface{}{
			"text_hid_charset":           "US-ASCII; arbitrary Unicode requires a host IME/clipboard agent",
			"async_text_max_characters": 32768,
			"hid_absolute_range":         "0..32767",
			"relative_mouse_per_report":  "-127..127",
			"normal_web_controller":      "single controller; read-only viewers are separate",
			"manual_takeover_priority":   "local human always wins over state-changing MCP input",
		},
		RecoveryPolicy: []string{
			"Transient HID write failures close the stale endpoint FD so the next request can reopen it.",
			"Repeated transient failures escalate to one serialized USB recovery task.",
			"Missing HID device/configfs endpoints escalate to hard gadget recovery.",
			"Recovery is complete only after UDC binding and all configured HID nodes are visible again.",
			"input_release_all is the emergency brake for stuck keyboard modifiers/keys and mouse buttons.",
		},
		RecommendedFlow: []string{
			"1. get_mcp_runtime_status",
			"2. if input_ready=false, call ensure_hid_ready and poll get_usb_reinitialize_status when a task is returned",
			"3. capture_screenshot",
			"4. use screen-pixel mouse tools plus keyboard tools",
			"5. use inject_text for long text and poll get_text_injection_status",
			"6. after an interrupted gesture/typing operation, call input_release_all before continuing",
		},
		Runtime: mcpRuntimeStatusV2(),
	}
	data, err := json.MarshalIndent(caps, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleEnsureHIDReadyV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	st := safeMCPHIDStatus()
	out := MCPEnsureHIDStatus{HID: st, Recovery: getUSBReinitializeStatus()}
	structural := mcpHIDStructuralProblems(st)
	if len(structural) == 0 && st.USBState == "configured" {
		out.State = "ready"
		out.Ready = true
		data, _ := json.MarshalIndent(out, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}

	if out.Recovery.State == "running" {
		out.State = "recovery_running"
		out.Blockers = structural
		data, _ := json.MarshalIndent(out, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}

	// A physically detached/suspended host is not a gadget corruption signal.
	// Do not flap configfs in a recovery loop just because no host is configured.
	if len(structural) == 0 && (st.USBState == "not attached" || st.USBState == "suspended") {
		out.State = "waiting_for_host"
		out.Blockers = []string{"usb_state:" + st.USBState}
		data, _ := json.MarshalIndent(out, "", "  ")
		return mcp.NewToolResultText(string(data)), nil
	}

	mode := "soft"
	blockers := append([]string(nil), structural...)
	if len(structural) > 0 {
		mode = "hard"
	} else {
		blockers = append(blockers, "usb_state:"+st.USBState)
	}
	out.State = "recovery_started"
	out.Blockers = blockers
	out.Recovery = startUSBReinitializeAsync(mode, "MCP 2.0 ensure_hid_ready preflight")
	data, _ := json.MarshalIndent(out, "", "  ")
	return mcp.NewToolResultText(string(data)), nil
}

func handleInputReleaseAllV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	out := MCPInputReleaseStatus{Errors: map[string]string{}}

	// Clear the automation-side state first so a later retry cannot re-assert a
	// stale modifier/key even if the current HID write fails.
	mcpKeyboardAutomationState.Lock()
	mcpKeyboardAutomationState.modifier = 0
	clear(mcpKeyboardAutomationState.keys)
	mcpKeyboardAutomationState.Unlock()

	if gadget == nil {
		out.Errors["usb"] = "USB gadget is not initialized"
	} else {
		if config != nil && config.UsbDevices != nil && config.UsbDevices.Keyboard {
			if err := rpcKeyboardReport(0, nil); err != nil {
				out.Errors["keyboard"] = err.Error()
			} else {
				out.KeyboardReleased = true
			}
		} else {
			out.KeyboardReleased = true
		}

		x, y, _ := mcpCurrentPointer()
		mcpPointerState.Lock()
		mcpPointerState.buttons = 0
		mcpPointerState.Unlock()

		if config != nil && config.UsbDevices != nil && config.UsbDevices.AbsoluteMouse {
			if err := rpcAbsMouseReport(x, y, 0); err != nil {
				out.Errors["absolute_mouse"] = err.Error()
			} else {
				out.AbsoluteMouseReleased = true
			}
		} else {
			out.AbsoluteMouseReleased = true
		}

		if config != nil && config.UsbDevices != nil && config.UsbDevices.RelativeMouse {
			if err := rpcRelMouseReport(0, 0, 0); err != nil {
				out.Errors["relative_mouse"] = err.Error()
			} else {
				out.RelativeMouseReleased = true
			}
		} else {
			out.RelativeMouseReleased = true
		}
	}

	out.Success = len(out.Errors) == 0
	if !out.Success {
		parts := make([]string, 0, len(out.Errors))
		for name, message := range out.Errors {
			parts = append(parts, name+"="+message)
		}
		sort.Strings(parts)
		out.Recovery = startUSBReinitializeAsync("hard", "input_release_all could not release every HID endpoint: "+strings.Join(parts, "; "))
	} else {
		out.Recovery = getUSBReinitializeStatus()
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	return mcp.NewToolResultText(string(data)), nil
}

func registerMCPV2UsabilityTools(s *server.MCPServer) {
	s.AddTool(readOnlyMCPTool(
		"get_mcp_capabilities",
		"Discover PicoKVM Enhanced MCP 2.0 control, recovery and media capabilities plus current runtime readiness",
	), handleGetMCPV2Capabilities)

	s.AddTool(readOnlyMCPTool(
		"get_mcp_runtime_status",
		"Get one compact MCP runtime snapshot covering video readiness, HID/configfs, USB recovery, async text, Manual Takeover and Supervisor state",
	), handleGetMCPRuntimeStatusV2)

	s.AddTool(mcp.NewTool(
		"ensure_hid_ready",
		mcp.WithDescription("Preflight configured keyboard/mouse HID endpoints and start one serialized soft/hard USB recovery task only when recovery is actually needed"),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(false),
	), handleEnsureHIDReadyV2)

	s.AddTool(mcp.NewTool(
		"input_release_all",
		mcp.WithDescription("Emergency release of all MCP keyboard keys/modifiers and mouse buttons. If release cannot reach a configured HID endpoint, start one hard USB recovery task."),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(false),
	), handleInputReleaseAllV2)
}
'''

Path("mcp_usability_v2.go").write_text(mcp_v2, encoding="utf-8")

extra_path = Path("mcp_enhanced_extra.go")
extra = extra_path.read_text(encoding="utf-8")
extra = replace_once(
    extra,
    "\tregisterEnhancedFinalReliabilityOverrides(s)\n\t// Annotation metadata must be the very last pass",
    "\tregisterEnhancedFinalReliabilityOverrides(s)\n\tregisterMCPV2UsabilityTools(s)\n\t// Annotation metadata must be the very last pass",
    "MCP v2 usability registration",
)
extra_path.write_text(extra, encoding="utf-8")

mcp_path = Path("mcp.go")
mcp_src = mcp_path.read_text(encoding="utf-8")
mcp_src = replace_once(
    mcp_src,
    'server.NewMCPServer("picokvm-mcp", "1.4.0-enhanced")',
    'server.NewMCPServer("picokvm-mcp", "2.0.0-enhanced")',
    "MCP server protocol version",
)
mcp_path.write_text(mcp_src, encoding="utf-8")

print("MCP 2.0 usability repair complete")
print("generated mcp_usability_v2.go")
