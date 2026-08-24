package kvm

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var reliableTextInjectionMu sync.Mutex

type reliableTextOptions struct {
	KeyDownMs    int
	InterKeyMs   int
	ChunkSize    int
	ChunkPauseMs int
}

func registerReliableTextInjectionMCPTools(s *server.MCPServer) {
	// Re-register type_text after the legacy MCP tools so existing clients keep
	// the same tool name but transparently get the reliable device-local pacing.
	s.AddTool(mcp.NewTool("type_text",
		mcp.WithDescription("Reliably type an ASCII text string through USB HID. The full string is submitted once; PicoKVM serializes and paces key press/release reports locally to avoid duplicate/missing characters."),
		mcp.WithString("text", mcp.Required(), mcp.Description("ASCII text to type; CR/LF is normalized to Enter")),
		mcp.WithString("profile", mcp.Enum("safe", "normal", "fast"), mcp.Description("Typing profile; default normal")),
		mcp.WithNumber("key_down_ms", mcp.Description("Optional key-down hold override, 2-100 ms")),
		mcp.WithNumber("inter_key_ms", mcp.Description("Optional delay after key release, 2-100 ms")),
		mcp.WithNumber("chunk_size", mcp.Description("Optional characters per pacing chunk, 1-256")),
		mcp.WithNumber("chunk_pause_ms", mcp.Description("Optional pause after each chunk, 0-500 ms")),
	), handleReliableTypeText)

	s.AddTool(mcp.NewTool("inject_text",
		mcp.WithDescription("Inject a complete ASCII text payload through the reliable USB-HID text engine. Use profile=safe for BIOS/slow consoles and fast only after validation."),
		mcp.WithString("text", mcp.Required()),
		mcp.WithString("profile", mcp.Enum("safe", "normal", "fast"), mcp.Description("Typing profile; default normal")),
		mcp.WithNumber("key_down_ms", mcp.Description("Optional key-down hold override, 2-100 ms")),
		mcp.WithNumber("inter_key_ms", mcp.Description("Optional delay after key release, 2-100 ms")),
		mcp.WithNumber("chunk_size", mcp.Description("Optional characters per pacing chunk, 1-256")),
		mcp.WithNumber("chunk_pause_ms", mcp.Description("Optional pause after each chunk, 0-500 ms")),
	), handleReliableTypeText)
}

func reliableTextOptionsFromArgs(args map[string]interface{}) (reliableTextOptions, error) {
	profile, _ := args["profile"].(string)
	profile = strings.ToLower(strings.TrimSpace(profile))
	if profile == "" {
		profile = "normal"
	}

	var opts reliableTextOptions
	switch profile {
	case "safe":
		opts = reliableTextOptions{KeyDownMs: 15, InterKeyMs: 15, ChunkSize: 16, ChunkPauseMs: 35}
	case "normal":
		opts = reliableTextOptions{KeyDownMs: 8, InterKeyMs: 8, ChunkSize: 32, ChunkPauseMs: 20}
	case "fast":
		opts = reliableTextOptions{KeyDownMs: 4, InterKeyMs: 4, ChunkSize: 64, ChunkPauseMs: 10}
	default:
		return reliableTextOptions{}, fmt.Errorf("invalid profile %q; use safe, normal or fast", profile)
	}

	if v, ok := args["key_down_ms"].(float64); ok {
		opts.KeyDownMs = int(v)
	}
	if v, ok := args["inter_key_ms"].(float64); ok {
		opts.InterKeyMs = int(v)
	}
	if v, ok := args["chunk_size"].(float64); ok {
		opts.ChunkSize = int(v)
	}
	if v, ok := args["chunk_pause_ms"].(float64); ok {
		opts.ChunkPauseMs = int(v)
	}

	if opts.KeyDownMs < 2 || opts.KeyDownMs > 100 {
		return reliableTextOptions{}, fmt.Errorf("key_down_ms must be between 2 and 100")
	}
	if opts.InterKeyMs < 2 || opts.InterKeyMs > 100 {
		return reliableTextOptions{}, fmt.Errorf("inter_key_ms must be between 2 and 100")
	}
	if opts.ChunkSize < 1 || opts.ChunkSize > 256 {
		return reliableTextOptions{}, fmt.Errorf("chunk_size must be between 1 and 256")
	}
	if opts.ChunkPauseMs < 0 || opts.ChunkPauseMs > 500 {
		return reliableTextOptions{}, fmt.Errorf("chunk_pause_ms must be between 0 and 500")
	}
	return opts, nil
}

func normalizeReliableText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text
}

func reliableRuneToReport(r rune) (uint8, uint8, error) {
	switch r {
	case '\n':
		code, err := mcpLookupKey("Enter")
		return code, 0, err
	case '\t':
		code, err := mcpLookupKey("Tab")
		return code, 0, err
	case '\b':
		code, err := mcpLookupKey("Backspace")
		return code, 0, err
	}

	if r < 0 || r > 0x7f {
		return 0, 0, fmt.Errorf("non-ASCII character %q (U+%04X) cannot be reliably injected through generic USB HID without a host-side IME/clipboard agent", r, r)
	}
	keyCode, modifier, ok := charToKeyCode(uint8(r))
	if !ok {
		return 0, 0, fmt.Errorf("ASCII character %q is not mapped by the current HID text map", r)
	}
	return keyCode, modifier, nil
}

func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func runReliableTextInjection(ctx context.Context, text string, opts reliableTextOptions) (int, time.Duration, error) {
	text = normalizeReliableText(text)
	if text == "" {
		return 0, 0, nil
	}
	if !utf8.ValidString(text) {
		return 0, 0, fmt.Errorf("text is not valid UTF-8")
	}
	if utf8.RuneCountInString(text) > 32768 {
		return 0, 0, fmt.Errorf("text exceeds the 32768-character reliable injection limit")
	}
	if gadget == nil {
		return 0, 0, fmt.Errorf("USB gadget is not initialized")
	}
	if state := rpcGetUSBState(); state != "configured" {
		return 0, 0, fmt.Errorf("USB gadget is not configured (state=%s)", state)
	}

	// Validate the entire payload before touching the keyboard so unsupported
	// characters cannot leave a partially-entered command on the host.
	type report struct {
		keyCode  uint8
		modifier uint8
	}
	reports := make([]report, 0, utf8.RuneCountInString(text))
	for _, r := range text {
		keyCode, modifier, err := reliableRuneToReport(r)
		if err != nil {
			return 0, 0, err
		}
		reports = append(reports, report{keyCode: keyCode, modifier: modifier})
	}

	reliableTextInjectionMu.Lock()
	defer reliableTextInjectionMu.Unlock()

	started := time.Now()
	// Clear any stale browser/MCP key state before the transaction, and always
	// release again on exit/cancellation.
	if err := rpcKeyboardReport(0, []uint8{}); err != nil {
		return 0, 0, err
	}
	defer func() { _ = rpcKeyboardReport(0, []uint8{}) }()
	if err := sleepContext(ctx, 10*time.Millisecond); err != nil {
		return 0, time.Since(started), err
	}

	for i, rep := range reports {
		select {
		case <-ctx.Done():
			return i, time.Since(started), ctx.Err()
		default:
		}

		if err := rpcKeyboardReport(rep.modifier, []uint8{rep.keyCode}); err != nil {
			return i, time.Since(started), fmt.Errorf("key down failed at character %d: %w", i, err)
		}
		if err := sleepContext(ctx, time.Duration(opts.KeyDownMs)*time.Millisecond); err != nil {
			return i, time.Since(started), err
		}
		if err := rpcKeyboardReport(0, []uint8{}); err != nil {
			return i, time.Since(started), fmt.Errorf("key release failed at character %d: %w", i, err)
		}
		if err := sleepContext(ctx, time.Duration(opts.InterKeyMs)*time.Millisecond); err != nil {
			return i + 1, time.Since(started), err
		}

		if opts.ChunkPauseMs > 0 && (i+1)%opts.ChunkSize == 0 && i+1 < len(reports) {
			if err := sleepContext(ctx, time.Duration(opts.ChunkPauseMs)*time.Millisecond); err != nil {
				return i + 1, time.Since(started), err
			}
		}
	}

	return len(reports), time.Since(started), nil
}

func handleReliableTypeText(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	text, ok := args["text"].(string)
	if !ok {
		return nil, fmt.Errorf("text is required")
	}
	opts, err := reliableTextOptionsFromArgs(args)
	if err != nil {
		return nil, err
	}

	sent, elapsed, err := runReliableTextInjection(ctx, text, opts)
	if err != nil {
		return nil, fmt.Errorf("reliable text injection stopped after %d characters: %w", sent, err)
	}
	return mcp.NewToolResultText(fmt.Sprintf("Reliable text injection completed: %d characters in %s (key_down=%dms inter_key=%dms chunk=%d pause=%dms)", sent, elapsed.Round(time.Millisecond), opts.KeyDownMs, opts.InterKeyMs, opts.ChunkSize, opts.ChunkPauseMs)), nil
}
