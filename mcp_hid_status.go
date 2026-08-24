package kvm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
)

type MCPHIDEndpointStatus struct {
	Name             string `json:"name"`
	Device           string `json:"device"`
	DeviceExists     bool   `json:"device_exists"`
	FunctionPath     string `json:"function_path"`
	FunctionExists   bool   `json:"function_exists"`
	ConfigLinkPath   string `json:"config_link_path"`
	ConfigLinkExists bool   `json:"config_link_exists"`
	Protocol         string `json:"protocol,omitempty"`
	Subclass         string `json:"subclass,omitempty"`
	ReportLength     string `json:"report_length,omitempty"`
}

type MCPHIDStatus struct {
	USBState       string                 `json:"usb_state"`
	UDC            string                 `json:"udc,omitempty"`
	UDCBound       bool                   `json:"udc_bound"`
	Configured     map[string]bool        `json:"configured"`
	Endpoints      []MCPHIDEndpointStatus `json:"endpoints"`
	Recovery       USBReinitializeStatus  `json:"recovery"`
}

func readTrimmed(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func hidEndpointStatus(name, device, function string) MCPHIDEndpointStatus {
	base := "/sys/kernel/config/usb_gadget/kvm"
	functionPath := filepath.Join(base, "functions", function)
	linkPath := filepath.Join(base, "configs", "c.1", function)
	_, devErr := os.Stat(device)
	_, functionErr := os.Stat(functionPath)
	_, linkErr := os.Lstat(linkPath)
	return MCPHIDEndpointStatus{
		Name: name, Device: device, DeviceExists: devErr == nil,
		FunctionPath: functionPath, FunctionExists: functionErr == nil,
		ConfigLinkPath: linkPath, ConfigLinkExists: linkErr == nil,
		Protocol: readTrimmed(filepath.Join(functionPath, "protocol")),
		Subclass: readTrimmed(filepath.Join(functionPath, "subclass")),
		ReportLength: readTrimmed(filepath.Join(functionPath, "report_length")),
	}
}

func getMCPHIDStatus() MCPHIDStatus {
	st := MCPHIDStatus{
		USBState: rpcGetUSBState(),
		Configured: map[string]bool{},
		Recovery: getUSBReinitializeStatus(),
	}
	if config.UsbDevices != nil {
		st.Configured["keyboard"] = config.UsbDevices.Keyboard
		st.Configured["absolute_mouse"] = config.UsbDevices.AbsoluteMouse
		st.Configured["relative_mouse"] = config.UsbDevices.RelativeMouse
		st.Configured["mass_storage"] = config.UsbDevices.MassStorage
		st.Configured["mtp"] = config.UsbDevices.Mtp
		st.Configured["audio"] = config.UsbDevices.Audio
	}
	st.UDC = readTrimmed("/sys/kernel/config/usb_gadget/kvm/UDC")
	st.UDCBound = st.UDC != "" && st.UDC != "none"
	st.Endpoints = []MCPHIDEndpointStatus{
		hidEndpointStatus("keyboard", "/dev/hidg0", "hid.usb0"),
		hidEndpointStatus("absolute_mouse", "/dev/hidg1", "hid.usb1"),
		hidEndpointStatus("relative_mouse", "/dev/hidg2", "hid.usb2"),
	}
	return st
}

func handleGetHIDStatus(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(getMCPHIDStatus(), "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}
