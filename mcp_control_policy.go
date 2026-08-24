package kvm

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func trackedMCPAction(kind, summary string, fn func() (*mcp.CallToolResult, error)) (result *mcp.CallToolResult, err error) {
	finish, beginErr := mcpControlBegin(kind, summary)
	if beginErr != nil {
		return nil, beginErr
	}
	defer func() { finish(err) }()
	return fn()
}

func mcpTextSummary(req mcp.CallToolRequest) string {
	text, _ := req.GetArguments()["text"].(string)
	s := getEnhancedMCPControlSettings()
	if s.RedactTypedText {
		return fmt.Sprintf("Type text (%d chars)", len([]rune(text)))
	}
	preview := strings.ReplaceAll(strings.ReplaceAll(text, "\r", "\\r"), "\n", "\\n")
	if len([]rune(preview)) > 80 {
		preview = string([]rune(preview)[:80]) + "…"
	}
	return fmt.Sprintf("Type text (%d chars): %s", len([]rune(text)), preview)
}

// registerEnhancedMCPControlPolicyTools runs after all normal Enhanced tool
// groups. Re-registering the state-changing tools lets us add the human/MCP
// collaboration lease without modifying the upstream-derived handlers.
func registerEnhancedMCPControlPolicyTools(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("mouse_move_absolute", mcp.WithDescription("Move mouse to HID absolute coordinates 0-32767"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required())), trackMouseMoveAbsolute)
	s.AddTool(mcp.NewTool("mouse_move_relative", mcp.WithDescription("Move mouse by relative HID offset"), mcp.WithNumber("dx", mcp.Required()), mcp.WithNumber("dy", mcp.Required())), trackMouseMoveRelative)
	s.AddTool(mcp.NewTool("mouse_click", mcp.WithDescription("Click at the current MCP pointer position"), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle"))), trackMouseClick)
	s.AddTool(mcp.NewTool("mouse_scroll", mcp.WithDescription("Scroll mouse wheel"), mcp.WithNumber("delta", mcp.Required())), trackMouseScroll)
	s.AddTool(mcp.NewTool("mouse_move_screen", mcp.WithDescription("Move mouse using source-screen pixel coordinates"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required())), trackMouseMoveScreen)
	s.AddTool(mcp.NewTool("mouse_click_screen", mcp.WithDescription("Click at source-screen pixel coordinates"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required()), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle"))), trackMouseClickScreen)
	s.AddTool(mcp.NewTool("mouse_button", mcp.WithDescription("Press/release/click a mouse button"), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")), mcp.WithString("action", mcp.Required(), mcp.Enum("down", "up", "click"))), trackMouseButton)
	s.AddTool(mcp.NewTool("mouse_double_click_screen", mcp.WithDescription("Double-click at a source-screen pixel"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required()), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle"))), trackMouseDoubleClickScreen)
	s.AddTool(mcp.NewTool("mouse_drag_screen", mcp.WithDescription("Drag between source-screen pixel coordinates"), mcp.WithNumber("from_x", mcp.Required()), mcp.WithNumber("from_y", mcp.Required()), mcp.WithNumber("to_x", mcp.Required()), mcp.WithNumber("to_y", mcp.Required()), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")), mcp.WithNumber("duration_ms")), trackMouseDragScreen)

	s.AddTool(mcp.NewTool("keyboard_key", mcp.WithDescription("Press a key"), mcp.WithString("key", mcp.Required())), trackKeyboardKey)
	s.AddTool(mcp.NewTool("keyboard_combo", mcp.WithDescription("Press a key combination"), mcp.WithArray("keys", mcp.Required(), mcp.Items(map[string]any{"type": "string"}))), trackKeyboardCombo)
	s.AddTool(mcp.NewTool("keyboard_event", mcp.WithDescription("Press, hold, or release one keyboard key"), mcp.WithString("key", mcp.Required()), mcp.WithString("action", mcp.Required(), mcp.Enum("press", "down", "up"))), trackKeyboardEvent)
	s.AddTool(mcp.NewTool("keyboard_release_all", mcp.WithDescription("Release all keyboard keys/modifiers")), trackKeyboardReleaseAll)

	// Keep both text tool names and all reliable pacing parameters.
	textOptions := []mcp.ToolOption{
		mcp.WithString("text", mcp.Required()),
		mcp.WithString("profile", mcp.Enum("safe", "normal", "fast")),
		mcp.WithNumber("key_down_ms"), mcp.WithNumber("inter_key_ms"),
		mcp.WithNumber("chunk_size"), mcp.WithNumber("chunk_pause_ms"),
	}
	s.AddTool(mcp.NewTool("type_text", append([]mcp.ToolOption{mcp.WithDescription("Reliably type a complete ASCII text payload using device-local HID pacing")}, textOptions...)...), trackReliableTypeText)
	s.AddTool(mcp.NewTool("inject_text", append([]mcp.ToolOption{mcp.WithDescription("Inject a complete ASCII text payload with reliable HID pacing")}, textOptions...)...), trackReliableTypeText)

	s.AddTool(mcp.NewTool("trigger_power", mcp.WithDescription("Trigger configured host power-button pulse")), trackTriggerPower)
	s.AddTool(mcp.NewTool("trigger_reset", mcp.WithDescription("Trigger configured host reset-button pulse")), trackTriggerReset)
	s.AddTool(mcp.NewTool("trigger_power_long", mcp.WithDescription("Hold host power button for configured forced-off duration")), trackTriggerPowerLong)
	s.AddTool(mcp.NewTool("trigger_power_for", mcp.WithDescription("Hold host power button for explicit duration"), mcp.WithNumber("duration_ms", mcp.Required())), trackTriggerPowerFor)
	s.AddTool(mcp.NewTool("trigger_reset_for", mcp.WithDescription("Pulse host reset button for explicit duration"), mcp.WithNumber("duration_ms", mcp.Required())), trackTriggerResetFor)
	s.AddTool(mcp.NewTool("usb_reinitialize_soft", mcp.WithDescription("Soft-reinitialize USB gadget/HID")), trackUSBSoft)
	s.AddTool(mcp.NewTool("usb_reinitialize_hard", mcp.WithDescription("Hard-recreate USB gadget/HID")), trackUSBHard)
}

func updateTrackedPointer() { x, y, _ := mcpCurrentPointer(); mcpControlPointerHID(x, y) }

func trackMouseMoveAbsolute(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a := req.GetArguments(); summary := fmt.Sprintf("Mouse move HID (%.0f, %.0f)", a["x"], a["y"])
	return trackedMCPAction("mouse", summary, func() (*mcp.CallToolResult, error) { r,e:=handleEnhancedMouseMoveAbsolute(ctx,req); if e==nil { updateTrackedPointer() }; return r,e })
}
func trackMouseMoveRelative(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); return trackedMCPAction("mouse", fmt.Sprintf("Mouse relative (%.0f, %.0f)", a["dx"],a["dy"]), func()(*mcp.CallToolResult,error){return handleEnhancedMouseMoveRelative(ctx,req)}) }
func trackMouseClick(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { b,_:=req.GetArguments()["button"].(string); return trackedMCPAction("mouse", "Mouse "+b+" click", func()(*mcp.CallToolResult,error){r,e:=handleEnhancedMouseClick(ctx,req); if e==nil{updateTrackedPointer()}; return r,e}) }
func trackMouseScroll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("mouse", fmt.Sprintf("Mouse scroll %.0f", req.GetArguments()["delta"]), func()(*mcp.CallToolResult,error){return handleEnhancedMouseScroll(ctx,req)}) }
func trackMouseMoveScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); return trackedMCPAction("mouse", fmt.Sprintf("Mouse move screen (%.0f, %.0f)",a["x"],a["y"]), func()(*mcp.CallToolResult,error){r,e:=handleMouseMoveScreen(ctx,req); if e==nil{updateTrackedPointer()}; return r,e}) }
func trackMouseClickScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); b,_:=a["button"].(string); return trackedMCPAction("mouse", fmt.Sprintf("%s click screen (%.0f, %.0f)",b,a["x"],a["y"]), func()(*mcp.CallToolResult,error){r,e:=handleMouseClickScreen(ctx,req); if e==nil{updateTrackedPointer()}; return r,e}) }
func trackMouseButton(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); return trackedMCPAction("mouse", fmt.Sprintf("Mouse %v %v",a["button"],a["action"]), func()(*mcp.CallToolResult,error){r,e:=handleMouseButton(ctx,req); if e==nil{updateTrackedPointer()}; return r,e}) }
func trackMouseDoubleClickScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); return trackedMCPAction("mouse", fmt.Sprintf("Double click screen (%.0f, %.0f)",a["x"],a["y"]), func()(*mcp.CallToolResult,error){r,e:=handleMouseDoubleClickScreen(ctx,req); if e==nil{updateTrackedPointer()}; return r,e}) }
func trackMouseDragScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); return trackedMCPAction("mouse", fmt.Sprintf("Drag (%.0f,%.0f) → (%.0f,%.0f)",a["from_x"],a["from_y"],a["to_x"],a["to_y"]), func()(*mcp.CallToolResult,error){r,e:=handleMouseDragScreen(ctx,req); if e==nil{updateTrackedPointer()}; return r,e}) }

func trackKeyboardKey(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { k,_:=req.GetArguments()["key"].(string); return trackedMCPAction("keyboard", "Key "+k, func()(*mcp.CallToolResult,error){return handleKeyboardKey(ctx,req)}) }
func trackKeyboardCombo(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("keyboard", fmt.Sprintf("Key combo %v",req.GetArguments()["keys"]), func()(*mcp.CallToolResult,error){return handleKeyboardCombo(ctx,req)}) }
func trackKeyboardEvent(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { a:=req.GetArguments(); return trackedMCPAction("keyboard", fmt.Sprintf("Key %v %v",a["key"],a["action"]), func()(*mcp.CallToolResult,error){return handleKeyboardEvent(ctx,req)}) }
func trackKeyboardReleaseAll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("keyboard", "Release all keys", func()(*mcp.CallToolResult,error){return handleKeyboardReleaseAll(ctx,req)}) }
func trackReliableTypeText(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("keyboard",mcpTextSummary(req),func()(*mcp.CallToolResult,error){return handleReliableTypeText(ctx,req)}) }

func trackTriggerPower(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("power","Host power button",func()(*mcp.CallToolResult,error){return handleTriggerPower(ctx,req)}) }
func trackTriggerReset(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("power","Host reset button",func()(*mcp.CallToolResult,error){return handleTriggerReset(ctx,req)}) }
func trackTriggerPowerLong(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("power","Host forced power hold",func()(*mcp.CallToolResult,error){return handleTriggerPowerLong(ctx,req)}) }
func trackTriggerPowerFor(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("power",fmt.Sprintf("Host power hold %.0f ms",req.GetArguments()["duration_ms"]),func()(*mcp.CallToolResult,error){return handleTriggerPowerFor(ctx,req)}) }
func trackTriggerResetFor(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("power",fmt.Sprintf("Host reset %.0f ms",req.GetArguments()["duration_ms"]),func()(*mcp.CallToolResult,error){return handleTriggerResetFor(ctx,req)}) }
func trackUSBSoft(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("usb","USB soft reinitialize",func()(*mcp.CallToolResult,error){return handleUSBReinitializeSoft(ctx,req)}) }
func trackUSBHard(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { return trackedMCPAction("usb","USB hard reinitialize",func()(*mcp.CallToolResult,error){return handleUSBReinitializeHard(ctx,req)}) }
