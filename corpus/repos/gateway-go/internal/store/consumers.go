package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/relaywork/gateway/internal/model"
)

// MaxPageSize bounds the consumers returned by one ListConsumers call.
const MaxPageSize = 500

// createConsumerScript claims the name and writes the consumer.
// KEYS: names, consumer, consumers. ARGV: lower-cased name, id, name, enabled, now.
var createConsumerScript = redis.NewScript(`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 0 then
  return 0
end
redis.call('HSET', KEYS[2], 'id', ARGV[2], 'name', ARGV[3], 'enabled', ARGV[4],
  'created_at', ARGV[5], 'updated_at', ARGV[5])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[2])
return 1
`)

// updateConsumerScript changes the name and/or enabled flag of an existing consumer, moving the
// name claim when the name changes.
// KEYS: names, consumer. ARGV: id, new name ("" to keep), new lower-cased name, enabled ("" to
// keep), now.
var updateConsumerScript = redis.NewScript(`
local current = redis.call('HGET', KEYS[2], 'name')
if not current then
  return -1
end
if ARGV[2] ~= '' then
  local old = string.lower(current)
  if old ~= ARGV[3] then
    if redis.call('HSETNX', KEYS[1], ARGV[3], ARGV[1]) == 0 then
      return 0
    end
    redis.call('HDEL', KEYS[1], old)
  end
  redis.call('HSET', KEYS[2], 'name', ARGV[2])
end
if ARGV[4] ~= '' then
  redis.call('HSET', KEYS[2], 'enabled', ARGV[4])
end
redis.call('HSET', KEYS[2], 'updated_at', ARGV[5])
return 1
`)

// deleteConsumerScript removes a consumer, its name claim and every credential it holds.
// KEYS: consumer, names, consumers, consumer keys, consumer hmac. ARGV: id, API key key prefix,
// HMAC key prefix.
var deleteConsumerScript = redis.NewScript(`
local name = redis.call('HGET', KEYS[1], 'name')
if not name then
  return -1
end
for _, p in ipairs(redis.call('SMEMBERS', KEYS[4])) do
  redis.call('DEL', ARGV[2] .. p)
end
for _, k in ipairs(redis.call('SMEMBERS', KEYS[5])) do
  redis.call('DEL', ARGV[3] .. k)
end
redis.call('DEL', KEYS[1], KEYS[4], KEYS[5])
if redis.call('HGET', KEYS[2], string.lower(name)) == ARGV[1] then
  redis.call('HDEL', KEYS[2], string.lower(name))
end
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`)

// CreateConsumer stores a new consumer. It returns model.ErrConflict when the name is taken;
// names are compared case-insensitively.
func (s *Store) CreateConsumer(ctx context.Context, in model.ConsumerInput) (model.Consumer, error) {
	if err := in.Validate(); err != nil {
		return model.Consumer{}, err
	}
	now := s.clock.Now().UTC().Truncate(time.Millisecond)
	c := model.Consumer{ID: model.NewConsumerID(), Name: in.Name, Enabled: in.Enabled, CreatedAt: now, UpdatedAt: now}
	n, err := createConsumerScript.Run(ctx, s.rdb,
		[]string{s.namesKey(), s.consumerKey(c.ID), s.consumersKey()},
		strings.ToLower(c.Name), c.ID, c.Name, formatBool(c.Enabled), formatTime(now)).Int64()
	if err != nil {
		return model.Consumer{}, fmt.Errorf("create consumer: %w", err)
	}
	if err := scriptResult(n, model.ErrNotFound, nameTaken(c.Name)); err != nil {
		return model.Consumer{}, err
	}
	return c, nil
}

func nameTaken(name string) error {
	return fmt.Errorf("%w: consumer name %q is taken", model.ErrConflict, name)
}

// GetConsumer returns the consumer with id, or model.ErrNotFound.
func (s *Store) GetConsumer(ctx context.Context, id string) (model.Consumer, error) {
	if !model.ValidConsumerID(id) {
		return model.Consumer{}, consumerNotFound(id)
	}
	key := s.consumerKey(id)
	h, err := s.rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return model.Consumer{}, fmt.Errorf("get consumer: %w", err)
	}
	if len(h) == 0 {
		return model.Consumer{}, consumerNotFound(id)
	}
	return decodeConsumer(key, h)
}

func consumerNotFound(id string) error {
	return fmt.Errorf("consumer %q: %w", id, model.ErrNotFound)
}

// UpdateConsumer applies patch to the consumer with id and returns the result.
func (s *Store) UpdateConsumer(ctx context.Context, id string, patch model.ConsumerPatch) (model.Consumer, error) {
	if err := patch.Validate(); err != nil {
		return model.Consumer{}, err
	}
	if !model.ValidConsumerID(id) {
		return model.Consumer{}, consumerNotFound(id)
	}
	var name, lname, enabled string
	if patch.Name != nil {
		name, lname = *patch.Name, strings.ToLower(*patch.Name)
	}
	if patch.Enabled != nil {
		enabled = formatBool(*patch.Enabled)
	}
	now := s.clock.Now().UTC()
	n, err := updateConsumerScript.Run(ctx, s.rdb, []string{s.namesKey(), s.consumerKey(id)},
		id, name, lname, enabled, formatTime(now)).Int64()
	if err != nil {
		return model.Consumer{}, fmt.Errorf("update consumer: %w", err)
	}
	if err := scriptResult(n, consumerNotFound(id), nameTaken(name)); err != nil {
		return model.Consumer{}, err
	}
	return s.GetConsumer(ctx, id)
}

// DeleteConsumer removes the consumer with id together with its API keys and HMAC secrets.
func (s *Store) DeleteConsumer(ctx context.Context, id string) error {
	if !model.ValidConsumerID(id) {
		return consumerNotFound(id)
	}
	n, err := deleteConsumerScript.Run(ctx, s.rdb,
		[]string{s.consumerKey(id), s.namesKey(), s.consumersKey(), s.consumerKeysKey(id), s.consumerHMACKey(id)},
		id, s.apiKeyKey(""), s.hmacKey("")).Int64()
	if err != nil {
		return fmt.Errorf("delete consumer: %w", err)
	}
	return scriptResult(n, consumerNotFound(id), model.ErrConflict)
}

// ListConsumers returns up to limit consumers in creation order, starting at offset, and the
// total number of consumers. A limit of 0 means MaxPageSize.
func (s *Store) ListConsumers(ctx context.Context, offset, limit int) ([]model.Consumer, int, error) {
	if offset < 0 {
		return nil, 0, model.Invalid("offset", "must not be negative")
	}
	if limit < 0 || limit > MaxPageSize {
		return nil, 0, model.Invalid("limit", "must be between 1 and %d", MaxPageSize)
	}
	if limit == 0 {
		limit = MaxPageSize
	}
	pipe := s.rdb.Pipeline()
	idsCmd := pipe.ZRange(ctx, s.consumersKey(), int64(offset), int64(offset+limit-1))
	totalCmd := pipe.ZCard(ctx, s.consumersKey())
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, 0, fmt.Errorf("list consumers: %w", err)
	}
	ids := idsCmd.Val()
	consumers := make([]model.Consumer, 0, len(ids))
	if len(ids) > 0 {
		pipe = s.rdb.Pipeline()
		cmds := make([]*redis.MapStringStringCmd, len(ids))
		for i, id := range ids {
			cmds[i] = pipe.HGetAll(ctx, s.consumerKey(id))
		}
		if _, err := pipe.Exec(ctx); err != nil {
			return nil, 0, fmt.Errorf("list consumers: %w", err)
		}
		for i, cmd := range cmds {
			if len(cmd.Val()) == 0 {
				continue // deleted between the two round trips
			}
			c, err := decodeConsumer(s.consumerKey(ids[i]), cmd.Val())
			if err != nil {
				return nil, 0, err
			}
			consumers = append(consumers, c)
		}
	}
	return consumers, int(totalCmd.Val()), nil
}

func decodeConsumer(key string, h map[string]string) (model.Consumer, error) {
	c := model.Consumer{ID: h["id"], Name: h["name"], Enabled: h["enabled"] == "1"}
	var err error
	if c.CreatedAt, err = parseTime(h["created_at"]); err != nil {
		return model.Consumer{}, corrupt(key, err)
	}
	if c.UpdatedAt, err = parseTime(h["updated_at"]); err != nil {
		return model.Consumer{}, corrupt(key, err)
	}
	if c.ID == "" || c.Name == "" {
		return model.Consumer{}, corrupt(key, errors.New("missing id or name"))
	}
	return c, nil
}

func formatBool(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
