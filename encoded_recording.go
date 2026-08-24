package kvm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const recordingReserveBytes uint64 = 128 * 1024 * 1024

type EncodedRecordingStatus struct {
	Running   bool      `json:"running"`
	Filename  string    `json:"filename,omitempty"`
	Path      string    `json:"path,omitempty"`
	Codec     string    `json:"codec,omitempty"`
	StartedAt time.Time `json:"started_at,omitempty"`
	Frames    uint64    `json:"frames"`
	Bytes     uint64    `json:"bytes"`
	LastError string    `json:"last_error,omitempty"`
}

type encodedRecordingManager struct {
	mu           sync.Mutex
	running      bool
	filename     string
	path         string
	codec        string
	startedAt    time.Time
	file         *os.File
	subscriberID string
	stop         chan struct{}
	done         chan struct{}
	frames       atomic.Uint64
	bytes        atomic.Uint64
	lastError    string
}

var enhancedRecording encodedRecordingManager

func uniqueRecordingPath(filename string) (string, string, error) {
	fullPath := filepath.Join(imagesFolder, filename)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) { return filename, fullPath, nil } else if err != nil { return "", "", err }
	ext := filepath.Ext(filename)
	base := strings.TrimSuffix(filename, ext)
	for i := 1; i <= 9999; i++ {
		candidate := fmt.Sprintf("%s-%03d%s", base, i, ext)
		path := filepath.Join(imagesFolder, candidate)
		if _, err := os.Stat(path); os.IsNotExist(err) { return candidate, path, nil } else if err != nil { return "", "", err }
	}
	return "", "", fmt.Errorf("unable to allocate a unique recording filename for %s", filename)
}

func startEncodedRecording(filename string) (EncodedRecordingStatus, error) {
	enhancedRecording.mu.Lock()
	if enhancedRecording.running {
		status := enhancedRecording.statusLocked(); enhancedRecording.mu.Unlock()
		return status, fmt.Errorf("recording already running: %s", status.Filename)
	}
	enhancedRecording.mu.Unlock()
	if !lastVideoState.Ready { return getEncodedRecordingStatus(), fmt.Errorf("video input is not ready; recording was not started") }

	codec := streamEncodecType
	ext := ".h264"
	if codec == "hevc" { ext = ".h265"; codec = "hevc" } else { codec = "avc" }

	filename = strings.TrimSpace(filename)
	if filename == "" { filename = fmt.Sprintf("recording-%s%s", time.Now().Format("20060102-150405"), ext) }
	filename = filepath.Base(filename)
	if filename == "." || filename == string(filepath.Separator) || strings.Contains(filename, "..") { return getEncodedRecordingStatus(), fmt.Errorf("invalid recording filename") }
	if !strings.HasSuffix(strings.ToLower(filename), ext) { filename = strings.TrimSuffix(filename, filepath.Ext(filename)) + ext }

	if err := os.MkdirAll(imagesFolder, 0755); err != nil { return getEncodedRecordingStatus(), fmt.Errorf("create recording folder: %w", err) }
	var err error
	filename, fullPath, err := uniqueRecordingPath(filename)
	if err != nil { return getEncodedRecordingStatus(), fmt.Errorf("select recording filename: %w", err) }
	file, err := os.OpenFile(fullPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil { return getEncodedRecordingStatus(), fmt.Errorf("create recording %s: %w", filename, err) }

	if free, err := userdataFreeBytes(); err == nil && free < recordingReserveBytes {
		_ = file.Close(); _ = os.Remove(fullPath)
		return getEncodedRecordingStatus(), fmt.Errorf("not enough free space to start recording")
	}

	subscriberID, frames := videoBroadcaster.SubscribeBuffered(defaultVideoSubscriberBuffer)
	stop := make(chan struct{}); done := make(chan struct{}); firstFrame := make(chan struct{})

	enhancedRecording.mu.Lock()
	if enhancedRecording.running {
		enhancedRecording.mu.Unlock(); videoBroadcaster.Unsubscribe(subscriberID); _ = file.Close(); _ = os.Remove(fullPath)
		return getEncodedRecordingStatus(), fmt.Errorf("recording started concurrently")
	}
	enhancedRecording.running = true; enhancedRecording.filename = filename; enhancedRecording.path = fullPath; enhancedRecording.codec = codec
	enhancedRecording.startedAt = time.Now(); enhancedRecording.file = file; enhancedRecording.subscriberID = subscriberID
	enhancedRecording.stop = stop; enhancedRecording.done = done; enhancedRecording.lastError = ""
	enhancedRecording.frames.Store(0); enhancedRecording.bytes.Store(0)
	enhancedRecording.mu.Unlock()

	logger.Info().Str("filename", filename).Str("codec", codec).Msg("encoded recording starting; waiting for first frame")
	go runEncodedRecording(file, subscriberID, frames, stop, done, codec, firstFrame)

	select {
	case <-firstFrame:
		status := getEncodedRecordingStatus()
		logger.Info().Str("filename", filename).Uint64("bytes", status.Bytes).Msg("encoded recording first frame committed")
		return status, nil
	case <-done:
		status := getEncodedRecordingStatus()
		if status.LastError == "" { status.LastError = "recording stopped before first frame" }
		if status.Bytes == 0 { _ = os.Remove(fullPath) }
		return status, fmt.Errorf("recording failed before first frame: %s", status.LastError)
	case <-time.After(1500 * time.Millisecond):
		status := stopEncodedRecording()
		if status.Bytes == 0 { _ = os.Remove(fullPath) }
		setEncodedRecordingError("recording start timed out waiting for first encoded frame")
		return getEncodedRecordingStatus(), fmt.Errorf("recording start timed out waiting for first encoded frame")
	}
}

func stopEncodedRecording() EncodedRecordingStatus {
	enhancedRecording.mu.Lock()
	if !enhancedRecording.running { status := enhancedRecording.statusLocked(); enhancedRecording.mu.Unlock(); return status }
	stop := enhancedRecording.stop; done := enhancedRecording.done; enhancedRecording.stop = nil
	enhancedRecording.mu.Unlock()
	if stop != nil { close(stop) }
	if done != nil { <-done }
	status := getEncodedRecordingStatus()
	logger.Info().Str("filename", status.Filename).Uint64("bytes", status.Bytes).Msg("encoded recording stopped")
	return status
}

func getEncodedRecordingStatus() EncodedRecordingStatus {
	enhancedRecording.mu.Lock(); status := enhancedRecording.statusLocked(); enhancedRecording.mu.Unlock(); return status
}

func (m *encodedRecordingManager) statusLocked() EncodedRecordingStatus {
	return EncodedRecordingStatus{Running:m.running, Filename:m.filename, Path:m.path, Codec:m.codec, StartedAt:m.startedAt, Frames:m.frames.Load(), Bytes:m.bytes.Load(), LastError:m.lastError}
}

func runEncodedRecording(file *os.File, subscriberID string, frames <-chan *VideoFrame, stop <-chan struct{}, done chan struct{}, codec string, firstFrame chan struct{}) {
	defer finalizeEncodedRecording(subscriberID, file, done)
	firstCommitted := false
	for {
		select { case <-stop: return; default: }
		select {
		case <-stop: return
		case frame, ok := <-frames:
			if !ok { return }
			currentCodec := streamEncodecType; if currentCodec == "" { currentCodec = "avc" }
			if currentCodec != codec { frame.Release(); setEncodedRecordingError(fmt.Sprintf("video codec changed from %s to %s; recording stopped", codec, currentCodec)); return }
			data := frame.Data(); n, err := file.Write(data); frame.Release()
			if err != nil { setEncodedRecordingError(fmt.Sprintf("write recording: %v", err)); return }
			enhancedRecording.frames.Add(1); enhancedRecording.bytes.Add(uint64(n))
			if !firstCommitted { firstCommitted = true; close(firstFrame) }
			if enhancedRecording.frames.Load()%120 == 0 {
				if free, freeErr := userdataFreeBytes(); freeErr == nil && free < recordingReserveBytes { setEncodedRecordingError("recording stopped: free space reserve reached"); return }
			}
		}
	}
}

func finalizeEncodedRecording(subscriberID string, file *os.File, done chan struct{}) {
	videoBroadcaster.Unsubscribe(subscriberID); _ = file.Sync(); _ = file.Close()
	enhancedRecording.mu.Lock()
	if enhancedRecording.subscriberID == subscriberID { enhancedRecording.running=false; enhancedRecording.subscriberID=""; enhancedRecording.stop=nil; enhancedRecording.done=nil; enhancedRecording.file=nil }
	enhancedRecording.mu.Unlock(); close(done)
}

func setEncodedRecordingError(message string) { enhancedRecording.mu.Lock(); enhancedRecording.lastError=message; enhancedRecording.mu.Unlock(); logger.Warn().Str("error", message).Msg("encoded recording stopped") }

func userdataFreeBytes() (uint64, error) { var stat syscall.Statfs_t; if err:=syscall.Statfs("/userdata", &stat); err!=nil{return 0,err}; return stat.Bavail*uint64(stat.Bsize),nil }
