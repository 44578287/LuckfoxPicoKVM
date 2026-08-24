package kvm

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerEnhancedFinalReliabilityOverrides(s *server.MCPServer) {
	// Mouse tools: preserve the collaboration wrappers, but if the HID endpoint
	// itself times out/misses, start a bounded USB recovery task instead of
	// leaving the MCP client hanging or silently pretending the report worked.
	s.AddTool(mcp.NewTool("mouse_move_absolute", mcp.WithDescription("Move mouse to HID absolute coordinates 0-32767"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required())), recoverMouseMoveAbsolute)
	s.AddTool(mcp.NewTool("mouse_move_relative", mcp.WithDescription("Move mouse by relative HID offset"), mcp.WithNumber("dx", mcp.Required()), mcp.WithNumber("dy", mcp.Required())), recoverMouseMoveRelative)
	s.AddTool(mcp.NewTool("mouse_click", mcp.WithDescription("Click at the current MCP pointer position"), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle"))), recoverMouseClick)
	s.AddTool(mcp.NewTool("mouse_scroll", mcp.WithDescription("Scroll mouse wheel"), mcp.WithNumber("delta", mcp.Required())), recoverMouseScroll)
	s.AddTool(mcp.NewTool("mouse_move_screen", mcp.WithDescription("Move mouse using source-screen pixel coordinates"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required())), recoverMouseMoveScreen)
	s.AddTool(mcp.NewTool("mouse_click_screen", mcp.WithDescription("Click at source-screen pixel coordinates"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required()), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle"))), recoverMouseClickScreen)
	s.AddTool(mcp.NewTool("mouse_button", mcp.WithDescription("Press/release/click a mouse button"), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")), mcp.WithString("action", mcp.Required(), mcp.Enum("down", "up", "click"))), recoverMouseButton)
	s.AddTool(mcp.NewTool("mouse_double_click_screen", mcp.WithDescription("Double-click at a source-screen pixel"), mcp.WithNumber("x", mcp.Required()), mcp.WithNumber("y", mcp.Required()), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle"))), recoverMouseDoubleClickScreen)
	s.AddTool(mcp.NewTool("mouse_drag_screen", mcp.WithDescription("Drag between source-screen pixel coordinates"), mcp.WithNumber("from_x", mcp.Required()), mcp.WithNumber("from_y", mcp.Required()), mcp.WithNumber("to_x", mcp.Required()), mcp.WithNumber("to_y", mcp.Required()), mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")), mcp.WithNumber("duration_ms")), recoverMouseDragScreen)

	// V3 keyboard state accepts modifier keys in keyboard_event and keeps held
	// modifiers/non-modifier keys coherent across down/up calls.
	s.AddTool(mcp.NewTool("keyboard_key", mcp.WithDescription("Press a keyboard key, including modifiers and F1-F24"), mcp.WithString("key", mcp.Required())), trackKeyboardKeyV3)
	s.AddTool(mcp.NewTool("keyboard_combo", mcp.WithDescription("Press a keyboard combination, including F13-F24 and left/right modifiers"), mcp.WithArray("keys", mcp.Required(), mcp.Items(map[string]any{"type": "string"}))), trackKeyboardComboV3)
	s.AddTool(mcp.NewTool("keyboard_event", mcp.WithDescription("Press, hold, or release a keyboard key or modifier"), mcp.WithString("key", mcp.Required()), mcp.WithString("action", mcp.Required(), mcp.Enum("press", "down", "up"))), trackKeyboardEventV3)
	s.AddTool(mcp.NewTool("keyboard_release_all", mcp.WithDescription("Release all keyboard keys and modifiers")), trackKeyboardReleaseAllV3)

	textOptions := []mcp.ToolOption{
		mcp.WithString("text", mcp.Required()),
		mcp.WithString("profile", mcp.Enum("safe", "normal", "fast")),
		mcp.WithNumber("key_down_ms"), mcp.WithNumber("inter_key_ms"),
		mcp.WithNumber("chunk_size"), mcp.WithNumber("chunk_pause_ms"),
	}
	s.AddTool(mcp.NewTool("inject_text", append([]mcp.ToolOption{mcp.WithDescription("Queue a complete US-ASCII payload for reliable asynchronous HID injection and return a task id immediately")}, textOptions...)...), handleInjectTextAsync)
	s.AddTool(mcp.NewTool("get_text_injection_status", mcp.WithDescription("Get the latest asynchronous reliable-text injection task status")), handleGetTextInjectionStatus)
	s.AddTool(mcp.NewTool("cancel_text_injection", mcp.WithDescription("Cancel the active reliable-text injection task and release keyboard state")), handleCancelTextInjection)
}

func mcpMouseFailureWithRecovery(operation string, result *mcp.CallToolResult, err error) (*mcp.CallToolResult, error) {
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
}

func recoverMouseMoveAbsolute(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseMoveAbsolute(ctx,req); return mcpMouseFailureWithRecovery("mouse_move_absolute",r,e) }
func recoverMouseMoveRelative(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseMoveRelative(ctx,req); return mcpMouseFailureWithRecovery("mouse_move_relative",r,e) }
func recoverMouseClick(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseClick(ctx,req); return mcpMouseFailureWithRecovery("mouse_click",r,e) }
func recoverMouseScroll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseScroll(ctx,req); return mcpMouseFailureWithRecovery("mouse_scroll",r,e) }
func recoverMouseMoveScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseMoveScreen(ctx,req); return mcpMouseFailureWithRecovery("mouse_move_screen",r,e) }
func recoverMouseClickScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseClickScreen(ctx,req); return mcpMouseFailureWithRecovery("mouse_click_screen",r,e) }
func recoverMouseButton(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseButton(ctx,req); return mcpMouseFailureWithRecovery("mouse_button",r,e) }
func recoverMouseDoubleClickScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseDoubleClickScreen(ctx,req); return mcpMouseFailureWithRecovery("mouse_double_click_screen",r,e) }
func recoverMouseDragScreen(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) { r,e:=trackMouseDragScreen(ctx,req); return mcpMouseFailureWithRecovery("mouse_drag_screen",r,e) }

func trackKeyboardKeyV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("keyboard", "Key "+req.GetString("key", ""), func() (*mcp.CallToolResult, error) { return handleKeyboardKeyV3(ctx, req) })
}
func trackKeyboardComboV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("keyboard", fmt.Sprintf("Key combo %v", req.GetArguments()["keys"]), func() (*mcp.CallToolResult, error) { return handleKeyboardComboV3(ctx, req) })
}
func trackKeyboardEventV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a:=req.GetArguments(); return trackedMCPAction("keyboard", fmt.Sprintf("Key %v %v",a["key"],a["action"]), func() (*mcp.CallToolResult, error) { return handleKeyboardEventV3(ctx, req) })
}
func trackKeyboardReleaseAllV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("keyboard", "Release all keys", func() (*mcp.CallToolResult, error) { return handleKeyboardReleaseAllV3(ctx, req) })
}
