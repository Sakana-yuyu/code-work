package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegisterPersistsOpaqueWorkspaceSummary(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	store := New(registryRoot)
	registered, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if registered.ID == "" || registered.Name != filepath.Base(workspaceRoot) {
		t.Fatalf("registered summary = %+v", registered)
	}
	if strings.Contains(strings.Join([]string{registered.ID, registered.Name}, "\n"), workspaceRoot) {
		t.Fatalf("public summary leaked workspace root: %+v", registered)
	}
	again, err := store.Register(context.Background(), workspaceRoot)
	if err != nil || again.ID != registered.ID {
		t.Fatalf("idempotent Register() = (%+v, %v)", again, err)
	}
	reloaded := New(registryRoot)
	items, err := reloaded.List(context.Background())
	if err != nil || len(items) != 1 || items[0].ID != registered.ID {
		t.Fatalf("reloaded List() = (%+v, %v)", items, err)
	}
	if err := reloaded.Remove(context.Background(), registered.ID); err != nil {
		t.Fatalf("Remove() error = %v", err)
	}
	items, err = New(registryRoot).List(context.Background())
	if err != nil || len(items) != 0 {
		t.Fatalf("List() after Remove = (%+v, %v)", items, err)
	}
}

func TestRegistryFailsClosedWhenInvalid(t *testing.T) {
	registryRoot := t.TempDir()
	if err := os.MkdirAll(registryRoot, registryDirectoryPerm); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	path := filepath.Join(registryRoot, registryFileName)
	if err := os.WriteFile(path, []byte(`{"schema_version":1,"unknown":true}`), registryFilePerm); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := New(registryRoot).List(context.Background()); !errors.Is(err, ErrRegistryInvalid) {
		t.Fatalf("List() error = %v, want ErrRegistryInvalid", err)
	}
	persisted, err := os.ReadFile(path)
	if err != nil || string(persisted) != `{"schema_version":1,"unknown":true}` {
		t.Fatalf("invalid registry was modified: %q, %v", persisted, err)
	}
}

func TestWorkspaceFilesystemRejectsSensitiveAndEscapingPaths(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "src", "main.go"), "package main\n// needle\n")
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, ".env"), "TOKEN=secret")
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "binary.dat"), "\x00binary")
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	tree, err := store.Tree(context.Background(), workspace.ID, "")
	if err != nil {
		t.Fatalf("Tree() error = %v", err)
	}
	if containsTreePath(tree.Entries, ".env") {
		t.Fatalf("Tree() exposed sensitive path: %+v", tree.Entries)
	}
	file, err := store.ReadText(context.Background(), workspace.ID, "src/main.go")
	if err != nil || file.Binary || !strings.Contains(file.Text, "needle") || file.Path != "src/main.go" {
		t.Fatalf("ReadText() = (%+v, %v)", file, err)
	}
	binary, err := store.ReadText(context.Background(), workspace.ID, "binary.dat")
	if err != nil || !binary.Binary || binary.Text != "" {
		t.Fatalf("binary ReadText() = (%+v, %v)", binary, err)
	}
	if _, err := store.ReadText(context.Background(), workspace.ID, ".env"); !errors.Is(err, ErrSensitivePath) {
		t.Fatalf("sensitive ReadText() error = %v", err)
	}
	for _, path := range []string{"../outside", "/outside", "C:/outside", "C:outside", `\\server\share`, `\\?\C:\outside`, "src\\main.go"} {
		if _, err := store.ReadText(context.Background(), workspace.ID, path); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("ReadText(%q) error = %v, want ErrInvalidPath", path, err)
		}
	}
	search, err := store.Search(context.Background(), workspace.ID, SearchRequest{Query: "needle"})
	if err != nil || len(search.Matches) != 1 || search.Matches[0].Path != "src/main.go" {
		t.Fatalf("Search() = (%+v, %v)", search, err)
	}
}

func TestRegisterRejectsSensitiveDirectoryNames(t *testing.T) {
	registryRoot := t.TempDir()
	sensitiveRoot := filepath.Join(t.TempDir(), ".ssh")
	if err := os.MkdirAll(sensitiveRoot, 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	_, err := New(registryRoot).Register(context.Background(), sensitiveRoot)
	if !errors.Is(err, ErrSensitivePath) {
		t.Fatalf("Register(sensitive) error = %v, want ErrSensitivePath", err)
	}
}

func TestReadTextMarksTruncatedAndBinaryStates(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	large := strings.Repeat("a", maxReadTextBytes+32)
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "large.txt"), large)
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "notes.bin"), "ok\x00secret")
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	file, err := store.ReadText(context.Background(), workspace.ID, "large.txt")
	if err != nil || !file.Truncated || file.Binary || file.Text != large[:maxReadTextBytes] || file.Size != int64(len(large)) {
		t.Fatalf("truncated ReadText() = (%+v, %v)", file, err)
	}
	binary, err := store.ReadText(context.Background(), workspace.ID, "notes.bin")
	if err != nil || !binary.Binary || binary.Text != "" || binary.Truncated {
		t.Fatalf("binary ReadText() = (%+v, %v)", binary, err)
	}
	assertNoHostPathLeak(t, workspaceRoot, file, binary)
}

func TestReadTextReturnsOpaqueVersionWithoutHostPath(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "readme.txt"), "hello")
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	first, err := store.ReadText(context.Background(), workspace.ID, "readme.txt")
	if err != nil || first.Version == "" {
		t.Fatalf("ReadText() = (%+v, %v)", first, err)
	}
	second, err := store.ReadText(context.Background(), workspace.ID, "readme.txt")
	if err != nil || second.Version != first.Version {
		t.Fatalf("stable version = %q/%q err=%v", first.Version, second.Version, err)
	}
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "readme.txt"), "hello world")
	changed, err := store.ReadText(context.Background(), workspace.ID, "readme.txt")
	if err != nil || changed.Version == "" || changed.Version == first.Version {
		t.Fatalf("changed version = %q want different from %q err=%v", changed.Version, first.Version, err)
	}
	assertNoHostPathLeak(t, workspaceRoot, first, second, changed)
}

func TestWriteTextRejectsStaleVersionAndDoesNotOverwrite(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	path := filepath.Join(workspaceRoot, "readme.txt")
	writeWorkspaceFile(t, path, "hello")
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "notes.bin"), "ok\x00secret")
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	current, err := store.ReadText(context.Background(), workspace.ID, "readme.txt")
	if err != nil {
		t.Fatalf("ReadText() error = %v", err)
	}
	written, err := store.WriteText(context.Background(), workspace.ID, WriteRequest{
		Path:            "readme.txt",
		Text:            "hello saved",
		ExpectedVersion: current.Version,
	})
	if err != nil || written.Text != "hello saved" || written.Version == "" || written.Version == current.Version {
		t.Fatalf("WriteText() = (%+v, %v)", written, err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "hello saved" {
		t.Fatalf("disk content = %q err=%v", data, err)
	}
	if _, err := store.WriteText(context.Background(), workspace.ID, WriteRequest{
		Path:            "readme.txt",
		Text:            "stale overwrite",
		ExpectedVersion: current.Version,
	}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("stale WriteText() error = %v, want ErrVersionConflict", err)
	}
	data, err = os.ReadFile(path)
	if err != nil || string(data) != "hello saved" {
		t.Fatalf("stale write mutated disk = %q err=%v", data, err)
	}
	binary, err := store.ReadText(context.Background(), workspace.ID, "notes.bin")
	if err != nil {
		t.Fatalf("binary ReadText() error = %v", err)
	}
	if _, err := store.WriteText(context.Background(), workspace.ID, WriteRequest{
		Path:            "notes.bin",
		Text:            "nope",
		ExpectedVersion: binary.Version,
	}); !errors.Is(err, ErrWriteNotAllowed) {
		t.Fatalf("binary WriteText() error = %v, want ErrWriteNotAllowed", err)
	}
	assertNoHostPathLeak(t, workspaceRoot, written)
}

func TestSearchSkipsBinarySensitiveAndOversizedFiles(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "src", "main.go"), "package main\n// needle\n")
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, ".env"), "needle=secret")
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "blob.bin"), "needle\x00")
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "huge.txt"), strings.Repeat("needle", (maxSearchFileBytes/6)+8))
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	result, err := store.Search(context.Background(), workspace.ID, SearchRequest{Query: "needle"})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Matches) != 1 || result.Matches[0].Path != "src/main.go" {
		t.Fatalf("Search() matches = %+v", result.Matches)
	}
	if result.FilesSkipped < 3 {
		t.Fatalf("Search() FilesSkipped = %d, want at least 3", result.FilesSkipped)
	}
	assertNoHostPathLeak(t, workspaceRoot, result)
}

func TestWorkspaceOperationsFailWhenRootBecomesUnavailable(t *testing.T) {
	registryRoot := t.TempDir()
	parent := t.TempDir()
	workspaceRoot := filepath.Join(parent, "project")
	if err := os.MkdirAll(workspaceRoot, 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	writeWorkspaceFile(t, filepath.Join(workspaceRoot, "readme.txt"), "hello")
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	if err := os.RemoveAll(workspaceRoot); err != nil {
		t.Fatalf("RemoveAll() error = %v", err)
	}
	if _, err := store.Tree(context.Background(), workspace.ID, ""); !errors.Is(err, ErrWorkspaceUnavailable) {
		t.Fatalf("Tree() error = %v, want ErrWorkspaceUnavailable", err)
	}
	if _, err := store.ReadText(context.Background(), workspace.ID, "readme.txt"); !errors.Is(err, ErrWorkspaceUnavailable) {
		t.Fatalf("ReadText() error = %v, want ErrWorkspaceUnavailable", err)
	}
	if _, err := store.Search(context.Background(), workspace.ID, SearchRequest{Query: "hello"}); !errors.Is(err, ErrWorkspaceUnavailable) {
		t.Fatalf("Search() error = %v, want ErrWorkspaceUnavailable", err)
	}
}

func TestWorkspaceFilesystemDoesNotFollowSymlinks(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	outsideRoot := t.TempDir()
	outsideFile := filepath.Join(outsideRoot, "outside.txt")
	writeWorkspaceFile(t, outsideFile, "outside")
	linkPath := filepath.Join(workspaceRoot, "linked.txt")
	if err := os.Symlink(outsideFile, linkPath); err != nil {
		t.Skipf("symlink unavailable in this environment: %v", err)
	}
	store := New(registryRoot)
	workspace, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	tree, err := store.Tree(context.Background(), workspace.ID, "")
	if err != nil || !containsTreeKind(tree.Entries, "linked.txt", "symlink") {
		t.Fatalf("Tree() = (%+v, %v)", tree, err)
	}
	if _, err := store.ReadText(context.Background(), workspace.ID, "linked.txt"); !errors.Is(err, ErrSymlinkNotAllowed) {
		t.Fatalf("ReadText(link) error = %v, want ErrSymlinkNotAllowed", err)
	}
}

func writeWorkspaceFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func TestAuthorizedRootResolvesRegisteredWorkspace(t *testing.T) {
	registryRoot := t.TempDir()
	workspaceRoot := t.TempDir()
	store := New(registryRoot)
	registered, err := store.Register(context.Background(), workspaceRoot)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	root, err := store.AuthorizedRoot(context.Background(), registered.ID)
	if err != nil || !samePath(root, workspaceRoot) {
		t.Fatalf("AuthorizedRoot() = (%q, %v)", root, err)
	}
	if _, err := store.AuthorizedRoot(context.Background(), ""); !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("empty AuthorizedRoot() error = %v", err)
	}
}

func containsTreePath(entries []TreeEntry, path string) bool {
	for _, entry := range entries {
		if entry.Path == path {
			return true
		}
	}
	return false
}

func containsTreeKind(entries []TreeEntry, path, kind string) bool {
	for _, entry := range entries {
		if entry.Path == path && entry.Kind == kind {
			return true
		}
	}
	return false
}

func assertNoHostPathLeak(t *testing.T, hostPath string, values ...any) {
	t.Helper()
	for _, value := range values {
		encoded := strings.ToLower(strings.ReplaceAll(fmt.Sprintf("%+v", value), "\\", "/"))
		leaked := strings.ToLower(strings.ReplaceAll(hostPath, "\\", "/"))
		if leaked != "" && strings.Contains(encoded, leaked) {
			t.Fatalf("value leaked host path %q: %+v", hostPath, value)
		}
	}
}
