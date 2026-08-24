package kvm

import (
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func readOnlyMCPTool(name, description string) mcp.Tool {
	return mcp.NewTool(name,
		mcp.WithDescription(description),
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(false),
	)
}

// registerEnhancedMCPAnnotationOverrides is deliberately the final MCP
// registration pass. mcp-go keeps tools by name, so re-registering these
// no-argument status tools fixes the annotations inherited from the SDK
// defaults without touching their already-tested handlers.
func registerEnhancedMCPAnnotationOverrides(s *server.MCPServer) {
	s.AddTool(readOnlyMCPTool("capture_screenshot", "Capture a serialized JPEG screenshot using the existing hardware capture pipeline"), handleCaptureScreenshotV2)
	s.AddTool(readOnlyMCPTool("get_ai_control_capabilities", "Describe the PicoKVM Enhanced AI-control coordinate spaces, input primitives and available recovery controls"), handleGetAIControlCapabilities)
	s.AddTool(readOnlyMCPTool("get_diagnostics", "Get a read-only PicoKVM diagnostics snapshot including video, USB, storage, network, host IO, RTSP and MCU visibility"), handleGetEnhancedDiagnostics)
	s.AddTool(readOnlyMCPTool("get_force_hpd", "Get HDMI force-HPD state"), handleGetForceHPDMCP)
	s.AddTool(readOnlyMCPTool("get_host_control_settings", "Get host power short-press, forced-off hold and reset pulse durations in milliseconds"), handleGetHostControlSettings)
	s.AddTool(readOnlyMCPTool("get_host_power_state", "Read host power/HDD LED state through the PicoKVM extension-board inputs"), handleGetHostPowerState)
	s.AddTool(readOnlyMCPTool("get_keyboard_layout", "Get the configured PicoKVM keyboard layout"), handleGetKeyboardLayoutMCP)
	s.AddTool(readOnlyMCPTool("get_keyboard_led_state", "Read host Caps Lock, Num Lock and Scroll Lock LED state"), handleGetKeyboardLEDState)
	s.AddTool(readOnlyMCPTool("get_recording_status", "Get zero-reencode H.264/H.265 recording status"), handleGetRecordingStatus)
	s.AddTool(readOnlyMCPTool("get_rtp_multicast_status", "Get the optional LAN RTP multicast sender status"), handleGetRTPMulticastStatus)
	s.AddTool(readOnlyMCPTool("get_rtsp_status", "Get the native read-only RTSP service status and connected client count"), handleGetRTSPStatus)
	s.AddTool(readOnlyMCPTool("get_stream_codec", "Get the active hardware video codec (avc/H.264 or hevc/H.265)"), handleGetStreamCodecMCP)
	s.AddTool(readOnlyMCPTool("get_stream_status", "Get codec, video state, controller/viewer counts and RTP multicast state"), handleGetStreamStatus)
	s.AddTool(readOnlyMCPTool("get_supervisor_settings", "Get Enhanced Supervisor video-stall recovery settings"), handleGetSupervisorSettings)
	s.AddTool(readOnlyMCPTool("get_supervisor_status", "Get Enhanced Supervisor health, encoded-video heartbeat and bounded recovery counters"), handleGetSupervisorStatus)
	s.AddTool(readOnlyMCPTool("get_text_injection_status", "Get the latest asynchronous reliable-text injection task status"), handleGetTextInjectionStatus)
	s.AddTool(readOnlyMCPTool("get_usb_reinitialize_status", "Get the latest asynchronous USB recovery task status"), handleGetUSBReinitializeStatusV2)
	s.AddTool(readOnlyMCPTool("get_usb_state", "Get the USB gadget connection state"), handleGetUSBState)
	s.AddTool(readOnlyMCPTool("get_video_state", "Get screen resolution and video status"), handleGetVideoState)
	s.AddTool(readOnlyMCPTool("get_virtual_media_state", "Get the currently mounted virtual CD-ROM/disk state"), handleGetVirtualMediaState)
	s.AddTool(readOnlyMCPTool("list_virtual_media", "List internal and SD-card virtual-media images and current mount state"), handleListVirtualMedia)
	s.AddTool(readOnlyMCPTool("probe_mcu", "Read-only probe for RV1106 MCU loader, remoteproc/rpmsg and device-tree facilities"), handleProbeMCU)
}
