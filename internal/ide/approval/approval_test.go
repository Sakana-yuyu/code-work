package approval

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestApprovalPersistsSingleUseClaim(t *testing.T) {
	root := t.TempDir()
	workspaceID := uuid.NewString()
	store := New(root)
	approval, err := store.Request(context.Background(), testRequest(workspaceID))
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	if approval.State != StatePending || approval.ID == "" {
		t.Fatalf("pending approval = %+v", approval)
	}
	approved, err := store.Approve(context.Background(), workspaceID, approval.ID)
	if err != nil || approved.State != StateApproved {
		t.Fatalf("Approve() = (%+v, %v)", approved, err)
	}
	claim, err := store.Claim(context.Background(), workspaceID, approval.ID, testFingerprint())
	if err != nil || claim.ApprovalID != approval.ID {
		t.Fatalf("Claim() = (%+v, %v)", claim, err)
	}
	if _, err := store.Claim(context.Background(), workspaceID, approval.ID, testFingerprint()); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("second Claim() error = %v", err)
	}
	items, err := New(root).List(context.Background(), workspaceID)
	if err != nil || len(items) != 1 || items[0].State != StateConsumed {
		t.Fatalf("reloaded List() = (%+v, %v)", items, err)
	}
	if strings.Contains(items[0].Summary.Title, testFingerprint()) {
		t.Fatal("public approval leaked fingerprint")
	}
}

func TestFingerprintMismatchLeavesApprovalApproved(t *testing.T) {
	workspaceID := uuid.NewString()
	store := New(t.TempDir())
	approval, err := store.Request(context.Background(), testRequest(workspaceID))
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	if _, err := store.Approve(context.Background(), workspaceID, approval.ID); err != nil {
		t.Fatalf("Approve() error = %v", err)
	}
	wrong := "ide-operation-v1:sha256:" + strings.Repeat("b", 64)
	if _, err := store.Claim(context.Background(), workspaceID, approval.ID, wrong); !errors.Is(err, ErrFingerprintMismatch) {
		t.Fatalf("Claim(wrong) error = %v", err)
	}
	items, err := store.List(context.Background(), workspaceID)
	if err != nil || len(items) != 1 || items[0].State != StateApproved {
		t.Fatalf("List() after mismatch = (%+v, %v)", items, err)
	}
}

func TestApprovalExpiryAndCancellation(t *testing.T) {
	workspaceID := uuid.NewString()
	store := New(t.TempDir())
	now := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	request := testRequest(workspaceID)
	request.TTL = time.Minute
	first, err := store.Request(context.Background(), request)
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	secondRequest := request
	secondRequest.RunID = "run_two"
	second, err := store.Request(context.Background(), secondRequest)
	if err != nil {
		t.Fatalf("Request(second) error = %v", err)
	}
	if _, err := store.Approve(context.Background(), workspaceID, second.ID); err != nil {
		t.Fatalf("Approve() error = %v", err)
	}
	now = now.Add(2 * time.Minute)
	items, err := store.List(context.Background(), workspaceID)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if items[0].State != StateExpired || items[1].State != StateExpired {
		t.Fatalf("expired approvals = %+v", items)
	}
	if _, err := store.Claim(context.Background(), workspaceID, first.ID, testFingerprint()); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("expired Claim() error = %v", err)
	}
	thirdRequest := testRequest(workspaceID)
	thirdRequest.RunID = "run_three"
	third, err := store.Request(context.Background(), thirdRequest)
	if err != nil {
		t.Fatalf("Request(third) error = %v", err)
	}
	if count, err := store.CancelRun(context.Background(), workspaceID, "run_three"); err != nil || count != 1 {
		t.Fatalf("CancelRun() = (%d, %v)", count, err)
	}
	items, err = store.List(context.Background(), workspaceID)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if approvalByID(items, third.ID).State != StateCanceled {
		t.Fatalf("canceled approval = %+v", approvalByID(items, third.ID))
	}
}

func TestApprovalSummaryIsSanitized(t *testing.T) {
	workspaceID := uuid.NewString()
	store := New(t.TempDir())
	request := testRequest(workspaceID)
	request.Summary = Summary{Title: "Bearer secret-value C:/Users/Name/.ssh/id_ed25519", Target: "src/main.go", ImpactCodes: []string{"workspace_write"}}
	approval, err := store.Request(context.Background(), request)
	if err != nil {
		t.Fatalf("Request() error = %v", err)
	}
	if strings.Contains(strings.ToLower(approval.Summary.Title), "secret") || strings.Contains(approval.Summary.Title, "C:") || strings.Contains(approval.Summary.Title, "id_ed25519") {
		t.Fatalf("sanitized title leaked sensitive text: %q", approval.Summary.Title)
	}
	request = testRequest(workspaceID)
	request.Summary.Target = ".env"
	if _, err := store.Request(context.Background(), request); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("sensitive target Request() error = %v", err)
	}
}

func TestApprovalStoreFailsClosedOnUnknownDocumentField(t *testing.T) {
	root := t.TempDir()
	path := joinPath(root, approvalRegistryName)
	if err := writeRawApprovalDocument(path, `{"schema_version":1,"unknown":true,"approvals":[]}`); err != nil {
		t.Fatal(err)
	}
	if _, err := New(root).List(context.Background(), uuid.NewString()); !errors.Is(err, ErrStoreInvalid) {
		t.Fatalf("List() error = %v", err)
	}
}

func testRequest(workspaceID string) Request {
	return Request{WorkspaceID: workspaceID, RunID: "run_one", Kind: "workspace_write", Fingerprint: testFingerprint(), Summary: Summary{Title: "Save reviewed file", Target: "src/main.go", ImpactCodes: []string{"workspace_write"}}}
}
func testFingerprint() string { return "ide-operation-v1:sha256:" + strings.Repeat("a", 64) }
func approvalByID(items []Approval, id string) Approval {
	for _, item := range items {
		if item.ID == id {
			return item
		}
	}
	return Approval{}
}

func writeRawApprovalDocument(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), approvalDirectoryPerm); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), approvalFilePerm)
}
