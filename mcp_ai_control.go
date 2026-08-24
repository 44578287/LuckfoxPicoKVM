package kvm

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// mcpPointerState tracks the last absolute position issued through MCP.  HID
// absolute mouse reports contain position and button state in the same packet,
// so a click must reuse the current position instead of sending (0,0).
var mcpPointerState = struct {
	sync.Mutex
	x       int
	y       int
	buttons uint8
}{x: 16384, y: 16384}

func registerEnhancedAIControlMCPTools(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("get_ai_control_capabilities",
		mcp.WithDescription("Describe the PicoKVM Enhanced AI-control coordinate spaces, input primitives and available recovery controls"),
	), handleGetAIControlCapabilities)

	s.AddTool(mcp.NewTool("mouse_move_screen",
		mcp.WithDescription("Move the absolute mouse using current HDMI source pixel coordinates, e.g. x=960 y=540 on a 1920x1080 screen"),
		mcp.WithNumber("x", mcp.Required(), mcp.Description("Source-screen X pixel")),
		mcp.WithNumber("y", mcp.Required(), mcp.Description("Source-screen Y pixel")),
	), handleMouseMoveScreen)

	s.AddTool(mcp.NewTool("mouse_click_screen",
		mcp.WithDescription("Move to a source-screen pixel coordinate and click without requiring HID-coordinate conversion"),
		mcp.WithNumber("x", mcp.Required(), mcp.Description("Source-screen X pixel")),
		mcp.WithNumber("y", mcp.Required(), mcp.Description("Source-screen Y pixel")),
		mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")),
	), handleMouseClickScreen)

	s.AddTool(mcp.NewTool("mouse_button",
		mcp.WithDescription("Press or release a mouse button at the current MCP absolute pointer position; use this for drag/select gestures"),
		mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")),
		mcp.WithString("action", mcp.Required(), mcp.Enum("down", "up", "click")),
	), handleMouseButton)

	s.AddTool(mcp.NewTool("mouse_double_click_screen",
		mcp.WithDescription("Double-click a mouse button at a source-screen pixel coordinate"),
		mcp.WithNumber("x", mcp.Required()),
		mcp.WithNumber("y", mcp.Required()),
		mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")),
	), handleMouseDoubleClickScreen)

	s.AddTool(mcp.NewTool("mouse_drag_screen",
		mcp.WithDescription("Drag from one source-screen pixel coordinate to another using the selected button"),
		mcp.WithNumber("from_x", mcp.Required()),
		mcp.WithNumber("from_y", mcp.Required()),
		mcp.WithNumber("to_x", mcp.Required()),
		mcp.WithNumber("to_y", mcp.Required()),
		mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")),
		mcp.WithNumber("duration_ms", mcp.Description("Gesture duration in milliseconds; default 250, range 0-3000")),
	), handleMouseDragScreen)

	s.AddTool(mcp.NewTool("keyboard_event",
		mcp.WithDescription("Press, hold, or release one keyboard key. action=press performs down+up; use down/up for held-key workflows"),
		mcp.WithString("key", mcp.Required()),
		mcp.WithString("action", mcp.Required(), mcp.Enum("press", "down", "up")),
	), handleKeyboardEvent)

	s.AddTool(mcp.NewTool("keyboard_release_all",
		mcp.WithDescription("Release all keyboard modifiers and keys; useful after interrupted automation"),
	), handleKeyboardReleaseAll)

	s.AddTool(mcp.NewTool("get_keyboard_led_state",
		mcp.WithDescription("Read host Caps Lock, Num Lock and Scroll Lock LED state"),
	), handleGetKeyboardLEDState)

	s.AddTool(mcp.NewTool("get_keyboard_layout",
		mcp.WithDescription("Get the configured PicoKVM keyboard layout"),
	), handleGetKeyboardLayoutMCP)

	s.AddTool(mcp.NewTool("usb_reinitialize_soft",
		mcp.WithDescription("Soft-reinitialize/rebind the USB gadget and HID file descriptors. Mounted virtual media may be unmounted"),
	), handleUSBReinitializeSoft)

	s.AddTool(mcp.NewTool("usb_reinitialize_hard",
		mcp.WithDescription("Hard-recreate the PicoKVM USB gadget. Use when HID is broken; mounted virtual media may be unmounted"),
	), handleUSBReinitializeHard)

	s.AddTool(mcp.NewTool("reboot_picokvm",
		mcp.WithDescription("Reboot the PicoKVM itself, not the attached host"),
		mcp.WithBoolean("force", mcp.Description("Use forced reboot; default false")),
	), handleRebootPicoKVM)

	s.AddTool(mcp.NewTool("get_stream_codec",
		mcp.WithDescription("Get the active hardware video codec (avc/H.264 or hevc/H.265)"),
	), handleGetStreamCodecMCP)

	s.AddTool(mcp.NewTool("set_stream_codec",
		mcp.WithDescription("Switch the single hardware encoder between H.264/AVC and H.265/HEVC"),
		mcp.WithString("codec", mcp.Required(), mcp.Enum("avc", "hevc")),
	), handleSetStreamCodecMCP)

	s.AddTool(mcp.NewTool("get_force_hpd",
		mcp.WithDescription("Get HDMI force-HPD state"),
	), handleGetForceHPDMCP)

	s.AddTool(mcp.NewTool("set_force_hpd",
		mcp.WithDescription("Enable or disable HDMI force-HPD"),
		mcp.WithBoolean("enabled", mcp.Required()),
	), handleSetForceHPDMCP)
}

func clampMCPHID(v int) int {
	if v < 0 {
		return 0
	}
	if v > 32767 {
		return 32767
	}
	return v
}

func mcpButtonMask(button string) (uint8, error) {
	switch strings.ToLower(strings.TrimSpace(button)) {
	case "left":
		return 1, nil
	case "right":
		return 2, nil
	case "middle":
		return 4, nil
	default:
		return 0, fmt.Errorf("unknown mouse button %q", button)
	}
}

func mcpSendAbsolute(x, y int, buttons uint8) error {
	x = clampMCPHID(x)
	y = clampMCPHID(y)
	if err := rpcAbsMouseReport(x, y, buttons); err != nil {
		return err
	}
	mcpPointerState.Lock()
	mcpPointerState.x = x
	mcpPointerState.y = y
	mcpPointerState.buttons = buttons
	mcpPointerState.Unlock()
	return nil
}

func mcpCurrentPointer() (int, int, uint8) {
	mcpPointerState.Lock()
	defer mcpPointerState.Unlock()
	return mcpPointerState.x, mcpPointerState.y, mcpPointerState.buttons
}

func mcpMoveAbsolute(x, y int) error {
	_, _, buttons := mcpCurrentPointer()
	return mcpSendAbsolute(x, y, buttons)
}

func mcpMoveRelative(dx, dy int) error {
	if dx < -127 || dx > 127 || dy < -127 || dy > 127 {
		return fmt.Errorf("relative mouse delta must be between -127 and 127 per report")
	}
	_, _, buttons := mcpCurrentPointer()
	return rpcRelMouseReport(int8(dx), int8(dy), buttons)
}

func mcpClick(button string) error {
	mask, err := mcpButtonMask(button)
	if err != nil {
		return err
	}
	x, y, existing := mcpCurrentPointer()
	pressed := existing | mask
	if err := mcpSendAbsolute(x, y, pressed); err != nil {
		return err
	}
	time.Sleep(35 * time.Millisecond)
	return mcpSendAbsolute(x, y, existing&^mask)
}

func mcpButtonAction(button, action string) error {
	mask, err := mcpButtonMask(button)
	if err != nil {
		return err
	}
	x, y, buttons := mcpCurrentPointer()
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "down":
		buttons |= mask
		return mcpSendAbsolute(x, y, buttons)
	case "up":
		buttons &^= mask
		return mcpSendAbsolute(x, y, buttons)
	case "click":
		return mcpClick(button)
	default:
		return fmt.Errorf("invalid mouse action %q", action)
	}
}

func mcpScreenToHID(x, y float64) (int, int, error) {
	state := lastVideoState
	if !state.Ready || state.Width <= 0 || state.Height <= 0 {
		return 0, 0, fmt.Errorf("video input is not ready; cannot map source-screen coordinates")
	}
	if x < 0 || y < 0 || x > float64(state.Width-1) || y > float64(state.Height-1) {
		return 0, 0, fmt.Errorf("screen coordinate (%.0f,%.0f) is outside %dx%d", x, y, state.Width, state.Height)
	}
	hx := int(math.Round(x / float64(maxInt(state.Width-1, 1)) * 32767.0))
	hy := int(math.Round(y / float64(maxInt(state.Height-1, 1)) * 32767.0))
	return clampMCPHID(hx), clampMCPHID(hy), nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func mcpLookupKey(name string) (uint8, error) {
	name = strings.TrimSpace(name)
	candidates := []string{name}
	if len(name) > 0 {
		candidates = append(candidates,
			strings.ToUpper(name),
			strings.ToLower(name),
			strings.ToUpper(name[:1])+strings.ToLower(name[1:]),
		)
	}
	aliases := map[string]string{
		"esc": "Escape", "return": "Enter", "del": "Delete", "ins": "Insert",
		"pgup": "PageUp", "pgdn": "PageDown", "spacebar": "Space",
	}
	if alias, ok := aliases[strings.ToLower(name)]; ok {
		candidates = append(candidates, alias)
	}
	for _, candidate := range candidates {
		if code, ok := keyNameToCode[candidate]; ok {
			return code, nil
		}
	}
	return 0, fmt.Errorf("unknown key: %s", name)
}

func handleGetAIControlCapabilities(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	state := lastVideoState
	caps := map[string]interface{}{
		"version": "ai-control-v1",
		"video": map[string]interface{}{
			"screenshot": true,
			"screen_width": state.Width,
			"screen_height": state.Height,
			"screen_ready": state.Ready,
			"screen_pixel_mouse": true,
			"hid_coordinate_range": "0..32767",
		},
		"mouse": []string{"absolute", "relative", "screen_pixel", "click", "button_down_up", "double_click", "drag", "vertical_scroll"},
		"keyboard": map[string]interface{}{
			"single_key": true,
			"combination": true,
			"key_down_up": true,
			"release_all": true,
			"type_text": "ASCII/keyboard-layout dependent; arbitrary Unicode is not guaranteed by USB HID",
		},
		"host_control": []string{"power_short", "power_long", "power_custom_duration", "reset", "reset_custom_duration", "power_led", "hdd_led", "wake_on_lan"},
		"virtual_media": []string{"list", "mount_internal", "mount_sd", "mount_http_url", "unmount"},
		"recovery": []string{"usb_wakeup", "usb_soft_reinitialize", "usb_hard_reinitialize", "video_pipeline_recovery", "picokvm_reboot"},
		"media": []string{"stream_status", "rtsp_status", "rtp_multicast", "zero_reencode_recording", "codec_switch"},
	}
	data, err := json.MarshalIndent(caps, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleMouseMoveScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	x, okX := args["x"].(float64)
	y, okY := args["y"].(float64)
	if !okX || !okY {
		return nil, fmt.Errorf("x and y are required")
	}
	hx, hy, err := mcpScreenToHID(x, y)
	if err != nil {
		return nil, err
	}
	if err := mcpMoveAbsolute(hx, hy); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Mouse moved to screen pixel (%.0f, %.0f) -> HID (%d, %d)", x, y, hx, hy)), nil
}

func handleMouseClickScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	x, okX := args["x"].(float64)
	y, okY := args["y"].(float64)
	button, _ := args["button"].(string)
	if !okX || !okY || button == "" {
		return nil, fmt.Errorf("x, y and button are required")
	}
	hx, hy, err := mcpScreenToHID(x, y)
	if err != nil {
		return nil, err
	}
	if err := mcpMoveAbsolute(hx, hy); err != nil {
		return nil, err
	}
	if err := mcpClick(button); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Clicked %s at screen pixel (%.0f, %.0f)", button, x, y)), nil
}

func handleMouseButton(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	button, _ := req.GetArguments()["button"].(string)
	action, _ := req.GetArguments()["action"].(string)
	if err := mcpButtonAction(button, action); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Mouse %s %s", button, action)), nil
}

func handleMouseDoubleClickScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	x, okX := args["x"].(float64)
	y, okY := args["y"].(float64)
	button, _ := args["button"].(string)
	if !okX || !okY || button == "" {
		return nil, fmt.Errorf("x, y and button are required")
	}
	hx, hy, err := mcpScreenToHID(x, y)
	if err != nil {
		return nil, err
	}
	if err := mcpMoveAbsolute(hx, hy); err != nil {
		return nil, err
	}
	if err := mcpClick(button); err != nil {
		return nil, err
	}
	time.Sleep(80 * time.Millisecond)
	if err := mcpClick(button); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Double-clicked %s at screen pixel (%.0f, %.0f)", button, x, y)), nil
}

func handleMouseDragScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	fx, okFX := args["from_x"].(float64)
	fy, okFY := args["from_y"].(float64)
	tx, okTX := args["to_x"].(float64)
	ty, okTY := args["to_y"].(float64)
	button, _ := args["button"].(string)
	if !okFX || !okFY || !okTX || !okTY || button == "" {
		return nil, fmt.Errorf("from_x, from_y, to_x, to_y and button are required")
	}
	duration := 250
	if v, ok := args["duration_ms"].(float64); ok {
		duration = int(v)
	}
	if duration < 0 || duration > 3000 {
		return nil, fmt.Errorf("duration_ms must be between 0 and 3000")
	}
	fromHX, fromHY, err := mcpScreenToHID(fx, fy)
	if err != nil {
		return nil, err
	}
	toHX, toHY, err := mcpScreenToHID(tx, ty)
	if err != nil {
		return nil, err
	}
	mask, err := mcpButtonMask(button)
	if err != nil {
		return nil, err
	}
	if err := mcpSendAbsolute(fromHX, fromHY, 0); err != nil {
		return nil, err
	}
	if err := mcpSendAbsolute(fromHX, fromHY, mask); err != nil {
		return nil, err
	}

	steps := 1
	if duration > 0 {
		steps = duration / 16
		if steps < 2 {
			steps = 2
		}
		if steps > 120 {
			steps = 120
		}
	}
	stepDelay := time.Duration(0)
	if duration > 0 {
		stepDelay = time.Duration(duration) * time.Millisecond / time.Duration(steps)
	}
	for i := 1; i <= steps; i++ {
		ratio := float64(i) / float64(steps)
		x := int(math.Round(float64(fromHX) + float64(toHX-fromHX)*ratio))
		y := int(math.Round(float64(fromHY) + float64(toHY-fromHY)*ratio))
		if err := mcpSendAbsolute(x, y, mask); err != nil {
			_ = mcpSendAbsolute(x, y, 0)
			return nil, err
		}
		if stepDelay > 0 {
			time.Sleep(stepDelay)
		}
	}
	if err := mcpSendAbsolute(toHX, toHY, 0); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Dragged %s from (%.0f,%.0f) to (%.0f,%.0f)", button, fx, fy, tx, ty)), nil
}

func handleKeyboardEvent(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	keyName, _ := req.GetArguments()["key"].(string)
	action, _ := req.GetArguments()["action"].(string)
	code, err := mcpLookupKey(keyName)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(action) {
	case "press":
		if err := rpcKeypressReport(code, true); err != nil {
			return nil, err
		}
		time.Sleep(30 * time.Millisecond)
		if err := rpcKeypressReport(code, false); err != nil {
			return nil, err
		}
	case "down":
		if err := rpcKeypressReport(code, true); err != nil {
			return nil, err
		}
	case "up":
		if err := rpcKeypressReport(code, false); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("invalid keyboard action %q", action)
	}
	return mcp.NewToolResultText(fmt.Sprintf("Keyboard %s: %s", action, keyName)), nil
}

func handleKeyboardReleaseAll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := rpcKeyboardReport(0, []uint8{}); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Released all keyboard keys and modifiers"), nil
}

func handleGetKeyboardLEDState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(rpcGetKeyboardLedState(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetKeyboardLayoutMCP(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	layout, err := rpcGetKeyboardLayout()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(layout), nil
}

func handleUSBReinitializeSoft(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := rpcReinitializeUsbGadgetSoft(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("USB gadget soft reinitialization completed"), nil
}

func handleUSBReinitializeHard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := rpcReinitializeUsbGadget(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("USB gadget hard reinitialization completed"), nil
}

func handleRebootPicoKVM(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	force, _ := req.GetArguments()["force"].(bool)
	if err := rpcReboot(force); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("PicoKVM reboot initiated"), nil
}

func handleGetStreamCodecMCP(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	codec, err := rpcGetStreamEncodecType()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(codec), nil
}

func handleSetStreamCodecMCP(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	codec, _ := req.GetArguments()["codec"].(string)
	if codec != "avc" && codec != "hevc" {
		return nil, fmt.Errorf("codec must be avc or hevc")
	}
	if err := rpcSetStreamEncodecType(codec); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Stream codec switched to " + codec), nil
}

func handleGetForceHPDMCP(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	enabled, err := rpcGetForceHpd()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("%v", enabled)), nil
}

func handleSetForceHPDMCP(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	enabled, ok := req.GetArguments()["enabled"].(bool)
	if !ok {
		return nil, fmt.Errorf("enabled is required")
	}
	if err := rpcSetForceHpd(enabled); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Force HPD set to %v", enabled)), nil
}
