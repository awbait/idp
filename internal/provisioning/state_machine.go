package provisioning

import "idp/pkg/models"

// transitions is the allowed FSM edges (see spec lifecycle diagram).
var transitions = map[models.RequestStatus]map[models.RequestStatus]bool{
	models.StatusDraft: {
		models.StatusMRCreated: true,
	},
	models.StatusMRCreated: {
		models.StatusMRClosed: true,
		models.StatusMRMerged: true,
	},
	// Once the create MR is merged (the instance exists in Git), the order can be
	// edited (update -> MR_CREATED) or deleted (-> DELETE_REQUESTED) from any of
	// MR_MERGED, DEPLOYING, HEALTHY, DEGRADED, ARGO_MISSING. Editing is NOT allowed
	// from MR_CREATED (a create/update MR is still open - guardOpenMR also blocks it)
	// nor DRAFT (which updates in place without an MR).
	models.StatusMRMerged: {
		models.StatusDeploying:       true,
		models.StatusArgoMissing:     true,
		models.StatusMRCreated:       true, // update opens a new MR
		models.StatusDeleteRequested: true,
	},
	models.StatusDeploying: {
		models.StatusHealthy:         true,
		models.StatusDegraded:        true,
		models.StatusMRCreated:       true, // update mid-rollout opens a new MR
		models.StatusDeleteRequested: true,
	},
	models.StatusHealthy: {
		models.StatusDegraded:        true,
		models.StatusDeploying:       true, // re-sync after update
		models.StatusMRCreated:       true, // update opens a new MR
		models.StatusDeleteRequested: true,
	},
	models.StatusDegraded: {
		models.StatusHealthy:         true,
		models.StatusDeploying:       true,
		models.StatusMRCreated:       true,
		models.StatusDeleteRequested: true,
	},
	models.StatusArgoMissing: {
		models.StatusDeploying:       true, // app reappears in ArgoCD
		models.StatusMRCreated:       true,
		models.StatusDeleteRequested: true,
	},
	models.StatusDeleteRequested: {
		models.StatusDeleteMRMerged: true,
		models.StatusMRClosed:       true, // delete MR cancelled
	},
	models.StatusDeleteMRMerged: {
		models.StatusDeleted: true,
	},
}

// CanTransition reports whether from->to is a valid FSM edge.
func CanTransition(from, to models.RequestStatus) bool {
	if from == to {
		return true
	}
	return transitions[from][to]
}
