package ingest

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"athar/backend/internal/store"
)

// settingIngestSecret is the settings key holding the long-lived secret the
// daily salt is derived from.
const settingIngestSecret = "ingest_secret"

// Identifier turns a request into a visitor hash, without cookies and without
// keeping anything that could identify the visitor later.
//
// The construction:
//
//	salt   = HMAC-SHA256(instance_secret, "YYYY-MM-DD")
//	visitor = HMAC-SHA256(salt, website_id || ip || user_agent)
//
// Three properties follow, and each is load-bearing:
//
//   - No cookie is set, so there is nothing to consent to under GDPR/ePrivacy
//     and nothing for a visitor to carry between sites.
//   - The salt changes at UTC midnight, so a visitor hash is stable for a day
//     and unlinkable across days. Cross-day tracking is not merely unimplemented
//     — it is not derivable from what is stored.
//   - The website id is inside the hash, so the same person browsing two sites
//     on one Athar instance produces two unrelated hashes. One operator cannot
//     build a cross-site profile out of their own database.
//
// The instance secret is persisted (see the settings table) so a restart does
// not re-count every returning visitor as new. It is the one long-lived value
// here; deleting it permanently breaks the link to all previous days' hashes,
// which is the intended way to hard-reset visitor identity.
type Identifier struct {
	secret []byte

	mu       sync.RWMutex
	saltDay  string
	saltHMAC []byte
}

// NewIdentifier loads the instance secret, generating and persisting one on
// first run.
func NewIdentifier(ctx context.Context, st store.Store) (*Identifier, error) {
	hexSecret, err := st.GetSetting(ctx, settingIngestSecret)
	switch {
	case err == nil:
		secret, decErr := hex.DecodeString(hexSecret)
		if decErr != nil || len(secret) < 32 {
			return nil, fmt.Errorf("ingest: stored secret is corrupt; " +
				"delete the ingest_secret row to regenerate (this resets visitor identity)")
		}
		return &Identifier{secret: secret}, nil

	case errors.Is(err, store.ErrNotFound):
		secret := make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return nil, fmt.Errorf("ingest: generate secret: %w", err)
		}
		if err := st.SetSetting(ctx, settingIngestSecret, hex.EncodeToString(secret)); err != nil {
			return nil, fmt.Errorf("ingest: persist secret: %w", err)
		}
		return &Identifier{secret: secret}, nil

	default:
		return nil, fmt.Errorf("ingest: load secret: %w", err)
	}
}

// saltFor returns the salt for the given instant's UTC day, recomputing it only
// when the day rolls over.
func (id *Identifier) saltFor(now time.Time) []byte {
	day := now.UTC().Format("2006-01-02")

	id.mu.RLock()
	if id.saltDay == day {
		salt := id.saltHMAC
		id.mu.RUnlock()
		return salt
	}
	id.mu.RUnlock()

	id.mu.Lock()
	defer id.mu.Unlock()
	if id.saltDay == day { // another goroutine rotated it while we waited
		return id.saltHMAC
	}
	mac := hmac.New(sha256.New, id.secret)
	mac.Write([]byte(day))
	id.saltDay, id.saltHMAC = day, mac.Sum(nil)
	return id.saltHMAC
}

// VisitorHash computes the daily, per-site visitor hash. The IP is used here and
// then discarded: it is never written to the database, a log, or a response.
func (id *Identifier) VisitorHash(websiteID, ip, userAgent string, now time.Time) string {
	mac := hmac.New(sha256.New, id.saltFor(now))
	mac.Write([]byte(websiteID))
	mac.Write([]byte{0}) // domain separator: fields cannot run together
	mac.Write([]byte(ip))
	mac.Write([]byte{0})
	mac.Write([]byte(userAgent))
	return hex.EncodeToString(mac.Sum(nil))
}
