package kvm

import (
	"fmt"
	"os"
)

const ethernetMacAddressPath = "/userdata/ethaddr.txt"

func rpcSetEthernetMacAddress(macAddress string) (interface{}, error) {
	normalized, err := networkState.SetMACAddress(macAddress)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(ethernetMacAddressPath, []byte(normalized+"\n"), 0644); err != nil {
		return nil, fmt.Errorf("failed to write %s: %w", ethernetMacAddressPath, err)
	}
	return networkState.RpcGetNetworkState(), nil
}

