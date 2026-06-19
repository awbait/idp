package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"console/internal/api"
)

func TestHTTPAbout(t *testing.T) {
	srv, _, _ := newServer(t)
	h := srv.Router()

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, devReq("GET", "/api/v1/info", "core", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("info: %d body=%s", rec.Code, rec.Body.String())
	}

	var got api.AboutInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Version == "" {
		t.Error("version must not be empty")
	}
	if got.GoVersion == "" {
		t.Error("go_version must not be empty")
	}
}
