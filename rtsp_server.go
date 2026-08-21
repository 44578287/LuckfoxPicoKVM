package kvm

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

const (
	defaultRTSPAddress   = ":8554"
	maxRTSPClients int32 = 8
)

type RTSPServerStatus struct {
	Running    bool   `json:"running"`
	Address    string `json:"address"`
	Path       string `json:"path"`
	Codec      string `json:"codec"`
	Clients    int32  `json:"clients"`
	MaxClients int32  `json:"max_clients"`
	LastError  string `json:"last_error,omitempty"`
}

var (
	rtspRunning   atomic.Bool
	rtspClients   atomic.Int32
	rtspLastError atomic.Value // string
)

type rtspTransportMode int

const (
	rtspTransportNone rtspTransportMode = iota
	rtspTransportTCP
	rtspTransportUDP
)

type rtspClient struct {
	conn       net.Conn
	reader     *bufio.Reader
	writeMu    sync.Mutex
	sessionID  string
	mode       rtspTransportMode
	interleave byte
	udpRTP     *net.UDPConn
	udpRTCP    *net.UDPConn
	udpTarget  *net.UDPAddr
	playMu     sync.Mutex
	playing    bool
	stopPlay   chan struct{}
	subID      string
	codec      string
	ssrc       uint32
}

type rtspRequest struct {
	Method  string
	URI     string
	Version string
	Headers map[string]string
	Body    []byte
}

func StartRTSPServer(address string) {
	if strings.TrimSpace(address) == "" {
		address = defaultRTSPAddress
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		setRTSPError(fmt.Sprintf("listen %s: %v", address, err))
		logger.Error().Err(err).Str("addr", address).Msg("RTSP server failed to listen")
		return
	}
	defer listener.Close()
	rtspRunning.Store(true)
	logger.Info().Str("addr", address).Int32("max_clients", maxRTSPClients).Msg("Starting enhanced RTSP server")
	defer rtspRunning.Store(false)

	for {
		conn, err := listener.Accept()
		if err != nil {
			setRTSPError(err.Error())
			return
		}
		go handleRTSPConnection(conn)
	}
}

func getRTSPServerStatus() RTSPServerStatus {
	lastError := ""
	if value := rtspLastError.Load(); value != nil {
		lastError, _ = value.(string)
	}
	codec := streamEncodecType
	if codec == "" {
		codec = "avc"
	}
	return RTSPServerStatus{
		Running:    rtspRunning.Load(),
		Address:    defaultRTSPAddress,
		Path:       "/live",
		Codec:      codec,
		Clients:    rtspClients.Load(),
		MaxClients: maxRTSPClients,
		LastError:  lastError,
	}
}

func setRTSPError(message string) {
	rtspLastError.Store(message)
	if message != "" {
		logger.Warn().Str("error", message).Msg("RTSP server error")
	}
}

func handleRTSPConnection(conn net.Conn) {
	client := &rtspClient{
		conn:      conn,
		reader:    bufio.NewReader(conn),
		sessionID: strings.ReplaceAll(uuid.NewString(), "-", ""),
		ssrc:      randomSSRC(),
	}
	defer client.close()

	for {
		req, err := readRTSPRequest(client.reader)
		if err != nil {
			if err != io.EOF {
				logger.Debug().Err(err).Msg("RTSP client disconnected")
			}
			return
		}

		cseq := req.Headers["cseq"]
		if cseq == "" {
			cseq = "0"
		}

		if !rtspAuthorized(req.Headers["authorization"]) {
			client.respond(cseq, 401, "Unauthorized", map[string]string{
				"WWW-Authenticate": `Basic realm="PicoKVM Enhanced"`,
			}, "")
			continue
		}

		switch strings.ToUpper(req.Method) {
		case "OPTIONS":
			client.respond(cseq, 200, "OK", map[string]string{
				"Public": "OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, GET_PARAMETER, TEARDOWN",
			}, "")

		case "DESCRIBE":
			if !validRTSPPath(req.URI) {
				client.respond(cseq, 404, "Not Found", nil, "")
				continue
			}
			sdp := buildRTSPSDP()
			base := ensureRTSPBaseURI(req.URI)
			client.respond(cseq, 200, "OK", map[string]string{
				"Content-Type": "application/sdp",
				"Content-Base": base,
			}, sdp)

		case "SETUP":
			if !strings.Contains(req.URI, "trackID=0") && !validRTSPPath(req.URI) {
				client.respond(cseq, 404, "Not Found", nil, "")
				continue
			}
			transport := req.Headers["transport"]
			responseTransport, err := client.configureTransport(transport)
			if err != nil {
				client.respond(cseq, 461, "Unsupported Transport", nil, "")
				continue
			}
			client.respond(cseq, 200, "OK", map[string]string{
				"Session":   client.sessionID,
				"Transport": responseTransport,
			}, "")

		case "PLAY":
			if client.mode == rtspTransportNone {
				client.respond(cseq, 455, "Method Not Valid in This State", nil, "")
				continue
			}
			if err := client.startPlaying(); err != nil {
				client.respond(cseq, 453, "Not Enough Bandwidth", nil, "")
				continue
			}
			client.respond(cseq, 200, "OK", map[string]string{
				"Session": client.sessionID,
				"Range":   "npt=0.000-",
			}, "")

		case "PAUSE":
			client.stopPlaying()
			client.respond(cseq, 200, "OK", map[string]string{"Session": client.sessionID}, "")

		case "GET_PARAMETER":
			client.respond(cseq, 200, "OK", map[string]string{"Session": client.sessionID}, "")

		case "TEARDOWN":
			client.stopPlaying()
			client.respond(cseq, 200, "OK", map[string]string{"Session": client.sessionID}, "")
			return

		default:
			client.respond(cseq, 405, "Method Not Allowed", map[string]string{
				"Allow": "OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, GET_PARAMETER, TEARDOWN",
			}, "")
		}
	}
}

func readRTSPRequest(reader *bufio.Reader) (rtspRequest, error) {
	for {
		first, err := reader.Peek(1)
		if err != nil {
			return rtspRequest{}, err
		}
		// RTCP interleaved frames from TCP clients start with '$'. Ignore them;
		// the current sender does not need RTCP feedback to deliver the stream.
		if first[0] == '$' {
			header := make([]byte, 4)
			if _, err := io.ReadFull(reader, header); err != nil {
				return rtspRequest{}, err
			}
			length := int(binary.BigEndian.Uint16(header[2:4]))
			if _, err := io.CopyN(io.Discard, reader, int64(length)); err != nil {
				return rtspRequest{}, err
			}
			continue
		}
		break
	}

	line, err := reader.ReadString('\n')
	if err != nil {
		return rtspRequest{}, err
	}
	line = strings.TrimSpace(line)
	parts := strings.SplitN(line, " ", 3)
	if len(parts) != 3 {
		return rtspRequest{}, fmt.Errorf("invalid RTSP request line: %q", line)
	}
	req := rtspRequest{Method: parts[0], URI: parts[1], Version: parts[2], Headers: map[string]string{}}

	for {
		headerLine, err := reader.ReadString('\n')
		if err != nil {
			return rtspRequest{}, err
		}
		headerLine = strings.TrimRight(headerLine, "\r\n")
		if headerLine == "" {
			break
		}
		name, value, ok := strings.Cut(headerLine, ":")
		if !ok {
			continue
		}
		req.Headers[strings.ToLower(strings.TrimSpace(name))] = strings.TrimSpace(value)
	}

	if rawLength := req.Headers["content-length"]; rawLength != "" {
		length, _ := strconv.Atoi(rawLength)
		if length > 0 {
			req.Body = make([]byte, length)
			if _, err := io.ReadFull(reader, req.Body); err != nil {
				return rtspRequest{}, err
			}
		}
	}
	return req, nil
}

func (c *rtspClient) configureTransport(transport string) (string, error) {
	c.closeUDP()
	transportLower := strings.ToLower(transport)

	if strings.Contains(transportLower, "rtp/avp/tcp") {
		channel := byte(0)
		if value := transportParam(transport, "interleaved"); value != "" {
			first, _, _ := strings.Cut(value, "-")
			if parsed, err := strconv.Atoi(first); err == nil && parsed >= 0 && parsed <= 255 {
				channel = byte(parsed)
			}
		}
		c.mode = rtspTransportTCP
		c.interleave = channel
		return fmt.Sprintf("RTP/AVP/TCP;unicast;interleaved=%d-%d;ssrc=%08X", channel, channel+1, c.ssrc), nil
	}

	if strings.Contains(transportLower, "rtp/avp") {
		ports := transportParam(transport, "client_port")
		first, _, ok := strings.Cut(ports, "-")
		if !ok {
			first = ports
		}
		clientPort, err := strconv.Atoi(first)
		if err != nil || clientPort <= 0 || clientPort > 65535 {
			return "", fmt.Errorf("invalid client_port")
		}
		peerHost, _, err := net.SplitHostPort(c.conn.RemoteAddr().String())
		if err != nil {
			return "", err
		}
		peerIP := net.ParseIP(peerHost)
		if peerIP == nil {
			return "", fmt.Errorf("invalid client ip")
		}
		rtpConn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			return "", err
		}
		rtcpConn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
		if err != nil {
			_ = rtpConn.Close()
			return "", err
		}
		c.mode = rtspTransportUDP
		c.udpRTP = rtpConn
		c.udpRTCP = rtcpConn
		c.udpTarget = &net.UDPAddr{IP: peerIP, Port: clientPort}
		serverRTP := rtpConn.LocalAddr().(*net.UDPAddr).Port
		serverRTCP := rtcpConn.LocalAddr().(*net.UDPAddr).Port
		go discardRTCP(rtcpConn)
		return fmt.Sprintf("RTP/AVP;unicast;client_port=%s;server_port=%d-%d;ssrc=%08X", ports, serverRTP, serverRTCP, c.ssrc), nil
	}

	return "", fmt.Errorf("unsupported transport")
}

func discardRTCP(conn *net.UDPConn) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := conn.ReadFromUDP(buf); err != nil {
			return
		}
	}
}

func transportParam(transport, name string) string {
	for _, part := range strings.Split(transport, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.EqualFold(key, name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (c *rtspClient) startPlaying() error {
	c.playMu.Lock()
	defer c.playMu.Unlock()
	if c.playing {
		return nil
	}
	for {
		current := rtspClients.Load()
		if current >= maxRTSPClients {
			return fmt.Errorf("RTSP client limit reached")
		}
		if rtspClients.CompareAndSwap(current, current+1) {
			break
		}
	}

	codec := streamEncodecType
	if codec == "" {
		codec = "avc"
	}
	id, frames := videoBroadcaster.SubscribeBuffered(defaultVideoSubscriberBuffer)
	c.playing = true
	c.stopPlay = make(chan struct{})
	c.subID = id
	c.codec = codec
	go c.streamRTP(frames, codec, c.stopPlay)
	logger.Info().Str("subscriber_id", id).Str("codec", codec).Int32("clients", rtspClients.Load()).Msg("RTSP client started playing")
	return nil
}

func (c *rtspClient) stopPlaying() {
	c.playMu.Lock()
	if !c.playing {
		c.playMu.Unlock()
		return
	}
	stop := c.stopPlay
	id := c.subID
	c.playing = false
	c.stopPlay = nil
	c.subID = ""
	c.playMu.Unlock()

	if stop != nil {
		close(stop)
	}
	if id != "" {
		videoBroadcaster.Unsubscribe(id)
	}
	rtspClients.Add(-1)
	logger.Info().Str("subscriber_id", id).Int32("clients", rtspClients.Load()).Msg("RTSP client stopped playing")
}

func (c *rtspClient) streamRTP(frames <-chan *VideoFrame, codec string, stop <-chan struct{}) {
	var payloader rtp.Payloader
	if codec == "hevc" {
		payloader = &codecs.H265Payloader{SkipAggregation: true}
	} else {
		payloader = &codecs.H264Payloader{DisableStapA: true}
	}
	packetizer := rtp.NewPacketizer(
		rtpVideoMTU,
		rtpVideoPayloadType,
		c.ssrc,
		payloader,
		rtp.NewRandomSequencer(),
		rtpVideoClockRate,
	)
	lastFrameAt := time.Now()

	for {
		select {
		case <-stop:
			return
		case frame, ok := <-frames:
			if !ok {
				return
			}
			currentCodec := streamEncodecType
			if currentCodec == "" {
				currentCodec = "avc"
			}
			if currentCodec != codec {
				frame.Release()
				setRTSPError(fmt.Sprintf("video codec changed from %s to %s; reconnect RTSP client", codec, currentCodec))
				c.stopPlayingAsync()
				return
			}

			now := time.Now()
			duration := now.Sub(lastFrameAt)
			lastFrameAt = now
			if duration <= 0 || duration > time.Second {
				duration = time.Second / 60
			}
			samples := uint32(duration.Seconds() * rtpVideoClockRate)
			if samples == 0 {
				samples = rtpVideoClockRate / 60
			}
			packets := packetizer.Packetize(frame.Data(), samples)
			frame.Release()

			for _, packet := range packets {
				raw, err := packet.Marshal()
				if err != nil {
					continue
				}
				if err := c.writeRTP(raw); err != nil {
					setRTSPError(err.Error())
					c.stopPlayingAsync()
					return
				}
			}
		}
	}
}

func (c *rtspClient) stopPlayingAsync() {
	go c.stopPlaying()
}

func (c *rtspClient) writeRTP(raw []byte) error {
	switch c.mode {
	case rtspTransportTCP:
		if len(raw) > 65535 {
			return fmt.Errorf("RTP packet too large")
		}
		frame := make([]byte, 4+len(raw))
		frame[0] = '$'
		frame[1] = c.interleave
		binary.BigEndian.PutUint16(frame[2:4], uint16(len(raw)))
		copy(frame[4:], raw)
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		_, err := c.conn.Write(frame)
		return err
	case rtspTransportUDP:
		if c.udpRTP == nil || c.udpTarget == nil {
			return fmt.Errorf("RTSP UDP transport unavailable")
		}
		_, err := c.udpRTP.WriteToUDP(raw, c.udpTarget)
		return err
	default:
		return fmt.Errorf("RTSP transport not configured")
	}
}

func (c *rtspClient) respond(cseq string, code int, reason string, headers map[string]string, body string) {
	var b strings.Builder
	fmt.Fprintf(&b, "RTSP/1.0 %d %s\r\n", code, reason)
	fmt.Fprintf(&b, "CSeq: %s\r\n", cseq)
	b.WriteString("Server: PicoKVM-Enhanced/1.0\r\n")
	if body != "" {
		fmt.Fprintf(&b, "Content-Length: %d\r\n", len(body))
	}
	for key, value := range headers {
		fmt.Fprintf(&b, "%s: %s\r\n", key, value)
	}
	b.WriteString("\r\n")
	b.WriteString(body)

	c.writeMu.Lock()
	_, _ = io.WriteString(c.conn, b.String())
	c.writeMu.Unlock()
}

func (c *rtspClient) closeUDP() {
	if c.udpRTP != nil {
		_ = c.udpRTP.Close()
		c.udpRTP = nil
	}
	if c.udpRTCP != nil {
		_ = c.udpRTCP.Close()
		c.udpRTCP = nil
	}
	c.udpTarget = nil
}

func (c *rtspClient) close() {
	c.stopPlaying()
	c.closeUDP()
	_ = c.conn.Close()
}

func rtspAuthorized(auth string) bool {
	if config.APIKey == "" {
		return true
	}
	if !strings.HasPrefix(strings.ToLower(auth), "basic ") {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(auth[6:]))
	if err != nil {
		return false
	}
	_, password, ok := strings.Cut(string(decoded), ":")
	return ok && password == config.APIKey
}

func validRTSPPath(uri string) bool {
	uri = strings.TrimSuffix(uri, "/")
	return strings.HasSuffix(uri, "/live") || uri == "live" || uri == "/live"
}

func ensureRTSPBaseURI(uri string) string {
	if strings.Contains(uri, "trackID=0") {
		uri = strings.TrimSuffix(uri, "trackID=0")
	}
	if !strings.HasSuffix(uri, "/") {
		uri += "/"
	}
	return uri
}

func buildRTSPSDP() string {
	codec := streamEncodecType
	codecName := "H264"
	fmtp := "a=fmtp:96 packetization-mode=1\r\n"
	if codec == "hevc" {
		codecName = "H265"
		fmtp = ""
	}
	return "v=0\r\n" +
		"o=- 0 0 IN IP4 0.0.0.0\r\n" +
		"s=PicoKVM Enhanced\r\n" +
		"t=0 0\r\n" +
		"a=control:*\r\n" +
		"m=video 0 RTP/AVP 96\r\n" +
		"c=IN IP4 0.0.0.0\r\n" +
		fmt.Sprintf("a=rtpmap:96 %s/90000\r\n", codecName) +
		fmtp +
		"a=control:trackID=0\r\n"
}
