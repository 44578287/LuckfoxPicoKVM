package kvm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// registerEnhancedReliabilityOverrides is intentionally called after the
// normal MCP control-policy registration. These handlers preserve the same
// Manual Takeover / lease tracking while swapping in the hardened V2 paths.
func registerEnhancedReliabilityOverrides(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("keyboard_key",
		mcp.WithDescription("Press a keyboard key, including F1-F24"),
		mcp.WithString("key", mcp.Required()),
	), trackKeyboardKeyV2)

	s.AddTool(mcp.NewTool("keyboard_combo",
		mcp.WithDescription("Press a keyboard combination, including F13-F24 and left/right modifiers"),
		mcp.WithArray("keys", mcp.Required(), mcp.Items(map[string]any{"type": "string"})),
	), trackKeyboardComboV2)

	s.AddTool(mcp.NewTool("keyboard_event",
		mcp.WithDescription("Press, hold, or release one keyboard key"),
		mcp.WithString("key", mcp.Required()),
		mcp.WithString("action", mcp.Required(), mcp.Enum("press", "down", "up")),
	), trackKeyboardEventV2)

	s.AddTool(mcp.NewTool("keyboard_release_all",
		mcp.WithDescription("Release all keyboard keys and modifiers"),
	), trackKeyboardReleaseAllV2)

	textOptions := []mcp.ToolOption{
		mcp.WithString("text", mcp.Required()),
		mcp.WithString("profile", mcp.Enum("safe", "normal", "fast")),
		mcp.WithNumber("key_down_ms"),
		mcp.WithNumber("inter_key_ms"),
		mcp.WithNumber("chunk_size"),
		mcp.WithNumber("chunk_pause_ms"),
	}
	s.AddTool(mcp.NewTool("type_text", append([]mcp.ToolOption{mcp.WithDescription("Reliably type complete US-ASCII text with device-local HID pacing")}, textOptions...)...), trackReliableTypeTextV2)
	s.AddTool(mcp.NewTool("inject_text", append([]mcp.ToolOption{mcp.WithDescription("Inject complete US-ASCII text with reliable HID pacing")}, textOptions...)...), trackReliableTypeTextV2)

	s.AddTool(mcp.NewTool("capture_screenshot",
		mcp.WithDescription("Capture a serialized JPEG screenshot using the existing hardware capture pipeline"),
	), handleCaptureScreenshotV2)

	s.AddTool(mcp.NewTool("usb_reinitialize_soft",
		mcp.WithDescription("Start asynchronous soft USB gadget reinitialization and return a task id immediately"),
	), trackUSBSoftV2)
	s.AddTool(mcp.NewTool("usb_reinitialize_hard",
		mcp.WithDescription("Start asynchronous hard USB gadget recreation and return a task id immediately"),
	), trackUSBHardV2)
	s.AddTool(mcp.NewTool("get_usb_reinitialize_status",
		mcp.WithDescription("Get the latest asynchronous USB recovery task status"),
	), handleGetUSBReinitializeStatusV2)
}

func trackKeyboardKeyV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key, _ := req.GetArguments()["key"].(string)
	return trackedMCPAction("keyboard", "Key "+key, func() (*mcp.CallToolResult, error) {
		return handleKeyboardKeyV2(ctx, req)
	})
}

func trackKeyboardComboV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("keyboard", fmt.Sprintf("Key combo %v", req.GetArguments()["keys"]), func() (*mcp.CallToolResult, error) {
		return handleKeyboardComboV2(ctx, req)
	})
}

func trackKeyboardEventV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	a := req.GetArguments()
	return trackedMCPAction("keyboard", fmt.Sprintf("Key %v %v", a["key"], a["action"]), func() (*mcp.CallToolResult, error) {
		return handleKeyboardEventV2(ctx, req)
	})
}

func trackKeyboardReleaseAllV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("keyboard", "Release all keys", func() (*mcp.CallToolResult, error) {
		return handleKeyboardReleaseAllV2(ctx, req)
	})
}

func trackReliableTypeTextV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("keyboard", mcpTextSummary(req), func() (*mcp.CallToolResult, error) {
		return handleReliableTypeTextV2(ctx, req)
	})
}

func handleCaptureScreenshotV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := captureMCPScreenshotReliable()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultImage("JPEG screenshot captured", base64.StdEncoding.EncodeToString(data), "image/jpeg"), nil
}

func startUSBRecoveryTool(mode string) (*mcp.CallToolResult, error) {
	status := startUSBReinitializeAsync(mode, "MCP requested USB reinitialization")
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func trackUSBSoftV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("usb", "USB soft reinitialize", func() (*mcp.CallToolResult, error) {
		return startUSBRecoveryTool("soft")
	})
}

func trackUSBHardV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return trackedMCPAction("usb", "USB hard reinitialize", func() (*mcp.CallToolResult, error) {
		return startUSBRecoveryTool("hard")
	})
}

func handleGetUSBReinitializeStatusV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getUSBReinitializeStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}
