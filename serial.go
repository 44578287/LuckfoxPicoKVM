package kvm

import (
	"io"

	"github.com/pion/webrtc/v4"
	"go.bug.st/serial"
)

const serialPortPath = "/dev/ttyS0"

var port serial.Port

var defaultMode = &serial.Mode{
	BaudRate: 115200,
	DataBits: 8,
	Parity:   serial.NoParity,
	StopBits: serial.OneStopBit,
}

func initSerialPort() {
	_ = reopenSerialPort()
}

func reopenSerialPort() error {
	if port != nil {
		port.Close()
		port = nil
	}
	var err error
	port, err = serial.Open(serialPortPath, defaultMode)
	if err != nil {
		serialLogger.Error().
			Err(err).
			Str("path", serialPortPath).
			Interface("mode", defaultMode).
			Msg("Error opening serial port")
		return err
	}
	serialLogger.Info().
		Str("path", serialPortPath).
		Interface("mode", defaultMode).
		Msg("Serial port opened successfully")
	return nil
}

func handleSerialChannel(d *webrtc.DataChannel) {
	scopedLogger := serialLogger.With().
		Uint16("data_channel_id", *d.ID()).Logger()

	d.OnOpen(func() {
		if err := reopenSerialPort(); err != nil {
			scopedLogger.Error().Err(err).Msg("Failed to open serial port")
			d.Close()
			return
		}

		go func() {
			buf := make([]byte, 1024)
			for {
				n, err := port.Read(buf)
				if err != nil {
					if err != io.EOF {
						scopedLogger.Warn().Err(err).Msg("Failed to read from serial port")
					}
					break
				}
				if err := d.Send(buf[:n]); err != nil {
					scopedLogger.Warn().Err(err).Msg("Failed to send serial output")
					break
				}
			}
		}()
	})

	d.OnMessage(func(msg webrtc.DataChannelMessage) {
		if port == nil {
			return
		}
		_, err := port.Write(msg.Data)
		if err != nil {
			scopedLogger.Warn().Err(err).Msg("Failed to write to serial")
		}
	})

	d.OnError(func(err error) {
		scopedLogger.Warn().Err(err).Msg("Serial channel error")
	})

	d.OnClose(func() {
		if port != nil {
			port.Close()
			port = nil
		}
		scopedLogger.Info().Msg("Serial channel closed")
	})
}
