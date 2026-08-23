package gitstatus

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestSnapshotReadsRealRepositoryWithoutLeakingSecrets(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "src", "main.go"), "package main\n")
	initGitRepo(t, root)
	runGit(t, root, "config", "user.email", "dev@example.com")
	runGit(t, root, "config", "user.name", "Dev")
	runGit(t, root, "add", "src/main.go")
	runGit(t, root, "commit", "--no-gpg-sign", "-m", "init")
	writeFile(t, filepath.Join(root, "src", "main.go"), "package main\n+needle\n")
	runGit(t, root, "remote", "add", "origin", "https://user:ghp_secret@github.com/org/repo.git")

	store := New(func(context.Context, string) (string, error) {
		return root, nil
	}, NewSystemRunner())
	snapshot, err := store.Snapshot(context.Background(), "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if !snapshot.Available || snapshot.Branch != "main" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if len(snapshot.Remotes) != 1 || snapshot.Remotes[0].URL != "https://github.com/org/repo.git" {
		t.Fatalf("remotes = %+v", snapshot.Remotes)
	}
	if !strings.Contains(snapshot.Diff, "needle") {
		t.Fatalf("diff missing needle: %q", snapshot.Diff)
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	encoded := strings.ToLower(strings.ReplaceAll(string(raw), "\\", "/"))
	host := strings.ToLower(strings.ReplaceAll(root, "\\", "/"))
	if strings.Contains(encoded, "ghp_secret") || strings.Contains(encoded, host) {
		t.Fatalf("snapshot leaked secret or host path: %s", raw)
	}
}

func TestSnapshotUnavailableOutsideGitWorkTree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	store := New(func(context.Context, string) (string, error) {
		return t.TempDir(), nil
	}, NewSystemRunner())
	snapshot, err := store.Snapshot(context.Background(), "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if snapshot.Available {
		t.Fatalf("snapshot.Available = true, want false")
	}
}

func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	if err := tryGit(t, dir, "init", "-b", "main"); err != nil {
		runGit(t, dir, "init")
		runGit(t, dir, "symbolic-ref", "HEAD", "refs/heads/main")
	}
}

func tryGit(t *testing.T, dir string, args ...string) error {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = isolatedGitEnv(t)
	return command.Run()
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = isolatedGitEnv(t)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v error = %v\n%s", args, err, output)
	}
}

func isolatedGitEnv(t *testing.T) []string {
	t.Helper()
	empty := filepath.Join(t.TempDir(), "empty.gitconfig")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	env := gitCommandEnv()
	return append(env,
		"GIT_CONFIG_GLOBAL="+empty,
		"GIT_CONFIG_SYSTEM="+empty,
		"GIT_AUTHOR_NAME=Dev",
		"GIT_AUTHOR_EMAIL=dev@example.com",
		"GIT_COMMITTER_NAME=Dev",
		"GIT_COMMITTER_EMAIL=dev@example.com",
	)
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
