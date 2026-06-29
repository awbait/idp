package api

import (
	"encoding/json"
	"errors"
	"net/http"

	"console/internal/auth"
	"console/internal/provisioning"
	"console/internal/publications"
	"console/pkg/models"
)

type errorBody struct {
	Error   string                    `json:"error"`
	Message string                    `json:"message,omitempty"`
	Details []provisioning.FieldError `json:"details,omitempty"`
	// MRURL/MRIID accompany the "open_mr" conflict so the UI can link to the
	// merge request that blocks a new change.
	MRURL string `json:"mr_url,omitempty"`
	MRIID int    `json:"mr_iid,omitempty"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if v != nil {
		_ = json.NewEncoder(w).Encode(v)
	}
}

func writeErr(w http.ResponseWriter, code int, errCode, msg string) {
	writeJSON(w, code, errorBody{Error: errCode, Message: msg})
}

// writeDomainErr maps domain/store errors to HTTP responses per the spec table.
func writeDomainErr(w http.ResponseWriter, err error) {
	var ve *provisioning.ValidationError
	var pve *publications.ValidationError
	var ome *provisioning.OpenMRError
	switch {
	case errors.As(err, &ome):
		// An order's open MR blocks the change: 409 with a link so the UI can
		// point the user at it instead of showing a bare English domain string.
		writeJSON(w, http.StatusConflict,
			errorBody{Error: "open_mr", Message: ome.Error(), MRURL: ome.URL, MRIID: ome.IID})
	case errors.As(err, &ve):
		writeJSON(w, http.StatusUnprocessableEntity,
			errorBody{Error: "validation_failed", Message: ve.Message, Details: ve.Fields})
	case errors.As(err, &pve):
		// Report view-document issues in details using the same path+message
		// format as values schema errors.
		details := make([]provisioning.FieldError, 0, len(pve.Issues))
		for _, is := range pve.Issues {
			details = append(details, provisioning.FieldError{Path: is.Path, Message: is.Message})
		}
		writeJSON(w, http.StatusUnprocessableEntity,
			errorBody{Error: "validation_failed", Message: pve.Message, Details: details})
	case errors.Is(err, models.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "")
	case errors.Is(err, models.ErrConflict), errors.Is(err, models.ErrStaleVersion),
		errors.Is(err, provisioning.ErrOpenMR), errors.Is(err, publications.ErrPendingLocked):
		writeErr(w, http.StatusConflict, "conflict", msgOf(err))
	case errors.Is(err, provisioning.ErrForbidden), errors.Is(err, publications.ErrForbidden):
		writeErr(w, http.StatusForbidden, "forbidden", "")
	case errors.Is(err, provisioning.ErrUpstream):
		writeErr(w, http.StatusBadGateway, "upstream_unavailable", msgOf(err))
	case errors.Is(err, auth.ErrUnauthenticated):
		writeErr(w, http.StatusUnauthorized, "unauthorized", "")
	default:
		writeErr(w, http.StatusInternalServerError, "internal", "")
	}
}

func msgOf(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
