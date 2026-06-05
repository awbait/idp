package models

import (
	"encoding/json"
	"time"
)

// PublicationStatus — жизненный цикл черновика view-документа публикации.
// «Опубликованность» (форма заказа доступна) определяется наличием
// ApprovedViewJSON, а не статусом: approved-версия продолжает работать,
// пока новый черновик находится на согласовании.
type PublicationStatus string

const (
	PubDraft    PublicationStatus = "DRAFT"
	PubPending  PublicationStatus = "PENDING"
	PubApproved PublicationStatus = "APPROVED"
	PubRejected PublicationStatus = "REJECTED"
)

// Category группирует опубликованные чарты в каталоге и левом меню.
type Category struct {
	ID    string `json:"id"` // slug
	Label string `json:"label"`
	Sort  int    `json:"sort"`
}

// ChartPublication — портальные метаданные поверх Harbor-чарта: категория,
// владелец (owner_team управляет, created_by — автор) и view-документ
// (бывший web/public/schemas/<chart>.ui.json).
type ChartPublication struct {
	ID            string            `json:"id"`
	ChartProject  string            `json:"chart_project"`
	ChartName     string            `json:"chart_name"`
	CategoryID    string            `json:"category_id"`
	OwnerTeam     string            `json:"owner_team"`
	CreatedBy     string            `json:"created_by"`
	CreatedByName string            `json:"created_by_name"`
	Status        PublicationStatus `json:"status"`
	// ViewJSON — редактируемый черновик view-документа; ApprovedViewJSON —
	// активная согласованная версия (по ней строятся формы заказа).
	ViewJSON         json.RawMessage `json:"view_json,omitempty"`
	ApprovedViewJSON json.RawMessage `json:"approved_view_json,omitempty"`
	ReviewedBy       string          `json:"reviewed_by,omitempty"`
	ReviewComment    string          `json:"review_comment,omitempty"`
	Version          int             `json:"version"` // optimistic lock
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

// Published сообщает, есть ли у публикации действующая согласованная view.
func (p *ChartPublication) Published() bool { return len(p.ApprovedViewJSON) > 0 }

// PublicationEvent — запись аудита / смены статуса публикации.
type PublicationEvent struct {
	ID            int64             `json:"id"`
	PublicationID string            `json:"publication_id"`
	Actor         string            `json:"actor"`
	EventType     string            `json:"event_type"`
	FromStatus    PublicationStatus `json:"from_status,omitempty"`
	ToStatus      PublicationStatus `json:"to_status,omitempty"`
	Payload       map[string]any    `json:"payload,omitempty"`
	CreatedAt     time.Time         `json:"created_at"`
}
