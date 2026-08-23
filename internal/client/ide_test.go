package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cursor/internal/ide/approval"
	"cursor/internal/ide/gitstatus"
	"cursor/internal/ide/knownhosts"
	"cursor/internal/ide/sshvault"
	"cursor/internal/ide/workspace"

	"golang.org/x/crypto/ssh"
)

func TestSelectAndRegisterIDEWorkspaceReturnsOpaqueSummary(t *testing.T) {
	service, workspaceRoot := newTestIDEService(t)
	summary, err := service.SelectAndRegisterIDEWorkspace()
	if err != nil {
		t.Fatalf("SelectAndRegisterIDEWorkspace() error = %v", err)
	}
	if summary.ID == "" || summary.Name != filepath.Base(workspaceRoot) {
		t.Fatalf("summary = %+v", summary)
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if strings.Contains(strings.ToLower(string(raw)), strings.ToLower(workspaceRoot)) {
		t.Fatalf("summary leaked host path: %s", raw)
	}
}

func TestSelectAndRegisterIDEWorkspaceCanceled(t *testing.T) {
	service, _ := newTestIDEService(t)
	service.selectIDEDirectory = func() (string, error) {
		return "", ErrIDEWorkspaceSelectionCanceled
	}
	_, err := service.SelectAndRegisterIDEWorkspace()
	if !errors.Is(err, ErrIDEWorkspaceSelectionCanceled) {
		t.Fatalf("canceled error = %v, want ErrIDEWorkspaceSelectionCanceled", err)
	}
}

func TestIDEWorkspaceOperationsUseWorkspaceIDAndRejectHostPaths(t *testing.T) {
	service, workspaceRoot := newTestIDEService(t)
	writeFile(t, filepath.Join(workspaceRoot, "src", "main.go"), "package main\n// needle\n")
	writeFile(t, filepath.Join(workspaceRoot, ".env"), "TOKEN=secret")
	writeFile(t, filepath.Join(workspaceRoot, "binary.dat"), "\x00bin")
	summary, err := service.SelectAndRegisterIDEWorkspace()
	if err != nil {
		t.Fatalf("SelectAndRegisterIDEWorkspace() error = %v", err)
	}
	items, err := service.ListIDEWorkspaces()
	if err != nil || len(items) != 1 || items[0].ID != summary.ID {
		t.Fatalf("ListIDEWorkspaces() = (%+v, %v)", items, err)
	}
	tree, err := service.GetIDEWorkspaceTree(summary.ID, "")
	if err != nil {
		t.Fatalf("GetIDEWorkspaceTree() error = %v", err)
	}
	if containsPath(tree.Entries, ".env") {
		t.Fatalf("tree exposed sensitive path: %+v", tree.Entries)
	}
	file, err := service.ReadIDEWorkspaceText(summary.ID, "src/main.go")
	if err != nil || file.Binary || !strings.Contains(file.Text, "needle") {
		t.Fatalf("ReadIDEWorkspaceText() = (%+v, %v)", file, err)
	}
	if _, err := service.ReadIDEWorkspaceText(summary.ID, workspaceRoot); !errors.Is(err, workspace.ErrInvalidPath) && !isMappedIDEError(err, "路径不合法") {
		t.Fatalf("host path ReadIDEWorkspaceText() error = %v", err)
	}
	search, err := service.SearchIDEWorkspace(summary.ID, "", "needle")
	if err != nil || len(search.Matches) != 1 || search.Matches[0].Path != "src/main.go" {
		t.Fatalf("SearchIDEWorkspace() = (%+v, %v)", search, err)
	}
	assertJSONHasNoHostPath(t, workspaceRoot, items, tree, file, search)
	if err := service.RemoveIDEWorkspace(summary.ID); err != nil {
		t.Fatalf("RemoveIDEWorkspace() error = %v", err)
	}
}

func TestIDEWorkspaceWriteRequiresApprovalAndRejectsStaleVersion(t *testing.T) {
	service, workspaceRoot := newTestIDEService(t)
	writeFile(t, filepath.Join(workspaceRoot, "src", "main.go"), "package main\n")
	summary, err := service.SelectAndRegisterIDEWorkspace()
	if err != nil {
		t.Fatalf("SelectAndRegisterIDEWorkspace() error = %v", err)
	}
	current, err := service.ReadIDEWorkspaceText(summary.ID, "src/main.go")
	if err != nil {
		t.Fatalf("ReadIDEWorkspaceText() error = %v", err)
	}
	if _, err := service.CommitIDEWorkspaceWrite(summary.ID, "00000000-0000-4000-8000-000000000000", "src/main.go", "package saved\n", current.Version); err == nil {
		t.Fatal("CommitIDEWorkspaceWrite() succeeded without approval")
	}
	preview, err := service.PreviewIDEWorkspaceWrite(summary.ID, "src/main.go", "package saved\n", current.Version)
	if err != nil || preview.Approval.ID == "" || preview.Approval.State != "pending" || preview.Path != "src/main.go" || preview.After != "package saved\n" {
		t.Fatalf("PreviewIDEWorkspaceWrite() = (%+v, %v)", preview, err)
	}
	if strings.Contains(fmtJSON(t, preview), workspaceRoot) {
		t.Fatalf("preview leaked host path: %+v", preview)
	}
	if _, err := service.CommitIDEWorkspaceWrite(summary.ID, preview.Approval.ID, "src/main.go", "package saved\n", current.Version); err == nil {
		t.Fatal("CommitIDEWorkspaceWrite() succeeded before approve")
	}
	approved, err := service.ApproveIDEApproval(summary.ID, preview.Approval.ID)
	if err != nil || approved.State != "approved" {
		t.Fatalf("ApproveIDEApproval() = (%+v, %v)", approved, err)
	}
	writeFile(t, filepath.Join(workspaceRoot, "src", "main.go"), "package changed\n")
	if _, err := service.CommitIDEWorkspaceWrite(summary.ID, preview.Approval.ID, "src/main.go", "package saved\n", current.Version); !isMappedIDEError(err, "版本冲突") && !errors.Is(err, workspace.ErrVersionConflict) {
		t.Fatalf("conflict CommitIDEWorkspaceWrite() error = %v", err)
	}
	disk, err := os.ReadFile(filepath.Join(workspaceRoot, "src", "main.go"))
	if err != nil || string(disk) != "package changed\n" {
		t.Fatalf("conflict mutated disk = %q err=%v", disk, err)
	}
	fresh, err := service.ReadIDEWorkspaceText(summary.ID, "src/main.go")
	if err != nil {
		t.Fatalf("ReadIDEWorkspaceText() after conflict error = %v", err)
	}
	preview, err = service.PreviewIDEWorkspaceWrite(summary.ID, "src/main.go", "package saved\n", fresh.Version)
	if err != nil {
		t.Fatalf("PreviewIDEWorkspaceWrite() retry error = %v", err)
	}
	if _, err := service.ApproveIDEApproval(summary.ID, preview.Approval.ID); err != nil {
		t.Fatalf("ApproveIDEApproval() retry error = %v", err)
	}
	written, err := service.CommitIDEWorkspaceWrite(summary.ID, preview.Approval.ID, "src/main.go", "package saved\n", fresh.Version)
	if err != nil || written.Text != "package saved\n" || written.Version == fresh.Version {
		t.Fatalf("CommitIDEWorkspaceWrite() = (%+v, %v)", written, err)
	}
	if _, err := service.CommitIDEWorkspaceWrite(summary.ID, preview.Approval.ID, "src/main.go", "package saved\n", written.Version); err == nil {
		t.Fatal("second CommitIDEWorkspaceWrite() reused consumed approval")
	}
	assertJSONHasNoHostPath(t, workspaceRoot, preview, written)
}

func TestGetIDEGitSnapshotSanitizesRemotesAndOmitsHostPaths(t *testing.T) {
	service, workspaceRoot := newTestIDEService(t)
	summary, err := service.SelectAndRegisterIDEWorkspace()
	if err != nil {
		t.Fatalf("SelectAndRegisterIDEWorkspace() error = %v", err)
	}
	service.ideGit = gitstatus.New(service.ideWorkspaces.AuthorizedRoot, &stubGitRunner{outputs: map[string]string{
		"rev-parse --is-inside-work-tree":                "true\n",
		"rev-parse --abbrev-ref HEAD":                    "main\n",
		"status --porcelain=v1 -b --untracked-files=all": "## main...origin/main [ahead 1, behind 2]\n M src/main.go\n?? notes.md\n",
		"diff --no-ext-diff --no-color -U3 HEAD":         "diff --git a/src/main.go b/src/main.go\n+needle\n",
		"remote -v":                                      "origin\thttps://user:ghp_secret@github.com/org/repo.git (fetch)\norigin\thttps://user:ghp_secret@github.com/org/repo.git (push)\n",
	}})
	snapshot, err := service.GetIDEGitSnapshot(summary.ID)
	if err != nil {
		t.Fatalf("GetIDEGitSnapshot() error = %v", err)
	}
	if !snapshot.Available || snapshot.Branch != "main" || snapshot.Ahead != 1 || snapshot.Behind != 2 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if len(snapshot.Remotes) != 1 || snapshot.Remotes[0].URL != "https://github.com/org/repo.git" {
		t.Fatalf("remotes = %+v", snapshot.Remotes)
	}
	encoded := strings.ToLower(fmtJSON(t, snapshot))
	if strings.Contains(encoded, "ghp_secret") {
		t.Fatalf("snapshot leaked secret: %s", encoded)
	}
	assertJSONHasNoHostPath(t, workspaceRoot, snapshot)
	if _, err := service.GetIDEGitSnapshot("00000000-0000-4000-8000-000000000000"); !isMappedIDEError(err, "工作区不存在") && !errors.Is(err, workspace.ErrWorkspaceNotFound) {
		t.Fatalf("missing workspace GetIDEGitSnapshot() error = %v", err)
	}
}

func TestIDESSHVaultOmitsPrivateKeyAndPassphrase(t *testing.T) {
	service, _ := newTestIDEService(t)
	privatePEM, _, _ := mustClientSSHKey(t)
	passphrase := "super-secret-passphrase"
	imported, err := service.ImportIDESSHKey("github", privatePEM, passphrase)
	if err != nil || imported.Name != "github" || imported.Fingerprint == "" || imported.PublicKey == "" {
		t.Fatalf("ImportIDESSHKey() = (%+v, %v)", imported, err)
	}
	generated, err := service.GenerateIDESSHKey("local")
	if err != nil || generated.Fingerprint == "" {
		t.Fatalf("GenerateIDESSHKey() = (%+v, %v)", generated, err)
	}
	items, err := service.ListIDESSHKeys()
	if err != nil || len(items) != 2 {
		t.Fatalf("ListIDESSHKeys() = (%+v, %v)", items, err)
	}
	encoded := strings.ToLower(fmtJSON(t, imported) + fmtJSON(t, generated) + fmtJSON(t, items))
	if strings.Contains(encoded, "begin ") || strings.Contains(encoded, strings.ToLower(passphrase)) || strings.Contains(encoded, "privatekey") {
		t.Fatalf("SSH DTO leaked secret: %s", encoded)
	}
	if err := service.RemoveIDESSHKey(imported.ID); err != nil {
		t.Fatalf("RemoveIDESSHKey() error = %v", err)
	}
}

func TestIDEKnownHostRequiresApprovalAndDoesNotAutoAccept(t *testing.T) {
	service, _ := newTestIDEService(t)
	summary, err := service.SelectAndRegisterIDEWorkspace()
	if err != nil {
		t.Fatalf("SelectAndRegisterIDEWorkspace() error = %v", err)
	}
	_, public, fingerprint := mustClientSSHKey(t)
	if items, err := service.ListIDEKnownHosts(); err != nil || len(items) != 0 {
		t.Fatalf("ListIDEKnownHosts() = (%+v, %v)", items, err)
	}
	preview, err := service.PreviewIDEKnownHost(summary.ID, "github.com", 22, public)
	if err != nil || preview.Status != knownhosts.StatusUnknown || preview.Approval.State != approval.StatePending {
		t.Fatalf("PreviewIDEKnownHost() = (%+v, %v)", preview, err)
	}
	if preview.Fingerprint != fingerprint || preview.Host != "github.com" {
		t.Fatalf("preview identity = %+v", preview)
	}
	if _, err := os.Stat(service.ideKnownHosts.FilePath()); !os.IsNotExist(err) {
		t.Fatalf("preview wrote known_hosts: %v", err)
	}
	if _, err := service.CommitIDEKnownHost(summary.ID, preview.Approval.ID, "github.com", 22, public); err == nil {
		t.Fatal("CommitIDEKnownHost before approve = nil")
	}
	if _, err := os.Stat(service.ideKnownHosts.FilePath()); !os.IsNotExist(err) {
		t.Fatalf("unapproved commit wrote known_hosts: %v", err)
	}
	if _, err := service.ApproveIDEApproval(summary.ID, preview.Approval.ID); err != nil {
		t.Fatalf("ApproveIDEApproval() error = %v", err)
	}
	committed, err := service.CommitIDEKnownHost(summary.ID, preview.Approval.ID, "github.com", 22, public)
	if err != nil || committed.Fingerprint != fingerprint {
		t.Fatalf("CommitIDEKnownHost() = (%+v, %v)", committed, err)
	}
	items, err := service.ListIDEKnownHosts()
	if err != nil || len(items) != 1 || items[0].Host != "github.com" {
		t.Fatalf("ListIDEKnownHosts() after commit = (%+v, %v)", items, err)
	}
	_, otherPublic, _ := mustClientSSHKey(t)
	changed, err := service.PreviewIDEKnownHost(summary.ID, "github.com", 22, otherPublic)
	if err != nil || changed.Status != knownhosts.StatusMismatch {
		t.Fatalf("PreviewIDEKnownHost(changed) = (%+v, %v)", changed, err)
	}
	if _, err := service.ApproveIDEApproval(summary.ID, changed.Approval.ID); err != nil {
		t.Fatalf("ApproveIDEApproval(changed) error = %v", err)
	}
	if _, err := service.CommitIDEKnownHost(summary.ID, preview.Approval.ID, "github.com", 22, otherPublic); err == nil {
		t.Fatal("CommitIDEKnownHost reused unknown-host approval = nil")
	}
	replaced, err := service.CommitIDEKnownHost(summary.ID, changed.Approval.ID, "github.com", 22, otherPublic)
	if err != nil || replaced.PublicKey != strings.TrimSpace(otherPublic) {
		t.Fatalf("CommitIDEKnownHost(changed) = (%+v, %v)", replaced, err)
	}
	encoded := strings.ToLower(fmtJSON(t, preview) + fmtJSON(t, committed) + fmtJSON(t, items) + fmtJSON(t, replaced))
	if strings.Contains(encoded, "privatekey") || strings.Contains(encoded, "begin ") || strings.Contains(encoded, "known_hosts") {
		t.Fatalf("known host DTO leaked secret or path: %s", encoded)
	}
}

func TestIDEHostKeyProbeDoesNotWriteKnownHosts(t *testing.T) {
	service, _ := newTestIDEService(t)
	if _, err := service.ProbeIDEHostKey(`C:\windows`, 22); err == nil {
		t.Fatal("ProbeIDEHostKey(host path) = nil")
	}
	if _, err := service.ProbeIDEHostKey("127.0.0.1", 1); err == nil {
		t.Fatal("ProbeIDEHostKey(closed port) = nil")
	}
	if _, err := os.Stat(service.ideKnownHosts.FilePath()); !os.IsNotExist(err) {
		t.Fatalf("ProbeIDEHostKey wrote known_hosts: %v", err)
	}
}

func mustClientSSHKey(t *testing.T) (privatePEM, publicKey, fingerprint string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	block, err := ssh.MarshalPrivateKey(private, "")
	if err != nil {
		t.Fatalf("MarshalPrivateKey() error = %v", err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatalf("NewSignerFromKey() error = %v", err)
	}
	return string(pem.EncodeToMemory(block)), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))), ssh.FingerprintSHA256(signer.PublicKey())
}

type stubSSHProtector struct{}

func (stubSSHProtector) Protect(plaintext []byte) ([]byte, error) {
	out := make([]byte, len(plaintext)+1)
	out[0] = 'S'
	for index, value := range plaintext {
		out[index+1] = value ^ 0x5A
	}
	return out, nil
}

func (stubSSHProtector) Unprotect(ciphertext []byte) ([]byte, error) {
	out := make([]byte, len(ciphertext)-1)
	for index, value := range ciphertext[1:] {
		out[index] = value ^ 0x5A
	}
	return out, nil
}

type stubGitRunner struct {
	outputs map[string]string
}

func (runner *stubGitRunner) Run(_ context.Context, _ string, args ...string) (string, error) {
	if output, ok := runner.outputs[strings.Join(args, " ")]; ok {
		return output, nil
	}
	return "", gitstatus.ErrGitUnavailable
}

func fmtJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return string(raw)
}

func newTestIDEService(t *testing.T) (*ProxyService, string) {
	t.Helper()
	workspaceRoot := t.TempDir()
	workspaces := workspace.New(t.TempDir())
	service := &ProxyService{
		ideWorkspaces: workspaces,
		ideApprovals:  approval.New(t.TempDir()),
		ideGit:        gitstatus.New(workspaces.AuthorizedRoot, gitstatus.NewSystemRunner()),
		ideSSH:        sshvault.New(t.TempDir(), stubSSHProtector{}),
		ideKnownHosts: knownhosts.New(t.TempDir()),
		selectIDEDirectory: func() (string, error) {
			return workspaceRoot, nil
		},
	}
	return service, workspaceRoot
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

func containsPath(entries []workspace.TreeEntry, path string) bool {
	for _, entry := range entries {
		if entry.Path == path {
			return true
		}
	}
	return false
}

func assertJSONHasNoHostPath(t *testing.T, hostPath string, values ...any) {
	t.Helper()
	leaked := strings.ToLower(strings.ReplaceAll(hostPath, "\\", "/"))
	for _, value := range values {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("Marshal() error = %v", err)
		}
		encoded := strings.ToLower(strings.ReplaceAll(string(raw), "\\", "/"))
		if leaked != "" && strings.Contains(encoded, leaked) {
			t.Fatalf("json leaked host path %q: %s", hostPath, raw)
		}
	}
}

func isMappedIDEError(err error, fragment string) bool {
	return err != nil && strings.Contains(err.Error(), fragment)
}
