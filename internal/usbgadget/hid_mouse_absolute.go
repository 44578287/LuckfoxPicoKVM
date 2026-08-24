package usbgadget

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

var absoluteMouseConfig = gadgetConfigItem{
	order:      1001,
	device:     "hid.usb1",
	path:       []string{"functions", "hid.usb1"},
	configPath: []string{"hid.usb1"},
	attrs: gadgetAttributes{
		"protocol":      "2",
		"subclass":      "0",
		"report_length": "6",
	},
	reportDesc: absoluteMouseCombinedReportDesc,
}

var absoluteMouseCombinedReportDesc = []byte{
	0x05, 0x01,
	0x09, 0x02,
	0xA1, 0x01,
	0x85, 0x01,
	0x09, 0x01,
	0xA1, 0x00,
	0x05, 0x09,
	0x19, 0x01,
	0x29, 0x03,
	0x15, 0x00,
	0x25, 0x01,
	0x75, 0x01,
	0x95, 0x03,
	0x81, 0x02,
	0x95, 0x01,
	0x75, 0x05,
	0x81, 0x03,
	0x05, 0x01,
	0x09, 0x30,
	0x09, 0x31,
	0x16, 0x00, 0x00,
	0x26, 0xFF, 0x7F,
	0x36, 0x00, 0x00,
	0x46, 0xFF, 0x7F,
	0x75, 0x10,
	0x95, 0x02,
	0x81, 0x02,
	0xC0,
	0x85, 0x02,
	0x09, 0x38,
	0x15, 0x81,
	0x25, 0x7F,
	0x35, 0x00,
	0x45, 0x00,
	0x75, 0x08,
	0x95, 0x01,
	0x81, 0x06,
	0xC0,
}

func (u *UsbGadget) absMouseWriteHidFile(data []byte) error {
	if u.absMouseHidFile == nil {
		file, err := openWithTimeout("/dev/hidg1", os.O_RDWR, 0666, 750*time.Millisecond)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no such file or directory") || strings.Contains(err.Error(), "no such device") {
				u.log.Error().Str("device", "hidg1").Str("device_name", "absolute_mouse").Err(err).Msg("HID device file missing, gadget may need reinitialization")
				if u.onHidDeviceMissing != nil {
					(*u.onHidDeviceMissing)("absolute_mouse", err)
				}
			}
			return fmt.Errorf("failed to open hidg1: %w", err)
		}
		u.absMouseHidFile = file
	}

	_, err := u.writeWithTimeout(u.absMouseHidFile, data)
	if err != nil {
		u.logWithSupression("absMouseWriteHidFile", 100, u.log, err, "failed to write to hidg1")
		_ = u.absMouseHidFile.Close()
		u.absMouseHidFile = nil
		return fmt.Errorf("absolute mouse HID write failed: %w", err)
	}
	u.resetLogSuppressionCounter("absMouseWriteHidFile")
	return nil
}

func (u *UsbGadget) AbsMouseReport(x, y int, buttons uint8) error {
	u.absMouseLock.Lock()
	defer u.absMouseLock.Unlock()

	err := u.absMouseWriteHidFile([]byte{1, buttons, uint8(x), uint8(x >> 8), uint8(y), uint8(y >> 8)})
	if err != nil {
		return err
	}
	u.resetUserInputTime()
	return nil
}

func (u *UsbGadget) AbsMouseWheelReport(wheelY int8) error {
	u.absMouseLock.Lock()
	defer u.absMouseLock.Unlock()
	if wheelY == 0 {
		return nil
	}
	err := u.absMouseWriteHidFile([]byte{2, byte(wheelY)})
	if err == nil {
		u.resetUserInputTime()
	}
	return err
}
