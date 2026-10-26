package api

import (
	"net/http"

	"github.com/relaywork/gateway/internal/model"
)

type createConsumerRequest struct {
	Name    string `json:"name"`
	Enabled *bool  `json:"enabled"` // default true
}

type updateConsumerRequest struct {
	Name    *string `json:"name"`
	Enabled *bool   `json:"enabled"`
}

type consumerList struct {
	Consumers []model.Consumer `json:"consumers"`
	Total     int              `json:"total"`
	Offset    int              `json:"offset"`
	Limit     int              `json:"limit"`
}

// issuedKey is returned once, when a key is issued: it is the only time the key is shown.
type issuedKey struct {
	Key    string       `json:"key"`
	APIKey model.APIKey `json:"api_key"`
}

// createdSecret is returned once, when an HMAC secret is created.
type createdSecret struct {
	KeyID      string               `json:"key_id"`
	Secret     string               `json:"secret"`
	Credential model.HMACCredential `json:"credential"`
}

func (s *Server) createConsumer(w http.ResponseWriter, r *http.Request) {
	var req createConsumerRequest
	if err := decodeJSON(w, r, &req, false); err != nil {
		s.writeError(w, r, err)
		return
	}
	in := model.ConsumerInput{Name: req.Name, Enabled: true}
	if req.Enabled != nil {
		in.Enabled = *req.Enabled
	}
	c, err := s.store.CreateConsumer(r.Context(), in)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	w.Header().Set("Location", "/admin/v1/consumers/"+c.ID)
	s.writeJSON(w, http.StatusCreated, c)
}

func (s *Server) listConsumers(w http.ResponseWriter, r *http.Request) {
	offset, limit, err := pageParams(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	consumers, total, err := s.store.ListConsumers(r.Context(), offset, limit)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, consumerList{Consumers: consumers, Total: total, Offset: offset, Limit: limit})
}

func (s *Server) getConsumer(w http.ResponseWriter, r *http.Request) {
	c, err := s.store.GetConsumer(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, c)
}

func (s *Server) updateConsumer(w http.ResponseWriter, r *http.Request) {
	var req updateConsumerRequest
	if err := decodeJSON(w, r, &req, false); err != nil {
		s.writeError(w, r, err)
		return
	}
	c, err := s.store.UpdateConsumer(r.Context(), r.PathValue("id"), model.ConsumerPatch{Name: req.Name, Enabled: req.Enabled})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, c)
}

func (s *Server) deleteConsumer(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteConsumer(r.Context(), r.PathValue("id")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) issueKey(w http.ResponseWriter, r *http.Request) {
	key, rec, err := s.store.IssueAPIKey(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.log.Info("API key issued", "consumer_id", rec.ConsumerID, "key_prefix", rec.Prefix,
		"request_id", requestID(r.Context()))
	s.writeJSON(w, http.StatusCreated, issuedKey{Key: key, APIKey: rec})
}

func (s *Server) listKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := s.store.ListAPIKeys(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (s *Server) revokeKey(w http.ResponseWriter, r *http.Request) {
	id, prefix := r.PathValue("id"), r.PathValue("prefix")
	if err := s.store.RevokeAPIKey(r.Context(), id, prefix); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.log.Info("API key revoked", "consumer_id", id, "key_prefix", prefix, "request_id", requestID(r.Context()))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createHMACSecret(w http.ResponseWriter, r *http.Request) {
	cred, err := s.store.CreateHMACCredential(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.log.Info("HMAC secret created", "consumer_id", cred.ConsumerID, "key_id", cred.KeyID,
		"request_id", requestID(r.Context()))
	secret := cred.Secret
	cred.Secret = ""
	s.writeJSON(w, http.StatusCreated, createdSecret{KeyID: cred.KeyID, Secret: secret, Credential: cred})
}

func (s *Server) listHMACSecrets(w http.ResponseWriter, r *http.Request) {
	creds, err := s.store.ListHMACCredentials(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"hmac_secrets": creds})
}

func (s *Server) revokeHMACSecret(w http.ResponseWriter, r *http.Request) {
	id, keyID := r.PathValue("id"), r.PathValue("key_id")
	if err := s.store.RevokeHMACCredential(r.Context(), id, keyID); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.log.Info("HMAC secret revoked", "consumer_id", id, "key_id", keyID, "request_id", requestID(r.Context()))
	w.WriteHeader(http.StatusNoContent)
}
