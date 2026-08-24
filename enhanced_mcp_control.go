package kvm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const enhancedMCPControlSettingsPath = "/userdata/picokvm/enhanced_mcp_control.json"

// EnhancedMCPControlSettings controls how autonomous MCP input is exposed to a
// human using the normal PicoKVM Web UI at the same time.
type EnhancedMCPControlSettings struct {
	LockLocalInputDuringAction bool `json:"lock_local_input_during_action"`
	LockReleaseDelayMs         int  `json:"lock_release_delay_ms"`
	ShowVirtualCursor          bool `json:"show_virtual_cursor"`
	CursorHideDelayMs          int  `json:"cursor_hide_delay_ms"`
	ShowActionHUD              bool `json:"show_action_hud"`
	ShowLiveLog                bool `json:"show_live_log"`
	LogLimit                   int  `json:"log_limit"`
	RedactTypedText            bool `json:"redact_typed_text"`
}

type EnhancedMCPActionLog struct {
	Seq       uint64 `json:"seq"`
	Timestamp string `json:"timestamp"`
	Kind      string `json:"kind"`
	Summary   string `json:"summary"`
	Success   *bool  `json:"success,omitempty"`
}

type EnhancedMCPControlStatus struct {
	Settings          EnhancedMCPControlSettings `json:"settings"`
	Active            bool                       `json:"active"`
	CurrentAction     string                     `json:"current_action,omitempty"`
	ActionStartedAt   string                     `json:"action_started_at,omitempty"`
	LocalInputLocked  bool                       `json:"local_input_locked"`
	LockRemainingMs   int64                      `json:"lock_remaining_ms"`
	ManualTakeover    bool                       `json:"manual_takeover"`
	PointerHIDX       int                        `json:"pointer_hid_x"`
	PointerHIDY       int                        `json:"pointer_hid_y"`
	PointerVisible    bool                       `json:"pointer_visible"`
	CursorRemainingMs int64                      `json:"cursor_remaining_ms"`
	Logs              []EnhancedMCPActionLog     `json:"logs,omitempty"`
}

var enhancedMCPControl = struct {
	sync.Mutex
	settings       EnhancedMCPControlSettings
	loaded         bool
	activeDepth    int
	currentAction  string
	actionStarted  time.Time
	lockUntil      time.Time
	manualTakeover bool
	pointerX       int
	pointerY       int
	cursorUntil    time.Time
	seq            uint64
	logs           []EnhancedMCPActionLog
}{pointerX: 16384, pointerY: 16384}

func defaultEnhancedMCPControlSettings() EnhancedMCPControlSettings {
	return EnhancedMCPControlSettings{
		LockLocalInputDuringAction: true,
		LockReleaseDelayMs:         450,
		ShowVirtualCursor:          true,
		CursorHideDelayMs:          1800,
		ShowActionHUD:              true,
		ShowLiveLog:                true,
		LogLimit:                   100,
		RedactTypedText:            true,
	}
}

func validateEnhancedMCPControlSettings(s EnhancedMCPControlSettings) error {
	if s.LockReleaseDelayMs < 0 || s.LockReleaseDelayMs > 10000 {
		return fmt.Errorf("lock_release_delay_ms must be between 0 and 10000")
	}
	if s.CursorHideDelayMs < 100 || s.CursorHideDelayMs > 30000 {
		return fmt.Errorf("cursor_hide_delay_ms must be between 100 and 30000")
	}
	if s.LogLimit < 10 || s.LogLimit > 500 {
		return fmt.Errorf("log_limit must be between 10 and 500")
	}
	return nil
}

func loadEnhancedMCPControlSettingsLocked() {
	if enhancedMCPControl.loaded {
		return
	}
	enhancedMCPControl.settings = defaultEnhancedMCPControlSettings()
	raw, err := os.ReadFile(enhancedMCPControlSettingsPath)
	if err == nil {
		var s EnhancedMCPControlSettings
		if json.Unmarshal(raw, &s) == nil && validateEnhancedMCPControlSettings(s) == nil {
			enhancedMCPControl.settings = s
		}
	}
	enhancedMCPControl.loaded = true
}

func getEnhancedMCPControlSettings() EnhancedMCPControlSettings {
	enhancedMCPControl.Lock()
	defer enhancedMCPControl.Unlock()
	loadEnhancedMCPControlSettingsLocked()
	return enhancedMCPControl.settings
}

func setEnhancedMCPControlSettings(s EnhancedMCPControlSettings) error {
	if err := validateEnhancedMCPControlSettings(s); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(enhancedMCPControlSettingsPath), 0755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := enhancedMCPControlSettingsPath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, enhancedMCPControlSettingsPath); err != nil {
		return err
	}
	enhancedMCPControl.Lock()
	enhancedMCPControl.settings = s
	enhancedMCPControl.loaded = true
	if len(enhancedMCPControl.logs) > s.LogLimit {
		enhancedMCPControl.logs = append([]EnhancedMCPActionLog(nil), enhancedMCPControl.logs[len(enhancedMCPControl.logs)-s.LogLimit:]...)
	}
	enhancedMCPControl.Unlock()
	return nil
}

func mcpControlAppendLogLocked(kind, summary string, success *bool) {
	loadEnhancedMCPControlSettingsLocked()
	enhancedMCPControl.seq++
	enhancedMCPControl.logs = append(enhancedMCPControl.logs, EnhancedMCPActionLog{
		Seq: enhancedMCPControl.seq, Timestamp: time.Now().Format(time.RFC3339Nano), Kind: kind, Summary: summary, Success: success,
	})
	limit := enhancedMCPControl.settings.LogLimit
	if limit <= 0 {
		limit = 100
	}
	if len(enhancedMCPControl.logs) > limit {
		enhancedMCPControl.logs = append([]EnhancedMCPActionLog(nil), enhancedMCPControl.logs[len(enhancedMCPControl.logs)-limit:]...)
	}
}

// mcpControlBegin starts a human-visible action lease. Manual takeover rejects
// state-changing MCP input while leaving read-only MCP tools available.
func mcpControlBegin(kind, summary string) (func(error), error) {
	enhancedMCPControl.Lock()
	loadEnhancedMCPControlSettingsLocked()
	if enhancedMCPControl.manualTakeover {
		enhancedMCPControl.Unlock()
		return nil, fmt.Errorf("MCP input is paused by local Manual Takeover")
	}
	enhancedMCPControl.activeDepth++
	enhancedMCPControl.currentAction = summary
	enhancedMCPControl.actionStarted = time.Now()
	if enhancedMCPControl.settings.LockLocalInputDuringAction {
		enhancedMCPControl.lockUntil = time.Now().Add(time.Duration(enhancedMCPControl.settings.LockReleaseDelayMs) * time.Millisecond)
	}
	mcpControlAppendLogLocked(kind, summary, nil)
	enhancedMCPControl.Unlock()

	return func(actionErr error) {
		enhancedMCPControl.Lock()
		if enhancedMCPControl.activeDepth > 0 {
			enhancedMCPControl.activeDepth--
		}
		if enhancedMCPControl.settings.LockLocalInputDuringAction {
			enhancedMCPControl.lockUntil = time.Now().Add(time.Duration(enhancedMCPControl.settings.LockReleaseDelayMs) * time.Millisecond)
		}
		ok := actionErr == nil
		mcpControlAppendLogLocked(kind, summary, &ok)
		if enhancedMCPControl.activeDepth == 0 {
			enhancedMCPControl.currentAction = ""
		}
		enhancedMCPControl.Unlock()
	}, nil
}

func mcpControlPointerHID(x, y int) {
	now := time.Now()
	enhancedMCPControl.Lock()
	loadEnhancedMCPControlSettingsLocked()
	enhancedMCPControl.pointerX = clampMCPHID(x)
	enhancedMCPControl.pointerY = clampMCPHID(y)
	if enhancedMCPControl.settings.ShowVirtualCursor {
		enhancedMCPControl.cursorUntil = now.Add(time.Duration(enhancedMCPControl.settings.CursorHideDelayMs) * time.Millisecond)
	}
	if enhancedMCPControl.settings.LockLocalInputDuringAction && enhancedMCPControl.activeDepth > 0 {
		enhancedMCPControl.lockUntil = now.Add(time.Duration(enhancedMCPControl.settings.LockReleaseDelayMs) * time.Millisecond)
	}
	enhancedMCPControl.Unlock()
}

func getEnhancedMCPControlStatus() EnhancedMCPControlStatus {
	now := time.Now()
	enhancedMCPControl.Lock()
	defer enhancedMCPControl.Unlock()
	loadEnhancedMCPControlSettingsLocked()
	locked := enhancedMCPControl.settings.LockLocalInputDuringAction && !enhancedMCPControl.manualTakeover && (enhancedMCPControl.activeDepth > 0 || now.Before(enhancedMCPControl.lockUntil))
	remaining := int64(0)
	if now.Before(enhancedMCPControl.lockUntil) {
		remaining = enhancedMCPControl.lockUntil.Sub(now).Milliseconds()
	}
	cursorRemaining := int64(0)
	pointerVisible := enhancedMCPControl.settings.ShowVirtualCursor && now.Before(enhancedMCPControl.cursorUntil)
	if pointerVisible {
		cursorRemaining = enhancedMCPControl.cursorUntil.Sub(now).Milliseconds()
	}
	st := EnhancedMCPControlStatus{
		Settings: enhancedMCPControl.settings,
		Active: enhancedMCPControl.activeDepth > 0,
		CurrentAction: enhancedMCPControl.currentAction,
		LocalInputLocked: locked,
		LockRemainingMs: remaining,
		ManualTakeover: enhancedMCPControl.manualTakeover,
		PointerHIDX: enhancedMCPControl.pointerX,
		PointerHIDY: enhancedMCPControl.pointerY,
		PointerVisible: pointerVisible,
		CursorRemainingMs: cursorRemaining,
		Logs: append([]EnhancedMCPActionLog(nil), enhancedMCPControl.logs...),
	}
	if !enhancedMCPControl.actionStarted.IsZero() {
		st.ActionStartedAt = enhancedMCPControl.actionStarted.Format(time.RFC3339Nano)
	}
	return st
}

func setEnhancedMCPManualTakeover(enabled bool) EnhancedMCPControlStatus {
	enhancedMCPControl.Lock()
	loadEnhancedMCPControlSettingsLocked()
	enhancedMCPControl.manualTakeover = enabled
	enhancedMCPControl.lockUntil = time.Time{}
	if enabled {
		mcpControlAppendLogLocked("control", "Local user took manual control; MCP input paused", nil)
	} else {
		mcpControlAppendLogLocked("control", "MCP input resumed by local user", nil)
	}
	enhancedMCPControl.Unlock()
	return getEnhancedMCPControlStatus()
}

func clearEnhancedMCPControlLog() EnhancedMCPControlStatus {
	enhancedMCPControl.Lock()
	enhancedMCPControl.logs = nil
	enhancedMCPControl.Unlock()
	return getEnhancedMCPControlStatus()
}

func init() {
	rpcHandlers["getEnhancedMCPControlStatus"] = RPCHandler{Func: rpcGetEnhancedMCPControlStatus}
	rpcHandlers["setEnhancedMCPControlSettings"] = RPCHandler{Func: rpcSetEnhancedMCPControlSettings, Params: []string{"lock_local_input_during_action", "lock_release_delay_ms", "show_virtual_cursor", "cursor_hide_delay_ms", "show_action_hud", "show_live_log", "log_limit", "redact_typed_text"}}
	rpcHandlers["setEnhancedMCPManualTakeover"] = RPCHandler{Func: rpcSetEnhancedMCPManualTakeover, Params: []string{"enabled"}}
	rpcHandlers["clearEnhancedMCPControlLog"] = RPCHandler{Func: rpcClearEnhancedMCPControlLog}
}

func rpcGetEnhancedMCPControlStatus() (EnhancedMCPControlStatus, error) {
	return getEnhancedMCPControlStatus(), nil
}

func rpcSetEnhancedMCPControlSettings(lock bool, lockReleaseMs int, showCursor bool, cursorHideMs int, showHUD bool, showLog bool, logLimit int, redactText bool) (EnhancedMCPControlStatus, error) {
	s := EnhancedMCPControlSettings{LockLocalInputDuringAction: lock, LockReleaseDelayMs: lockReleaseMs, ShowVirtualCursor: showCursor, CursorHideDelayMs: cursorHideMs, ShowActionHUD: showHUD, ShowLiveLog: showLog, LogLimit: logLimit, RedactTypedText: redactText}
	if err := setEnhancedMCPControlSettings(s); err != nil {
		return EnhancedMCPControlStatus{}, err
	}
	return getEnhancedMCPControlStatus(), nil
}

func rpcSetEnhancedMCPManualTakeover(enabled bool) (EnhancedMCPControlStatus, error) {
	return setEnhancedMCPManualTakeover(enabled), nil
}

func rpcClearEnhancedMCPControlLog() (EnhancedMCPControlStatus, error) {
	return clearEnhancedMCPControlLog(), nil
}
