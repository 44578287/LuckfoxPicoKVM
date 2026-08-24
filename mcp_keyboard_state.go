package kvm

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

var mcpKeyboardAutomationState = struct {
	sync.Mutex
	modifier uint8
	keys     map[uint8]struct{}
}{keys: make(map[uint8]struct{})}

func mcpModifierBit(name string) (uint8, bool) {
	switch strings.ToLower(strings.ReplaceAll(strings.TrimSpace(name), " ", "")) {
	case "ctrl", "control", "leftctrl", "leftcontrol":
		return 0x01, true
	case "shift", "leftshift":
		return 0x02, true
	case "alt", "leftalt":
		return 0x04, true
	case "meta", "win", "windows", "cmd", "gui", "leftgui", "leftwin":
		return 0x08, true
	case "rightctrl", "rightcontrol":
		return 0x10, true
	case "rightshift":
		return 0x20, true
	case "rightalt", "altgr":
		return 0x40, true
	case "rightgui", "rightwin", "rightwindows":
		return 0x80, true
	default:
		return 0, false
	}
}

func mcpAutomationKeysLocked(extra ...uint8) ([]uint8, error) {
	seen := make(map[uint8]struct{}, len(mcpKeyboardAutomationState.keys)+len(extra))
	keys := make([]uint8, 0, len(mcpKeyboardAutomationState.keys)+len(extra))
	for code := range mcpKeyboardAutomationState.keys {
		seen[code] = struct{}{}
		keys = append(keys, code)
	}
	for _, code := range extra {
		if code == 0 {
			continue
		}
		if _, ok := seen[code]; ok {
			continue
		}
		seen[code] = struct{}{}
		keys = append(keys, code)
	}
	if len(keys) > 6 {
		return nil, fmt.Errorf("USB boot keyboard supports at most 6 simultaneous non-modifier keys")
	}
	return keys, nil
}

func mcpKeyboardSendAutomationStateLocked(extraModifier uint8, extraKeys ...uint8) error {
	keys, err := mcpAutomationKeysLocked(extraKeys...)
	if err != nil {
		return err
	}
	return mcpKeyboardReportV2(mcpKeyboardAutomationState.modifier|extraModifier, keys)
}

func handleKeyboardKeyV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key, _ := req.GetArguments()["key"].(string)
	if bit, ok := mcpModifierBit(key); ok {
		mcpKeyboardAutomationState.Lock()
		err := mcpKeyboardSendAutomationStateLocked(bit)
		if err == nil {
			err = sleepContext(ctx, 12*time.Millisecond)
		}
		if err == nil {
			err = mcpKeyboardSendAutomationStateLocked(0)
		}
		mcpKeyboardAutomationState.Unlock()
		if err != nil {
			return nil, err
		}
		return mcp.NewToolResultText(fmt.Sprintf("Pressed modifier key: %s", key)), nil
	}
	code, err := mcpLookupKeyV2(key)
	if err != nil {
		return nil, err
	}
	mcpKeyboardAutomationState.Lock()
	err = mcpKeyboardSendAutomationStateLocked(0, code)
	if err == nil {
		err = sleepContext(ctx, 12*time.Millisecond)
	}
	if err == nil {
		err = mcpKeyboardSendAutomationStateLocked(0)
	}
	mcpKeyboardAutomationState.Unlock()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Pressed key: %s (HID 0x%02X)", key, code)), nil
}

func handleKeyboardComboV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	items, err := req.RequireStringSlice("keys")
	if err != nil || len(items) == 0 {
		return nil, fmt.Errorf("keys is required")
	}
	var comboModifier uint8
	comboKeys := make([]uint8, 0, 6)
	for _, name := range items {
		if bit, ok := mcpModifierBit(name); ok {
			comboModifier |= bit
			continue
		}
		code, lookupErr := mcpLookupKeyV2(name)
		if lookupErr != nil {
			return nil, lookupErr
		}
		comboKeys = append(comboKeys, code)
	}
	if len(comboKeys) > 6 {
		return nil, fmt.Errorf("USB boot keyboard supports at most 6 simultaneous non-modifier keys")
	}
	mcpKeyboardAutomationState.Lock()
	err = mcpKeyboardSendAutomationStateLocked(comboModifier, comboKeys...)
	if err == nil {
		err = sleepContext(ctx, 18*time.Millisecond)
	}
	if err == nil {
		err = mcpKeyboardSendAutomationStateLocked(0)
	}
	mcpKeyboardAutomationState.Unlock()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Pressed combo: %v", items)), nil
}

func handleKeyboardEventV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	key, _ := req.GetArguments()["key"].(string)
	action := strings.ToLower(strings.TrimSpace(req.GetString("action", "")))
	if action != "down" && action != "up" && action != "press" {
		return nil, fmt.Errorf("invalid action %q; use press, down or up", action)
	}

	mcpKeyboardAutomationState.Lock()
	defer mcpKeyboardAutomationState.Unlock()

	if bit, ok := mcpModifierBit(key); ok {
		switch action {
		case "down":
			mcpKeyboardAutomationState.modifier |= bit
			if err := mcpKeyboardSendAutomationStateLocked(0); err != nil { return nil, err }
		case "up":
			mcpKeyboardAutomationState.modifier &^= bit
			if err := mcpKeyboardSendAutomationStateLocked(0); err != nil { return nil, err }
		case "press":
			if err := mcpKeyboardSendAutomationStateLocked(bit); err != nil { return nil, err }
			if err := sleepContext(ctx, 12*time.Millisecond); err != nil { return nil, err }
			if err := mcpKeyboardSendAutomationStateLocked(0); err != nil { return nil, err }
		}
		return mcp.NewToolResultText(fmt.Sprintf("Modifier %s %s", key, action)), nil
	}

	code, err := mcpLookupKeyV2(key)
	if err != nil {
		return nil, err
	}
	switch action {
	case "down":
		mcpKeyboardAutomationState.keys[code] = struct{}{}
		err = mcpKeyboardSendAutomationStateLocked(0)
	case "up":
		delete(mcpKeyboardAutomationState.keys, code)
		err = mcpKeyboardSendAutomationStateLocked(0)
	case "press":
		err = mcpKeyboardSendAutomationStateLocked(0, code)
		if err == nil {
			err = sleepContext(ctx, 12*time.Millisecond)
		}
		if err == nil {
			err = mcpKeyboardSendAutomationStateLocked(0)
		}
	}
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(fmt.Sprintf("Key %s %s", key, action)), nil
}

func handleKeyboardReleaseAllV3(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mcpKeyboardAutomationState.Lock()
	mcpKeyboardAutomationState.modifier = 0
	clear(mcpKeyboardAutomationState.keys)
	err := mcpKeyboardReportV2(0, nil)
	mcpKeyboardAutomationState.Unlock()
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Released all keyboard keys and modifiers"), nil
}
