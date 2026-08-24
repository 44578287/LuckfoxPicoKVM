package kvm

import (
	"context"
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func registerEnhancedSupervisorMCPTools(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("get_supervisor_status",
		mcp.WithDescription("Get Enhanced Supervisor health, encoded-video heartbeat and bounded recovery counters"),
	), handleGetSupervisorStatus)

	s.AddTool(mcp.NewTool("get_supervisor_settings",
		mcp.WithDescription("Get Enhanced Supervisor video-stall recovery settings"),
	), handleGetSupervisorSettings)

	s.AddTool(mcp.NewTool("force_video_recovery",
		mcp.WithDescription("Force one stop/start recovery of the native encoded-video pipeline without rebooting PicoKVM"),
	), handleForceVideoRecovery)
}

func handleGetSupervisorStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getEnhancedSupervisorStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetSupervisorSettings(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getEnhancedSupervisorSettings(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleForceVideoRecovery(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := forceEnhancedVideoRecovery(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Native video pipeline stop/start recovery triggered"), nil
}
