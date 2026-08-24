package kvm

import "sync"

// The stock capture pipeline uses shared native state and a shared JPEG output
// file. Serializing MCP captures prevents a second request from racing the
// first request's ready/file lifecycle while keeping the proven stock capture
// implementation as the single source of truth.
var mcpScreenshotMu sync.Mutex

func captureMCPScreenshotReliable() ([]byte, error) {
	mcpScreenshotMu.Lock()
	defer mcpScreenshotMu.Unlock()
	return captureScreenshot("jpeg")
}
