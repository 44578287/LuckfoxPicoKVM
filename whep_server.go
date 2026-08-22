package kvm

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

const (
	defaultWHEPPort        = 8083
	maxWHEPOfferBytes int64 = 1024 * 1024
)

var whepRunning atomic.Bool

type WHEPServerStatus struct {
	Running    bool   `json:"running"`
	Endpoint   string `json:"endpoint"`
	Codec      string `json:"codec"`
	Viewers    int32  `json:"viewers"`
	MaxViewers int32  `json:"max_viewers"`
}

// StartWHEPServer exposes the existing read-only WebRTC viewer as a standard
// synchronous WHEP source. go2rtc/Frigate/HA relays can therefore consume the
// same RV1106 hardware-encoded stream without the custom browser signaling API
// or an RTSP buffering stage.
func StartWHEPServer(port int) {
	if port == 0 {
		port = defaultWHEPPort
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/whep", handleWHEP)
	mux.HandleFunc("/status", handleWHEPStatus)

	addr := fmt.Sprintf(":%d", port)
	whepRunning.Store(true)
	logger.Info().Str("addr", addr).Str("endpoint", "/whep").Msg("Starting enhanced WHEP WebRTC source")
	if err := http.ListenAndServe(addr, mux); err != nil {
		whepRunning.Store(false)
		logger.Error().Err(err).Msg("Enhanced WHEP server failed")
	}
}

func getWHEPServerStatus() WHEPServerStatus {
	codec := streamEncodecType
	if codec == "" {
		codec = "avc"
	}
	return WHEPServerStatus{
		Running:    whepRunning.Load(),
		Endpoint:   "/whep",
		Codec:      codec,
		Viewers:    enhancedViewerCount.Load(),
		MaxViewers: maxEnhancedWebRTCViewers,
	}
}

func handleWHEPStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		writeWHEPCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !whepAuthorized(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="PicoKVM Enhanced WHEP"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	writeWHEPCORS(w)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(getWHEPServerStatus())
}

func handleWHEP(w http.ResponseWriter, r *http.Request) {
	writeWHEPCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !whepAuthorized(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="PicoKVM Enhanced WHEP"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxWHEPOfferBytes+1))
	if err != nil {
		http.Error(w, "failed to read SDP offer", http.StatusBadRequest)
		return
	}
	if len(body) == 0 {
		http.Error(w, "empty SDP offer", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > maxWHEPOfferBytes {
		http.Error(w, "SDP offer too large", http.StatusRequestEntityTooLarge)
		return
	}

	answer, err := createWHEPAnswer(string(body))
	if err != nil {
		logger.Warn().Err(err).Msg("failed to create WHEP answer")
		status := http.StatusBadRequest
		if err == errViewerLimitReached {
			status = http.StatusTooManyRequests
		}
		http.Error(w, err.Error(), status)
		return
	}

	// go2rtc accepts both 200 and 201 WHEP responses. Return 201 and a Location
	// header as specified by WHEP while keeping the connection lifetime tied to
	// the underlying PeerConnection state managed by viewerSession.
	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Location", "/whep")
	w.WriteHeader(http.StatusCreated)
	_, _ = io.WriteString(w, answer)
}

func writeWHEPCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
}

func whepAuthorized(r *http.Request) bool {
	if strings.HasPrefix(r.RemoteAddr, "127.0.0.1:") || strings.HasPrefix(r.RemoteAddr, "[::1]:") {
		return true
	}
	if config == nil || config.APIKey == "" {
		return true
	}

	if _, password, ok := r.BasicAuth(); ok && password == config.APIKey {
		return true
	}
	const bearerPrefix = "Bearer "
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(auth) > len(bearerPrefix) && strings.EqualFold(auth[:len(bearerPrefix)], bearerPrefix) {
		return strings.TrimSpace(auth[len(bearerPrefix):]) == config.APIKey
	}
	return false
}

func createWHEPAnswer(rawOffer string) (string, error) {
	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: rawOffer}
	offerJSON, err := json.Marshal(offer)
	if err != nil {
		return "", fmt.Errorf("marshal WHEP offer: %w", err)
	}

	encodedAnswer, err := createViewerAnswer(base64.StdEncoding.EncodeToString(offerJSON))
	if err != nil {
		return "", err
	}
	answerJSON, err := base64.StdEncoding.DecodeString(encodedAnswer)
	if err != nil {
		return "", fmt.Errorf("decode WHEP answer: %w", err)
	}
	var answer webrtc.SessionDescription
	if err := json.Unmarshal(answerJSON, &answer); err != nil {
		return "", fmt.Errorf("parse WHEP answer: %w", err)
	}
	if answer.Type != webrtc.SDPTypeAnswer || strings.TrimSpace(answer.SDP) == "" {
		return "", fmt.Errorf("invalid WHEP answer")
	}
	return answer.SDP, nil
}
