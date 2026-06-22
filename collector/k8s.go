package main

import (
	"context"
	"fmt"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Port is an exposed container port declared in a workload's pod template.
type Port struct {
	Name     string `json:"name,omitempty"`
	Port     int32  `json:"port"`
	Protocol string `json:"protocol"` // TCP | UDP | SCTP
}

// Workload is one catalog record: a controller (not an individual Pod replica).
type Workload struct {
	Name               string            `json:"name"`
	Namespace          string            `json:"namespace"`
	Kind               string            `json:"kind"` // Deployment | StatefulSet | DaemonSet
	Labels             map[string]string `json:"labels,omitempty"`
	Ports              []Port            `json:"ports,omitempty"`
	ServiceAccountName string            `json:"serviceAccountName,omitempty"`
	CollectedAt        string            `json:"collectedAt"` // RFC3339
}

// newClientset builds a Kubernetes client. In-cluster config is preferred;
// KUBECONFIG is a fallback for local out-of-cluster development only.
func newClientset(kubeconfig string) (*kubernetes.Clientset, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		if kubeconfig == "" {
			return nil, fmt.Errorf("not running in cluster and KUBECONFIG is empty: %w", err)
		}
		cfg, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		if err != nil {
			return nil, err
		}
	}
	return kubernetes.NewForConfig(cfg)
}

// collect lists namespaces matching nsLabel and gathers their workloads.
// Authorization is cluster-wide read-only; nsLabel filters at the query level.
// A failure in one namespace is logged and skipped so a single bad namespace
// does not drop the whole snapshot.
func collect(ctx context.Context, cs kubernetes.Interface, nsLabel, now string, log *slog.Logger) (map[string][]Workload, error) {
	nss, err := cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{LabelSelector: nsLabel})
	if err != nil {
		return nil, fmt.Errorf("list namespaces: %w", err)
	}
	out := make(map[string][]Workload, len(nss.Items))
	for i := range nss.Items {
		ns := nss.Items[i].Name
		ws, err := collectNamespace(ctx, cs, ns, now)
		if err != nil {
			log.Warn("skip namespace: collect failed", "namespace", ns, "err", err)
			continue
		}
		out[ns] = ws
	}
	return out, nil
}

func collectNamespace(ctx context.Context, cs kubernetes.Interface, ns, now string) ([]Workload, error) {
	var ws []Workload

	deps, err := cs.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list deployments in %s: %w", ns, err)
	}
	for i := range deps.Items {
		d := &deps.Items[i]
		ws = append(ws, fromTemplate("Deployment", d.Name, ns, d.Labels, d.Spec.Template, now))
	}

	sts, err := cs.AppsV1().StatefulSets(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list statefulsets in %s: %w", ns, err)
	}
	for i := range sts.Items {
		s := &sts.Items[i]
		ws = append(ws, fromTemplate("StatefulSet", s.Name, ns, s.Labels, s.Spec.Template, now))
	}

	ds, err := cs.AppsV1().DaemonSets(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list daemonsets in %s: %w", ns, err)
	}
	for i := range ds.Items {
		d := &ds.Items[i]
		ws = append(ws, fromTemplate("DaemonSet", d.Name, ns, d.Labels, d.Spec.Template, now))
	}

	return ws, nil
}

// fromTemplate extracts the catalog fields from a workload's pod template.
func fromTemplate(kind, name, ns string, labels map[string]string, tmpl corev1.PodTemplateSpec, now string) Workload {
	var ports []Port
	for _, c := range tmpl.Spec.Containers {
		for _, p := range c.Ports {
			proto := string(p.Protocol)
			if proto == "" {
				proto = string(corev1.ProtocolTCP) // Kubernetes defaults empty protocol to TCP
			}
			ports = append(ports, Port{Name: p.Name, Port: p.ContainerPort, Protocol: proto})
		}
	}
	return Workload{
		Name:               name,
		Namespace:          ns,
		Kind:               kind,
		Labels:             labels,
		Ports:              ports,
		ServiceAccountName: tmpl.Spec.ServiceAccountName,
		CollectedAt:        now,
	}
}
