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

	codec := streamEncodecType
	contentType := "video/x-h264"
	if codec == "hevc" {
		contentType = "video/x-h265"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-PicoKVM-Codec", codec)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("Connection", "keep-alive")

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	flusher.Flush()

	id, ch := videoBroadcaster.Subscribe()
	logger.Info().Str("subscriber_id", id).Str("codec", codec).Msg("enhanced raw video subscriber connected")
	defer func() {
		videoBroadcaster.Unsubscribe(id)
		logger.Info().Str("subscriber_id", id).Msg("enhanced raw video subscriber disconnected")
	}()

	ctx := r.Context()
	for {
		select {
		case frame, open := <-ch:
			if !open {
				return
			}
			_, err := w.Write(frame.Data())
			frame.Release()
			if err != nil {
				return
			}
			flusher.Flush()
		case <-ctx.Done():
			return
		}
	}
}

// === MCP Tool Registration ===

func registerMCPTools(s *server.MCPServer) {
	s.AddTool(mcp.NewTool("mouse_move_absolute",
		mcp.WithDescription("Move mouse to absolute coordinates (0-32767)"),
		mcp.WithNumber("x", mcp.Required(), mcp.Description("X coordinate")),
		mcp.WithNumber("y", mcp.Required(), mcp.Description("Y coordinate")),
	), handleMouseMoveAbsolute)

	s.AddTool(mcp.NewTool("mouse_move_relative",
		mcp.WithDescription("Move mouse by relative offset"),
		mcp.WithNumber("dx", mcp.Required()),
		mcp.WithNumber("dy", mcp.Required()),
	), handleMouseMoveRelative)

	s.AddTool(mcp.NewTool("mouse_click",
		mcp.WithDescription("Click mouse button"),
		mcp.WithString("button", mcp.Required(), mcp.Enum("left", "right", "middle")),
	), handleMouseClick)

	s.AddTool(mcp.NewTool("mouse_scroll",
		mcp.WithDescription("Scroll mouse wheel"),
		mcp.WithNumber("delta", mcp.Required()),
	), handleMouseScroll)

	s.AddTool(mcp.NewTool("keyboard_key",
		mcp.WithDescription("Press a key"),
		mcp.WithString("key", mcp.Required(), mcp.Description("Key name: Enter, Escape, Tab, etc.")),
	), handleKeyboardKey)

	s.AddTool(mcp.NewTool("keyboard_combo",
		mcp.WithDescription("Press key combination"),
		mcp.WithArray("keys", mcp.Required(), mcp.Items(map[string]any{"type": "string"})),
	), handleKeyboardCombo)

	s.AddTool(mcp.NewTool("type_text",
		mcp.WithDescription("Type text string"),
		mcp.WithString("text", mcp.Required()),
	), handleTypeText)

	s.AddTool(mcp.NewTool("capture_screenshot",
		mcp.WithDescription("Capture JPEG screenshot using hardware encoder"),
	), handleCaptureScreenshot)

	s.AddTool(mcp.NewTool("get_video_state",
		mcp.WithDescription("Get screen resolution and video status"),
	), handleGetVideoState)

	// Enhanced observability/media tools.
	s.AddTool(mcp.NewTool("get_stream_status",
		mcp.WithDescription("Get codec, video state, controller/viewer counts and RTP multicast state"),
	), handleGetStreamStatus)

	s.AddTool(mcp.NewTool("get_host_power_state",
		mcp.WithDescription("Read host power/HDD LED state through the PicoKVM extension-board inputs"),
	), handleGetHostPowerState)

	// Enhanced extension-board actions. These intentionally reuse the existing
	// PicoKVM RPC implementation so timing and GPIO mapping stay in one place.
	s.AddTool(mcp.NewTool("trigger_power",
		mcp.WithDescription("Trigger the configured host power-button pulse"),
	), handleTriggerPower)

	s.AddTool(mcp.NewTool("trigger_reset",
		mcp.WithDescription("Trigger the configured host reset-button pulse"),
	), handleTriggerReset)

	s.AddTool(mcp.NewTool("send_wol",
		mcp.WithDescription("Send a Wake-on-LAN magic packet"),
		mcp.WithString("mac", mcp.Required(), mcp.Description("Target MAC address")),
	), handleSendWOL)

	s.AddTool(mcp.NewTool("probe_mcu",
		mcp.WithDescription("Read-only probe for RV1106 MCU loader, remoteproc/rpmsg and device-tree facilities"),
	), handleProbeMCU)

	s.AddTool(mcp.NewTool("get_rtp_multicast_status",
		mcp.WithDescription("Get the optional LAN RTP multicast sender status"),
	), handleGetRTPMulticastStatus)

	s.AddTool(mcp.NewTool("start_rtp_multicast",
		mcp.WithDescription("Start one hardware-encoded RTP multicast stream for efficient LAN fan-out"),
		mcp.WithString("address", mcp.Description("IPv4 multicast group and UDP port, default 239.255.42.42:5004")),
		mcp.WithNumber("ttl", mcp.Description("Multicast TTL 1-255, default 1")),
	), handleStartRTPMulticast)

	s.AddTool(mcp.NewTool("stop_rtp_multicast",
		mcp.WithDescription("Stop the optional LAN RTP multicast stream"),
	), handleStopRTPMulticast)

	// Virtual-media and USB recovery tools make the MCP endpoint useful for
	// unattended provisioning/recovery without duplicating the vendor logic.
	s.AddTool(mcp.NewTool("get_usb_state",
		mcp.WithDescription("Get the USB gadget connection state"),
	), handleGetUSBState)

	s.AddTool(mcp.NewTool("usb_wakeup",
		mcp.WithDescription("Send a USB remote-wakeup signal to the attached host"),
	), handleUSBWakeup)

	s.AddTool(mcp.NewTool("get_virtual_media_state",
		mcp.WithDescription("Get the currently mounted virtual CD-ROM/disk state"),
	), handleGetVirtualMediaState)

	s.AddTool(mcp.NewTool("list_virtual_media",
		mcp.WithDescription("List internal and SD-card virtual-media images and current mount state"),
	), handleListVirtualMedia)

	s.AddTool(mcp.NewTool("mount_virtual_media",
		mcp.WithDescription("Mount an existing internal or SD-card image as USB virtual media"),
		mcp.WithString("filename", mcp.Required(), mcp.Description("Image filename")),
		mcp.WithString("source", mcp.Enum("storage", "sd"), mcp.Description("Image source; defaults to storage")),
		mcp.WithString("mode", mcp.Enum("auto", "cdrom", "disk"), mcp.Description("USB media mode; defaults to auto")),
	), handleMountVirtualMedia)

	s.AddTool(mcp.NewTool("mount_virtual_media_url",
		mcp.WithDescription("Mount a remote HTTP image directly as USB virtual media"),
		mcp.WithString("url", mcp.Required(), mcp.Description("HTTP/HTTPS image URL")),
		mcp.WithString("mode", mcp.Enum("auto", "cdrom", "disk"), mcp.Description("USB media mode; defaults to auto")),
	), handleMountVirtualMediaURL)

	s.AddTool(mcp.NewTool("unmount_virtual_media",
		mcp.WithDescription("Unmount the current USB virtual media image"),
	), handleUnmountVirtualMedia)
}

// === MCP Handlers ===

func handleMouseMoveAbsolute(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	x, _ := args["x"].(float64)
	y, _ := args["y"].(float64)
	_, err := callRPCHandler(rpcHandlers["absMouseReport"], map[string]interface{}{
		"x": x, "y": y, "buttons": 0,
	})
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Mouse moved to (%d, %d)", int(x), int(y))), nil
}

func handleMouseMoveRelative(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	dx, _ := args["dx"].(float64)
	dy, _ := args["dy"].(float64)
	_, err := callRPCHandler(rpcHandlers["relMouseReport"], map[string]interface{}{
		"dx": dx, "dy": dy, "buttons": 0,
	})
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Mouse moved by (%d, %d)", int(dx), int(dy))), nil
}

func handleMouseClick(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	button, _ := args["button"].(string)
	var buttons uint8
	switch button {
	case "left":
		buttons = 1
	case "right":
		buttons = 2
	case "middle":
		buttons = 4
	}
	_, err := callRPCHandler(rpcHandlers["absMouseReport"], map[string]interface{}{
		"x": 0, "y": 0, "buttons": buttons,
	})
	if err != nil {
		return nil, err
	}
	_, err = callRPCHandler(rpcHandlers["absMouseReport"], map[string]interface{}{
		"x": 0, "y": 0, "buttons": 0,
	})
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Clicked %s button", button)), nil
}

func handleMouseScroll(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	delta, _ := args["delta"].(float64)
	_, err := callRPCHandler(rpcHandlers["wheelReport"], map[string]interface{}{
		"wheelY": delta,
	})
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Scrolled by %d", int(delta))), nil
}

func handleKeyboardKey(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	keyName, _ := args["key"].(string)
	keyCode, ok := keyNameToCode[keyName]
	if !ok {
		return nil, fmt.Errorf("unknown key: %s", keyName)
	}
	_, err := callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
		"modifier": 0, "keys": []uint8{keyCode},
	})
	if err != nil {
		return nil, err
	}
	_, err = callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
		"modifier": 0, "keys": []uint8{},
	})
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Pressed key: %s", keyName)), nil
}

func handleKeyboardCombo(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	keysArg, _ := args["keys"].([]interface{})
	var keys []uint8
	var modifier uint8

	for _, k := range keysArg {
		keyName, _ := k.(string)
		switch strings.ToLower(keyName) {
		case "ctrl", "control":
			modifier |= 0x01
			continue
		case "shift":
			modifier |= 0x02
			continue
		case "alt":
			modifier |= 0x04
			continue
		case "meta", "win", "cmd":
			modifier |= 0x08
			continue
		}
		keyCode, ok := keyNameToCode[keyName]
		if !ok {
			return nil, fmt.Errorf("unknown key: %s", keyName)
		}
		keys = append(keys, keyCode)
	}

	_, err := callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
		"modifier": modifier, "keys": keys,
	})
	if err != nil {
		return nil, err
	}
	_, err = callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
		"modifier": 0, "keys": []uint8{},
	})
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Pressed combo: %v", keysArg)), nil
}

func handleTypeText(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	text, _ := args["text"].(string)
	for _, char := range text {
		keyCode, modifier, ok := charToKeyCode(uint8(char))
		if !ok {
			continue
		}
		_, err := callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
			"modifier": modifier, "keys": []uint8{keyCode},
		})
		if err != nil {
			return nil, err
		}
		_, err = callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
			"modifier": 0, "keys": []uint8{},
		})
		if err != nil {
			return nil, err
		}
	}
	return mcp.NewToolResultText(fmt.Sprintf("Typed: %s", text)), nil
}

func handleCaptureScreenshot(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := captureScreenshot("jpeg")
	if err != nil {
		return nil, err
	}
	base64Data := base64.StdEncoding.EncodeToString(data)
	return mcp.NewToolResultImage("JPEG screenshot captured", base64Data, "image/jpeg"), nil
}

func handleGetVideoState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	result, err := callRPCHandler(rpcHandlers["getVideoState"], nil)
	if err != nil {
		return nil, err
	}
	state, ok := result.(VideoInputState)
	if !ok {
		return nil, fmt.Errorf("unexpected video state type")
	}
	text := fmt.Sprintf("Video: %dx%d @ %.1f fps (Ready: %v)", state.Width, state.Height, state.FramePerSecond, state.Ready)
	if state.Error != "" {
		text += fmt.Sprintf(" [Error: %s]", state.Error)
	}
	return mcp.NewToolResultText(text), nil
}

func handleGetStreamStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getEnhancedStreamStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetHostPowerState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	state, err := rpcGetIOInputStatus()
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleTriggerPower(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := rpcTriggerPower(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Power-button pulse triggered"), nil
}

func handleTriggerReset(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := rpcTriggerReset(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Reset-button pulse triggered"), nil
}

func handleSendWOL(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	mac, _ := args["mac"].(string)
	if mac == "" {
		return nil, fmt.Errorf("mac is required")
	}
	if err := rpcSendWOLMagicPacket(mac); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Wake-on-LAN packet sent to %s", mac)), nil
}

func handleProbeMCU(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := probeMCUStatus()
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleGetRTPMulticastStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getRTPMulticastStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleStartRTPMulticast(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	address, _ := args["address"].(string)
	if strings.TrimSpace(address) == "" {
		address = defaultRTPMulticastAddress
	}
	ttl := defaultRTPMulticastTTL
	if value, ok := args["ttl"].(float64); ok && value != 0 {
		ttl = int(value)
	}

	status, err := startRTPMulticast(address, ttl)
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleStopRTPMulticast(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	status := stopRTPMulticast()
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}
