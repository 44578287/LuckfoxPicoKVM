package kvm

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/psanford/httpreadat"
)

type MCPVirtualMediaInventory struct {
	Mounted     *VirtualMediaState       `json:"mounted,omitempty"`
	Internal    *StorageFiles            `json:"internal"`
	SDStatus    *SDMountStatusResponse   `json:"sd_status,omitempty"`
	SD          *StorageFiles            `json:"sd,omitempty"`
	InternalErr string                   `json:"internal_error,omitempty"`
	SDErr       string                   `json:"sd_error,omitempty"`
}

var mcpVirtualMediaTxnMu sync.Mutex

func handleGetUSBState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if gadget == nil { return nil, fmt.Errorf("USB gadget is not initialized on this System version") }
	return mcp.NewToolResultText(rpcGetUSBState()), nil
}

func handleUSBWakeup(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if gadget == nil { return nil, fmt.Errorf("USB gadget is not initialized on this System version") }
	if err := rpcSendUsbWakeupSignal(); err != nil { return nil, err }
	return mcp.NewToolResultText("USB remote-wakeup signal sent"), nil
}

func handleGetVirtualMediaState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	state, err := rpcGetVirtualMediaState(); if err != nil { return nil, err }
	if state == nil { return mcp.NewToolResultText("null"), nil }
	data, err := json.MarshalIndent(state, "", "  "); if err != nil { return nil, err }
	return mcp.NewToolResultText(string(data)), nil
}

func handleListVirtualMedia(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	inventory := MCPVirtualMediaInventory{}
	inventory.Mounted, _ = rpcGetVirtualMediaState()
	if err := initImagesFolder(); err != nil {
		inventory.Internal = &StorageFiles{Files: []StorageFile{}}; inventory.InternalErr = err.Error()
	} else if files, err := rpcListStorageFiles(); err != nil {
		inventory.Internal = &StorageFiles{Files: []StorageFile{}}; inventory.InternalErr = err.Error()
	} else { inventory.Internal = files }
	sdStatus, sdErr := rpcGetSDMountStatus(); inventory.SDStatus = sdStatus
	if sdErr != nil { inventory.SDErr = sdErr.Error() } else if sdStatus != nil && sdStatus.Status == SDMountOK {
		if files, err := rpcListSDStorageFiles(); err != nil { inventory.SDErr = err.Error() } else { inventory.SD = files }
	}
	data, err := json.MarshalIndent(inventory, "", "  "); if err != nil { return nil, err }
	return mcp.NewToolResultText(string(data)), nil
}

func parseVirtualMediaMode(value string, filename string) (VirtualMediaMode, error) {
	mode := strings.ToLower(strings.TrimSpace(value))
	if mode == "" || mode == "auto" {
		if strings.HasSuffix(strings.ToLower(filename), ".iso") { return CDROM, nil }
		return Disk, nil
	}
	switch mode {
	case "cdrom", "cd", "iso": return CDROM, nil
	case "disk", "drive": return Disk, nil
	default: return "", fmt.Errorf("invalid mode %q; use auto, cdrom or disk", value)
	}
}

func snapshotMCPVirtualMedia() *VirtualMediaState {
	state, _ := rpcGetVirtualMediaState()
	if state == nil { return nil }
	copy := *state
	return &copy
}

func preflightMCPVirtualMediaFile(filename string, source VirtualMediaSource) (string, error) {
	clean, err := sanitizeFilename(filename); if err != nil { return "", err }
	base := imagesFolder; if source == SDStorage { base = SDImagesFolder }
	info, err := os.Stat(filepath.Join(base, clean)); if err != nil { return "", fmt.Errorf("virtual-media preflight failed: %w", err) }
	if !info.Mode().IsRegular() || info.Size() <= 0 { return "", fmt.Errorf("virtual-media preflight failed: target is not a non-empty regular file") }
	return clean, nil
}

func preflightMCPRemoteImage(url string) (*httpreadat.RangeReader, int64, error) {
	url = strings.TrimSpace(url)
	lower := strings.ToLower(url)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") { return nil, 0, fmt.Errorf("url must use http or https") }
	rr := httpreadat.New(url)
	size, err := rr.Size(); if err != nil { return nil, 0, fmt.Errorf("remote image validation failed before changing current media: %w", err) }
	if size <= 0 { return nil, 0, fmt.Errorf("remote image validation returned invalid size %d", size) }
	return rr, size, nil
}

func mountMCPHTTPValidated(url string, mode VirtualMediaMode, rr *httpreadat.RangeReader, size int64) error {
	if err := setMassStorageMode(mode == CDROM); err != nil { return fmt.Errorf("set mass-storage mode: %w", err) }
	virtualMediaStateMutex.Lock()
	if currentVirtualMediaState != nil { virtualMediaStateMutex.Unlock(); return fmt.Errorf("another virtual media is already mounted") }
	httpRangeReader = rr
	virtualMediaStateMutex.Unlock()

	dev := NewNBDDevice()
	if err := dev.Start(); err != nil { return fmt.Errorf("start remote-image NBD: %w", err) }
	time.Sleep(time.Second)
	if err := setMassStorageImage("/dev/nbd0"); err != nil { dev.Close(); return fmt.Errorf("attach remote-image NBD: %w", err) }

	virtualMediaStateMutex.Lock()
	nbdDevice = dev
	currentVirtualMediaState = &VirtualMediaState{Source: HTTP, Mode: mode, URL: url, Size: size}
	virtualMediaStateMutex.Unlock()
	return nil
}

func restoreMCPVirtualMedia(previous *VirtualMediaState) error {
	if previous == nil { return nil }
	switch previous.Source {
	case Storage: return rpcMountWithStorage(previous.Filename, previous.Mode)
	case SDStorage: return rpcMountWithSDStorage(previous.Filename, previous.Mode)
	case HTTP:
		rr, size, err := preflightMCPRemoteImage(previous.URL); if err != nil { return err }
		return mountMCPHTTPValidated(previous.URL, previous.Mode, rr, size)
	default: return fmt.Errorf("rollback of source %s is not supported", previous.Source)
	}
}

func rollbackMCPVirtualMedia(previous *VirtualMediaState, mountErr error) error {
	current, _ := rpcGetVirtualMediaState()
	if current != nil { _ = rpcUnmountImage() }
	if previous == nil { return mountErr }
	if err := restoreMCPVirtualMedia(previous); err != nil { return fmt.Errorf("new mount failed: %v; rollback failed: %v", mountErr, err) }
	return fmt.Errorf("new mount failed: %v; previous virtual media was restored", mountErr)
}

func handleMountVirtualMedia(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments(); filename, _ := args["filename"].(string)
	if strings.TrimSpace(filename) == "" { return nil, fmt.Errorf("filename is required") }
	sourceValue, _ := args["source"].(string); if sourceValue == "" { sourceValue = "storage" }
	var source VirtualMediaSource
	switch strings.ToLower(strings.TrimSpace(sourceValue)) {
	case "storage", "internal", "kvm": source = Storage
	case "sd", "sdstorage", "sd-card": source = SDStorage
	default: return nil, fmt.Errorf("invalid source %q; use storage or sd", sourceValue)
	}
	clean, err := preflightMCPVirtualMediaFile(filename, source); if err != nil { return nil, err }
	modeValue, _ := args["mode"].(string); mode, err := parseVirtualMediaMode(modeValue, clean); if err != nil { return nil, err }

	mcpVirtualMediaTxnMu.Lock(); defer mcpVirtualMediaTxnMu.Unlock()
	previous := snapshotMCPVirtualMedia()
	var mountErr error
	if source == SDStorage { mountErr = rpcMountWithSDStorage(clean, mode) } else { mountErr = rpcMountWithStorage(clean, mode) }
	if mountErr != nil { return nil, rollbackMCPVirtualMedia(previous, mountErr) }
	return handleGetVirtualMediaState(ctx, req)
}

func handleMountVirtualMediaURL(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments(); url, _ := args["url"].(string)
	if strings.TrimSpace(url) == "" { return nil, fmt.Errorf("url is required") }
	modeValue, _ := args["mode"].(string); mode, err := parseVirtualMediaMode(modeValue, url); if err != nil { return nil, err }
	// Validate Range/Content-Range behavior BEFORE touching the currently mounted image.
	rr, size, err := preflightMCPRemoteImage(url); if err != nil { return nil, err }

	mcpVirtualMediaTxnMu.Lock(); defer mcpVirtualMediaTxnMu.Unlock()
	previous := snapshotMCPVirtualMedia()
	if previous != nil { if err := rpcUnmountImage(); err != nil { return nil, fmt.Errorf("validated new image, but current image could not be unmounted: %w", err) } }
	if err := mountMCPHTTPValidated(url, mode, rr, size); err != nil { return nil, rollbackMCPVirtualMedia(previous, err) }
	return handleGetVirtualMediaState(ctx, req)
}

func handleUnmountVirtualMedia(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	mcpVirtualMediaTxnMu.Lock(); defer mcpVirtualMediaTxnMu.Unlock()
	if err := rpcUnmountImage(); err != nil { return nil, err }
	return mcp.NewToolResultText("Virtual media unmounted"), nil
}
