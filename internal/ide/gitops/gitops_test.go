package gitops

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareRejectsShellAndCredentialRemotes(t *testing.T) {
	store := New(func(context.Context, string) (string, error) {
		return t.TempDir(), nil
	}, &recordRunner{})
	for _, remote := range []string{
		"https://user:ghp_secret@github.com/org/repo.git",
		"file:///tmp/repo",
		`C:\src\repo`,
		"https://github.com/org/repo.git;rm -rf /",
		"git@github.com:org/repo.git && calc",
	} {
		if _, err := store.Prepare(Operation{Kind: KindClone, RemoteURL: remote, Directory: "src"}); err == nil {
			t.Fatalf("Prepare(%q) = nil", remote)
		}
	}
	if _, err := store.Prepare(Operation{Kind: KindClone, RemoteURL: "https://github.com/org/repo.git", Directory: "../escape"}); err == nil {
		t.Fatal("Prepare(relative escape) = nil")
	}
	if _, err := store.Prepare(Operation{Kind: "status", RemoteURL: "https://github.com/org/repo.git"}); err == nil {
		t.Fatal("Prepare(untyped kind) = nil")
	}
}

func TestPrepareBuildsTypedArgvWithoutHostPaths(t *testing.T) {
	store := New(nil, nil)
	prepared, err := store.Prepare(Operation{
		Kind:      KindClone,
		RemoteURL: "https://github.com/org/repo.git",
		Directory: "vendor/repo",
	})
	if err != nil {
		t.Fatalf("Prepare(clone) error = %v", err)
	}
	want := []string{"clone", "--", "https://github.com/org/repo.git", "vendor/repo"}
	if strings.Join(prepared.Argv, " ") != strings.Join(want, " ") {
		t.Fatalf("clone argv = %v, want %v", prepared.Argv, want)
	}
	stage, err := store.Prepare(Operation{Kind: KindStage, Paths: []string{"src/main.go", "README.md"}})
	if err != nil || strings.Join(stage.Argv, " ") != "add -- src/main.go README.md" {
		t.Fatalf("stage = (%+v, %v)", stage, err)
	}
	all, err := store.Prepare(Operation{Kind: KindStage, StageAll: true})
	if err != nil || strings.Join(all.Argv, " ") != "add -A --" {
		t.Fatalf("stage all = (%+v, %v)", all, err)
	}
	commit, err := store.Prepare(Operation{Kind: KindCommit, Message: "fix parser"})
	if err != nil || strings.Join(commit.Argv, " ") != "commit --no-gpg-sign -m fix parser" {
		t.Fatalf("commit = (%+v, %v)", commit, err)
	}
	fetch, err := store.Prepare(Operation{Kind: KindFetch, Remote: "origin"})
	if err != nil || strings.Join(fetch.Argv, " ") != "fetch -- origin" {
		t.Fatalf("fetch = (%+v, %v)", fetch, err)
	}
	pull, err := store.Prepare(Operation{Kind: KindPull, Remote: "origin"})
	if err != nil || strings.Join(pull.Argv, " ") != "pull --ff-only -- origin" {
		t.Fatalf("pull = (%+v, %v)", pull, err)
	}
	push, err := store.Prepare(Operation{Kind: KindPush, Remote: "origin"})
	if err != nil || strings.Join(push.Argv, " ") != "push -- origin HEAD" {
		t.Fatalf("push = (%+v, %v)", push, err)
	}
	encoded := string(mustJSON(t, prepared))
	if strings.Contains(encoded, `\`) || strings.Contains(strings.ToLower(encoded), "c:") {
		t.Fatalf("prepared leaked host path: %s", encoded)
	}
}

func TestExecuteUsesPreparedArgvAndDoesNotRunShell(t *testing.T) {
	runner := &recordRunner{}
	root := t.TempDir()
	store := New(func(context.Context, string) (string, error) {
		return root, nil
	}, runner)
	op := Operation{Kind: KindFetch, Remote: "origin"}
	if err := store.Execute(context.Background(), "11111111-1111-4111-8111-111111111111", op); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(runner.calls) != 1 || strings.Join(runner.calls[0], " ") != "fetch -- origin" {
		t.Fatalf("calls = %v", runner.calls)
	}
	if runner.dirs[0] != root {
		t.Fatalf("dir = %q, want workspace root", runner.dirs[0])
	}
}

func TestExecuteStageAndCommitWithRealGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not on PATH")
	}
	root := t.TempDir()
	initBareAndClone := false
	_ = initBareAndClone
	runGit(t, root, "init", "-b", "main")
	runGit(t, root, "config", "user.email", "dev@example.com")
	runGit(t, root, "config", "user.name", "Dev")
	writeFile(t, filepath.Join(root, "src", "main.go"), "package main\n")
	store := New(func(context.Context, string) (string, error) {
		return root, nil
	}, NewSystemRunner())
	if err := store.Execute(context.Background(), "11111111-1111-4111-8111-111111111111", Operation{Kind: KindStage, Paths: []string{"src/main.go"}}); err != nil {
		t.Fatalf("stage error = %v", err)
	}
	if err := store.Execute(context.Background(), "11111111-1111-4111-8111-111111111111", Operation{Kind: KindCommit, Message: "add main"}); err != nil {
		t.Fatalf("commit error = %v", err)
	}
	logOut := runGitOutput(t, root, "log", "-1", "--pretty=%s")
	if strings.TrimSpace(logOut) != "add main" {
		t.Fatalf("log = %q", logOut)
	}
}

type recordRunner struct {
	calls [][]string
	dirs  []string
}

func (runner *recordRunner) Run(_ context.Context, dir string, args ...string) (string, error) {
	copied := append([]string(nil), args...)
	runner.calls = append(runner.calls, copied)
	runner.dirs = append(runner.dirs, dir)
	return "", nil
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return raw
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

func runGitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = isolatedGitEnv(t)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v error = %v\n%s", args, err, output)
	}
	return string(output)
}

func isolatedGitEnv(t *testing.T) []string {
	t.Helper()
	empty := filepath.Join(t.TempDir(), "empty.gitconfig")
	if err := os.WriteFile(empty, nil, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	return append(os.Environ(),
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
