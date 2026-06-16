package main

import (
	"fmt"
	"os"
	"time"
)

// config is the collector runtime configuration, read from the environment.
type config struct {
	redisURL     string        // REDIS_URL, e.g. redis://valkey:6379/0 (required)
	nsLabel      string        // NS_LABEL_SELECTOR, e.g. "idp.scan=true" (empty = all namespaces)
	pollInterval time.Duration // POLL_INTERVAL, default 30s
	clusterName  string        // CLUSTER_NAME, used in the Redis key prefix
	keyPrefix    string        // KEY_PREFIX, default "k8s:catalog"
	kubeconfig   string        // KUBECONFIG, only used for out-of-cluster local dev
}

func loadConfig() (config, error) {
	c := config{
		redisURL:     os.Getenv("REDIS_URL"),
		nsLabel:      os.Getenv("NS_LABEL_SELECTOR"),
		clusterName:  envOr("CLUSTER_NAME", "default"),
		keyPrefix:    envOr("KEY_PREFIX", "k8s:catalog"),
		kubeconfig:   os.Getenv("KUBECONFIG"),
		pollInterval: 30 * time.Second,
	}
	if c.redisURL == "" {
		return c, fmt.Errorf("REDIS_URL is required")
	}
	if v := os.Getenv("POLL_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return c, fmt.Errorf("invalid POLL_INTERVAL %q: %w", v, err)
		}
		c.pollInterval = d
	}
	return c, nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
