package kvm

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"golang.org/x/net/ipv4"
)

const (
	defaultRTPMulticastAddress = "239.255.42.42:5004"
	defaultRTPMulticastTTL     = 1
	rtpVideoPayloadType        = 96
	rtpVideoClockRate          = 90000
	rtpVideoMTU                = 1200
)

type RTPMulticastStatus struct {
	Running     bool      `json:"running"`
	Address     string    `json:"address"`
	TTL         int       `json:"ttl"`
	Codec       string    `json:"codec"`
	PayloadType uint8     `json:"payload_type"`
	SSRC        uint32    `json:"ssrc"`
	Packets     uint64    `json:"packets"`
	Bytes       uint64    `json:"bytes"`
	StartedAt   time.Time `json:"started_at,omitempty"`
	LastError   string    `json:"last_error,omitempty"`
	SDPPath     string    `json:"sdp_path"`
	Subscribers int       `json:"fanout_subscribers"`
}

type rtpMulticastStartRequest struct {
	Address string `json:"address"`
	TTL     int    `json:"ttl"`
}

type rtpMulticastSender struct {
	mu           sync.Mutex
	running      bool
	address      string
	ttl          int
	codec        string
	ssrc         uint32
	startedAt    time.Time
	lastError    string
	cancel       context.CancelFunc
	conn         *net.UDPConn
	subscriberID string
	packets      atomic.Uint64
	bytes        atomic.Uint64
}

var enhancedRTPMulticast rtpMulticastSender

func registerRTPRoutes(mux *http.ServeMux) {
	var startHandler http.Handler = http.HandlerFunc(handleRTPMulticastStart)
	var stopHandler http.Handler = http.HandlerFunc(handleRTPMulticastStop)
	var statusHandler http.Handler = http.HandlerFunc(handleRTPMulticastStatus)
	if config.APIKey != "" {
		startHandler = withAPIKeyAuth(startHandler, config.APIKey)
		stopHandler = withAPIKeyAuth(stopHandler, config.APIKey)
		statusHandler = withAPIKeyAuth(statusHandler, config.APIKey)
	}

	mux.Handle("/rtp/start", startHandler)
	mux.Handle("/rtp/stop", stopHandler)
	mux.Handle("/rtp/status", statusHandler)
	mux.HandleFunc("/rtp.sdp", handleRTPMulticastSDP)
}

func handleRTPMulticastStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	req := rtpMulticastStartRequest{Address: defaultRTPMulticastAddress, TTL: defaultRTPMulticastTTL}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
	}
	if strings.TrimSpace(req.Address) == "" {
		req.Address = defaultRTPMulticastAddress
	}
	if req.TTL == 0 {
		req.TTL = defaultRTPMulticastTTL
	}

	status, err := startRTPMulticast(req.Address, req.TTL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeEnhancedRTPJSON(w, status)
}

func handleRTPMulticastStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeEnhancedRTPJSON(w, stopRTPMulticast())
}

func handleRTPMulticastStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	writeEnhancedRTPJSON(w, getRTPMulticastStatus())
}

func handleRTPMulticastSDP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	status := getRTPMulticastStatus()
	if !status.Running {
		http.Error(w, "RTP multicast is not running", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(buildRTPMulticastSDP(status)))
}

func writeEnhancedRTPJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(value)
}

func startRTPMulticast(address string, ttl int) (RTPMulticastStatus, error) {
	if ttl < 1 || ttl > 255 {
		return getRTPMulticastStatus(), fmt.Errorf("ttl must be between 1 and 255")
	}

	destination, err := net.ResolveUDPAddr("udp4", address)
	if err != nil {
		return getRTPMulticastStatus(), fmt.Errorf("resolve multicast address: %w", err)
	}
	if destination.IP == nil || !destination.IP.IsMulticast() || destination.IP.To4() == nil {
		return getRTPMulticastStatus(), fmt.Errorf("address must use an IPv4 multicast group")
	}
	if destination.Port <= 0 || destination.Port > 65535 {
		return getRTPMulticastStatus(), fmt.Errorf("invalid multicast port")
	}

	enhancedRTPMulticast.mu.Lock()
	if enhancedRTPMulticast.running {
		status := enhancedRTPMulticast.statusLocked()
		enhancedRTPMulticast.mu.Unlock()
		return status, fmt.Errorf("RTP multicast already running on %s", status.Address)
	}
	enhancedRTPMulticast.mu.Unlock()

	conn, err := net.DialUDP("udp4", nil, destination)
	if err != nil {
		return getRTPMulticastStatus(), fmt.Errorf("open multicast socket: %w", err)
	}
	if err := ipv4.NewPacketConn(conn).SetMulticastTTL(ttl); err != nil {
		_ = conn.Close()
		return getRTPMulticastStatus(), fmt.Errorf("set multicast ttl: %w", err)
	}

	codec := streamEncodecType
	var payloader rtp.Payloader
	if codec == "hevc" {
		payloader = &codecs.H265Payloader{SkipAggregation: true}
	} else {
		codec = "avc"
		payloader = &codecs.H264Payloader{DisableStapA: true}
	}

	ssrc := randomSSRC()
	packetizer := rtp.NewPacketizer(
		rtpVideoMTU,
		rtpVideoPayloadType,
		ssrc,
		payloader,
		rtp.NewRandomSequencer(),
		rtpVideoClockRate,
	)

	subscriberID, frames := videoBroadcaster.SubscribeBuffered(4)
	ctx, cancel := context.WithCancel(context.Background())

	enhancedRTPMulticast.mu.Lock()
	if enhancedRTPMulticast.running {
		enhancedRTPMulticast.mu.Unlock()
		cancel()
		videoBroadcaster.Unsubscribe(subscriberID)
		_ = conn.Close()
		return getRTPMulticastStatus(), fmt.Errorf("RTP multicast started concurrently")
	}
	enhancedRTPMulticast.running = true
	enhancedRTPMulticast.address = destination.String()
	enhancedRTPMulticast.ttl = ttl
	enhancedRTPMulticast.codec = codec
	enhancedRTPMulticast.ssrc = ssrc
	enhancedRTPMulticast.startedAt = time.Now()
	enhancedRTPMulticast.lastError = ""
	enhancedRTPMulticast.cancel = cancel
	enhancedRTPMulticast.conn = conn
	enhancedRTPMulticast.subscriberID = subscriberID
	enhancedRTPMulticast.packets.Store(0)
	enhancedRTPMulticast.bytes.Store(0)
	status := enhancedRTPMulticast.statusLocked()
	enhancedRTPMulticast.mu.Unlock()

	logger.Info().Str("address", status.Address).Int("ttl", ttl).Str("codec", codec).Uint32("ssrc", ssrc).Msg("RTP multicast started")
	go runRTPMulticast(ctx, subscriberID, frames, conn, packetizer, codec)
	return status, nil
}

func stopRTPMulticast() RTPMulticastStatus {
	enhancedRTPMulticast.mu.Lock()
	if !enhancedRTPMulticast.running {
		status := enhancedRTPMulticast.statusLocked()
		enhancedRTPMulticast.mu.Unlock()
		return status
	}

	cancel := enhancedRTPMulticast.cancel
	conn := enhancedRTPMulticast.conn
	subscriberID := enhancedRTPMulticast.subscriberID
	enhancedRTPMulticast.running = false
	enhancedRTPMulticast.cancel = nil
	enhancedRTPMulticast.conn = nil
	enhancedRTPMulticast.subscriberID = ""
	status := enhancedRTPMulticast.statusLocked()
	enhancedRTPMulticast.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if conn != nil {
		_ = conn.Close()
	}
	if subscriberID != "" {
		videoBroadcaster.Unsubscribe(subscriberID)
	}
	logger.Info().Str("address", status.Address).Msg("RTP multicast stopped")
	return status
}

func getRTPMulticastStatus() RTPMulticastStatus {
	enhancedRTPMulticast.mu.Lock()
	status := enhancedRTPMulticast.statusLocked()
	enhancedRTPMulticast.mu.Unlock()
	return status
}

func (s *rtpMulticastSender) statusLocked() RTPMulticastStatus {
	address := s.address
	if address == "" {
		address = defaultRTPMulticastAddress
	}
	ttl := s.ttl
	if ttl == 0 {
		ttl = defaultRTPMulticastTTL
	}
	codec := s.codec
	if codec == "" {
		codec = streamEncodecType
	}
	return RTPMulticastStatus{
		Running:     s.running,
		Address:     address,
		TTL:         ttl,
		Codec:       codec,
		PayloadType: rtpVideoPayloadType,
		SSRC:        s.ssrc,
		Packets:     s.packets.Load(),
		Bytes:       s.bytes.Load(),
		StartedAt:   s.startedAt,
		LastError:   s.lastError,
		SDPPath:     "/rtp.sdp",
		Subscribers: videoBroadcaster.SubscriberCount(),
	}
}

func runRTPMulticast(
	ctx context.Context,
	subscriberID string,
	frames <-chan *VideoFrame,
	conn *net.UDPConn,
	packetizer rtp.Packetizer,
	codec string,
) {
	defer func() {
		videoBroadcaster.Unsubscribe(subscriberID)
		finalizeRTPMulticast(subscriberID)
	}()

	lastFrameAt := time.Now()
	for {
		select {
		case <-ctx.Done():
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
				setRTPMulticastError(fmt.Sprintf("video codec changed from %s to %s; restart RTP multicast", codec, currentCodec))
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
					setRTPMulticastError(fmt.Sprintf("marshal RTP packet: %v", err))
					continue
				}
				if _, err := conn.Write(raw); err != nil {
					if ctx.Err() == nil {
						setRTPMulticastError(fmt.Sprintf("write RTP packet: %v", err))
					}
					return
				}
				enhancedRTPMulticast.packets.Add(1)
				enhancedRTPMulticast.bytes.Add(uint64(len(raw)))
			}
		}
	}
}

func finalizeRTPMulticast(subscriberID string) {
	enhancedRTPMulticast.mu.Lock()
	if enhancedRTPMulticast.subscriberID == subscriberID {
		if enhancedRTPMulticast.conn != nil {
			_ = enhancedRTPMulticast.conn.Close()
		}
		enhancedRTPMulticast.running = false
		enhancedRTPMulticast.cancel = nil
		enhancedRTPMulticast.conn = nil
		enhancedRTPMulticast.subscriberID = ""
	}
	enhancedRTPMulticast.mu.Unlock()
}

func setRTPMulticastError(message string) {
	enhancedRTPMulticast.mu.Lock()
	enhancedRTPMulticast.lastError = message
	enhancedRTPMulticast.mu.Unlock()
	logger.Warn().Str("error", message).Msg("RTP multicast error")
}

func randomSSRC() uint32 {
	var b [4]byte
	if _, err := cryptorand.Read(b[:]); err == nil {
		value := binary.BigEndian.Uint32(b[:])
		if value != 0 {
			return value
		}
	}
	value := uint32(time.Now().UnixNano())
	if value == 0 {
		return 1
	}
	return value
}

func buildRTPMulticastSDP(status RTPMulticastStatus) string {
	host, portString, err := net.SplitHostPort(status.Address)
	if err != nil {
		host = "239.255.42.42"
		portString = "5004"
	}
	port, err := strconv.Atoi(portString)
	if err != nil || port <= 0 {
		port = 5004
	}

	codecName := "H264"
	fmtp := "a=fmtp:96 packetization-mode=1\r\n"
	if status.Codec == "hevc" {
		codecName = "H265"
		fmtp = ""
	}

	return fmt.Sprintf(
		"v=0\r\n"+
			"o=- 0 0 IN IP4 127.0.0.1\r\n"+
			"s=PicoKVM Enhanced RTP\r\n"+
			"c=IN IP4 %s/%d\r\n"+
			"t=0 0\r\n"+
			"m=video %d RTP/AVP %d\r\n"+
			"a=rtpmap:%d %s/%d\r\n"+
			"%s"+
			"a=recvonly\r\n",
		host,
		status.TTL,
		port,
		status.PayloadType,
		status.PayloadType,
		codecName,
		rtpVideoClockRate,
		fmtp,
	)
}
