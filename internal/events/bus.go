// Package events is a tiny in-process pub/sub used to push status changes to
// SSE clients. MVP runs a single replica, so an in-memory bus is enough.
// NOTE: scaling to 2+ replicas requires swapping this for Redis Pub/Sub
// (see spec "status update strategy" / techdebt).
package events

import "sync"

// Event is a status update for a request or application.
type Event struct {
	Topic string         `json:"-"`    // e.g. "request:<id>" or "app:<name>"
	Type  string         `json:"type"` // status_changed, mr_updated, ...
	Data  map[string]any `json:"data"`
}

// Bus is an in-memory topic pub/sub.
type Bus struct {
	mu   sync.RWMutex
	subs map[string]map[chan Event]struct{}
}

// New returns an empty bus.
func New() *Bus {
	return &Bus{subs: map[string]map[chan Event]struct{}{}}
}

// Subscribe returns a channel of events for a topic and an unsubscribe func.
func (b *Bus) Subscribe(topic string) (<-chan Event, func()) {
	ch := make(chan Event, 16)
	b.mu.Lock()
	if b.subs[topic] == nil {
		b.subs[topic] = map[chan Event]struct{}{}
	}
	b.subs[topic][ch] = struct{}{}
	b.mu.Unlock()

	return ch, func() {
		b.mu.Lock()
		if m, ok := b.subs[topic]; ok {
			if _, ok := m[ch]; ok {
				delete(m, ch)
				close(ch)
			}
			if len(m) == 0 {
				delete(b.subs, topic)
			}
		}
		b.mu.Unlock()
	}
}

// Publish delivers an event to all subscribers of its topic (non-blocking).
func (b *Bus) Publish(e Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs[e.Topic] {
		select {
		case ch <- e:
		default: // drop if subscriber is slow; SSE clients re-fetch on connect
		}
	}
}
