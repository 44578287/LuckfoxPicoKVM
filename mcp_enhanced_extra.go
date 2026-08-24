package kvm

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// registerEnhancedExtraMCPTools keeps post-1.3 enhanced tools out of the
// upstream-derived mcp.go. This makes future Luckfox merges substantially
// smaller while still exposing one unified MCP server to clients.
func registerEnhancedExtraMCPTools(s *server.MCPServer) {
	// Keep newer extension groups modular so upstream-derived mcp.go remains
	// small and future Luckfox merges do not require rewriting the core file.
	registerEnhancedSupervisorMCPTools(s)
	registerEnhancedAIControlMCPTools(s)
	registerReliableTextInjectionMCPTools(s)

	s.AddTool(mcp.NewTool("get_diagnostics",
		mcp.WithDescription("Get a read-only PicoKVM diagnostics snapshot including video, USB, storage, network, host IO, RTSP and MCU visibility"),
	), handleGetEnhancedDiagnostics)

	s.AddTool(mcp.NewTool("get_rtsp_status",
		mcp.WithDescription("Get the native read-only RTSP service status and connected client count"),
	), handleGetRTSPStatus)

	s.AddTool(mcp.NewTool("get_recording_status",
		mcp.WithDescription("Get zero-reencode H.264/H.265 recording status"),
	), handleGetRecordingStatus)

	s.AddTool(mcp.NewTool("start_recording",
		mcp.WithDescription("Start recording the already hardware-encoded video stream to local PicoKVM storage without re-encoding"),
		mcp.WithString("filename", mcp.Description("Optional filename; .h264/.h265 extension is selected from the active codec")),
	), handleStartRecording)

	s.AddTool(mcp.NewTool("stop_recording",
		mcp.WithDescription("Stop and flush the active encoded video recording"),
	), handleStopRecording)

	s.AddTool(mcp.NewTool("get_host_control_settings",
		mcp.WithDescription("Get host power short-press, forced-off hold and reset pulse durations in milliseconds"),
	), handleGetHostControlSettings)

	s.AddTool(mcp.NewTool("set_host_control_settings",
		mcp.WithDescription("Set host power/reset pulse durations"),
		mcp.WithNumber("power_short_ms", mcp.Required(), mcp.Description("Normal power-button pulse, 100-2500 ms")),
		mcp.WithNumber("power_long_ms", mcp.Required(), mcp.Description("Forced power-off hold, 3000-15000 ms")),
		mcp.WithNumber("reset_ms", mcp.Required(), mcp.Description("Reset-button pulse, 100-2500 ms")),
	), handleSetHostControlSettings)

	s.AddTool(mcp.NewTool("trigger_power_long",
		mcp.WithDescription("Hold the host power button for the configured forced power-off duration"),
	), handleTriggerPowerLong)

	s.AddTool(mcp.NewTool("trigger_power_for",
		mcp.WithDescription("Hold the host power button for an explicit duration"),
		mcp.WithNumber("duration_ms", mcp.Required(), mcp.Description("100-15000 ms")),
	), handleTriggerPowerFor)

	s.AddTool(mcp.NewTool("trigger_reset_for",
		mcp.WithDescription("Pulse the host reset button for an explicit duration"),
		mcp.WithNumber("duration_ms", mcp.Required(), mcp.Description("100-2500 ms")),
	), handleTriggerResetFor)

	// Apply collaboration policy first, then replace only the hardened tool
	// implementations with wrappers that preserve the same lease/takeover log.
	registerEnhancedMCPControlPolicyTools(s)
	registerEnhancedReliabilityOverrides(s)
}

func handleGetEnhancedDiagnostics(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status, err := rpcGetEnhancedDiagnostics()
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetRTSPStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getRTSPServerStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetRecordingStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getEncodedRecordingStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleStartRecording(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	filename, _ := req.GetArguments()["filename"].(string)
	status, err := startEncodedRecording(filename)
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleStopRecording(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := stopEncodedRecording()
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetHostControlSettings(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getEnhancedHostControlSettings(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleSetHostControlSettings(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	shortValue, ok := args["power_short_ms"].(float64)
	if !ok {
		return nil, fmt.Errorf("power_short_ms is required")
	}
	longValue, ok := args["power_long_ms"].(float64)
	if !ok {
		return nil, fmt.Errorf("power_long_ms is required")
	}
	resetValue, ok := args["reset_ms"].(float64)
	if !ok {
		return nil, fmt.Errorf("reset_ms is required")
	}
	settings := EnhancedHostControlSettings{
		PowerShortMs: int(shortValue),
		PowerLongMs:  int(longValue),
		ResetMs:      int(resetValue),
	}
	if err := setEnhancedHostControlSettings(settings); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleTriggerPowerLong(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := triggerPowerLong(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Forced power-button hold triggered"), nil
}

func handleTriggerPowerFor(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	value, ok := req.GetArguments()["duration_ms"].(float64)
	if !ok {
		return nil, fmt.Errorf("duration_ms is required")
	}
	if err := triggerPowerFor(int(value)); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Power button held for %d ms", int(value))), nil
}

func handleTriggerResetFor(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	value, ok := req.GetArguments()["duration_ms"].(float64)
	if !ok {
		return nil, fmt.Errorf("duration_ms is required")
	}
	if err := triggerResetFor(int(value)); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Reset button pulsed for %d ms", int(value))), nil
}
