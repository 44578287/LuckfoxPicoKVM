package kvm

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/gwatts/rootcerts"
)

const (
	enhancedMQTTConfigPath    = "/userdata/picokvm/enhanced_mqtt.json"
	enhancedMQTTPasswordMask  = "********"
	enhancedMQTTPublishWait   = 5 * time.Second
	enhancedMQTTUpdatePeriod  = 10 * time.Second
	enhancedMQTTDefaultPort   = 1883
	enhancedMQTTDefaultTopic  = "picokvm"
	enhancedMQTTDiscoveryRoot = "homeassistant"
)

// EnhancedMQTTConfig is intentionally stored separately from the vendor
// PicoKVM configuration. This keeps the enhanced HA integration easy to remove
// or merge while avoiding unnecessary churn in upstream config migrations.
type EnhancedMQTTConfig struct {
	Enabled           bool   `json:"enabled"`
	Broker            string `json:"broker"`
	Port              int    `json:"port"`
	Username          string `json:"username"`
	Password          string `json:"password"`
	BaseTopic         string `json:"base_topic"`
	UseTLS            bool   `json:"use_tls"`
	TLSInsecure       bool   `json:"tls_insecure"`
	EnableHADiscovery bool   `json:"enable_ha_discovery"`
	EnableActions     bool   `json:"enable_actions"`
}

type EnhancedMQTTStatus struct {
	Connected bool   `json:"connected"`
	Error     string `json:"error,omitempty"`
	BaseTopic string `json:"base_topic,omitempty"`
}

type EnhancedMQTTTestResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type enhancedMQTTManager struct {
	client     mqtt.Client
	cfg        EnhancedMQTTConfig
	deviceID   string
	baseTopic  string
	stop       chan struct{}
	closeOnce  sync.Once
	stateMu    sync.RWMutex
	lastError  string
	connected  bool
}

var (
	enhancedMQTTGlobalMu sync.Mutex
	enhancedMQTT         *enhancedMQTTManager
)

func init() {
	rpcHandlers["getEnhancedMQTTSettings"] = RPCHandler{Func: rpcGetEnhancedMQTTSettings}
	rpcHandlers["setEnhancedMQTTSettings"] = RPCHandler{Func: rpcSetEnhancedMQTTSettings, Params: []string{"settings"}}
	rpcHandlers["getEnhancedMQTTStatus"] = RPCHandler{Func: rpcGetEnhancedMQTTStatus}
	rpcHandlers["testEnhancedMQTTConnection"] = RPCHandler{Func: rpcTestEnhancedMQTTConnection, Params: []string{"settings"}}
}

func defaultEnhancedMQTTConfig() EnhancedMQTTConfig {
	return EnhancedMQTTConfig{
		Port:              enhancedMQTTDefaultPort,
		BaseTopic:         enhancedMQTTDefaultTopic,
		EnableHADiscovery: true,
		EnableActions:     false,
	}
}

func normalizeEnhancedMQTTConfig(cfg EnhancedMQTTConfig) (EnhancedMQTTConfig, error) {
	cfg.Broker = strings.TrimSpace(cfg.Broker)
	cfg.BaseTopic = strings.Trim(strings.TrimSpace(cfg.BaseTopic), "/")
	if cfg.Port == 0 {
		if cfg.UseTLS {
			cfg.Port = 8883
		} else {
			cfg.Port = enhancedMQTTDefaultPort
		}
	}
	if cfg.BaseTopic == "" {
		cfg.BaseTopic = enhancedMQTTDefaultTopic
	}
	if cfg.Enabled && cfg.Broker == "" {
		return cfg, fmt.Errorf("MQTT broker address is required")
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return cfg, fmt.Errorf("MQTT port must be between 1 and 65535")
	}
	if strings.ContainsAny(cfg.BaseTopic, "+#") || strings.Contains(cfg.BaseTopic, " ") {
		return cfg, fmt.Errorf("MQTT base topic cannot contain spaces or wildcards (+/#)")
	}
	return cfg, nil
}

func loadEnhancedMQTTConfig() EnhancedMQTTConfig {
	cfg := defaultEnhancedMQTTConfig()
	data, err := os.ReadFile(enhancedMQTTConfigPath)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn().Err(err).Str("path", enhancedMQTTConfigPath).Msg("failed to read enhanced MQTT config")
		}
		return cfg
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		logger.Warn().Err(err).Str("path", enhancedMQTTConfigPath).Msg("failed to parse enhanced MQTT config")
		return defaultEnhancedMQTTConfig()
	}
	normalized, err := normalizeEnhancedMQTTConfig(cfg)
	if err != nil {
		logger.Warn().Err(err).Msg("enhanced MQTT config is invalid")
		return cfg
	}
	return normalized
}

func saveEnhancedMQTTConfig(cfg EnhancedMQTTConfig) error {
	cfg, err := normalizeEnhancedMQTTConfig(cfg)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(enhancedMQTTConfigPath), 0o755); err != nil {
		return fmt.Errorf("create enhanced config directory: %w", err)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := enhancedMQTTConfigPath + ".new"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write enhanced MQTT config: %w", err)
	}
	if err := os.Rename(tmp, enhancedMQTTConfigPath); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace enhanced MQTT config: %w", err)
	}
	return nil
}

func enhancedMQTTBrokerURL(cfg EnhancedMQTTConfig) string {
	scheme := "tcp"
	if cfg.UseTLS {
		scheme = "ssl"
	}
	return fmt.Sprintf("%s://%s:%d", scheme, cfg.Broker, cfg.Port)
}

func newEnhancedMQTTClientOptions(cfg EnhancedMQTTConfig, clientID string) *mqtt.ClientOptions {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(enhancedMQTTBrokerURL(cfg))
	opts.SetClientID(clientID)
	opts.SetUsername(cfg.Username)
	opts.SetPassword(cfg.Password)
	opts.SetConnectTimeout(8 * time.Second)
	if cfg.UseTLS {
		tlsConfig := &tls.Config{InsecureSkipVerify: cfg.TLSInsecure} //nolint:gosec -- explicit user option
		if !cfg.TLSInsecure {
			tlsConfig.RootCAs = rootcerts.ServerCertPool()
		}
		opts.SetTLSConfig(tlsConfig)
	}
	return opts
}

func initEnhancedMQTT() {
	cfg := loadEnhancedMQTTConfig()
	if !cfg.Enabled {
		logger.Info().Msg("Enhanced MQTT/Home Assistant integration disabled")
		return
	}
	if err := startEnhancedMQTT(cfg); err != nil {
		logger.Warn().Err(err).Msg("failed to start Enhanced MQTT/Home Assistant integration")
	}
}

func startEnhancedMQTT(cfg EnhancedMQTTConfig) error {
	cfg, err := normalizeEnhancedMQTTConfig(cfg)
	if err != nil {
		return err
	}
	if !cfg.Enabled {
		return nil
	}

	deviceID := strings.TrimSpace(GetDeviceID())
	if deviceID == "" {
		deviceID = "device"
	}
	baseTopic := strings.TrimSuffix(cfg.BaseTopic, "/") + "/" + deviceID
	m := &enhancedMQTTManager{
		cfg:       cfg,
		deviceID:  deviceID,
		baseTopic: baseTopic,
		stop:      make(chan struct{}),
	}

	opts := newEnhancedMQTTClientOptions(cfg, "picokvm-"+sanitizeHAID(deviceID))
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(10 * time.Second)
	opts.SetCleanSession(false)
	opts.SetWill(m.topic("status"), "offline", 1, true)
	opts.OnConnect = func(_ mqtt.Client) {
		m.setConnectionState(true, "")
		logger.Info().Str("broker", enhancedMQTTBrokerURL(cfg)).Str("base_topic", baseTopic).Msg("Enhanced MQTT connected")
		m.publishString(m.topic("status"), "online", true)
		if cfg.EnableHADiscovery {
			m.publishHADiscovery()
		}
		m.subscribeCommands()
		m.publishAllStates()
	}
	opts.OnConnectionLost = func(_ mqtt.Client, lostErr error) {
		m.setConnectionState(false, lostErr.Error())
		logger.Warn().Err(lostErr).Msg("Enhanced MQTT connection lost")
	}
	m.client = mqtt.NewClient(opts)

	enhancedMQTTGlobalMu.Lock()
	old := enhancedMQTT
	enhancedMQTT = m
	enhancedMQTTGlobalMu.Unlock()
	if old != nil {
		old.close()
	}

	token := m.client.Connect()
	go func() {
		if !token.WaitTimeout(9 * time.Second) {
			m.setConnectionState(false, "initial MQTT connection timed out; retrying")
			return
		}
		if token.Error() != nil {
			m.setConnectionState(false, token.Error().Error())
			logger.Warn().Err(token.Error()).Msg("initial Enhanced MQTT connection failed; automatic retry remains enabled")
		}
	}()
	go m.periodicStateLoop()
	return nil
}

func closeEnhancedMQTT() {
	enhancedMQTTGlobalMu.Lock()
	m := enhancedMQTT
	enhancedMQTT = nil
	enhancedMQTTGlobalMu.Unlock()
	if m != nil {
		m.close()
	}
}

func restartEnhancedMQTT(cfg EnhancedMQTTConfig) error {
	closeEnhancedMQTT()
	if !cfg.Enabled {
		return nil
	}
	return startEnhancedMQTT(cfg)
}

func (m *enhancedMQTTManager) close() {
	m.closeOnce.Do(func() {
		close(m.stop)
		if m.client != nil && m.client.IsConnected() {
			m.publishString(m.topic("status"), "offline", true)
			m.client.Disconnect(500)
		}
		m.setConnectionState(false, "")
	})
}

func (m *enhancedMQTTManager) setConnectionState(connected bool, errText string) {
	m.stateMu.Lock()
	m.connected = connected
	m.lastError = errText
	m.stateMu.Unlock()
}

func (m *enhancedMQTTManager) status() EnhancedMQTTStatus {
	m.stateMu.RLock()
	defer m.stateMu.RUnlock()
	connected := m.connected
	if m.client != nil {
		connected = connected && m.client.IsConnected()
	}
	return EnhancedMQTTStatus{Connected: connected, Error: m.lastError, BaseTopic: m.baseTopic}
}

func (m *enhancedMQTTManager) topic(parts ...string) string {
	if len(parts) == 0 {
		return m.baseTopic
	}
	return m.baseTopic + "/" + strings.Join(parts, "/")
}

func (m *enhancedMQTTManager) publishString(topic, payload string, retained bool) {
	if m.client == nil || !m.client.IsConnected() {
		return
	}
	token := m.client.Publish(topic, 1, retained, payload)
	if !token.WaitTimeout(enhancedMQTTPublishWait) {
		logger.Warn().Str("topic", topic).Msg("Enhanced MQTT publish timed out")
		return
	}
	if token.Error() != nil {
		logger.Warn().Err(token.Error()).Str("topic", topic).Msg("Enhanced MQTT publish failed")
	}
}

func (m *enhancedMQTTManager) publishJSON(topic string, value interface{}, retained bool) {
	data, err := json.Marshal(value)
	if err != nil {
		logger.Warn().Err(err).Str("topic", topic).Msg("Enhanced MQTT JSON encode failed")
		return
	}
	m.publishString(topic, string(data), retained)
}

func (m *enhancedMQTTManager) periodicStateLoop() {
	ticker := time.NewTicker(enhancedMQTTUpdatePeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			m.publishAllStates()
		case <-m.stop:
			return
		}
	}
}

func (m *enhancedMQTTManager) publishAllStates() {
	if m.client == nil || !m.client.IsConnected() {
		return
	}

	stream := getEnhancedStreamStatus()
	rtsp := getRTSPServerStatus()
	m.publishJSON(m.topic("video", "state"), map[string]interface{}{
		"ready":               stream.Video.Ready,
		"width":               stream.Video.Width,
		"height":              stream.Video.Height,
		"fps":                 stream.Video.FramePerSecond,
		"codec":               stream.Codec,
		"controller_active":   stream.ControllerActive,
		"webrtc_sessions":     stream.WebRTCSessions,
		"viewers":             stream.ReadOnlyViewers,
		"fanout_subscribers":  stream.RawSubscribers,
		"rtsp_clients":        rtsp.Clients,
	}, true)

	m.publishJSON(m.topic("rtp", "state"), getRTPMulticastStatus(), true)
	m.publishJSON(m.topic("recording", "state"), getEncodedRecordingStatus(), true)
	m.publishJSON(m.topic("usb", "state"), map[string]interface{}{"state": rpcGetUSBState()}, true)

	if host, err := rpcGetIOInputStatus(); err == nil {
		m.publishJSON(m.topic("host", "state"), host, true)
	}
	if media, err := rpcGetVirtualMediaState(); err == nil {
		payload := map[string]interface{}{"mounted": media != nil}
		if media != nil {
			payload["source"] = media.Source
			payload["mode"] = media.Mode
			payload["filename"] = media.Filename
			payload["url"] = media.URL
			payload["size"] = media.Size
		}
		m.publishJSON(m.topic("virtual_media", "state"), payload, true)
	}
	m.publishJSON(m.topic("system", "state"), readEnhancedMQTTSystemState(), true)
}

func readEnhancedMQTTSystemState() map[string]interface{} {
	state := map[string]interface{}{}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) >= 3 {
			state["load_1m"], _ = strconv.ParseFloat(fields[0], 64)
			state["load_5m"], _ = strconv.ParseFloat(fields[1], 64)
			state["load_15m"], _ = strconv.ParseFloat(fields[2], 64)
		}
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			kb, err := strconv.ParseUint(fields[1], 10, 64)
			if err != nil {
				continue
			}
			switch strings.TrimSuffix(fields[0], ":") {
			case "MemTotal":
				state["memory_total"] = kb * 1024
			case "MemAvailable":
				state["memory_available"] = kb * 1024
			}
		}
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs("/userdata", &stat); err == nil {
		state["storage_total"] = stat.Blocks * uint64(stat.Bsize)
		state["storage_free"] = stat.Bavail * uint64(stat.Bsize)
	}
	if temp, ok := readSoCTemperatureC(); ok {
		state["temperature"] = temp
	}
	return state
}

func readSoCTemperatureC() (float64, bool) {
	paths, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
		if err != nil {
			continue
		}
		if value > 1000 {
			value /= 1000
		}
		if value > -20 && value < 150 {
			return value, true
		}
	}
	return 0, false
}

func sanitizeHAID(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	return strings.Trim(b.String(), "_")
}

func (m *enhancedMQTTManager) haDevice() map[string]interface{} {
	name := "PicoKVM"
	if hostname, err := os.Hostname(); err == nil && strings.TrimSpace(hostname) != "" {
		name = "PicoKVM " + strings.TrimSpace(hostname)
	}
	return map[string]interface{}{
		"identifiers":   []string{"picokvm_" + m.deviceID},
		"name":          name,
		"manufacturer":  "Luckfox",
		"model":         "PicoKVM Enhanced",
		"sw_version":    builtAppVersion,
		"serial_number": m.deviceID,
	}
}

func (m *enhancedMQTTManager) discoveryTopic(component, objectID string) string {
	return fmt.Sprintf("%s/%s/picokvm_%s/%s/config", enhancedMQTTDiscoveryRoot, component, sanitizeHAID(m.deviceID), objectID)
}

func (m *enhancedMQTTManager) publishDiscovery(component, objectID, name string, extra map[string]interface{}) {
	payload := map[string]interface{}{
		"name":              name,
		"unique_id":         fmt.Sprintf("picokvm_%s_%s", sanitizeHAID(m.deviceID), objectID),
		"availability_topic": m.topic("status"),
		"payload_available": "online",
		"payload_not_available": "offline",
		"device":            m.haDevice(),
	}
	for k, v := range extra {
		payload[k] = v
	}
	m.publishJSON(m.discoveryTopic(component, objectID), payload, true)
}

func (m *enhancedMQTTManager) publishHADiscovery() {
	videoState := m.topic("video", "state")
	systemState := m.topic("system", "state")
	hostState := m.topic("host", "state")
	recordingState := m.topic("recording", "state")
	rtpState := m.topic("rtp", "state")

	m.publishDiscovery("binary_sensor", "online", "Online", map[string]interface{}{
		"state_topic": m.topic("status"), "payload_on": "online", "payload_off": "offline", "device_class": "connectivity",
	})
	m.publishDiscovery("binary_sensor", "hdmi_signal", "HDMI Signal", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ 'ON' if value_json.ready else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "device_class": "connectivity", "icon": "mdi:video-input-hdmi",
	})
	m.publishDiscovery("sensor", "video_resolution", "Video Resolution", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ value_json.width }}x{{ value_json.height }}", "icon": "mdi:monitor", "entity_category": "diagnostic",
	})
	m.publishDiscovery("sensor", "video_fps", "Video FPS", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ value_json.fps | round(1) }}", "unit_of_measurement": "fps", "state_class": "measurement", "icon": "mdi:speedometer", "entity_category": "diagnostic",
	})
	m.publishDiscovery("sensor", "video_codec", "Video Codec", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ value_json.codec | upper }}", "icon": "mdi:video-wireless", "entity_category": "diagnostic",
	})
	m.publishDiscovery("binary_sensor", "controller_active", "KVM Controller", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ 'ON' if value_json.controller_active else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "icon": "mdi:mouse",
	})
	m.publishDiscovery("sensor", "viewers", "Read-only Viewers", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ value_json.viewers }}", "icon": "mdi:account-multiple", "state_class": "measurement",
	})
	m.publishDiscovery("sensor", "fanout_subscribers", "Video Fan-out Subscribers", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ value_json.fanout_subscribers }}", "icon": "mdi:lan-connect", "state_class": "measurement", "entity_category": "diagnostic",
	})
	m.publishDiscovery("sensor", "rtsp_clients", "RTSP Clients", map[string]interface{}{
		"state_topic": videoState, "value_template": "{{ value_json.rtsp_clients }}", "icon": "mdi:cctv", "state_class": "measurement",
	})
	m.publishDiscovery("binary_sensor", "usb_connected", "USB Connected", map[string]interface{}{
		"state_topic": m.topic("usb", "state"), "value_template": "{{ 'ON' if value_json.state == 'configured' else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "device_class": "connectivity", "icon": "mdi:usb",
	})
	m.publishDiscovery("binary_sensor", "host_power_led", "Host Power LED", map[string]interface{}{
		"state_topic": hostState, "value_template": "{{ 'ON' if value_json.powerLed else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "icon": "mdi:power",
	})
	m.publishDiscovery("binary_sensor", "host_hdd_led", "Host HDD LED", map[string]interface{}{
		"state_topic": hostState, "value_template": "{{ 'ON' if value_json.hddLed else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "icon": "mdi:harddisk",
	})
	m.publishDiscovery("sensor", "load_1m", "Load Average 1m", map[string]interface{}{
		"state_topic": systemState, "value_template": "{{ value_json.load_1m | round(2) }}", "state_class": "measurement", "icon": "mdi:chip", "entity_category": "diagnostic",
	})
	m.publishDiscovery("sensor", "memory_available", "Memory Available", map[string]interface{}{
		"state_topic": systemState, "value_template": "{{ (value_json.memory_available / 1048576) | round(1) }}", "unit_of_measurement": "MB", "state_class": "measurement", "icon": "mdi:memory", "entity_category": "diagnostic",
	})
	m.publishDiscovery("sensor", "storage_free", "Storage Free", map[string]interface{}{
		"state_topic": systemState, "value_template": "{{ (value_json.storage_free / 1048576) | round(1) }}", "unit_of_measurement": "MB", "state_class": "measurement", "device_class": "data_size", "entity_category": "diagnostic",
	})
	m.publishDiscovery("sensor", "temperature", "SoC Temperature", map[string]interface{}{
		"state_topic": systemState, "value_template": "{{ value_json.temperature | default(0) | round(1) }}", "unit_of_measurement": "°C", "state_class": "measurement", "device_class": "temperature", "entity_category": "diagnostic",
	})
	m.publishDiscovery("binary_sensor", "recording", "Recording", map[string]interface{}{
		"state_topic": recordingState, "value_template": "{{ 'ON' if value_json.running else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "icon": "mdi:record-rec",
	})
	m.publishDiscovery("binary_sensor", "rtp_multicast", "RTP Multicast", map[string]interface{}{
		"state_topic": rtpState, "value_template": "{{ 'ON' if value_json.running else 'OFF' }}", "payload_on": "ON", "payload_off": "OFF", "icon": "mdi:access-point-network",
	})
	m.publishDiscovery("sensor", "virtual_media", "Virtual Media", map[string]interface{}{
		"state_topic": m.topic("virtual_media", "state"), "value_template": "{{ value_json.filename if value_json.mounted and value_json.filename else ('Remote URL' if value_json.mounted else 'Unmounted') }}", "icon": "mdi:disc",
	})

	if !m.cfg.EnableActions {
		return
	}
	buttons := []struct {
		id, name, icon string
	}{
		{"host_power", "Host Power Button", "mdi:power"},
		{"host_reset", "Host Reset Button", "mdi:restart"},
		{"usb_wakeup", "USB Wake", "mdi:usb"},
		{"usb_reinitialize", "USB Reinitialize", "mdi:usb-flash-drive-outline"},
		{"recording_start", "Start Recording", "mdi:record-rec"},
		{"recording_stop", "Stop Recording", "mdi:stop"},
		{"rtp_start", "Start RTP Multicast", "mdi:broadcast"},
		{"rtp_stop", "Stop RTP Multicast", "mdi:broadcast-off"},
		{"virtual_media_unmount", "Unmount Virtual Media", "mdi:eject"},
		{"key_enter", "Key Enter", "mdi:keyboard-return"},
		{"key_escape", "Key Escape", "mdi:keyboard-esc"},
		{"key_f2", "Key F2", "mdi:keyboard"},
		{"key_f12", "Key F12", "mdi:keyboard"},
		{"key_ctrl_alt_delete", "Ctrl+Alt+Delete", "mdi:keyboard"},
		{"reboot_picokvm", "Reboot PicoKVM", "mdi:restart-alert"},
	}
	for _, b := range buttons {
		m.publishDiscovery("button", b.id, b.name, map[string]interface{}{
			"command_topic": m.topic("command", b.id), "payload_press": "PRESS", "icon": b.icon,
		})
	}
}

func (m *enhancedMQTTManager) subscribeCommands() {
	if !m.cfg.EnableActions || m.client == nil || !m.client.IsConnected() {
		return
	}
	topic := m.topic("command", "+")
	token := m.client.Subscribe(topic, 1, func(_ mqtt.Client, msg mqtt.Message) {
		if strings.TrimSpace(string(msg.Payload())) != "PRESS" {
			return
		}
		action := msg.Topic()[strings.LastIndex(msg.Topic(), "/")+1:]
		if err := executeEnhancedMQTTAction(action); err != nil {
			logger.Warn().Err(err).Str("action", action).Msg("Home Assistant MQTT action failed")
		} else {
			logger.Info().Str("action", action).Msg("Home Assistant MQTT action executed")
			m.publishAllStates()
		}
	})
	if !token.WaitTimeout(5 * time.Second) {
		logger.Warn().Str("topic", topic).Msg("Enhanced MQTT command subscribe timed out")
	} else if token.Error() != nil {
		logger.Warn().Err(token.Error()).Str("topic", topic).Msg("Enhanced MQTT command subscribe failed")
	}
}

func executeEnhancedMQTTAction(action string) error {
	switch action {
	case "host_power":
		return rpcTriggerPower()
	case "host_reset":
		return rpcTriggerReset()
	case "usb_wakeup":
		return rpcSendUsbWakeupSignal()
	case "usb_reinitialize":
		return rpcReinitializeUsbGadgetSoft()
	case "recording_start":
		_, err := startEncodedRecording("")
		return err
	case "recording_stop":
		stopEncodedRecording()
		return nil
	case "rtp_start":
		_, err := startRTPMulticast(defaultRTPMulticastAddress, defaultRTPMulticastTTL)
		return err
	case "rtp_stop":
		stopRTPMulticast()
		return nil
	case "virtual_media_unmount":
		return rpcUnmountImage()
	case "key_enter":
		return sendEnhancedMQTTHotkey(0, 0x28)
	case "key_escape":
		return sendEnhancedMQTTHotkey(0, 0x29)
	case "key_f2":
		return sendEnhancedMQTTHotkey(0, 0x3b)
	case "key_f12":
		return sendEnhancedMQTTHotkey(0, 0x45)
	case "key_ctrl_alt_delete":
		return sendEnhancedMQTTHotkey(0x05, 0x4c)
	case "reboot_picokvm":
		return rpcReboot(false)
	default:
		return fmt.Errorf("unknown Home Assistant action: %s", action)
	}
}

func sendEnhancedMQTTHotkey(modifier, key uint8) error {
	if _, err := callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
		"modifier": modifier,
		"keys":     []uint8{key},
	}); err != nil {
		return err
	}
	time.Sleep(50 * time.Millisecond)
	_, err := callRPCHandler(rpcHandlers["keyboardReport"], map[string]interface{}{
		"modifier": uint8(0),
		"keys":     []uint8{},
	})
	return err
}

func rpcGetEnhancedMQTTSettings() (EnhancedMQTTConfig, error) {
	cfg := loadEnhancedMQTTConfig()
	if cfg.Password != "" {
		cfg.Password = enhancedMQTTPasswordMask
	}
	return cfg, nil
}

func rpcSetEnhancedMQTTSettings(settings EnhancedMQTTConfig) (EnhancedMQTTStatus, error) {
	current := loadEnhancedMQTTConfig()
	if settings.Password == enhancedMQTTPasswordMask {
		settings.Password = current.Password
	}
	settings, err := normalizeEnhancedMQTTConfig(settings)
	if err != nil {
		return EnhancedMQTTStatus{}, err
	}
	if err := saveEnhancedMQTTConfig(settings); err != nil {
		return EnhancedMQTTStatus{}, err
	}
	if err := restartEnhancedMQTT(settings); err != nil {
		return EnhancedMQTTStatus{}, err
	}
	return rpcGetEnhancedMQTTStatus()
}

func rpcGetEnhancedMQTTStatus() (EnhancedMQTTStatus, error) {
	enhancedMQTTGlobalMu.Lock()
	m := enhancedMQTT
	enhancedMQTTGlobalMu.Unlock()
	if m == nil {
		cfg := loadEnhancedMQTTConfig()
		return EnhancedMQTTStatus{Connected: false, BaseTopic: cfg.BaseTopic}, nil
	}
	return m.status(), nil
}

func rpcTestEnhancedMQTTConnection(settings EnhancedMQTTConfig) (EnhancedMQTTTestResult, error) {
	current := loadEnhancedMQTTConfig()
	if settings.Password == enhancedMQTTPasswordMask {
		settings.Password = current.Password
	}
	settings.Enabled = true
	settings, err := normalizeEnhancedMQTTConfig(settings)
	if err != nil {
		return EnhancedMQTTTestResult{Error: err.Error()}, nil
	}
	deviceID := sanitizeHAID(GetDeviceID())
	opts := newEnhancedMQTTClientOptions(settings, "picokvm-test-"+deviceID)
	opts.SetAutoReconnect(false)
	opts.SetConnectRetry(false)
	client := mqtt.NewClient(opts)
	token := client.Connect()
	if !token.WaitTimeout(8 * time.Second) {
		return EnhancedMQTTTestResult{Error: "connection timed out"}, nil
	}
	if token.Error() != nil {
		return EnhancedMQTTTestResult{Error: token.Error().Error()}, nil
	}
	client.Disconnect(250)
	return EnhancedMQTTTestResult{Success: true}, nil
}
