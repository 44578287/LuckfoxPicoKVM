package kvm

import (
	"fmt"
	"sync"
	"time"
)

type USBReinitializeStatus struct {
	ID             string `json:"id,omitempty"`
	Mode           string `json:"mode,omitempty"`
	Reason         string `json:"reason,omitempty"`
	State          string `json:"state"`
	StartedAt      string `json:"started_at,omitempty"`
	FinishedAt     string `json:"finished_at,omitempty"`
	USBStateBefore string `json:"usb_state_before,omitempty"`
	USBStateAfter  string `json:"usb_state_after,omitempty"`
	MediaRestored  bool   `json:"media_restored"`
	Error          string `json:"error,omitempty"`
}

var enhancedUSBRecovery = struct {
	sync.Mutex
	status USBReinitializeStatus
}{status: USBReinitializeStatus{State: "idle"}}

func getUSBReinitializeStatus() USBReinitializeStatus {
	enhancedUSBRecovery.Lock()
	defer enhancedUSBRecovery.Unlock()
	return enhancedUSBRecovery.status
}

func startUSBReinitializeAsync(mode, reason string) USBReinitializeStatus {
	mode = normalizeUSBRecoveryMode(mode)
	enhancedUSBRecovery.Lock()
	if enhancedUSBRecovery.status.State == "running" {
		st := enhancedUSBRecovery.status
		enhancedUSBRecovery.Unlock()
		return st
	}
	now := time.Now()
	st := USBReinitializeStatus{
		ID: fmt.Sprintf("usb-%d", now.UnixNano()), Mode: mode, Reason: reason,
		State: "running", StartedAt: now.Format(time.RFC3339Nano), USBStateBefore: rpcGetUSBState(),
	}
	enhancedUSBRecovery.status = st
	enhancedUSBRecovery.Unlock()
	go runUSBReinitializeTask(st)
	return st
}

func normalizeUSBRecoveryMode(mode string) string {
	if mode == "soft" { return "soft" }
	return "hard"
}

func cloneVirtualMediaState() *VirtualMediaState {
	state, _ := rpcGetVirtualMediaState()
	if state == nil { return nil }
	copy := *state
	return &copy
}

func restoreVirtualMediaSnapshot(state *VirtualMediaState) error {
	if state == nil { return nil }
	current, _ := rpcGetVirtualMediaState()
	if current != nil { return nil }
	switch state.Source {
	case Storage:
		return rpcMountWithStorage(state.Filename, state.Mode)
	case SDStorage:
		return rpcMountWithSDStorage(state.Filename, state.Mode)
	case HTTP:
		return rpcMountWithHTTP(state.URL, state.Mode)
	default:
		return fmt.Errorf("cannot restore virtual media source %s", state.Source)
	}
}

func runUSBReinitializeTask(initial USBReinitializeStatus) {
	media := cloneVirtualMediaState()
	var err error
	if initial.Mode == "soft" { err = rpcReinitializeUsbGadgetSoft() } else { err = rpcReinitializeUsbGadget() }

	// A gadget rebind can return before the host-facing state sampler catches up.
	// Bound the wait so MCP never has to hold a request open for it.
	deadline := time.Now().Add(8 * time.Second)
	for err == nil && time.Now().Before(deadline) {
		state := rpcGetUSBState()
		if state == "configured" || state == "not attached" || state == "suspended" { break }
		time.Sleep(200 * time.Millisecond)
	}

	mediaRestored := false
	if err == nil && media != nil {
		if restoreErr := restoreVirtualMediaSnapshot(media); restoreErr != nil {
			err = fmt.Errorf("USB recovery succeeded but virtual-media restore failed: %w", restoreErr)
		} else {
			mediaRestored = true
		}
	}

	enhancedUSBRecovery.Lock()
	st := enhancedUSBRecovery.status
	if st.ID == initial.ID {
		st.USBStateAfter = rpcGetUSBState()
		st.MediaRestored = mediaRestored
		st.FinishedAt = time.Now().Format(time.RFC3339Nano)
		if err != nil { st.State = "failed"; st.Error = err.Error() } else { st.State = "succeeded" }
		enhancedUSBRecovery.status = st
	}
	enhancedUSBRecovery.Unlock()
}
