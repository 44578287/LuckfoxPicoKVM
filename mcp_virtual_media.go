package kvm

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

type MCPVirtualMediaInventory struct {
	Mounted     *VirtualMediaState       `json:"mounted,omitempty"`
	Internal    *StorageFiles            `json:"internal"`
	SDStatus    *SDMountStatusResponse   `json:"sd_status,omitempty"`
	SD          *StorageFiles            `json:"sd,omitempty"`
	InternalErr string                   `json:"internal_error,omitempty"`
	SDErr       string                   `json:"sd_error,omitempty"`
}

func handleGetUSBState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if gadget == nil {
		return nil, fmt.Errorf("USB gadget is not initialized on this System version")
	}
	return mcp.NewToolResultText(rpcGetUSBState()), nil
}

func handleUSBWakeup(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if gadget == nil {
		return nil, fmt.Errorf("USB gadget is not initialized on this System version")
	}
	if err := rpcSendUsbWakeupSignal(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("USB remote-wakeup signal sent"), nil
}

func handleGetVirtualMediaState(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	state, err := rpcGetVirtualMediaState()
	if err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return nil, err
	}
	if state == nil {
		return mcp.NewToolResultText("null"), nil
	}
	return mcp.NewToolResultText(string(data)), nil
}

func handleListVirtualMedia(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	inventory := MCPVirtualMediaInventory{}
	inventory.Mounted, _ = rpcGetVirtualMediaState()

	if err := initImagesFolder(); err != nil {
		inventory.Internal = &StorageFiles{Files: []StorageFile{}}
		inventory.InternalErr = err.Error()
	} else if files, err := rpcListStorageFiles(); err != nil {
		inventory.Internal = &StorageFiles{Files: []StorageFile{}}
		inventory.InternalErr = err.Error()
	} else {
		inventory.Internal = files
	}

	sdStatus, sdErr := rpcGetSDMountStatus()
	inventory.SDStatus = sdStatus
	if sdErr != nil {
		inventory.SDErr = sdErr.Error()
	} else if sdStatus != nil && sdStatus.Status == SDMountOK {
		if files, err := rpcListSDStorageFiles(); err != nil {
			inventory.SDErr = err.Error()
		} else {
			inventory.SD = files
		}
	}

	data, err := json.MarshalIndent(inventory, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func parseVirtualMediaMode(value string, filename string) (VirtualMediaMode, error) {
	mode := strings.ToLower(strings.TrimSpace(value))
	if mode == "" || mode == "auto" {
		if strings.HasSuffix(strings.ToLower(filename), ".iso") {
			return CDROM, nil
		}
		return Disk, nil
	}
	switch mode {
	case "cdrom", "cd", "iso":
		return CDROM, nil
	case "disk", "drive":
		return Disk, nil
	default:
		return "", fmt.Errorf("invalid mode %q; use auto, cdrom or disk", value)
	}
}

func handleMountVirtualMedia(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	filename, _ := args["filename"].(string)
	if strings.TrimSpace(filename) == "" {
		return nil, fmt.Errorf("filename is required")
	}
	source, _ := args["source"].(string)
	if source == "" {
		source = "storage"
	}
	modeValue, _ := args["mode"].(string)
	mode, err := parseVirtualMediaMode(modeValue, filename)
	if err != nil {
		return nil, err
	}

	switch strings.ToLower(strings.TrimSpace(source)) {
	case "storage", "internal", "kvm":
		err = rpcMountWithStorage(filename, mode)
	case "sd", "sdstorage", "sd-card":
		err = rpcMountWithSDStorage(filename, mode)
	default:
		return nil, fmt.Errorf("invalid source %q; use storage or sd", source)
	}
	if err != nil {
		return nil, err
	}
	return handleGetVirtualMediaState(ctx, req)
}

func handleMountVirtualMediaURL(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	args := req.GetArguments()
	url, _ := args["url"].(string)
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("url is required")
	}
	modeValue, _ := args["mode"].(string)
	mode, err := parseVirtualMediaMode(modeValue, url)
	if err != nil {
		return nil, err
	}
	if err := rpcMountWithHTTP(url, mode); err != nil {
		return nil, err
	}
	return handleGetVirtualMediaState(ctx, req)
}

func handleUnmountVirtualMedia(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if err := rpcUnmountImage(); err != nil {
		return nil, err
	}
	return mcp.NewToolResultText("Virtual media unmounted"), nil
}
