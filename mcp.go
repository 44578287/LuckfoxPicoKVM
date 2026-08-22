package kvm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

type EnhancedStreamStatus struct {
	Codec            string             `json:"codec"`
	WebRTCSessions   int                `json:"webrtc_sessions"`
	ReadOnlyViewers  int32              `json:"read_only_viewers"`
	RawSubscribers   int                `json:"raw_stream_subscribers"`
	ControllerActive bool               `json:"controller_active"`
	Video            VideoInputState    `json:"video"`
	RTPMulticast     RTPMulticastStatus `json:"rtp_multicast"`
}

func getEnhancedStreamStatus() EnhancedStreamStatus {
	return EnhancedStreamStatus{
		Codec:            streamEncodecType,
		WebRTCSessions:   actionSessions,
		ReadOnlyViewers:  enhancedViewerCount.Load(),
		RawSubscribers:   videoBroadcaster.SubscriberCount(),
		ControllerActive: currentSession != nil,
		Video:            lastVideoState,
		RTPMulticast:     getRTPMulticastStatus(),
	}
}

func StartMCP(port int, stdio bool) {
	s := server.NewMCPServer("picokvm-mcp", "1.4.0-enhanced")
	registerMCPTools(s)
	registerEnhancedExtraMCPTools(s)
	registerEnhancedSupervisorMCPTools(s)

	if stdio {
		logger.Info().Msg("Starting MCP stdio server")
		if err := server.ServeStdio(s); err != nil {
			logger.Error().Err(err).Msg("MCP stdio server failed")
		}
		return
	}

	// SSE mode. The same authenticated listener also exposes a raw encoded
	// video feed so automation, VLC/ffplay/OBS gateways and future relays can
	// consume the already hardware-encoded stream without opening the Web UI.
	addr := fmt.Sprintf(":%d", port)
	sseServer := server.NewSSEServer(s)

	mux := http.NewServeMux()
	mux.Handle("/sse", sseServer.SSEHandler())
	mux.Handle("/message", sseServer.MessageHandler())
	mux.HandleFunc("/video/stream", handleEnhancedRawVideoStream)
	mux.HandleFunc("/video/status", handleEnhancedVideoStatus)

	var handler http.Handler = mux
	if config.APIKey != "" {
		handler = withAPIKeyAuth(handler, config.APIKey)
	}
	handler = withCORS(handler)

	logger.Info().Str("addr", addr).Msg("Starting MCP SSE + enhanced media server")
	if err := http.ListenAndServe(addr, handler); err != nil {
		logger.Error().Err(err).Msg("MCP SSE server failed")
	}
}

// === Shared middleware helpers ===

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Origin, Content-Type, Accept, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withAPIKeyAuth(next http.Handler, expectedKey string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Skip auth for localhost.
		if strings.HasPrefix(r.RemoteAddr, "127.0.0.1:") ||
			strings.HasPrefix(r.RemoteAddr, "[::1]:") {
			next.ServeHTTP(w, r)
			return
		}

		auth := r.Header.Get("Authorization")
		var key string
		if _, err := fmt.Sscanf(auth, "Bearer %s", &key); err != nil {
			http.Error(w, `{"error":"missing or invalid authorization"}`, http.StatusUnauthorized)
			return
		}
		if !strings.EqualFold(key, expectedKey) {
			http.Error(w, `{"error":"invalid api key"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func handleEnhancedVideoStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(getEnhancedStreamStatus())
}

func handleEnhancedRawVideoStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if streamEncodecType == "hevc" {
		w.Header().Set("Content-Type", "video/x-h265")
	} else {
		w.Header().Set("Content-Type", "video/x-h264")
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")

	flusher, _ := w.(http.Flusher)
	subID, frames := videoBroadcaster.Subscribe()
	defer videoBroadcaster.Unsubscribe(subID)

	for {
		select {
		case <-r.Context().Done():
			return
		case frame, ok := <-frames:
			if !ok {
				return
			}
			_, err := w.Write(frame.Data())
			frame.Release()
			if err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func registerMCPTools(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("mouse_move_absolute",
		mcp.WithDescription("Move mouse to absolute coordinates on the KVM display"),
		mcp.WithNumber("x", mcp.Required(), mcp.Description("X coordinate")),
		mcp.WithNumber("y", mcp.Required(), mcp.Description("Y coordinate")),
	), handleMouseMoveAbsolute)

	s.AddTool(mcp.NewTool("mouse_move_relative",
		mcp.WithDescription("Move mouse relative to current position"),
		mcp.WithNumber("x", mcp.Required(), mcp.Description("X delta")),
		mcp.WithNumber("y", mcp.Required(), mcp.Description("Y delta")),
	), handleMouseMoveRelative)

	s.AddTool(mcp.NewTool("mouse_click",
		mcp.WithDescription("Click mouse button"),
		mcp.WithString("button", mcp.Required(), mcp.Description("left, middle, right")),
	), handleMouseClick)

	s.AddTool(mcp.NewTool("scroll",
		mcp.WithDescription("Scroll mouse wheel"),
		mcp.WithNumber("delta", mcp.Required(), mcp.Description("Positive or negative wheel delta")),
	), handleScroll)

	s.AddTool(mcp.NewTool("key",
		mcp.WithDescription("Send a keyboard key"),
		mcp.WithString("key", mcp.Required(), mcp.Description("Key name")),
	), handleKey)

	s.AddTool(mcp.NewTool("key_combo",
		mcp.WithDescription("Send a keyboard key combination"),
		mcp.WithString("keys", mcp.Required(), mcp.Description("Keys joined by +, for example CTRL+ALT+DELETE")),
	), handleKeyCombo)

	s.AddTool(mcp.NewTool("type_text",
		mcp.WithDescription("Type text through KVM keyboard HID"),
		mcp.WithString("text", mcp.Required(), mcp.Description("Text to type")),
	), handleTypeText)

	s.AddTool(mcp.NewTool("screenshot",
		mcp.WithDescription("Capture the current KVM screen as a JPEG image"),
	), handleScreenshot)

	s.AddTool(mcp.NewTool("get_video_state",
		mcp.WithDescription("Get current HDMI input/video state"),
	), handleGetVideoState)

	s.AddTool(mcp.NewTool("get_stream_status",
		mcp.WithDescription("Get enhanced stream/fan-out status"),
	), handleGetStreamStatus)

	s.AddTool(mcp.NewTool("get_rtp_multicast_status",
		mcp.WithDescription("Get RTP multicast status"),
	), handleGetRTPMulticastStatus)

	s.AddTool(mcp.NewTool("start_rtp_multicast",
		mcp.WithDescription("Start RTP multicast from the existing hardware-encoded video stream"),
		mcp.WithString("address", mcp.Description("Multicast IPv4 address:port")),
		mcp.WithNumber("ttl", mcp.Description("IP multicast TTL 1-255")),
	), handleStartRTPMulticast)

	s.AddTool(mcp.NewTool("stop_rtp_multicast",
		mcp.WithDescription("Stop RTP multicast"),
	), handleStopRTPMulticast)

	s.AddTool(mcp.NewTool("get_host_power_state",
		mcp.WithDescription("Get host power LED state from PicoKVM Ext board"),
	), handleGetHostPowerState)

	s.AddTool(mcp.NewTool("trigger_power",
		mcp.WithDescription("Press the attached host power button through PicoKVM Ext board"),
	), handleTriggerPower)

	s.AddTool(mcp.NewTool("trigger_reset",
		mcp.WithDescription("Press the attached host reset button through PicoKVM Ext board"),
	), handleTriggerReset)

	s.AddTool(mcp.NewTool("send_wol",
		mcp.WithDescription("Send Wake-on-LAN magic packet"),
		mcp.WithString("mac", mcp.Required(), mcp.Description("Target MAC address")),
	), handleSendWOL)

	s.AddTool(mcp.NewTool("probe_mcu",
		mcp.WithDescription("Read-only probe of RV1106 MCU/remoteproc/rpmsg/device-tree visibility; performs no firmware load or memory writes"),
	), handleProbeMCU)

	registerVirtualMediaMCPTools(s)
}

func handleMouseMoveAbsolute(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	x, _ := req.GetArguments()["x"].(float64)
	y, _ := req.GetArguments()["y"].(float64)
	if err := sendMouseAbsolute(int(x), int(y)); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleMouseMoveRelative(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	x, _ := req.GetArguments()["x"].(float64)
	y, _ := req.GetArguments()["y"].(float64)
	if err := sendMouseRelative(int(x), int(y)); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleMouseClick(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	button, _ := req.GetArguments()["button"].(string)
	if err := clickMouseButton(button); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleScroll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	delta, _ := req.GetArguments()["delta"].(float64)
	if err := scrollMouse(int(delta)); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleKey(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key, _ := req.GetArguments()["key"].(string)
	if err := sendNamedKey(key); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleKeyCombo(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	keys, _ := req.GetArguments()["keys"].(string)
	if err := sendKeyCombo(keys); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleTypeText(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	text, _ := req.GetArguments()["text"].(string)
	if err := typeTextHID(text); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("ok"), nil
}

func handleScreenshot(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	jpg, err := captureScreenshotJPEG()
	if err != nil {
		return nil, err
	}
	return &mcp.CallToolResult{
		Content: []mcp.Content{mcp.ImageContent{
			Type:     "image",
			Data:     base64.StdEncoding.EncodeToString(jpg),
			MIMEType: "image/jpeg",
		}},
	}, nil
}

func handleGetVideoState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	state, err := rpcGetVideoState()
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(state)
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetStreamStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := getEnhancedStreamStatus()
	data, _ := json.Marshal(status)
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetRTPMulticastStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := getRTPMulticastStatus()
	data, _ := json.Marshal(status)
	return mcp.NewToolResultText(string(data)), nil
}

func handleStartRTPMulticast(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	address, _ := args["address"].(string)
	ttl := 0
	if value, ok := args["ttl"].(float64); ok {
		ttl = int(value)
	}
	status, err := startRTPMulticast(address, ttl)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(status)
	return mcp.NewToolResultText(string(data)), nil
}

func handleStopRTPMulticast(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := stopRTPMulticast()
	data, _ := json.Marshal(status)
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetHostPowerState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status, err := rpcGetIOInputStatus()
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(status)
	return mcp.NewToolResultText(string(data)), nil
}

func handleTriggerPower(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := triggerPower(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("power pulse triggered"), nil
}

func handleTriggerReset(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := triggerReset(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("reset pulse triggered"), nil
}

func handleSendWOL(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mac, _ := req.GetArguments()["mac"].(string)
	if err := sendWakeOnLAN(mac); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("WOL sent"), nil
}

func handleProbeMCU(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := probeMCUStatus()
	data, _ := json.MarshalIndent(status, "", "  ")
	return mcp.NewToolResultText(string(data)), nil
}
