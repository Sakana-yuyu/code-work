package client

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"cursor/internal/ide/workspace"
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

func newTestIDEService(t *testing.T) (*ProxyService, string) {
	t.Helper()
	workspaceRoot := t.TempDir()
	service := &ProxyService{
		ideWorkspaces: workspace.New(t.TempDir()),
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
