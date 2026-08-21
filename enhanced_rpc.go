package kvm

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// EnhancedDiagnostics is a compact, read-only snapshot intended for the Web UI
// and automation. It deliberately reuses the existing PicoKVM state/functions
// rather than probing hardware through new privileged paths.
type EnhancedDiagnostics struct {
	AppVersion    string                     `json:"app_version"`
	SystemVersion string                     `json:"system_version,omitempty"`
	Hostname      string                     `json:"hostname,omitempty"`
	UptimeSeconds float64                    `json:"uptime_seconds"`
	Load          EnhancedLoadStatus         `json:"load"`
	Memory        EnhancedMemoryStatus       `json:"memory"`
	Userdata      EnhancedStorageStatus      `json:"userdata"`
	Network       []EnhancedNetworkInterface `json:"network"`
	USBState      string                     `json:"usb_state"`
	HostIO        map[string]bool            `json:"host_io,omitempty"`
	VirtualMedia  *VirtualMediaState         `json:"virtual_media,omitempty"`
	Stream        EnhancedStreamStatus       `json:"stream"`
	RTSP          RTSPServerStatus           `json:"rtsp"`
	MCU           MCUProbeStatus             `json:"mcu"`
	Warnings      []string                   `json:"warnings,omitempty"`
}

type EnhancedLoadStatus struct {
	One     float64 `json:"one"`
	Five    float64 `json:"five"`
	Fifteen float64 `json:"fifteen"`
}

type EnhancedMemoryStatus struct {
	TotalBytes     uint64 `json:"total_bytes"`
	AvailableBytes uint64 `json:"available_bytes"`
}

type EnhancedStorageStatus struct {
	TotalBytes uint64 `json:"total_bytes"`
	FreeBytes  uint64 `json:"free_bytes"`
}

type EnhancedNetworkInterface struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
}

func init() {
	// Keep enhanced RPC registration isolated from the vendor handler table so
	// upstream jsonrpc.go remains easy to merge.
	rpcHandlers["getEnhancedStreamStatus"] = RPCHandler{Func: rpcGetEnhancedStreamStatus}
	rpcHandlers["getEnhancedDiagnostics"] = RPCHandler{Func: rpcGetEnhancedDiagnostics}
	rpcHandlers["getRTPMulticastStatus"] = RPCHandler{Func: rpcGetEnhancedRTPMulticastStatus}
	rpcHandlers["startRTPMulticast"] = RPCHandler{Func: rpcStartEnhancedRTPMulticast, Params: []string{"address", "ttl"}}
	rpcHandlers["stopRTPMulticast"] = RPCHandler{Func: rpcStopEnhancedRTPMulticast}
	rpcHandlers["getRTSPStatus"] = RPCHandler{Func: rpcGetEnhancedRTSPStatus}
}

func rpcGetEnhancedStreamStatus() (EnhancedStreamStatus, error) {
	return getEnhancedStreamStatus(), nil
}

func rpcGetEnhancedRTPMulticastStatus() (RTPMulticastStatus, error) {
	return getRTPMulticastStatus(), nil
}

func rpcGetEnhancedRTSPStatus() (RTSPServerStatus, error) {
	return getRTSPServerStatus(), nil
}

func rpcStartEnhancedRTPMulticast(address string, ttl int) (RTPMulticastStatus, error) {
	if strings.TrimSpace(address) == "" {
		address = defaultRTPMulticastAddress
	}
	if ttl == 0 {
		ttl = defaultRTPMulticastTTL
	}
	return startRTPMulticast(address, ttl)
}

func rpcStopEnhancedRTPMulticast() (RTPMulticastStatus, error) {
	return stopRTPMulticast(), nil
}

func rpcGetEnhancedDiagnostics() (EnhancedDiagnostics, error) {
	d := EnhancedDiagnostics{
		AppVersion: builtAppVersion,
		USBState:   rpcGetUSBState(),
		Stream:     getEnhancedStreamStatus(),
		RTSP:       getRTSPServerStatus(),
		MCU:        probeMCUStatus(),
	}

	if hostname, err := os.Hostname(); err == nil {
		d.Hostname = hostname
	} else {
		d.Warnings = append(d.Warnings, "hostname: "+err.Error())
	}

	if raw, err := os.ReadFile("/version"); err == nil {
		d.SystemVersion = strings.TrimSpace(string(raw))
	} else {
		d.Warnings = append(d.Warnings, "system version: "+err.Error())
	}

	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) > 0 {
			d.UptimeSeconds, _ = strconv.ParseFloat(fields[0], 64)
		}
	} else {
		d.Warnings = append(d.Warnings, "uptime: "+err.Error())
	}

	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) >= 3 {
			d.Load.One, _ = strconv.ParseFloat(fields[0], 64)
			d.Load.Five, _ = strconv.ParseFloat(fields[1], 64)
			d.Load.Fifteen, _ = strconv.ParseFloat(fields[2], 64)
		}
	} else {
		d.Warnings = append(d.Warnings, "loadavg: "+err.Error())
	}

	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			kb, parseErr := strconv.ParseUint(fields[1], 10, 64)
			if parseErr != nil {
				continue
			}
			switch strings.TrimSuffix(fields[0], ":") {
			case "MemTotal":
				d.Memory.TotalBytes = kb * 1024
			case "MemAvailable":
				d.Memory.AvailableBytes = kb * 1024
			}
		}
	} else {
		d.Warnings = append(d.Warnings, "meminfo: "+err.Error())
	}

	var stat syscall.Statfs_t
	if err := syscall.Statfs("/userdata", &stat); err == nil {
		d.Userdata.TotalBytes = stat.Blocks * uint64(stat.Bsize)
		d.Userdata.FreeBytes = stat.Bavail * uint64(stat.Bsize)
	} else {
		d.Warnings = append(d.Warnings, "userdata statfs: "+err.Error())
	}

	if media, err := rpcGetVirtualMediaState(); err == nil {
		d.VirtualMedia = media
	} else {
		d.Warnings = append(d.Warnings, "virtual media: "+err.Error())
	}

	if hostIO, err := rpcGetIOInputStatus(); err == nil {
		d.HostIO = hostIO
	} else {
		d.Warnings = append(d.Warnings, "host io: "+err.Error())
	}

	ifaces, err := net.Interfaces()
	if err != nil {
		d.Warnings = append(d.Warnings, "network interfaces: "+err.Error())
	} else {
		for _, iface := range ifaces {
			entry := EnhancedNetworkInterface{Name: iface.Name}
			addrs, addrErr := iface.Addrs()
			if addrErr != nil {
				d.Warnings = append(d.Warnings, fmt.Sprintf("network %s: %v", iface.Name, addrErr))
				continue
			}
			for _, addr := range addrs {
				entry.Addresses = append(entry.Addresses, addr.String())
			}
			d.Network = append(d.Network, entry)
		}
	}

	return d, nil
}
