package kvm

import (
	"encoding/json"
	"fmt"
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

	//fmt.Printf("[rpcLoginTailScale] xEdge: %v\n", xEdge)

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
			SaveConfig()
			return settings, nil
		case "connected":
			config.TailScaleAutoStart = true
			config.TailScaleXEdge = settings.XEdge
			SaveConfig()
			return settings, nil
		case "connecting":
			if i >= 10 {
				settings.State = "disconnected"
			} else {
				settings.State = "connecting"
			}
		case "cancel":
			go rpcLogoutTailScale()
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
	//fmt.Printf("[rpcLoginZeroTier] networkID: %s\n", networkID)
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

	if settings.State == "closed" {
		config.ZeroTierAutoStart = false
		config.ZeroTierNetworkID = ""
		if err := SaveConfig(); err != nil {
			vpnLogger.Error().Err(err).Msg("failed to save config")
		}
	} else if settings.State == "connected" || settings.State == "logined" {
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

	if vpnUpdateDisplayState.TailScaleState == "connected" {
		updateLabelIfChanged("Network_TailScale_Label", "Connected")
	} else if vpnUpdateDisplayState.TailScaleState == "logined" {
		updateLabelIfChanged("Network_TailScale_Label", "Logined")
	} else {
		updateLabelIfChanged("Network_TailScale_Label", "Disconnected")
	}

	if vpnUpdateDisplayState.ZeroTierState == "connected" {
		updateLabelIfChanged("Network_ZeroTier_Label", "Connected")
	} else if vpnUpdateDisplayState.ZeroTierState == "logined" {
		updateLabelIfChanged("Network_ZeroTier_Label", "Logined")
	} else {
		updateLabelIfChanged("Network_ZeroTier_Label", "Disconnected")
	}

}

func initVPN() {
	waitVpnCtrlClientConnected()
	go func() {
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
