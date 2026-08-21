package kvm

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
)

// MCUProbeStatus describes MCU-related facilities visible from the running
// PicoKVM userspace. The probe is deliberately read-only: it never loads MCU
// firmware, touches /dev/mem, changes pinmux, or writes to remoteproc/rpmsg.
type MCUProbeStatus struct {
	LoaderAvailable bool     `json:"loader_available"`
	LoaderPath      string   `json:"loader_path,omitempty"`
	RemoteProc      []string `json:"remoteproc,omitempty"`
	RPMsgDevices    []string `json:"rpmsg_devices,omitempty"`
	DevMemAvailable bool     `json:"devmem_available"`
	DeviceTree      bool     `json:"device_tree_available"`
	ReadyForLab     bool     `json:"ready_for_lab"`
}

func probeMCUStatus() MCUProbeStatus {
	status := MCUProbeStatus{}

	if loader, err := exec.LookPath("mcuload"); err == nil {
		status.LoaderAvailable = true
		status.LoaderPath = loader
	} else {
		for _, candidate := range []string{
			"/usr/bin/mcuload",
			"/bin/mcuload",
			"/usr/local/bin/mcuload",
			"/userdata/picokvm/bin/mcuload",
		} {
			if fileExists(candidate) {
				status.LoaderAvailable = true
				status.LoaderPath = candidate
				break
			}
		}
	}

	status.RemoteProc = existingGlob("/sys/class/remoteproc/remoteproc*")
	status.RPMsgDevices = existingGlob("/dev/rpmsg*")
	status.DevMemAvailable = fileExists("/dev/mem")
	status.DeviceTree = fileExists("/sys/firmware/devicetree/base")

	// "ReadyForLab" only means the userspace has enough visible plumbing to
	// justify a controlled MCU loading/IPC experiment. It does not imply that
	// the production PicoKVM pinmux or extension-board signals are MCU-safe.
	status.ReadyForLab = status.LoaderAvailable || len(status.RemoteProc) > 0 || len(status.RPMsgDevices) > 0
	return status
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func existingGlob(pattern string) []string {
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	return matches
}
