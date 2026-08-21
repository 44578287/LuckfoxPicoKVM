package kvm

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

type MCPMemoryStatus struct {
	TotalBytes     uint64 `json:"total_bytes"`
	AvailableBytes uint64 `json:"available_bytes"`
}

type MCPFilesystemStatus struct {
	Path       string `json:"path"`
	TotalBytes uint64 `json:"total_bytes,omitempty"`
	FreeBytes  uint64 `json:"free_bytes,omitempty"`
	Error      string `json:"error,omitempty"`
}

type MCPNetworkAddress struct {
	Interface string `json:"interface"`
	Address   string `json:"address"`
}

type MCPDeviceDiagnostics struct {
	Timestamp          time.Time              `json:"timestamp"`
	AppVersion         string                 `json:"app_version"`
	GoVersion          string                 `json:"go_version"`
	Architecture       string                 `json:"architecture"`
	UptimeSeconds      float64                `json:"uptime_seconds,omitempty"`
	LoadAverage        string                 `json:"load_average,omitempty"`
	Memory             MCPMemoryStatus        `json:"memory"`
	Filesystems        []MCPFilesystemStatus  `json:"filesystems"`
	NetworkAddresses   []MCPNetworkAddress    `json:"network_addresses"`
	Video              VideoInputState        `json:"video"`
	USBState           string                 `json:"usb_state"`
	VirtualMedia       *VirtualMediaState     `json:"virtual_media,omitempty"`
	ControllerActive   bool                   `json:"controller_active"`
	ReadOnlyViewers    int32                  `json:"read_only_viewers"`
	FanoutSubscribers  int                    `json:"fanout_subscribers"`
	RTPMulticast       RTPMulticastStatus     `json:"rtp_multicast"`
	MCU                MCUProbeStatus         `json:"mcu"`
}

func collectMCPDeviceDiagnostics() MCPDeviceDiagnostics {
	d := MCPDeviceDiagnostics{
		Timestamp:         time.Now(),
		AppVersion:        builtAppVersion,
		GoVersion:         runtime.Version(),
		Architecture:      runtime.GOARCH,
		Memory:            readMCPMemoryStatus(),
		Video:             lastVideoState,
		ControllerActive:  currentSession != nil,
		ReadOnlyViewers:   enhancedViewerCount.Load(),
		FanoutSubscribers: videoBroadcaster.SubscriberCount(),
		RTPMulticast:      getRTPMulticastStatus(),
		MCU:               probeMCUStatus(),
	}

	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(data))
		if len(fields) > 0 {
			d.UptimeSeconds, _ = strconv.ParseFloat(fields[0], 64)
		}
	}
	if data, err := os.ReadFile("/proc/loadavg"); err == nil {
		d.LoadAverage = strings.TrimSpace(string(data))
	}

	for _, p := range []string{"/", "/userdata", imagesFolder, SDImagesFolder} {
		d.Filesystems = append(d.Filesystems, statMCPFilesystem(p))
	}

	ifaces, err := net.Interfaces()
	if err == nil {
		for _, iface := range ifaces {
			addresses, addrErr := iface.Addrs()
			if addrErr != nil {
				continue
			}
			for _, address := range addresses {
				d.NetworkAddresses = append(d.NetworkAddresses, MCPNetworkAddress{
					Interface: iface.Name,
					Address:   address.String(),
				})
			}
		}
	}

	if gadget == nil {
		d.USBState = "unavailable"
	} else {
		d.USBState = rpcGetUSBState()
	}
	d.VirtualMedia, _ = rpcGetVirtualMediaState()
	return d
}

func readMCPMemoryStatus() MCPMemoryStatus {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return MCPMemoryStatus{}
	}
	defer file.Close()

	var result MCPMemoryStatus
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		valueKB, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			result.TotalBytes = valueKB * 1024
		case "MemAvailable":
			result.AvailableBytes = valueKB * 1024
		}
	}
	return result
}

func statMCPFilesystem(path string) MCPFilesystemStatus {
	status := MCPFilesystemStatus{Path: path}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		status.Error = err.Error()
		return status
	}
	status.TotalBytes = stat.Blocks * uint64(stat.Bsize)
	status.FreeBytes = stat.Bavail * uint64(stat.Bsize)
	return status
}

func handleGetDeviceDiagnostics(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(collectMCPDeviceDiagnostics(), "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal diagnostics: %w", err)
	}
	return mcp.NewToolResultText(string(data)), nil
}
