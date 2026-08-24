package kvm

import (
	"strings"
	"testing"
)

func TestBuildRTPMulticastSDPH264(t *testing.T) {
	status := RTPMulticastStatus{
		Running:     true,
		Address:     "239.255.42.42:5004",
		TTL:         1,
		Codec:       "avc",
		PayloadType: 96,
	}

	sdp := buildRTPMulticastSDP(status)
	for _, expected := range []string{
		"c=IN IP4 239.255.42.42/1",
		"m=video 5004 RTP/AVP 96",
		"a=rtpmap:96 H264/90000",
		"a=fmtp:96 packetization-mode=1",
	} {
		if !strings.Contains(sdp, expected) {
			t.Fatalf("SDP missing %q:\n%s", expected, sdp)
		}
	}
}

func TestBuildRTPMulticastSDPH265(t *testing.T) {
	status := RTPMulticastStatus{
		Running:     true,
		Address:     "239.1.2.3:6000",
		TTL:         4,
		Codec:       "hevc",
		PayloadType: 96,
	}

	sdp := buildRTPMulticastSDP(status)
	for _, expected := range []string{
		"c=IN IP4 239.1.2.3/4",
		"m=video 6000 RTP/AVP 96",
		"a=rtpmap:96 H265/90000",
	} {
		if !strings.Contains(sdp, expected) {
			t.Fatalf("SDP missing %q:\n%s", expected, sdp)
		}
	}
	if strings.Contains(sdp, "packetization-mode=1") {
		t.Fatalf("H265 SDP unexpectedly contains H264 fmtp:\n%s", sdp)
	}
}

func TestStartRTPMulticastRejectsInvalidTTL(t *testing.T) {
	if _, err := startRTPMulticast(defaultRTPMulticastAddress, 0); err == nil {
		t.Fatal("expected TTL=0 to be rejected")
	}
	if _, err := startRTPMulticast(defaultRTPMulticastAddress, 256); err == nil {
		t.Fatal("expected TTL=256 to be rejected")
	}
}

func TestStartRTPMulticastRejectsUnicastAddress(t *testing.T) {
	if _, err := startRTPMulticast("127.0.0.1:5004", 1); err == nil {
		t.Fatal("expected unicast address to be rejected")
	}
}
