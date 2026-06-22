package api

import (
	"encoding/json"
	"net/http"
	"time"
)

// stream sends Server-Sent Events for a bus topic until the client disconnects.
func (s *Server) stream(w http.ResponseWriter, r *http.Request, topic string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "internal", "streaming unsupported")
		return
	}

	// Cap concurrent streams: each holds a goroutine, a bus subscription and a
	// socket until the client disconnects, so an unbounded count is a DoS vector.
	if s.sseStreams.Add(1) > maxSSEStreams {
		s.sseStreams.Add(-1)
		writeErr(w, http.StatusServiceUnavailable, "too_many_streams", "too many concurrent event streams")
		return
	}
	defer s.sseStreams.Add(-1)

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch, unsub := s.Bus.Subscribe(topic)
	defer unsub()

	// initial comment so clients know the stream is open
	_, _ = w.Write([]byte(": connected\n\n"))
	flusher.Flush()

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case e := <-ch:
			payload, _ := json.Marshal(e)
			_, _ = w.Write([]byte("event: " + e.Type + "\ndata: "))
			_, _ = w.Write(payload)
			_, _ = w.Write([]byte("\n\n"))
			flusher.Flush()
		case <-keepalive.C:
			_, _ = w.Write([]byte(": keepalive\n\n"))
			flusher.Flush()
		}
	}
}
