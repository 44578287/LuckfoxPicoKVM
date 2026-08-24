package usbgadget

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

var relativeMouseConfig = gadgetConfigItem{
	order:      1002,
	device:     "hid.usb2",
	path:       []string{"functions", "hid.usb2"},
	configPath: []string{"hid.usb2"},
	attrs: gadgetAttributes{
		"protocol":      "2",
		"subclass":      "1",
		"report_length": "4",
	},
	reportDesc: relativeMouseCombinedReportDesc,
}

var relativeMouseCombinedReportDesc = []byte{
	0x05, 0x01,
	0x09, 0x02,
	0xa1, 0x01,
	0x09, 0x01,
	0xa1, 0x00,
	0x05, 0x09,
	0x19, 0x01,
	0x29, 0x08,
	0x15, 0x00,
	0x25, 0x01,
	0x95, 0x08,
	0x75, 0x01,
	0x81, 0x02,
	0x05, 0x01,
	0x09, 0x30,
	0x09, 0x31,
	0x09, 0x38,
	0x15, 0x81,
	0x25, 0x7f,
	0x75, 0x08,
	0x95, 0x03,
	0x81, 0x06,
	0xc0,
	0xc0,
}

func (u *UsbGadget) relMouseWriteHidFile(data []byte) error {
	if u.relMouseHidFile == nil {
		file, err := openWithTimeout("/dev/hidg2", os.O_RDWR, 0666, 750*time.Millisecond)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no such file or directory") || strings.Contains(err.Error(), "no such device") {
				u.log.Error().Str("device", "hidg2").Str("device_name", "relative_mouse").Err(err).Msg("HID device file missing, gadget may need reinitialization")
				if u.onHidDeviceMissing != nil {
					(*u.onHidDeviceMissing)("relative_mouse", err)
				}
			}
			return fmt.Errorf("failed to open hidg2: %w", err)
		}
		u.relMouseHidFile = file
	}

	_, err := u.writeWithTimeout(u.relMouseHidFile, data)
	if err != nil {
		u.logWithSupression("relMouseWriteHidFile", 100, u.log, err, "failed to write to hidg2")
		_ = u.relMouseHidFile.Close()
		u.relMouseHidFile = nil
		return fmt.Errorf("relative mouse HID write failed: %w", err)
	}
	u.resetLogSuppressionCounter("relMouseWriteHidFile")
	return nil
}

func (u *UsbGadget) RelMouseReport(mx, my int8, buttons uint8, wheel int8) error {
	u.relMouseLock.Lock()
	defer u.relMouseLock.Unlock()

	err := u.relMouseWriteHidFile([]byte{buttons, uint8(mx), uint8(my), uint8(wheel)})
	if err != nil {
		return err
	}
	u.resetUserInputTime()
	return nil
}
