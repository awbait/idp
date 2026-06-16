package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

// publish writes the snapshot to Redis/Valkey as one key per namespace plus a
// single index key listing the active namespaces. The whole snapshot is
// rewritten each cycle, so removed workloads disappear on overwrite and removed
// namespaces drop out of the index and expire by TTL.
//
//	{prefix}:{cluster}:index            -> JSON ["ns-a","ns-b", ...]
//	{prefix}:{cluster}:ns:{namespace}   -> JSON [ Workload, ... ]
func publish(ctx context.Context, rdb *redis.Client, cluster, prefix string, snapshot map[string][]Workload, ttl time.Duration) error {
	namespaces := make([]string, 0, len(snapshot))
	for ns, ws := range snapshot {
		b, err := json.Marshal(ws)
		if err != nil {
			return fmt.Errorf("marshal namespace %s: %w", ns, err)
		}
		key := fmt.Sprintf("%s:%s:ns:%s", prefix, cluster, ns)
		if err := rdb.Set(ctx, key, b, ttl).Err(); err != nil {
			return fmt.Errorf("set %s: %w", key, err)
		}
		namespaces = append(namespaces, ns)
	}

	sort.Strings(namespaces)
	idx, err := json.Marshal(namespaces)
	if err != nil {
		return fmt.Errorf("marshal index: %w", err)
	}
	idxKey := fmt.Sprintf("%s:%s:index", prefix, cluster)
	if err := rdb.Set(ctx, idxKey, idx, ttl).Err(); err != nil {
		return fmt.Errorf("set %s: %w", idxKey, err)
	}
	return nil
}
