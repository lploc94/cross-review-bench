package api

import (
	"strings"
	"testing"

	"github.com/relaywork/gateway/internal/model"
)

func TestConsumerLifecycle(t *testing.T) {
	s := redisServer(t)

	r := s.call(t, "POST", "/admin/v1/consumers", `{"name":"billing"}`)
	var c model.Consumer
	r.decode(t, &c)
	if r.status != 201 || !model.ValidConsumerID(c.ID) || c.Name != "billing" || !c.Enabled {
		t.Fatalf("create: status %d, body %s", r.status, r.body)
	}
	if r.header.Get("Location") != "/admin/v1/consumers/"+c.ID {
		t.Errorf("Location = %q", r.header.Get("Location"))
	}
	if r := s.call(t, "POST", "/admin/v1/consumers", `{"name":"BILLING"}`); r.status != 409 || r.errorCode(t) != "conflict" {
		t.Errorf("duplicate name: status %d", r.status)
	}

	var got model.Consumer
	r = s.call(t, "GET", "/admin/v1/consumers/"+c.ID, "")
	r.decode(t, &got)
	if r.status != 200 || got.ID != c.ID {
		t.Errorf("get: status %d, body %s", r.status, r.body)
	}

	r = s.call(t, "PATCH", "/admin/v1/consumers/"+c.ID, `{"enabled":false}`)
	r.decode(t, &got)
	if r.status != 200 || got.Enabled || got.Name != "billing" {
		t.Errorf("patch: status %d, body %s", r.status, r.body)
	}

	if r := s.call(t, "DELETE", "/admin/v1/consumers/"+c.ID, ""); r.status != 204 || len(r.body) != 0 {
		t.Errorf("delete: status %d", r.status)
	}
	if r := s.call(t, "GET", "/admin/v1/consumers/"+c.ID, ""); r.status != 404 || r.errorCode(t) != "not_found" {
		t.Errorf("get after delete: status %d", r.status)
	}
	if r := s.call(t, "DELETE", "/admin/v1/consumers/"+c.ID, ""); r.status != 404 {
		t.Errorf("second delete: status %d", r.status)
	}
}

func TestConsumerRequestValidation(t *testing.T) {
	s := redisServer(t)
	cases := []struct {
		name, body, contentType string
		status                  int
		code                    string
	}{
		{"invalid name", `{"name":"has space"}`, "", 422, "validation_failed"},
		{"missing name", `{}`, "", 422, "validation_failed"},
		{"unknown field", `{"name":"a","role":"admin"}`, "", 400, "bad_request"},
		{"two objects", `{"name":"a"}{"name":"b"}`, "", 400, "bad_request"},
		{"not json", `name=a`, "", 400, "bad_request"},
		{"empty", ``, "", 400, "bad_request"},
		{"wrong media type", `{"name":"a"}`, "text/plain", 415, "unsupported_media_type"},
		{"too large", `{"name":"` + strings.Repeat("a", 20<<10) + `"}`, "", 413, "too_large"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			headers := []string{}
			if c.contentType != "" {
				headers = append(headers, "Content-Type", "", "Content-Type", c.contentType)
			}
			r := s.call(t, "POST", "/admin/v1/consumers", c.body, headers...)
			if r.status != c.status || r.errorCode(t) != c.code {
				t.Errorf("status %d, body %.200s", r.status, r.body)
			}
		})
	}

	var e errorBody
	r := s.call(t, "POST", "/admin/v1/consumers", `{"name":""}`)
	r.decode(t, &e)
	if len(e.Error.Fields) != 1 || e.Error.Fields[0].Field != "name" {
		t.Errorf("fields = %+v", e.Error.Fields)
	}
	if r := s.call(t, "PATCH", "/admin/v1/consumers/c_0123456789abcdef", `{"name":"x"}`); r.status != 404 {
		t.Errorf("patch of a missing consumer: status %d", r.status)
	}
}

func TestListConsumersPages(t *testing.T) {
	s := redisServer(t)
	for _, name := range []string{"a", "b", "c"} {
		if r := s.call(t, "POST", "/admin/v1/consumers", `{"name":"`+name+`"}`); r.status != 201 {
			t.Fatalf("create %s: %d", name, r.status)
		}
	}
	var page consumerList
	r := s.call(t, "GET", "/admin/v1/consumers?offset=1&limit=1", "")
	r.decode(t, &page)
	if r.status != 200 || page.Total != 3 || len(page.Consumers) != 1 || page.Offset != 1 || page.Limit != 1 {
		t.Errorf("page: status %d, body %s", r.status, r.body)
	}
	for _, q := range []string{"offset=-1", "limit=0", "limit=x", "limit=501"} {
		if r := s.call(t, "GET", "/admin/v1/consumers?"+q, ""); r.status != 422 {
			t.Errorf("%s: status %d", q, r.status)
		}
	}
}

func TestKeysAndSecretsAreShownOnce(t *testing.T) {
	s := redisServer(t)
	var c model.Consumer
	s.call(t, "POST", "/admin/v1/consumers", `{"name":"svc"}`).decode(t, &c)

	r := s.call(t, "POST", "/admin/v1/consumers/"+c.ID+"/keys", "")
	var issued issuedKey
	r.decode(t, &issued)
	prefix, ok := model.ParseAPIKey(issued.Key)
	if r.status != 201 || !ok || prefix != issued.APIKey.Prefix {
		t.Fatalf("issue: status %d, body %s", r.status, r.body)
	}
	secretPart := issued.Key[strings.Index(issued.Key, ".")+1:]
	r = s.call(t, "GET", "/admin/v1/consumers/"+c.ID+"/keys", "")
	if r.status != 200 || strings.Contains(string(r.body), secretPart) || !strings.Contains(string(r.body), prefix) {
		t.Errorf("list keys: status %d, body %s", r.status, r.body)
	}
	if r := s.call(t, "DELETE", "/admin/v1/consumers/"+c.ID+"/keys/"+prefix, ""); r.status != 204 {
		t.Errorf("revoke: status %d", r.status)
	}
	if r := s.call(t, "DELETE", "/admin/v1/consumers/c_0123456789abcdef/keys/"+prefix, ""); r.status != 404 {
		t.Errorf("revoke under another consumer: status %d", r.status)
	}

	r = s.call(t, "POST", "/admin/v1/consumers/"+c.ID+"/hmac-secrets", "")
	var created createdSecret
	r.decode(t, &created)
	if r.status != 201 || !model.ValidHMACKeyID(created.KeyID) || created.Secret == "" {
		t.Fatalf("create secret: status %d, body %s", r.status, r.body)
	}
	r = s.call(t, "GET", "/admin/v1/consumers/"+c.ID+"/hmac-secrets", "")
	if r.status != 200 || strings.Contains(string(r.body), created.Secret) || !strings.Contains(string(r.body), created.KeyID) {
		t.Errorf("list secrets: status %d, body %s", r.status, r.body)
	}
	if r := s.call(t, "DELETE", "/admin/v1/consumers/"+c.ID+"/hmac-secrets/"+created.KeyID, ""); r.status != 204 {
		t.Errorf("revoke secret: status %d", r.status)
	}
	if r := s.call(t, "POST", "/admin/v1/consumers/c_0123456789abcdef/keys", ""); r.status != 404 {
		t.Errorf("key for a missing consumer: status %d", r.status)
	}
}
