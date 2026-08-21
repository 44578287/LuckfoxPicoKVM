package kvm

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const maxEnhancedWebRTCViewers int32 = 8

var enhancedViewerCount atomic.Int32

// viewerSession is intentionally video-only. It never creates HID/RPC/disk
// data channels and therefore cannot contend with the normal PicoKVM control
// session. Multiple viewer sessions can coexist and share the single hardware
// encoded stream through videoBroadcaster.
type viewerSession struct {
	pc      *webrtc.PeerConnection
	track   *webrtc.TrackLocalStaticSample
	mu      sync.Mutex
	subID   string
	started bool
	closed  bool
	cleanup sync.Once
}

type viewerOfferRequest struct {
	SD string `json:"sd"`
}

type viewerOfferResponse struct {
	SD      string `json:"sd"`
	Viewers int32  `json:"viewers"`
}

func StartViewerServer(port int) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", handleViewerPage)

	var offerHandler http.Handler = http.HandlerFunc(handleViewerOffer)
	var statusHandler http.Handler = http.HandlerFunc(handleViewerStatus)
	if config.APIKey != "" {
		offerHandler = withAPIKeyAuth(offerHandler, config.APIKey)
		statusHandler = withAPIKeyAuth(statusHandler, config.APIKey)
	}
	mux.Handle("/offer", offerHandler)
	mux.Handle("/status", statusHandler)
	registerRTPRoutes(mux)

	addr := fmt.Sprintf(":%d", port)
	logger.Info().Str("addr", addr).Int32("max_viewers", maxEnhancedWebRTCViewers).Msg("Starting enhanced read-only WebRTC viewer server")
	if err := http.ListenAndServe(addr, mux); err != nil {
		logger.Error().Err(err).Msg("Enhanced viewer server failed")
	}
}

func handleViewerStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"viewers":     enhancedViewerCount.Load(),
		"max_viewers": maxEnhancedWebRTCViewers,
		"subscribers": videoBroadcaster.SubscriberCount(),
		"codec":       streamEncodecType,
		"video":       lastVideoState,
	})
}

func handleViewerOffer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	if enhancedViewerCount.Load() >= maxEnhancedWebRTCViewers {
		http.Error(w, fmt.Sprintf("viewer limit reached (%d)", maxEnhancedWebRTCViewers), http.StatusTooManyRequests)
		return
	}

	var req viewerOfferRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.SD == "" {
		http.Error(w, "invalid offer", http.StatusBadRequest)
		return
	}

	answer, err := createViewerAnswer(req.SD)
	if err != nil {
		logger.Warn().Err(err).Msg("failed to create viewer WebRTC answer")
		status := http.StatusInternalServerError
		if err == errViewerLimitReached {
			status = http.StatusTooManyRequests
		}
		http.Error(w, err.Error(), status)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(viewerOfferResponse{SD: answer, Viewers: enhancedViewerCount.Load()})
}

var errViewerLimitReached = fmt.Errorf("viewer limit reached")

func reserveViewerSlot() bool {
	for {
		current := enhancedViewerCount.Load()
		if current >= maxEnhancedWebRTCViewers {
			return false
		}
		if enhancedViewerCount.CompareAndSwap(current, current+1) {
			return true
		}
	}
}

func createViewerAnswer(encodedOffer string) (string, error) {
	offerJSON, err := base64.StdEncoding.DecodeString(encodedOffer)
	if err != nil {
		return "", fmt.Errorf("decode viewer offer: %w", err)
	}

	var offer webrtc.SessionDescription
	if err := json.Unmarshal(offerJSON, &offer); err != nil {
		return "", fmt.Errorf("parse viewer offer: %w", err)
	}

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: buildICEServers()})
	if err != nil {
		return "", fmt.Errorf("create viewer peer connection: %w", err)
	}

	mimeType := webrtc.MimeTypeH264
	if streamEncodecType == "hevc" {
		mimeType = webrtc.MimeTypeH265
	}
	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: mimeType},
		"video",
		"picokvm-viewer",
	)
	if err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("create viewer video track: %w", err)
	}

	sender, err := pc.AddTrack(track)
	if err != nil {
		_ = pc.Close()
		return "", fmt.Errorf("add viewer video track: %w", err)
	}

	// Pion needs incoming RTCP to be consumed for feedback/NACK processing.
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, readErr := sender.Read(buf); readErr != nil {
				return
			}
		}
	}()

	if !reserveViewerSlot() {
		_ = pc.Close()
		return "", errViewerLimitReached
	}

	session := &viewerSession{pc: pc, track: track}
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		logger.Info().Str("state", state.String()).Int32("viewers", enhancedViewerCount.Load()).Msg("enhanced viewer WebRTC state changed")
		switch state {
		case webrtc.PeerConnectionStateConnected:
			session.start()
		case webrtc.PeerConnectionStateFailed:
			session.close()
			_ = pc.Close()
		case webrtc.PeerConnectionStateClosed:
			session.close()
		}
	})

	// Do not leave abandoned offers alive indefinitely if the browser never
	// completes ICE/DTLS after receiving the answer.
	go func() {
		timer := time.NewTimer(30 * time.Second)
		defer timer.Stop()
		<-timer.C
		state := pc.ConnectionState()
		if state != webrtc.PeerConnectionStateConnected && state != webrtc.PeerConnectionStateClosed {
			logger.Debug().Str("state", state.String()).Msg("closing stale enhanced viewer session")
			session.close()
			_ = pc.Close()
		}
	}()

	if err := pc.SetRemoteDescription(offer); err != nil {
		session.close()
		_ = pc.Close()
		return "", fmt.Errorf("set viewer remote description: %w", err)
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		session.close()
		_ = pc.Close()
		return "", fmt.Errorf("create viewer answer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		session.close()
		_ = pc.Close()
		return "", fmt.Errorf("set viewer local description: %w", err)
	}

	select {
	case <-gatherComplete:
	case <-time.After(5 * time.Second):
		logger.Warn().Msg("viewer ICE gathering timeout; returning available candidates")
	}

	local := pc.LocalDescription()
	if local == nil {
		session.close()
		_ = pc.Close()
		return "", fmt.Errorf("viewer local description unavailable")
	}
	answerJSON, err := json.Marshal(local)
	if err != nil {
		session.close()
		_ = pc.Close()
		return "", fmt.Errorf("marshal viewer answer: %w", err)
	}
	return base64.StdEncoding.EncodeToString(answerJSON), nil
}

func (s *viewerSession) start() {
	s.mu.Lock()
	if s.started || s.closed {
		s.mu.Unlock()
		return
	}
	id, ch := videoBroadcaster.SubscribeBuffered(defaultVideoSubscriberBuffer)
	s.subID = id
	s.started = true
	s.mu.Unlock()

	logger.Info().Str("subscriber_id", id).Msg("enhanced WebRTC viewer subscribed")
	go func() {
		lastFrameAt := time.Now()
		for frame := range ch {
			now := time.Now()
			duration := now.Sub(lastFrameAt)
			if duration <= 0 || duration > time.Second {
				duration = time.Second / 60
			}
			lastFrameAt = now

			err := s.track.WriteSample(media.Sample{Data: frame.Data(), Duration: duration})
			frame.Release()
			if err != nil {
				logger.Debug().Err(err).Str("subscriber_id", id).Msg("viewer video write failed")
				s.close()
				_ = s.pc.Close()
				return
			}
		}
	}()
}

func (s *viewerSession) close() {
	s.cleanup.Do(func() {
		s.mu.Lock()
		s.closed = true
		id := s.subID
		s.subID = ""
		s.started = false
		s.mu.Unlock()

		if id != "" {
			videoBroadcaster.Unsubscribe(id)
			logger.Info().Str("subscriber_id", id).Msg("enhanced WebRTC viewer unsubscribed")
		}
		enhancedViewerCount.Add(-1)
	})
}

func handleViewerPage(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(viewerHTML))
}

const viewerHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PicoKVM Enhanced Viewer</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#080b10;color:#e6edf3;font-family:system-ui,sans-serif}body{display:flex;flex-direction:column}.bar{display:flex;gap:8px;align-items:center;padding:10px 12px;background:#11161e;border-bottom:1px solid #263041}.bar strong{margin-right:auto}.bar input{min-width:260px;background:#080b10;color:#e6edf3;border:1px solid #344258;border-radius:6px;padding:7px 9px}.bar button{border:0;border-radius:6px;padding:8px 13px;background:#2f81f7;color:white;cursor:pointer}.status{font-size:12px;color:#8b949e}.stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}.stage video{width:100%;height:100%;object-fit:contain;background:#000}
</style>
</head>
<body>
<div class="bar"><strong>PicoKVM Enhanced · Viewer</strong><span id="status" class="status">Disconnected</span><input id="token" type="password" placeholder="API key"><button id="connect">Connect</button></div>
<div class="stage"><video id="video" autoplay playsinline muted></video></div>
<script>
const statusEl=document.getElementById('status');
const video=document.getElementById('video');
let pc;
function waitForIceGathering(p){if(p.iceGatheringState==='complete')return Promise.resolve();return new Promise(resolve=>{const f=()=>{if(p.iceGatheringState==='complete'){p.removeEventListener('icegatheringstatechange',f);resolve();}};p.addEventListener('icegatheringstatechange',f);setTimeout(resolve,5000);});}
function encodeSD(d){return btoa(JSON.stringify(d));}
function decodeSD(s){return JSON.parse(atob(s));}
document.getElementById('connect').onclick=async()=>{
  try{
    if(pc)pc.close();
    statusEl.textContent='Connecting…';
    pc=new RTCPeerConnection();
    pc.addTransceiver('video',{direction:'recvonly'});
    pc.ontrack=e=>{video.srcObject=e.streams[0]||new MediaStream([e.track]);};
    pc.onconnectionstatechange=()=>{statusEl.textContent=pc.connectionState;};
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const token=document.getElementById('token').value;
    const res=await fetch('/offer',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({sd:encodeSD(pc.localDescription)})});
    if(!res.ok)throw new Error(await res.text());
    const data=await res.json();
    await pc.setRemoteDescription(decodeSD(data.sd));
    statusEl.textContent=pc.connectionState+' · viewers '+data.viewers+'/'+8;
  }catch(e){statusEl.textContent='Error: '+e.message;if(pc)pc.close();}
};
</script>
</body>
</html>`
