package provisioning

import (
	"errors"
	"fmt"

	"console/pkg/models"
)

// Domain errors mapped to HTTP codes by the API layer.
var (
	ErrForbidden = errors.New("forbidden")
	ErrOpenMR    = errors.New("an open merge request already exists for this order")
	ErrUpstream  = errors.New("upstream unavailable")
)

// FieldError is one schema-validation failure pinned to a values field.
// Path is a JSON Pointer into the submitted values (e.g. "/gateways/0/listeners/0").
type FieldError struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ValidationError is a 422 with a human-readable reason and, when it comes from
// schema validation, a per-field breakdown for the UI.
type ValidationError struct {
	Message string
	Fields  []FieldError
}

func (e *ValidationError) Error() string { return e.Message }

// OpenMRError is the 409 returned when a new change is blocked by an order's
// already-open merge request. It carries that MR's URL and IID so the API can
// point the user straight at it. errors.Is(err, ErrOpenMR) stays true, so the
// HTTP mapping and existing call sites keep working.
type OpenMRError struct {
	URL string
	IID int
}

func (e *OpenMRError) Error() string        { return ErrOpenMR.Error() }
func (e *OpenMRError) Is(target error) bool { return target == ErrOpenMR }

// conflictError is a 409 carrying a human-readable reason. errors.Is(err,
// models.ErrConflict) stays true (the API maps it to 409 and surfaces the
// message), so a uniqueness collision reads as actionable text rather than a
// bare "conflict". Mirrors the publications package pattern.
type conflictError struct{ msg string }

func (e *conflictError) Error() string        { return e.msg }
func (e *conflictError) Is(target error) bool { return target == models.ErrConflict }

func conflict(format string, a ...any) error {
	return &conflictError{msg: fmt.Sprintf(format, a...)}
}
