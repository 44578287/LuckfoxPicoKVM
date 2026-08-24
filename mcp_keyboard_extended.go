package kvm

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mark3labs/mcp-go/mcp"
)

const mcpShiftModifierV2 uint8 = 0x02

func mcpLookupKeyV2(name string) (uint8, error) {
	n := strings.TrimSpace(name)
	if n == "" {
		return 0, fmt.Errorf("key is required")
	}
	upper := strings.ToUpper(n)
	if strings.HasPrefix(upper, "F") {
		if fn, err := strconv.Atoi(strings.TrimPrefix(upper, "F")); err == nil {
			switch {
			case fn >= 1 && fn <= 12:
				return uint8(0x3A + fn - 1), nil
			case fn >= 13 && fn <= 24:
				return uint8(0x68 + fn - 13), nil
			}
		}
	}

	aliases := map[string]uint8{
		"ENTER": 0x28, "RETURN": 0x28,
		"ESC": 0x29, "ESCAPE": 0x29,
		"BACKSPACE": 0x2A, "TAB": 0x2B, "SPACE": 0x2C, "SPACEBAR": 0x2C,
		"PRINTSCREEN": 0x46, "PRINT_SCREEN": 0x46, "SCROLLLOCK": 0x47, "PAUSE": 0x48,
		"INSERT": 0x49, "INS": 0x49, "HOME": 0x4A, "PAGEUP": 0x4B, "PGUP": 0x4B,
		"DELETE": 0x4C, "DEL": 0x4C, "END": 0x4D, "PAGEDOWN": 0x4E, "PGDN": 0x4E,
		"RIGHT": 0x4F, "ARROWRIGHT": 0x4F, "LEFT": 0x50, "ARROWLEFT": 0x50,
		"DOWN": 0x51, "ARROWDOWN": 0x51, "UP": 0x52, "ARROWUP": 0x52,
		"NUMLOCK": 0x53,
	}
	if code, ok := aliases[strings.ReplaceAll(upper, " ", "")]; ok {
		return code, nil
	}

	for _, candidate := range []string{n, upper, strings.ToLower(n), strings.ToUpper(n[:1]) + strings.ToLower(n[1:])} {
		if code, ok := keyNameToCode[candidate]; ok {
			return code, nil
		}
	}
	if len([]rune(n)) == 1 {
		code, _, err := mcpASCIIReportV2([]rune(n)[0])
		if err == nil {
			return code, nil
		}
	}
	return 0, fmt.Errorf("unknown key: %s", name)
}

func mcpASCIIReportV2(r rune) (keyCode uint8, modifier uint8, err error) {
	if r >= 'a' && r <= 'z' {
		return uint8(0x04 + r - 'a'), 0, nil
	}
	if r >= 'A' && r <= 'Z' {
		return uint8(0x04 + r - 'A'), mcpShiftModifierV2, nil
	}
	if r >= '1' && r <= '9' {
		return uint8(0x1E + r - '1'), 0, nil
	}
	if r == '0' {
		return 0x27, 0, nil
	}
	switch r {
	case '\n', '\r':
		return 0x28, 0, nil
	case '\t':
		return 0x2B, 0, nil
	case '\b':
		return 0x2A, 0, nil
	case ' ':
		return 0x2C, 0, nil
	case '-':
		return 0x2D, 0, nil
	case '_':
		return 0x2D, mcpShiftModifierV2, nil
	case '=':
		return 0x2E, 0, nil
	case '+':
		return 0x2E, mcpShiftModifierV2, nil
	case '[':
		return 0x2F, 0, nil
	case '{':
		return 0x2F, mcpShiftModifierV2, nil
	case ']':
		return 0x30, 0, nil
	case '}':
		return 0x30, mcpShiftModifierV2, nil
	case '\\':
		return 0x31, 0, nil
	case '|':
		return 0x31, mcpShiftModifierV2, nil
	case ';':
		return 0x33, 0, nil
	case ':':
		return 0x33, mcpShiftModifierV2, nil
	case '\'':
		return 0x34, 0, nil
	case '"':
		return 0x34, mcpShiftModifierV2, nil
	case '`':
		return 0x35, 0, nil
	case '~':
		return 0x35, mcpShiftModifierV2, nil
	case ',':
		return 0x36, 0, nil
	case '<':
		return 0x36, mcpShiftModifierV2, nil
	case '.':
		return 0x37, 0, nil
	case '>':
		return 0x37, mcpShiftModifierV2, nil
	case '/':
		return 0x38, 0, nil
	case '?':
		return 0x38, mcpShiftModifierV2, nil
	case '!':
		return 0x1E, mcpShiftModifierV2, nil
	case '@':
		return 0x1F, mcpShiftModifierV2, nil
	case '#':
		return 0x20, mcpShiftModifierV2, nil
	case '$':
		return 0x21, mcpShiftModifierV2, nil
	case '%':
		return 0x22, mcpShiftModifierV2, nil
	case '^':
		return 0x23, mcpShiftModifierV2, nil
	case '&':
		return 0x24, mcpShiftModifierV2, nil
	case '*':
		return 0x25, mcpShiftModifierV2, nil
	case '(':
		return 0x26, mcpShiftModifierV2, nil
	case ')':
		return 0x27, mcpShiftModifierV2, nil
	default:
		return 0, 0, fmt.Errorf("character %q (U+%04X) cannot be represented by the US USB-HID text map", r, r)
	}
}

func mcpKeyboardReportV2(modifier uint8, keys []uint8) error {
	if gadget == nil {
		return fmt.Errorf("USB gadget is not initialized")
	}
	if err := rpcKeyboardReport(modifier, keys); err != nil {
		if task := startUSBReinitializeAsync("hard", "automatic HID recovery after keyboard error"); task.ID != "" {
			return fmt.Errorf("keyboard HID unavailable: %w; USB recovery started (task=%s), poll get_usb_reinitialize_status then retry", err, task.ID)
		}
		return fmt.Errorf("keyboard HID unavailable: %w", err)
	}
	return nil
}

func handleKeyboardKeyV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key, _ := req.GetArguments()["key"].(string)
	code, err := mcpLookupKeyV2(key)
	if err != nil {
		return nil, err
	}
	if err = mcpKeyboardReportV2(0, []uint8{code}); err != nil {
		return nil, err
	}
	if err = sleepContext(ctx, 12*time.Millisecond); err != nil {
		return nil, err
	}
	if err = mcpKeyboardReportV2(0, nil); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Pressed key: %s (HID 0x%02X)", key, code)), nil
}

func handleKeyboardComboV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	raw, _ := req.GetArguments()["keys"].([]interface{})
	if len(raw) == 0 {
		return nil, fmt.Errorf("keys is required")
	}
	var modifier uint8
	keys := make([]uint8, 0, 6)
	for _, item := range raw {
		name, _ := item.(string)
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "ctrl", "control", "leftctrl", "leftcontrol":
			modifier |= 0x01
		case "shift", "leftshift":
			modifier |= 0x02
		case "alt", "leftalt":
			modifier |= 0x04
		case "meta", "win", "windows", "cmd", "gui", "leftgui":
			modifier |= 0x08
		case "rightctrl", "rightcontrol":
			modifier |= 0x10
		case "rightshift":
			modifier |= 0x20
		case "rightalt", "altgr":
			modifier |= 0x40
		case "rightgui", "rightwin":
			modifier |= 0x80
		default:
			code, err := mcpLookupKeyV2(name)
			if err != nil {
				return nil, err
			}
			if len(keys) >= 6 {
				return nil, fmt.Errorf("USB boot keyboard supports at most 6 simultaneous non-modifier keys")
			}
			keys = append(keys, code)
		}
	}
	if err := mcpKeyboardReportV2(modifier, keys); err != nil {
		return nil, err
	}
	if err := sleepContext(ctx, 18*time.Millisecond); err != nil {
		return nil, err
	}
	if err := mcpKeyboardReportV2(0, nil); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Pressed combo: %v", raw)), nil
}

func handleKeyboardEventV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key, _ := req.GetArguments()["key"].(string)
	action, _ := req.GetArguments()["action"].(string)
	code, err := mcpLookupKeyV2(key)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(action) {
	case "down":
		err = mcpKeyboardReportV2(0, []uint8{code})
	case "up":
		err = mcpKeyboardReportV2(0, nil)
	case "press":
		if err = mcpKeyboardReportV2(0, []uint8{code}); err == nil {
			if e := sleepContext(ctx, 12*time.Millisecond); e != nil {
				err = e
			} else {
				err = mcpKeyboardReportV2(0, nil)
			}
		}
	default:
		return nil, fmt.Errorf("invalid action %q", action)
	}
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Key %s %s", key, action)), nil
}

func handleKeyboardReleaseAllV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := mcpKeyboardReportV2(0, nil); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Released all keyboard keys and modifiers"), nil
}

func runReliableTextInjectionV2(ctx context.Context, text string, opts reliableTextOptions) (int, time.Duration, error) {
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
	if state := rpcGetUSBState(); state != "configured" {
		return 0, 0, fmt.Errorf("USB gadget is not configured (state=%s)", state)
	}

	type report struct{ keyCode, modifier uint8 }
	reports := make([]report, 0, utf8.RuneCountInString(text))
	for _, r := range text {
		if r > 0x7f {
			return 0, 0, fmt.Errorf("non-ASCII character %q requires a host clipboard/IME agent", r)
		}
		code, mod, err := mcpASCIIReportV2(r)
		if err != nil {
			return 0, 0, err
		}
		reports = append(reports, report{code, mod})
	}

	reliableTextInjectionMu.Lock()
	defer reliableTextInjectionMu.Unlock()
	started := time.Now()
	if err := mcpKeyboardReportV2(0, nil); err != nil {
		return 0, 0, err
	}
	defer func() { _ = rpcKeyboardReport(0, nil) }()
	for i, rep := range reports {
		if err := ctx.Err(); err != nil {
			return i, time.Since(started), err
		}
		if err := mcpKeyboardReportV2(rep.modifier, []uint8{rep.keyCode}); err != nil {
			return i, time.Since(started), fmt.Errorf("key down failed at character %d: %w", i, err)
		}
		if err := sleepContext(ctx, time.Duration(opts.KeyDownMs)*time.Millisecond); err != nil {
			return i, time.Since(started), err
		}
		if err := mcpKeyboardReportV2(0, nil); err != nil {
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

func handleReliableTypeTextV2(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	text, ok := req.GetArguments()["text"].(string)
	if !ok {
		return nil, fmt.Errorf("text is required")
	}
	opts, err := reliableTextOptionsFromArgs(req.GetArguments())
	if err != nil {
		return nil, err
	}
	sent, elapsed, err := runReliableTextInjectionV2(ctx, text, opts)
	if err != nil {
		return nil, fmt.Errorf("reliable text injection stopped after %d characters: %w", sent, err)
	}
	return mcp.NewToolResultText(fmt.Sprintf("Reliable text injection completed: %d characters in %s", sent, elapsed.Round(time.Millisecond))), nil
}
