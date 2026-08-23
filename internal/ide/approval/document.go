package approval

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"cursor/internal/ide/workspace"
	"github.com/google/uuid"
)

var (
	fingerprintPattern = regexp.MustCompile(`^ide-operation-v1:sha256:[0-9a-f]{64}$`)
	tokenPattern       = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,95}$`)
	kindPattern        = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	impactPattern      = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
)

func normalizeRequest(request Request) (Request, error) {
	if !validUUID(request.WorkspaceID) || !validFingerprint(request.Fingerprint) || !kindPattern.MatchString(request.Kind) || (request.RunID != "" && !validToken(request.RunID, 96)) {
		return Request{}, fmt.Errorf("%w: identifiers", ErrInvalidRequest)
	}
	summary, err := normalizeSummary(request.Summary)
	if err != nil {
		return Request{}, err
	}
	if request.TTL < 0 {
		return Request{}, fmt.Errorf("%w: negative TTL", ErrInvalidRequest)
	}
	if request.TTL == 0 {
		request.TTL = defaultTTL
	}
	if request.TTL > maximumTTL {
		request.TTL = maximumTTL
	}
	request.Summary = summary
	return request, nil
}

func normalizeSummary(summary Summary) (Summary, error) {
	title, err := sanitizeDisplayText(summary.Title, 160)
	if err != nil || title == "" {
		return Summary{}, fmt.Errorf("%w: summary title", ErrInvalidRequest)
	}
	target := strings.TrimSpace(summary.Target)
	if target != "" {
		canonical, err := workspace.ValidateRelativeDisplayPath(target)
		if err != nil {
			return Summary{}, fmt.Errorf("%w: summary target", ErrInvalidRequest)
		}
		target = canonical
	}
	if len(summary.ImpactCodes) > 8 {
		return Summary{}, fmt.Errorf("%w: impact codes", ErrInvalidRequest)
	}
	codes := make([]string, 0, len(summary.ImpactCodes))
	seen := map[string]struct{}{}
	for _, code := range summary.ImpactCodes {
		code = strings.TrimSpace(code)
		if !impactPattern.MatchString(code) {
			return Summary{}, fmt.Errorf("%w: impact code", ErrInvalidRequest)
		}
		if _, exists := seen[code]; exists {
			return Summary{}, fmt.Errorf("%w: duplicate impact code", ErrInvalidRequest)
		}
		seen[code] = struct{}{}
		codes = append(codes, code)
	}
	sort.Strings(codes)
	return Summary{Title: title, Target: target, ImpactCodes: codes}, nil
}

func validateDocument(document approvalDocument) error {
	if document.SchemaVersion != documentVersion || len(document.Approvals) > maxApprovalRecords || document.Approvals == nil {
		return fmt.Errorf("%w: document schema", ErrStoreInvalid)
	}
	ids := make(map[string]struct{}, len(document.Approvals))
	active := 0
	for _, record := range document.Approvals {
		if !validUUID(record.ID) || !validUUID(record.WorkspaceID) || !kindPattern.MatchString(record.Kind) || !validFingerprint(record.Fingerprint) || (record.RunID != "" && !validToken(record.RunID, 96)) || !validState(record.State) || record.CreatedAt.IsZero() || record.ExpiresAt.IsZero() || record.StateChangedAt.IsZero() || !record.ExpiresAt.After(record.CreatedAt) || record.StateChangedAt.Before(record.CreatedAt) {
			return fmt.Errorf("%w: approval record", ErrStoreInvalid)
		}
		normalized, err := normalizeSummary(record.Summary)
		if err != nil || normalized.Title != record.Summary.Title || normalized.Target != record.Summary.Target || !sameCodes(normalized.ImpactCodes, record.Summary.ImpactCodes) {
			return fmt.Errorf("%w: approval summary", ErrStoreInvalid)
		}
		if _, exists := ids[record.ID]; exists {
			return fmt.Errorf("%w: duplicate approval ID", ErrStoreInvalid)
		}
		ids[record.ID] = struct{}{}
		if record.State == StatePending || record.State == StateApproved {
			active++
		}
	}
	if active > maxActiveApprovals {
		return fmt.Errorf("%w: active approvals", ErrStoreInvalid)
	}
	return nil
}

func expireAndPrune(records []approvalRecord, now time.Time) ([]approvalRecord, bool) {
	next := append([]approvalRecord(nil), records...)
	changed := false
	kept := next[:0]
	for _, record := range next {
		if (record.State == StatePending || record.State == StateApproved) && !now.Before(record.ExpiresAt) {
			record.State = StateExpired
			record.StateChangedAt = now
			changed = true
		}
		if isTerminal(record.State) && !now.Before(record.StateChangedAt.Add(terminalRetention)) {
			changed = true
			continue
		}
		kept = append(kept, record)
	}
	return kept, changed
}

func activeApprovalCount(records []approvalRecord) int {
	count := 0
	for _, record := range records {
		if record.State == StatePending || record.State == StateApproved {
			count++
		}
	}
	return count
}
func validState(state State) bool {
	return state == StatePending || state == StateApproved || state == StateRejected || state == StateCanceled || state == StateExpired || state == StateConsumed
}
func isTerminal(state State) bool {
	return state == StateRejected || state == StateCanceled || state == StateExpired || state == StateConsumed
}
func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}
func validFingerprint(value string) bool  { return fingerprintPattern.MatchString(value) }
func validToken(value string, _ int) bool { return tokenPattern.MatchString(value) }
func cloneSummary(summary Summary) Summary {
	return Summary{Title: summary.Title, Target: summary.Target, ImpactCodes: append([]string(nil), summary.ImpactCodes...)}
}
func sameCodes(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}
func validContext(ctx context.Context) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	return ctx.Err()
}

// Keep time imported in this file because persisted record validation is intentionally time-aware.
var _ = time.Time{}
