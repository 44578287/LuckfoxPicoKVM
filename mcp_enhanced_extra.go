package kvm

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// registerEnhancedExtraMCPTools keeps post-1.3 enhanced tools out of the
// upstream-derived mcp.go. This makes future Luckfox merges substantially
// smaller while still exposing one unified MCP server to clients.
func registerEnhancedExtraMCPTools(s *server.MCPServer) {
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
