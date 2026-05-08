package hidrpc

import "fmt"

type Handler interface {
	HandleHandshake(version byte) error
	HandleKeyboardReport(modifier byte, keys []byte) error
	HandleKeypressReport(key byte, press bool) error
	HandleKeypressKeepAlive() error
	HandleKeyboardMacroReport(data []byte) error
	HandleCancelKeyboardMacro() error
}

type Server struct {
	handler Handler
}

func NewServer(handler Handler) *Server {
	return &Server{handler: handler}
}

func (s *Server) HandleMessage(data []byte) error {
	msg, err := UnmarshalMessage(data)
	if err != nil {
		return err
	}

	switch msg.Type {
	case MessageTypeHandshake:
		if len(msg.Data) < 1 {
			return fmt.Errorf("invalid handshake length: %d", len(msg.Data))
		}
		return s.handler.HandleHandshake(msg.Data[0])
	case MessageTypeKeyboardReport:
		if len(msg.Data) < 7 {
			return fmt.Errorf("invalid keyboard report length: %d", len(msg.Data))
		}
		return s.handler.HandleKeyboardReport(msg.Data[0], msg.Data[1:7])
	case MessageTypeKeypressReport:
		if len(msg.Data) < 2 {
			return fmt.Errorf("invalid keypress report length: %d", len(msg.Data))
		}
		return s.handler.HandleKeypressReport(msg.Data[0], msg.Data[1] != 0)
	case MessageTypeKeypressKeepAlive:
		return s.handler.HandleKeypressKeepAlive()
	case MessageTypeKeyboardMacroReport:
		return s.handler.HandleKeyboardMacroReport(msg.Data)
	case MessageTypeCancelKeyboardMacro:
		return s.handler.HandleCancelKeyboardMacro()
	default:
		return fmt.Errorf("unknown message type: 0x%02x", msg.Type)
	}
}
