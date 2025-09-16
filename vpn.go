package kvm

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

type TailScaleSettings struct {
	State    string `json:"state"`
	LoginUrl string `json:"loginUrl"`
	IP       string `json:"ip"`
	XEdge    bool   `json:"xEdge"`
}

func rpcCanelTailScale() error {
	_, err := CallVpnCtrlAction("cancel_tailscale", map[string]interface{}{"type": "no_param"})
	if err != nil {
		return err
	}
	return nil
}

func rpcLoginTailScale(xEdge bool) (TailScaleSettings, error) {
	settings := TailScaleSettings{
		State:    "connecting",
		XEdge:    xEdge,
		LoginUrl: "",
		IP:       "",
	}

	_, err := CallVpnCtrlAction("login_tailscale", map[string]interface{}{"xEdge": xEdge})
	if err != nil {
		return settings, err
	}

	for i := 0; i < 15; i++ {
		time.Sleep(2 * time.Second)

		resp, err := CallVpnCtrlAction("get_tailscale_state", map[string]interface{}{"type": "no_param"})
		if err != nil {
			return settings, err
		}
		if resp.Event == "tailscale_state" {
			if _, ok := resp.Result["state"]; ok {
				settings.State = resp.Result["state"].(string)
			}
			if _, ok := resp.Result["ip"]; ok {
				settings.IP = resp.Result["ip"].(string)
			}
			if _, ok := resp.Result["loginUrl"]; ok {
				settings.LoginUrl = resp.Result["loginUrl"].(string)
			}
			if _, ok := resp.Result["xEdge"]; ok {
				settings.XEdge = resp.Result["xEdge"].(bool)
			}
		}

		switch settings.State {
		case "logined":
			config.TailScaleAutoStart = true
			config.TailScaleXEdge = settings.XEdge
			err := SaveConfig()
			if err != nil {
				vpnLogger.Error().Err(err).Msg("failed to save config")
			}
			return settings, err
		case "connected":
			config.TailScaleAutoStart = true
			config.TailScaleXEdge = settings.XEdge
			err = SaveConfig()
			if err != nil {
				vpnLogger.Error().Err(err).Msg("failed to save config")
			}
			return settings, err
		case "connecting":
			if i >= 10 {
				settings.State = "disconnected"
			} else {
				settings.State = "connecting"
			}
		case "cancel":
			err := rpcLogoutTailScale()
			if err != nil {
				vpnLogger.Error().Err(err).Msg("failed to logout tailscale")
			}
			settings.State = "disconnected"
			return settings, nil
		default:
			settings.State = "disconnected"
		}
	}

	return settings, nil
}

func rpcLogoutTailScale() error {
	_, err := CallVpnCtrlAction("logout_tailscale", map[string]interface{}{"type": "no_param"})
	if err != nil {
		return err
	}
	config.TailScaleAutoStart = false

	if err := SaveConfig(); err != nil {
		return err
	}

	return nil
}

func rpcGetTailScaleSettings() (TailScaleSettings, error) {
	settings := TailScaleSettings{}

	resp, err := CallVpnCtrlAction("get_tailscale_state", map[string]interface{}{"type": "no_param"})
	if err != nil {
		return settings, err
	}
	if resp.Event == "tailscale_state" {
		if _, ok := resp.Result["state"]; ok {
			settings.State = resp.Result["state"].(string)
		}
		if _, ok := resp.Result["ip"]; ok {
			settings.IP = resp.Result["ip"].(string)
		}
		if _, ok := resp.Result["loginUrl"]; ok {
			settings.LoginUrl = resp.Result["loginUrl"].(string)
		}
		if _, ok := resp.Result["xEdge"]; ok {
			settings.XEdge = resp.Result["xEdge"].(bool)
		}
	}

	return settings, nil
}

type ZeroTierSettings struct {
	State     string `json:"state"`
	NetworkID string `json:"networkID"`
	IP        string `json:"ip"`
}

func rpcLoginZeroTier(networkID string) (ZeroTierSettings, error) {
	LoadConfig()
	settings := ZeroTierSettings{
		State:     "connecting",
		NetworkID: networkID,
		IP:        "",
	}

	resp, err := CallVpnCtrlAction("login_zerotier", map[string]interface{}{
		"network_id":        networkID,
		"config_network_id": config.ZeroTierNetworkID,
	})
	if err != nil {
		return ZeroTierSettings{}, err
	}
	if resp.Event == "zerotier_state" {
		if _, ok := resp.Result["state"]; ok {
			settings.State = resp.Result["state"].(string)
		}
		if _, ok := resp.Result["network_id"]; ok {
			settings.NetworkID = resp.Result["network_id"].(string)
		}
		if _, ok := resp.Result["ip"]; ok {
			settings.IP = resp.Result["ip"].(string)
		}
	}

	switch settings.State {
	case "closed":
		config.ZeroTierAutoStart = false
		config.ZeroTierNetworkID = ""
		if err := SaveConfig(); err != nil {
			vpnLogger.Error().Err(err).Msg("failed to save config")
		}
	case "connected", "logined":
		config.ZeroTierAutoStart = true
		config.ZeroTierNetworkID = settings.NetworkID
		if err := SaveConfig(); err != nil {
			vpnLogger.Error().Err(err).Msg("failed to save config")
		}
	}
	/* disconnected - does not handle */

	return settings, nil
}

func rpcLogoutZeroTier(networkID string) error {
	_, err := CallVpnCtrlAction("logout_zerotier", map[string]interface{}{
		"network_id": networkID,
	})
	if err != nil {
		return err
	}

	config.ZeroTierAutoStart = false
	config.ZeroTierNetworkID = ""
	if err := SaveConfig(); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}
	return nil
}

func rpcGetZeroTierSettings() (ZeroTierSettings, error) {
	LoadConfig()
	configNetworkID := fmt.Sprintf("%v", config.ZeroTierNetworkID)
	settings := ZeroTierSettings{
		State:     "disconnected",
		NetworkID: configNetworkID,
		IP:        "",
	}

	resp, err := CallVpnCtrlAction("get_zerotier_state", map[string]interface{}{
		"network_id": configNetworkID,
	})
	if err != nil {
		return settings, err
	}
	if resp.Event == "zerotier_state" {
		if _, ok := resp.Result["state"]; ok {
			settings.State = resp.Result["state"].(string)
		}
		if _, ok := resp.Result["network_id"]; ok {
			settings.NetworkID = resp.Result["network_id"].(string)
		}
		if _, ok := resp.Result["ip"]; ok {
			settings.IP = resp.Result["ip"].(string)
		}
	}

	return settings, nil
}

type VpnUpdateDisplayState struct {
	TailScaleState string `json:"tailscale_state"`
	ZeroTierState  string `json:"zerotier_state"`
	Error          string `json:"error,omitempty"` //no_signal, no_lock, out_of_range
}

func HandleVpnDisplayUpdateMessage(event CtrlResponse) {
	waitDisplayUpdate.Lock()
	defer waitDisplayUpdate.Unlock()
	waitDisplayCtrlClientConnected()

	vpnUpdateDisplayState := VpnUpdateDisplayState{}
	err := json.Unmarshal(event.Data, &vpnUpdateDisplayState)
	if err != nil {
		vpnLogger.Warn().Err(err).Msg("Error parsing vpn state json")
		return
	}

	switch vpnUpdateDisplayState.TailScaleState {
	case "connected":
		updateLabelIfChanged("Network_TailScale_Label", "Connected")
	case "logined":
		updateLabelIfChanged("Network_TailScale_Label", "Logined")
	default:
		updateLabelIfChanged("Network_TailScale_Label", "Disconnected")
	}

	switch vpnUpdateDisplayState.ZeroTierState {
	case "connected":
		updateLabelIfChanged("Network_ZeroTier_Label", "Connected")
	case "logined":
		updateLabelIfChanged("Network_ZeroTier_Label", "Logined")
	default:
		updateLabelIfChanged("Network_ZeroTier_Label", "Disconnected")
	}
}

type FrpcStatus struct {
	Running bool `json:"running"`
}

var (
	frpcTomlPath = "/userdata/frpc/frpc.toml"
	frpcLogPath  = "/tmp/frpc.log"
)

func frpcRunning() bool {
	cmd := exec.Command("pgrep", "-x", "frpc")
	return cmd.Run() == nil
}

func rpcGetFrpcLog() (string, error) {
	f, err := os.Open(frpcLogPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("frpc log file not exist")
		}
		return "", err
	}
	defer f.Close()

	const want = 30
	lines := make([]string, 0, want+10)
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > want {
			lines = lines[1:]
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}

	var buf []byte
	for _, l := range lines {
		buf = append(buf, l...)
		buf = append(buf, '\n')
	}
	return string(buf), nil
}

func rpcGetFrpcToml() (string, error) {
	return config.FrpcToml, nil
}

func rpcStartFrpc(frpcToml string) error {
	if frpcRunning() {
		_ = exec.Command("pkill", "-x", "frpc").Run()
	}

	if frpcToml != "" {
		_ = os.MkdirAll(filepath.Dir(frpcTomlPath), 0700)
		if err := os.WriteFile(frpcTomlPath, []byte(frpcToml), 0600); err != nil {
			return err
		}
		cmd := exec.Command("frpc", "-c", frpcTomlPath)
		cmd.Stdout = nil
		cmd.Stderr = nil
		logFile, err := os.OpenFile(frpcLogPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			return err
		}
		defer logFile.Close()
		cmd.Stdout = logFile
		cmd.Stderr = logFile

		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start frpc failed: %w", err)
		} else {
			config.FrpcAutoStart = true
			config.FrpcToml = frpcToml
			if err := SaveConfig(); err != nil {
				return fmt.Errorf("failed to save config: %w", err)
			}
		}
	} else {
		return fmt.Errorf("frpcToml is empty")
	}

	return nil
}

func rpcStopFrpc() error {
	if frpcRunning() {
		err := exec.Command("pkill", "-x", "frpc").Run()
		if err != nil {
			return fmt.Errorf("failed to stop frpc: %w", err)
		}
	}

	config.FrpcAutoStart = false
	err := SaveConfig()
	if err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}
	return nil
}

func rpcGetFrpcStatus() (FrpcStatus, error) {
	return FrpcStatus{Running: frpcRunning()}, nil
}

func initVPN() {
	waitVpnCtrlClientConnected()
	go func() {
		for {
			if !networkState.IsOnline() {
				vpnLogger.Warn().Msg("waiting for network to be online, will retry in 3 seconds")
				time.Sleep(3 * time.Second)
				continue
			} else {
				break
			}
		}

		if config.TailScaleAutoStart {
			if _, err := rpcLoginTailScale(config.TailScaleXEdge); err != nil {
				vpnLogger.Error().Err(err).Msg("Failed to auto start TailScale")
			}
		}

		if config.ZeroTierAutoStart && config.ZeroTierNetworkID != "" {
			if _, err := rpcLoginZeroTier(config.ZeroTierNetworkID); err != nil {
				vpnLogger.Error().Err(err).Msg("Failed to auto start ZeroTier")
			}
		}

		if config.FrpcAutoStart && config.FrpcToml != "" {
			if err := rpcStartFrpc(config.FrpcToml); err != nil {
				vpnLogger.Error().Err(err).Msg("Failed to auto start frpc")
			}
		}
	}()

	go func() {
		for {
			var status syscall.WaitStatus
			var rusage syscall.Rusage
			pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, &rusage)
			if pid <= 0 || err != nil {
				time.Sleep(5 * time.Second)
			}
		}
	}()
}
