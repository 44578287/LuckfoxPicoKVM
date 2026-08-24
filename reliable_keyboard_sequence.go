package kvm

import (
	"fmt"
	"time"
)

type ReliableHIDStroke struct {
	Key      uint8 `json:"key"`
	Modifier uint8 `json:"modifier"`
}

type ReliableKeyboardSequenceParams struct {
	Strokes      []ReliableHIDStroke `json:"strokes"`
	Profile      string              `json:"profile,omitempty"`
	KeyDownMs    int                 `json:"key_down_ms,omitempty"`
	InterKeyMs   int                 `json:"inter_key_ms,omitempty"`
	ChunkSize    int                 `json:"chunk_size,omitempty"`
	ChunkPauseMs int                 `json:"chunk_pause_ms,omitempty"`
}

func init() {
	// Register without editing the large upstream-derived rpcHandlers table.
	rpcHandlers["reliableKeyboardSequence"] = RPCHandler{
		Func:   rpcReliableKeyboardSequence,
		Params: []string{"params"},
	}
}

func reliableOptionsFromSequenceParams(params ReliableKeyboardSequenceParams) (reliableTextOptions, error) {
	args := map[string]interface{}{}
	if params.Profile != "" {
		args["profile"] = params.Profile
	}
	if params.KeyDownMs != 0 {
		args["key_down_ms"] = float64(params.KeyDownMs)
	}
	if params.InterKeyMs != 0 {
		args["inter_key_ms"] = float64(params.InterKeyMs)
	}
	if params.ChunkSize != 0 {
		args["chunk_size"] = float64(params.ChunkSize)
	}
	if params.ChunkPauseMs != 0 {
		args["chunk_pause_ms"] = float64(params.ChunkPauseMs)
	}
	return reliableTextOptionsFromArgs(args)
}

func rpcReliableKeyboardSequence(params ReliableKeyboardSequenceParams) (map[string]interface{}, error) {
	if len(params.Strokes) == 0 {
		return map[string]interface{}{"sent": 0, "elapsed_ms": 0}, nil
	}
	if len(params.Strokes) > 65536 {
		return nil, fmt.Errorf("reliable keyboard sequence exceeds 65536 strokes")
	}
	if gadget == nil {
		return nil, fmt.Errorf("USB gadget is not initialized")
	}
	if state := rpcGetUSBState(); state != "configured" {
		return nil, fmt.Errorf("USB gadget is not configured (state=%s)", state)
	}

	opts, err := reliableOptionsFromSequenceParams(params)
	if err != nil {
		return nil, err
	}

	reliableTextInjectionMu.Lock()
	defer reliableTextInjectionMu.Unlock()

	started := time.Now()
	if err := rpcKeyboardReport(0, []uint8{}); err != nil {
		return nil, err
	}
	defer func() { _ = rpcKeyboardReport(0, []uint8{}) }()
	time.Sleep(10 * time.Millisecond)

	for i, stroke := range params.Strokes {
		if stroke.Key == 0 {
			return nil, fmt.Errorf("invalid HID key code 0 at stroke %d", i)
		}
		if err := rpcKeyboardReport(stroke.Modifier, []uint8{stroke.Key}); err != nil {
			return nil, fmt.Errorf("key down failed at stroke %d: %w", i, err)
		}
		time.Sleep(time.Duration(opts.KeyDownMs) * time.Millisecond)
		if err := rpcKeyboardReport(0, []uint8{}); err != nil {
			return nil, fmt.Errorf("key release failed at stroke %d: %w", i, err)
		}
		time.Sleep(time.Duration(opts.InterKeyMs) * time.Millisecond)

		if opts.ChunkPauseMs > 0 && (i+1)%opts.ChunkSize == 0 && i+1 < len(params.Strokes) {
			time.Sleep(time.Duration(opts.ChunkPauseMs) * time.Millisecond)
		}
	}

	elapsed := time.Since(started)
	return map[string]interface{}{
		"sent":           len(params.Strokes),
		"elapsed_ms":     elapsed.Milliseconds(),
		"key_down_ms":    opts.KeyDownMs,
		"inter_key_ms":   opts.InterKeyMs,
		"chunk_size":     opts.ChunkSize,
		"chunk_pause_ms": opts.ChunkPauseMs,
	}, nil
}
