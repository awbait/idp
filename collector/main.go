// Command console-collector periodically lists labeled namespaces and their
// workloads (Deployment/StatefulSet/DaemonSet) and writes a read-only snapshot
// into Valkey/Redis for the IDP console to consume. The console never talks to
// the Kubernetes API: it only reads the snapshot from Valkey.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := loadConfig()
	if err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}

	cs, err := newClientset(cfg.kubeconfig)
	if err != nil {
		log.Error("kubernetes client", "err", err)
		os.Exit(1)
	}

	opt, err := redis.ParseURL(cfg.redisURL)
	if err != nil {
		log.Error("redis url", "err", err)
		os.Exit(1)
	}
	rdb := redis.NewClient(opt)
	defer rdb.Close()

	// TTL outlives a few cycles so the snapshot survives a transient hiccup but
	// expires if the collector dies, rather than serving stale data forever.
	ttl := 3 * cfg.pollInterval

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Info("collector started",
		"cluster", cfg.clusterName,
		"nsLabel", cfg.nsLabel,
		"interval", cfg.pollInterval.String(),
	)

	runOnce := func() {
		cctx, cancel := context.WithTimeout(ctx, cfg.pollInterval)
		defer cancel()
		now := time.Now().UTC().Format(time.RFC3339)
		snapshot, err := collect(cctx, cs, cfg.nsLabel, now)
		if err != nil {
			log.Error("collect", "err", err)
			return
		}
		if err := publish(cctx, rdb, cfg.clusterName, cfg.keyPrefix, snapshot, ttl); err != nil {
			log.Error("publish", "err", err)
			return
		}
		workloads := 0
		for _, ws := range snapshot {
			workloads += len(ws)
		}
		log.Info("snapshot published", "namespaces", len(snapshot), "workloads", workloads)
	}

	runOnce()
	tick := time.NewTicker(cfg.pollInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return
		case <-tick.C:
			runOnce()
		}
	}
}
