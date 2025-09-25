package kvm

import (
	"os"
	"time"

	"kvm/internal/usbgadget"
)

var gadget *usbgadget.UsbGadget

// initUsbGadget initializes the USB gadget.
// call it only after the config is loaded.
func initUsbGadget() {
	resp, _ := rpcGetSDMountStatus()
	if resp.Status == SDMountOK {
		if err := writeUmtprdConfFile(true); err != nil {
			usbLogger.Error().Err(err).Msg("failed to write umtprd conf file")
		}
	} else {
		if err := writeUmtprdConfFile(false); err != nil {
			usbLogger.Error().Err(err).Msg("failed to write umtprd conf file")
		}
	}

	gadget = usbgadget.NewUsbGadget(
		"kvm",
		config.UsbDevices,
		config.UsbConfig,
		usbLogger,
	)

	go func() {
		for {
			checkUSBState()
			time.Sleep(500 * time.Millisecond)
		}
	}()

	gadget.SetOnKeyboardStateChange(func(state usbgadget.KeyboardState) {
		if currentSession != nil {
			writeJSONRPCEvent("keyboardLedState", state, currentSession)
		}
	})

	// open the keyboard hid file to listen for keyboard events
	if err := gadget.OpenKeyboardHidFile(); err != nil {
		usbLogger.Error().Err(err).Msg("failed to open keyboard hid file")
	}
}

func initSystemInfo() {
	if !config.AutoMountSystemInfo {
		return
	}

	go func() {
		for {
			if !networkState.HasIPAssigned() {
				vpnLogger.Warn().Msg("waiting for network get IPv4 address, will retry in 3 seconds")
				time.Sleep(3 * time.Second)
				continue
			} else {
				break
			}
		}
		err := writeSystemInfoImg()
		if err != nil {
			usbLogger.Error().Err(err).Msg("failed to create system_info.img")
		}

		mediaState, _ := rpcGetVirtualMediaState()
		if mediaState != nil && mediaState.Filename == "system_info.img" {
			usbLogger.Error().Err(err).Msg("system_info.img is busy")
		} else if mediaState == nil || mediaState.Filename == "" {
			err = rpcMountWithStorage("system_info.img", Disk)
			if err != nil {
				usbLogger.Error().Err(err).Msg("failed to mount system_info.img")
			}
		}
	}()
}

func rpcKeyboardReport(modifier uint8, keys []uint8) error {
	return gadget.KeyboardReport(modifier, keys)
}

func rpcAbsMouseReport(x, y int, buttons uint8) error {
	return gadget.AbsMouseReport(x, y, buttons)
}

func rpcRelMouseReport(dx, dy int8, buttons uint8) error {
	return gadget.RelMouseReport(dx, dy, buttons)
}

func rpcWheelReport(wheelY int8) error {
	return gadget.AbsMouseWheelReport(wheelY)
}

func rpcGetKeyboardLedState() (state usbgadget.KeyboardState) {
	return gadget.GetKeyboardState()
}

var usbState = "unknown"

func rpcGetUSBState() (state string) {
	return gadget.GetUsbState()
}

func triggerUSBStateUpdate() {
	go func() {
		if currentSession == nil {
			usbLogger.Info().Msg("No active RPC session, skipping update state update")
			return
		}
		writeJSONRPCEvent("usbState", usbState, currentSession)
	}()
}

func checkUSBState() {
	newState := gadget.GetUsbState()
	if newState == usbState {
		return
	}
	usbState = newState

	usbLogger.Info().Str("from", usbState).Str("to", newState).Msg("USB state changed")
	requestDisplayUpdate(true)
	triggerUSBStateUpdate()
}

func rpcSendUsbWakeupSignal() error {
	err := os.WriteFile("/sys/class/udc/ffb00000.usb/srp", []byte("1"), 0644)
	if err != nil {
		return err
	}
	return nil
}
