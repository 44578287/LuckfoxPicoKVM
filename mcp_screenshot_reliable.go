package kvm

import (
	"fmt"
	"os"
	"sync"
	"time"
)

var mcpScreenshotMu sync.Mutex

func captureMCPScreenshotReliable() ([]byte, error) {
	mcpScreenshotMu.Lock()
	defer mcpScreenshotMu.Unlock()

	// Remove only while holding the dedicated screenshot lock. The old path
	// removed the shared JPEG before acquiring its lock, allowing a second
	// capture to delete the first capture's output.
	_ = os.Remove(JPEG_FILE)
	for {
		select { case <-jpegReadyCh: continue; default: goto drained }
	}

drained:

	lock.Lock()
	err := CallCtrlAction(CaputeJpeg)
	lock.Unlock()
	if err != nil { return nil, fmt.Errorf("request JPEG capture: %w", err) }

	select {
	case <-jpegReadyCh:
	case <-time.After(1500 * time.Millisecond):
		return nil, fmt.Errorf("JPEG capture timed out after 1.5s")
	}

	// Native code can signal immediately before the filesystem metadata/data is
	// visible. Poll briefly for a non-empty file instead of returning a racy
	// 'JPEG file not found'.
	deadline := time.Now().Add(500 * time.Millisecond)
	var lastErr error
	for time.Now().Before(deadline) {
		info, statErr := os.Stat(JPEG_FILE)
		if statErr == nil && info.Size() > 0 {
			data, readErr := os.ReadFile(JPEG_FILE)
			if readErr == nil && len(data) > 0 {
				_ = os.Remove(JPEG_FILE)
				return data, nil
			}
			lastErr = readErr
		} else if statErr != nil {
			lastErr = statErr
		}
		time.Sleep(15 * time.Millisecond)
	}
	_ = os.Remove(JPEG_FILE)
	if lastErr != nil { return nil, fmt.Errorf("JPEG capture signaled ready but file was unavailable: %w", lastErr) }
	return nil, fmt.Errorf("JPEG capture signaled ready but produced an empty file")
}
