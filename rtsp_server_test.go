package kvm

import (
	"bufio"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRTSPTransportParam(t *testing.T) {
	transport := "RTP/AVP/TCP;unicast;interleaved=2-3;mode=play"
	require.Equal(t, "2-3", transportParam(transport, "interleaved"))
	require.Equal(t, "play", transportParam(transport, "MODE"))
	require.Empty(t, transportParam(transport, "client_port"))
}

func TestValidRTSPPath(t *testing.T) {
	valid := []string{
		"/live",
		"/live/",
		"live",
		"rtsp://192.0.2.10:8554/live",
		"rtsp://192.0.2.10:8554/live/",
	}
	for _, value := range valid {
		require.Truef(t, validRTSPPath(value), "expected valid path: %s", value)
	}

	invalid := []string{"/", "/other", "rtsp://192.0.2.10:8554/other", "/live2"}
	for _, value := range invalid {
		require.Falsef(t, validRTSPPath(value), "expected invalid path: %s", value)
	}
}

func TestBuildRTSPSDPH264(t *testing.T) {
	old := streamEncodecType
	streamEncodecType = "avc"
	t.Cleanup(func() { streamEncodecType = old })

	sdp := buildRTSPSDP()
	require.Contains(t, sdp, "m=video 0 RTP/AVP 96")
	require.Contains(t, sdp, "a=rtpmap:96 H264/90000")
	require.Contains(t, sdp, "a=fmtp:96 packetization-mode=1")
	require.Contains(t, sdp, "a=control:trackID=0")
}

func TestBuildRTSPSDPH265(t *testing.T) {
	old := streamEncodecType
	streamEncodecType = "hevc"
	t.Cleanup(func() { streamEncodecType = old })

	sdp := buildRTSPSDP()
	require.Contains(t, sdp, "a=rtpmap:96 H265/90000")
	require.NotContains(t, sdp, "packetization-mode=1")
}

func TestReadRTSPRequest(t *testing.T) {
	raw := "DESCRIBE rtsp://192.0.2.10:8554/live RTSP/1.0\r\n" +
		"CSeq: 7\r\n" +
		"Accept: application/sdp\r\n" +
		"Content-Length: 4\r\n" +
		"\r\n" +
		"test"

	req, err := readRTSPRequest(bufio.NewReader(strings.NewReader(raw)))
	require.NoError(t, err)
	require.Equal(t, "DESCRIBE", req.Method)
	require.Equal(t, "rtsp://192.0.2.10:8554/live", req.URI)
	require.Equal(t, "RTSP/1.0", req.Version)
	require.Equal(t, "7", req.Headers["cseq"])
	require.Equal(t, "application/sdp", req.Headers["accept"])
	require.Equal(t, []byte("test"), req.Body)
}

func TestEnsureRTSPBaseURI(t *testing.T) {
	require.Equal(t, "rtsp://192.0.2.10:8554/live/", ensureRTSPBaseURI("rtsp://192.0.2.10:8554/live"))
	require.Equal(t, "rtsp://192.0.2.10:8554/live/", ensureRTSPBaseURI("rtsp://192.0.2.10:8554/live/trackID=0"))
}
