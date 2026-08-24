package kvm

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

const defaultVideoSubscriberBuffer = 8

type VideoFrame struct {
	data []byte
	refs atomic.Int32
	pool *sync.Pool
}

func (f *VideoFrame) Data() []byte {
	return f.data
}

func (f *VideoFrame) Release() {
	if f.refs.Add(-1) == 0 {
		f.data = f.data[:cap(f.data)]
		f.pool.Put(f.data)
	}
}

var framePool = sync.Pool{
	New: func() interface{} {
		return make([]byte, maxFrameSize)
	},
}

type VideoBroadcaster struct {
	subscribers       map[string]chan *VideoFrame
	subscriberList    []chan *VideoFrame // cached flat slice, rebuilt on Subscribe/Unsubscribe
	count             atomic.Int32       // len(subscribers) as atomic for fast Broadcast check
	lastFrameUnixNano atomic.Int64       // passive heartbeat for supervisor/diagnostics
	totalFrames       atomic.Uint64
	lock              sync.RWMutex
	onFirstSubscribe  func()
	onLastUnsubscribe func()
}

var videoBroadcaster = &VideoBroadcaster{
	subscribers: make(map[string]chan *VideoFrame),
}

func (b *VideoBroadcaster) rebuildList() {
	list := make([]chan *VideoFrame, 0, len(b.subscribers))
	for _, ch := range b.subscribers {
		list = append(list, ch)
	}
	b.subscriberList = list
}

func (b *VideoBroadcaster) Subscribe() (string, chan *VideoFrame) {
	return b.SubscribeBuffered(defaultVideoSubscriberBuffer)
}

func (b *VideoBroadcaster) SubscribeBuffered(buffer int) (string, chan *VideoFrame) {
	if buffer < 1 {
		buffer = 1
	}

	b.lock.Lock()
	defer b.lock.Unlock()

	id := uuid.New().String()
	ch := make(chan *VideoFrame, buffer)
	wasEmpty := len(b.subscribers) == 0
	b.subscribers[id] = ch
	b.rebuildList()
	b.count.Store(int32(len(b.subscribers)))
	if wasEmpty && b.onFirstSubscribe != nil {
		b.onFirstSubscribe()
	}
	return id, ch
}

func (b *VideoBroadcaster) Unsubscribe(id string) {
	var ch chan *VideoFrame
	callLastUnsubscribe := false

	b.lock.Lock()
	if existing, ok := b.subscribers[id]; ok {
		ch = existing
		delete(b.subscribers, id)
		b.rebuildList()
		b.count.Store(int32(len(b.subscribers)))
		callLastUnsubscribe = len(b.subscribers) == 0 && b.onLastUnsubscribe != nil
		close(ch)
	}
	b.lock.Unlock()

	// A subscriber can disconnect with frames still buffered. Drain and release
	// them here so pooled frame references are never leaked.
	if ch != nil {
		for frame := range ch {
			frame.Release()
		}
	}

	if callLastUnsubscribe {
		// Hold a read lock while invoking the callback so a concurrent new
		// subscriber cannot slip in between the empty check and stop_video.
		b.lock.RLock()
		if len(b.subscribers) == 0 && b.onLastUnsubscribe != nil {
			b.onLastUnsubscribe()
		}
		b.lock.RUnlock()
	}
}

// SubscriberCount returns the number of consumers currently attached to the
// encoded video broadcaster. It is intentionally lock-free so status/metrics
// callers do not interfere with the hot video path.
func (b *VideoBroadcaster) SubscriberCount() int {
	return int(b.count.Load())
}

func (b *VideoBroadcaster) LastFrameAt() time.Time {
	ns := b.lastFrameUnixNano.Load()
	if ns <= 0 {
		return time.Time{}
	}
	return time.Unix(0, ns)
}

func (b *VideoBroadcaster) TotalFrames() uint64 {
	return b.totalFrames.Load()
}

func (b *VideoBroadcaster) Broadcast(data []byte) {
	// Record the native encoded-stream heartbeat before the no-subscriber fast
	// path. This makes diagnostics useful without changing the frame fan-out.
	b.lastFrameUnixNano.Store(time.Now().UnixNano())
	b.totalFrames.Add(1)

	// Atomic check avoids acquiring RLock on every video frame when nobody is watching.
	if b.count.Load() == 0 {
		return
	}

	b.lock.RLock()
	subscribers := b.subscriberList
	subscriberCount := len(subscribers)
	if subscriberCount == 0 {
		b.lock.RUnlock()
		return
	}

	buf := framePool.Get().([]byte)
	if cap(buf) < len(data) {
		buf = make([]byte, len(data))
	}
	n := copy(buf, data)

	frame := &VideoFrame{
		data: buf[:n],
		pool: &framePool,
	}
	frame.refs.Store(int32(subscriberCount + 1))

	for _, ch := range subscribers {
		select {
		case ch <- frame:
		default:
			// Slow consumers drop the newest frame instead of blocking capture.
			// With a small buffer this keeps latency bounded and protects the
			// native encoder pipeline from backpressure.
			frame.Release()
		}
	}
	b.lock.RUnlock()
	frame.Release()
}
