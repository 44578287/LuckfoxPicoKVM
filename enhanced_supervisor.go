package kvm

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const enhancedSupervisorConfigPath = "/userdata/picokvm/enhanced_supervisor.json"

type EnhancedSupervisorSettings struct {
	Enabled                     bool `json:"enabled"`
	AutoRecoverVideo            bool `json:"auto_recover_video"`
	VideoStallSeconds           int  `json:"video_stall_seconds"`
	RecoveryCooldownSeconds     int  `json:"recovery_cooldown_seconds"`
	MaxVideoRecoveriesPerHour   int  `json:"max_video_recoveries_per_hour"`
}

type EnhancedSupervisorStatus struct {
	Running              bool      `json:"running"`
	Healthy              bool      `json:"healthy"`
	VideoExpected        bool      `json:"video_expected"`
	Subscribers          int       `json:"subscribers"`
	ControlSessions      int       `json:"control_sessions"`
	LastFrameAt          time.Time `json:"last_frame_at"`
	LastFrameAgeMs       int64     `json:"last_frame_age_ms"`
	TotalFrames          uint64    `json:"total_frames"`
	VideoRecoveries      uint64    `json:"video_recoveries"`
	RecoveriesLastHour   int       `json:"recoveries_last_hour"`
	LastRecoveryAt       time.Time `json:"last_recovery_at"`
	LastRecoveryReason   string    `json:"last_recovery_reason,omitempty"`
	LastError            string    `json:"last_error,omitempty"`
	NextRecoveryAllowedAt time.Time `json:"next_recovery_allowed_at"`
	CheckedAt            time.Time `json:"checked_at"`
}

var enhancedSupervisor = struct {
	sync.Mutex
	settingsLoaded bool
	settings       EnhancedSupervisorSettings
	started        bool
	activeSince    time.Time
	lastRecovery   time.Time
	lastReason     string
	lastError      string
	recoveryTimes  []time.Time
	recoveryCount  uint64
	status         EnhancedSupervisorStatus
}{settings: defaultEnhancedSupervisorSettings()}

func defaultEnhancedSupervisorSettings() EnhancedSupervisorSettings {
	return EnhancedSupervisorSettings{
		Enabled:                   true,
		AutoRecoverVideo:          true,
		VideoStallSeconds:         8,
		RecoveryCooldownSeconds:   30,
		MaxVideoRecoveriesPerHour: 6,
	}
}

func validateEnhancedSupervisorSettings(s EnhancedSupervisorSettings) error {
	if s.VideoStallSeconds < 3 || s.VideoStallSeconds > 120 {
		return fmt.Errorf("video_stall_seconds must be between 3 and 120")
	}
	if s.RecoveryCooldownSeconds < 10 || s.RecoveryCooldownSeconds > 600 {
		return fmt.Errorf("recovery_cooldown_seconds must be between 10 and 600")
	}
	if s.MaxVideoRecoveriesPerHour < 1 || s.MaxVideoRecoveriesPerHour > 30 {
		return fmt.Errorf("max_video_recoveries_per_hour must be between 1 and 30")
	}
	return nil
}

func loadEnhancedSupervisorSettingsLocked() {
	if enhancedSupervisor.settingsLoaded {
		return
	}
	enhancedSupervisor.settingsLoaded = true
	enhancedSupervisor.settings = defaultEnhancedSupervisorSettings()
	data, err := os.ReadFile(enhancedSupervisorConfigPath)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn().Err(err).Msg("failed to read enhanced supervisor config; using defaults")
		}
		return
	}
	var s EnhancedSupervisorSettings
	if err := json.Unmarshal(data, &s); err != nil || validateEnhancedSupervisorSettings(s) != nil {
		logger.Warn().Msg("invalid enhanced supervisor config; using defaults")
		return
	}
	enhancedSupervisor.settings = s
}

func getEnhancedSupervisorSettings() EnhancedSupervisorSettings {
	enhancedSupervisor.Lock()
	defer enhancedSupervisor.Unlock()
	loadEnhancedSupervisorSettingsLocked()
	return enhancedSupervisor.settings
}

func setEnhancedSupervisorSettings(s EnhancedSupervisorSettings) error {
	if err := validateEnhancedSupervisorSettings(s); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(enhancedSupervisorConfigPath), 0755); err != nil {
		return err
	}
	tmp := enhancedSupervisorConfigPath + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, enhancedSupervisorConfigPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	enhancedSupervisor.Lock()
	enhancedSupervisor.settingsLoaded = true
	enhancedSupervisor.settings = s
	enhancedSupervisor.Unlock()
	return nil
}

func startEnhancedSupervisor() {
	enhancedSupervisor.Lock()
	if enhancedSupervisor.started {
		enhancedSupervisor.Unlock()
		return
	}
	enhancedSupervisor.started = true
	loadEnhancedSupervisorSettingsLocked()
	enhancedSupervisor.Unlock()

	logger.Info().Msg("Enhanced supervisor started")
	go func() {
		// Let native kvm_video/network/USB initialization settle before evaluating
		// recovery conditions.
		time.Sleep(10 * time.Second)
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			runEnhancedSupervisorCheck(time.Now())
		}
	}()
}

func trimRecoveryTimesLocked(now time.Time) {
	cutoff := now.Add(-time.Hour)
	kept := enhancedSupervisor.recoveryTimes[:0]
	for _, t := range enhancedSupervisor.recoveryTimes {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	enhancedSupervisor.recoveryTimes = kept
}

func runEnhancedSupervisorCheck(now time.Time) {
	subscribers := videoBroadcaster.SubscriberCount()
	controls := actionSessions
	videoExpected := lastVideoState.Ready && (subscribers > 0 || controls > 0)
	lastFrame := videoBroadcaster.LastFrameAt()

	enhancedSupervisor.Lock()
	loadEnhancedSupervisorSettingsLocked()
	s := enhancedSupervisor.settings
	trimRecoveryTimesLocked(now)

	if videoExpected {
		if enhancedSupervisor.activeSince.IsZero() {
			enhancedSupervisor.activeSince = now
		}
	} else {
		enhancedSupervisor.activeSince = time.Time{}
	}

	effectiveFrameAt := lastFrame
	if effectiveFrameAt.Before(enhancedSupervisor.activeSince) {
		effectiveFrameAt = enhancedSupervisor.activeSince
	}
	age := int64(0)
	if videoExpected && !effectiveFrameAt.IsZero() {
		age = now.Sub(effectiveFrameAt).Milliseconds()
	}
	stalled := videoExpected && age >= int64(s.VideoStallSeconds)*1000
	cooldownUntil := enhancedSupervisor.lastRecovery.Add(time.Duration(s.RecoveryCooldownSeconds) * time.Second)
	canRecover := s.Enabled && s.AutoRecoverVideo && stalled &&
		(enhancedSupervisor.lastRecovery.IsZero() || !now.Before(cooldownUntil)) &&
		len(enhancedSupervisor.recoveryTimes) < s.MaxVideoRecoveriesPerHour

	status := EnhancedSupervisorStatus{
		Running:               enhancedSupervisor.started && s.Enabled,
		Healthy:               !stalled,
		VideoExpected:         videoExpected,
		Subscribers:           subscribers,
		ControlSessions:       controls,
		LastFrameAt:           lastFrame,
		LastFrameAgeMs:        age,
		TotalFrames:           videoBroadcaster.TotalFrames(),
		VideoRecoveries:       enhancedSupervisor.recoveryCount,
		RecoveriesLastHour:    len(enhancedSupervisor.recoveryTimes),
		LastRecoveryAt:        enhancedSupervisor.lastRecovery,
		LastRecoveryReason:    enhancedSupervisor.lastReason,
		LastError:             enhancedSupervisor.lastError,
		NextRecoveryAllowedAt: cooldownUntil,
		CheckedAt:             now,
	}
	enhancedSupervisor.status = status
	if !canRecover {
		enhancedSupervisor.Unlock()
		return
	}

	// Reserve recovery before dropping the lock so another check cannot launch a
	// second stop/start sequence concurrently.
	enhancedSupervisor.lastRecovery = now
	enhancedSupervisor.lastReason = fmt.Sprintf("encoded video stalled for %d ms with %d consumer(s)", age, subscribers+controls)
	enhancedSupervisor.recoveryTimes = append(enhancedSupervisor.recoveryTimes, now)
	enhancedSupervisor.recoveryCount++
	enhancedSupervisor.activeSince = now
	reason := enhancedSupervisor.lastReason
	enhancedSupervisor.Unlock()

	logger.Warn().Str("reason", reason).Msg("Enhanced supervisor restarting native video pipeline")
	if err := recoverEnhancedVideoPipeline(); err != nil {
		enhancedSupervisor.Lock()
		enhancedSupervisor.lastError = err.Error()
		enhancedSupervisor.Unlock()
		logger.Error().Err(err).Msg("Enhanced supervisor video recovery failed")
		return
	}
	enhancedSupervisor.Lock()
	enhancedSupervisor.lastError = ""
	enhancedSupervisor.Unlock()
}

func recoverEnhancedVideoPipeline() error {
	if err := writeCtrlAction("stop_video"); err != nil {
		return fmt.Errorf("stop video: %w", err)
	}
	time.Sleep(250 * time.Millisecond)
	if err := writeCtrlAction("start_video"); err != nil {
		return fmt.Errorf("start video: %w", err)
	}
	return nil
}

func forceEnhancedVideoRecovery() error {
	return recoverEnhancedVideoPipeline()
}

func getEnhancedSupervisorStatus() EnhancedSupervisorStatus {
	enhancedSupervisor.Lock()
	defer enhancedSupervisor.Unlock()
	status := enhancedSupervisor.status
	status.VideoRecoveries = enhancedSupervisor.recoveryCount
	status.LastRecoveryAt = enhancedSupervisor.lastRecovery
	status.LastRecoveryReason = enhancedSupervisor.lastReason
	status.LastError = enhancedSupervisor.lastError
	status.TotalFrames = videoBroadcaster.TotalFrames()
	status.LastFrameAt = videoBroadcaster.LastFrameAt()
	status.Subscribers = videoBroadcaster.SubscriberCount()
	status.ControlSessions = actionSessions
	return status
}

func rpcGetEnhancedSupervisorSettings() (EnhancedSupervisorSettings, error) {
	return getEnhancedSupervisorSettings(), nil
}

func rpcSetEnhancedSupervisorSettings(settings EnhancedSupervisorSettings) (EnhancedSupervisorSettings, error) {
	if err := setEnhancedSupervisorSettings(settings); err != nil {
		return EnhancedSupervisorSettings{}, err
	}
	return getEnhancedSupervisorSettings(), nil
}

func rpcGetEnhancedSupervisorStatus() (EnhancedSupervisorStatus, error) {
	return getEnhancedSupervisorStatus(), nil
}

func rpcForceEnhancedVideoRecovery() error {
	return forceEnhancedVideoRecovery()
}

func init() {
	rpcHandlers["getEnhancedSupervisorSettings"] = RPCHandler{Func: rpcGetEnhancedSupervisorSettings}
	rpcHandlers["setEnhancedSupervisorSettings"] = RPCHandler{Func: rpcSetEnhancedSupervisorSettings, Params: []string{"settings"}}
	rpcHandlers["getEnhancedSupervisorStatus"] = RPCHandler{Func: rpcGetEnhancedSupervisorStatus}
	rpcHandlers["forceEnhancedVideoRecovery"] = RPCHandler{Func: rpcForceEnhancedVideoRecovery}
}
