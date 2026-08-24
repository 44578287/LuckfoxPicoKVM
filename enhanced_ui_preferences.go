package kvm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const enhancedUIPreferencesPath = "/userdata/picokvm/enhanced_ui_preferences.json"

// EnhancedUIPreferences are intentionally device-scoped rather than browser-scoped.
// They let the normal Web UI keep the same language and theme after an IP change,
// when opened from another browser/computer, or after the local browser cache is cleared.
type EnhancedUIPreferences struct {
	Language   string `json:"language"`
	Theme      string `json:"theme"`
	Configured bool   `json:"configured"`
}

var enhancedUIPreferencesState = struct {
	sync.RWMutex
	loaded      bool
	preferences EnhancedUIPreferences
}{preferences: defaultEnhancedUIPreferences()}

func defaultEnhancedUIPreferences() EnhancedUIPreferences {
	return EnhancedUIPreferences{Language: "en", Theme: "light", Configured: false}
}

func validateEnhancedUIPreferences(p EnhancedUIPreferences) error {
	if p.Language != "en" && p.Language != "zh" {
		return fmt.Errorf("language must be en or zh")
	}
	if p.Theme != "light" && p.Theme != "dark" {
		return fmt.Errorf("theme must be light or dark")
	}
	return nil
}

func loadEnhancedUIPreferencesLocked() {
	if enhancedUIPreferencesState.loaded {
		return
	}
	enhancedUIPreferencesState.loaded = true
	enhancedUIPreferencesState.preferences = defaultEnhancedUIPreferences()

	data, err := os.ReadFile(enhancedUIPreferencesPath)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn().Err(err).Str("path", enhancedUIPreferencesPath).Msg("failed to read enhanced UI preferences; using defaults")
		}
		return
	}

	var p EnhancedUIPreferences
	if err := json.Unmarshal(data, &p); err != nil {
		logger.Warn().Err(err).Str("path", enhancedUIPreferencesPath).Msg("invalid enhanced UI preferences; using defaults")
		return
	}
	if err := validateEnhancedUIPreferences(p); err != nil {
		logger.Warn().Err(err).Str("path", enhancedUIPreferencesPath).Msg("invalid enhanced UI preferences values; using defaults")
		return
	}
	// Presence of a valid file means the device already owns these preferences,
	// including files written by an early build before Configured was introduced.
	p.Configured = true
	enhancedUIPreferencesState.preferences = p
}

func getEnhancedUIPreferences() EnhancedUIPreferences {
	enhancedUIPreferencesState.Lock()
	loadEnhancedUIPreferencesLocked()
	p := enhancedUIPreferencesState.preferences
	enhancedUIPreferencesState.Unlock()
	return p
}

func setEnhancedUIPreferences(p EnhancedUIPreferences) error {
	if err := validateEnhancedUIPreferences(p); err != nil {
		return err
	}
	p.Configured = true
	data, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal UI preferences: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(enhancedUIPreferencesPath), 0755); err != nil {
		return fmt.Errorf("create UI preferences directory: %w", err)
	}

	// Write/rename avoids leaving a truncated preferences file if power is lost
	// during a save.
	tmp := enhancedUIPreferencesPath + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0600); err != nil {
		return fmt.Errorf("write UI preferences: %w", err)
	}
	if err := os.Rename(tmp, enhancedUIPreferencesPath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("commit UI preferences: %w", err)
	}

	enhancedUIPreferencesState.Lock()
	enhancedUIPreferencesState.loaded = true
	enhancedUIPreferencesState.preferences = p
	enhancedUIPreferencesState.Unlock()
	return nil
}

func rpcGetEnhancedUIPreferences() (EnhancedUIPreferences, error) {
	return getEnhancedUIPreferences(), nil
}

func rpcSetEnhancedUIPreferences(preferences EnhancedUIPreferences) (EnhancedUIPreferences, error) {
	if err := setEnhancedUIPreferences(preferences); err != nil {
		return EnhancedUIPreferences{}, err
	}
	return getEnhancedUIPreferences(), nil
}

func init() {
	rpcHandlers["getEnhancedUIPreferences"] = RPCHandler{Func: rpcGetEnhancedUIPreferences}
	rpcHandlers["setEnhancedUIPreferences"] = RPCHandler{Func: rpcSetEnhancedUIPreferences, Params: []string{"preferences"}}
}
