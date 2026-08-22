package kvm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const enhancedHostControlConfigPath = "/userdata/picokvm/enhanced_host_control.json"

// EnhancedHostControlSettings controls the physical ATX button pulse widths.
// The vendor implementation used a fixed 2 second pulse for both power and
// reset, which is too long for many motherboards and can blur the distinction
// between a normal short press and a forced power-off hold.
type EnhancedHostControlSettings struct {
	PowerShortMs int `json:"power_short_ms"`
	PowerLongMs  int `json:"power_long_ms"`
	ResetMs      int `json:"reset_ms"`
}

var enhancedHostControlState = struct {
	sync.RWMutex
	loaded   bool
	settings EnhancedHostControlSettings
}{settings: defaultEnhancedHostControlSettings()}

func defaultEnhancedHostControlSettings() EnhancedHostControlSettings {
	return EnhancedHostControlSettings{
		PowerShortMs: 500,
		PowerLongMs:  6000,
		ResetMs:      500,
	}
}

func validateEnhancedHostControlSettings(settings EnhancedHostControlSettings) error {
	if settings.PowerShortMs < 100 || settings.PowerShortMs > 2500 {
		return fmt.Errorf("power_short_ms must be between 100 and 2500")
	}
	if settings.PowerLongMs < 3000 || settings.PowerLongMs > 15000 {
		return fmt.Errorf("power_long_ms must be between 3000 and 15000")
	}
	if settings.ResetMs < 100 || settings.ResetMs > 2500 {
		return fmt.Errorf("reset_ms must be between 100 and 2500")
	}
	return nil
}

func loadEnhancedHostControlSettingsLocked() {
	if enhancedHostControlState.loaded {
		return
	}
	enhancedHostControlState.loaded = true
	enhancedHostControlState.settings = defaultEnhancedHostControlSettings()

	data, err := os.ReadFile(enhancedHostControlConfigPath)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn().Err(err).Str("path", enhancedHostControlConfigPath).Msg("failed to read enhanced host control config; using defaults")
		}
		return
	}

	var settings EnhancedHostControlSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		logger.Warn().Err(err).Str("path", enhancedHostControlConfigPath).Msg("invalid enhanced host control config; using defaults")
		return
	}
	if err := validateEnhancedHostControlSettings(settings); err != nil {
		logger.Warn().Err(err).Str("path", enhancedHostControlConfigPath).Msg("invalid enhanced host control timings; using defaults")
		return
	}
	enhancedHostControlState.settings = settings
}

func getEnhancedHostControlSettings() EnhancedHostControlSettings {
	enhancedHostControlState.Lock()
	loadEnhancedHostControlSettingsLocked()
	settings := enhancedHostControlState.settings
	enhancedHostControlState.Unlock()
	return settings
}

func setEnhancedHostControlSettings(settings EnhancedHostControlSettings) error {
	if err := validateEnhancedHostControlSettings(settings); err != nil {
		return err
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal host control settings: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(enhancedHostControlConfigPath), 0755); err != nil {
		return fmt.Errorf("create host control config directory: %w", err)
	}
	if err := os.WriteFile(enhancedHostControlConfigPath, append(data, '\n'), 0600); err != nil {
		return fmt.Errorf("save host control settings: %w", err)
	}

	enhancedHostControlState.Lock()
	enhancedHostControlState.loaded = true
	enhancedHostControlState.settings = settings
	enhancedHostControlState.Unlock()
	return nil
}

// hostControlPulseDuration only rewrites the legacy vendor 2 second pulses on
// the Ext-board power/reset GPIOs. Explicit/custom pulses use pulseGPIOExact.
func hostControlPulseDuration(pin int, requested time.Duration) time.Duration {
	if requested != 2*time.Second {
		return requested
	}
	settings := getEnhancedHostControlSettings()
	switch pin {
	case 58:
		return time.Duration(settings.PowerShortMs) * time.Millisecond
	case 59:
		return time.Duration(settings.ResetMs) * time.Millisecond
	default:
		return requested
	}
}

func triggerPowerLong() error {
	settings := getEnhancedHostControlSettings()
	go func() {
		if err := pulseGPIOExact(58, time.Duration(settings.PowerLongMs)*time.Millisecond); err != nil {
			logger.Error().Err(err).Msg("failed to trigger long power-button pulse")
		}
	}()
	return nil
}

func triggerPowerFor(durationMs int) error {
	if durationMs < 100 || durationMs > 15000 {
		return fmt.Errorf("duration_ms must be between 100 and 15000")
	}
	go func() {
		if err := pulseGPIOExact(58, time.Duration(durationMs)*time.Millisecond); err != nil {
			logger.Error().Err(err).Int("duration_ms", durationMs).Msg("failed to trigger custom power-button pulse")
		}
	}()
	return nil
}

func triggerResetFor(durationMs int) error {
	if durationMs < 100 || durationMs > 2500 {
		return fmt.Errorf("duration_ms must be between 100 and 2500")
	}
	go func() {
		if err := pulseGPIOExact(59, time.Duration(durationMs)*time.Millisecond); err != nil {
			logger.Error().Err(err).Int("duration_ms", durationMs).Msg("failed to trigger custom reset-button pulse")
		}
	}()
	return nil
}

func rpcGetEnhancedHostControlSettings() (EnhancedHostControlSettings, error) {
	return getEnhancedHostControlSettings(), nil
}

func rpcSetEnhancedHostControlSettings(settings EnhancedHostControlSettings) error {
	return setEnhancedHostControlSettings(settings)
}

func rpcTriggerPowerLong() error {
	return triggerPowerLong()
}

func rpcTriggerPowerFor(durationMs int) error {
	return triggerPowerFor(durationMs)
}

func rpcTriggerResetFor(durationMs int) error {
	return triggerResetFor(durationMs)
}

func init() {
	rpcHandlers["getEnhancedHostControlSettings"] = RPCHandler{Func: rpcGetEnhancedHostControlSettings}
	rpcHandlers["setEnhancedHostControlSettings"] = RPCHandler{Func: rpcSetEnhancedHostControlSettings, Params: []string{"settings"}}
	rpcHandlers["triggerPowerLong"] = RPCHandler{Func: rpcTriggerPowerLong}
	rpcHandlers["triggerPowerFor"] = RPCHandler{Func: rpcTriggerPowerFor, Params: []string{"durationMs"}}
	rpcHandlers["triggerResetFor"] = RPCHandler{Func: rpcTriggerResetFor, Params: []string{"durationMs"}}
}
