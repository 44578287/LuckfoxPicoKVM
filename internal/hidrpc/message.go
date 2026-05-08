package hidrpc

import "fmt"

const (
	MessageTypeHandshake           = 0x01
	MessageTypeKeyboardReport      = 0x02
	MessageTypePointerReport       = 0x03
	MessageTypeWheelReport         = 0x04
	MessageTypeKeypressReport      = 0x05
	MessageTypeMouseReport         = 0x06
	MessageTypeKeyboardMacroReport = 0x07
	MessageTypeCancelKeyboardMacro = 0x08
	MessageTypeKeypressKeepAlive   = 0x09
	MessageTypeKeyboardLedState    = 0x32
	MessageTypeKeysDownState       = 0x33
	MessageTypeKeyboardMacroState  = 0x34
)

type Message struct {
	Type byte
	Data []byte
}

func MarshalKeyboardReport(modifier byte, keys []byte) []byte {
	data := make([]byte, 8)
	data[0] = MessageTypeKeyboardReport
	data[1] = modifier
	copy(data[2:], keys)
	return data
}

func MarshalHandshake(version byte) []byte {
	return []byte{MessageTypeHandshake, version}
}

func MarshalKeypressReport(key byte, press bool) []byte {
	data := make([]byte, 3)
	data[0] = MessageTypeKeypressReport
	data[1] = key
	if press {
		data[2] = 1
	} else {
		data[2] = 0
	}
	return data
}

func MarshalKeypressKeepAlive() []byte {
	return []byte{MessageTypeKeypressKeepAlive}
}

func MarshalKeyboardLedState(state byte) []byte {
	return []byte{MessageTypeKeyboardLedState, state}
}

func MarshalKeysDownState(modifier byte, keys []byte) []byte {
	data := make([]byte, 8)
	data[0] = MessageTypeKeysDownState
	data[1] = modifier
	copy(data[2:], keys)
	return data
}

func UnmarshalMessage(data []byte) (Message, error) {
	if len(data) < 1 {
		return Message{}, fmt.Errorf("empty message")
	}
	return Message{Type: data[0], Data: data[1:]}, nil
}
