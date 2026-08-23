package gitstatus

import (
	"context"
	"strings"
	"testing"
)

func TestSanitizeRemoteURLStripsSecretsAndLocalPaths(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"https://user:ghp_secret@github.com/org/repo.git", "https://github.com/org/repo.git"},
		{"https://ghp_secret@github.com/org/repo.git", "https://github.com/org/repo.git"},
		{"git@github.com:org/repo.git", "git@github.com:org/repo.git"},
		{`C:\Users\me\.ssh\repo`, "<redacted-local>"},
		{"/home/me/src/repo", "<redacted-local>"},
		{"file:///home/me/repo.git", "<redacted-local>"},
	}
	for _, testCase := range cases {
		got := SanitizeRemoteURL(testCase.in)
		if got != testCase.want {
			t.Fatalf("SanitizeRemoteURL(%q) = %q, want %q", testCase.in, got, testCase.want)
		}
	}
}

func TestValidateArgsRejectsShellAndUnknownSubcommands(t *testing.T) {
	if err := validateArgs([]string{"status", "--porcelain=v1"}); err != nil {
		t.Fatalf("validateArgs(status) error = %v", err)
	}
	for _, args := range [][]string{
		{"status; rm -rf /"},
		{"-c", "core.sshCommand=touch /tmp/pwned", "status"},
		{"config", "--get", "user.email"},
		{"status", "file\n;id"},
	} {
		if err := validateArgs(args); err == nil {
			t.Fatalf("validateArgs(%q) = nil, want error", args)
		}
	}
}

func TestSnapshotUsesTypedGitArgvAndSanitizesRemotes(t *testing.T) {
	runner := &recordingRunner{outputs: map[string]string{
		"rev-parse --is-inside-work-tree":                  "true\n",
		"rev-parse --abbrev-ref HEAD":                      "main\n",
		"status --porcelain=v1 -b --untracked-files=all":   "## main...origin/main [ahead 1, behind 2]\n M src/main.go\n?? notes.md\n",
		"diff --no-ext-diff --no-color -U3 HEAD":           "diff --git a/src/main.go b/src/main.go\n+needle\n",
		"remote -v":                                        "origin\thttps://user:ghp_secret@github.com/org/repo.git (fetch)\norigin\thttps://user:ghp_secret@github.com/org/repo.git (push)\n",
		"rev-list --left-right --count HEAD...@{upstream}": "2\t1\n",
	}}
	store := New(func(context.Context, string) (string, error) {
		return `E:\secret\workspace`, nil
	}, runner)
	snapshot, err := store.Snapshot(context.Background(), "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if !snapshot.Available || snapshot.Branch != "main" || snapshot.Ahead != 1 || snapshot.Behind != 2 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if len(snapshot.Changes) != 2 || snapshot.Changes[0].Path != "src/main.go" {
		t.Fatalf("changes = %+v", snapshot.Changes)
	}
	if !strings.Contains(snapshot.Diff, "needle") || snapshot.DiffTruncated {
		t.Fatalf("diff = %q", snapshot.Diff)
	}
	if len(snapshot.Remotes) != 1 || snapshot.Remotes[0].URL != "https://github.com/org/repo.git" {
		t.Fatalf("remotes = %+v", snapshot.Remotes)
	}
	encoded := strings.ToLower(snapshot.Diff + snapshot.Branch + snapshot.Remotes[0].URL)
	if strings.Contains(encoded, "ghp_secret") || strings.Contains(encoded, `e:\secret`) {
		t.Fatalf("snapshot leaked secret or host path: %+v", snapshot)
	}
	for _, call := range runner.calls {
		if err := validateArgs(call); err != nil {
			t.Fatalf("recorded argv %q rejected: %v", call, err)
		}
		joined := strings.Join(call, " ")
		if strings.Contains(joined, "cmd") || strings.Contains(joined, "/c") || strings.Contains(joined, "sh") {
			t.Fatalf("used a shell: %q", call)
		}
	}
}

type recordingRunner struct {
	calls   [][]string
	outputs map[string]string
}

func (runner *recordingRunner) Run(_ context.Context, _ string, args ...string) (string, error) {
	copied := append([]string(nil), args...)
	runner.calls = append(runner.calls, copied)
	if output, ok := runner.outputs[strings.Join(args, " ")]; ok {
		return output, nil
	}
	return "", ErrGitUnavailable
}

func TestSnapshotUnavailableWhenGitMissing(t *testing.T) {
	store := New(func(context.Context, string) (string, error) {
		return t.TempDir(), nil
	}, &recordingRunner{})
	snapshot, err := store.Snapshot(context.Background(), "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if snapshot.Available {
		t.Fatalf("snapshot.Available = true, want false: %+v", snapshot)
	}
}

func TestSnapshotTruncatesLargeDiff(t *testing.T) {
	huge := strings.Repeat("x", maxDiffBytes+32)
	runner := &recordingRunner{outputs: map[string]string{
		"rev-parse --is-inside-work-tree":                "true\n",
		"rev-parse --abbrev-ref HEAD":                    "main\n",
		"status --porcelain=v1 -b --untracked-files=all": "## main\n",
		"diff --no-ext-diff --no-color -U3 HEAD":         huge,
		"remote -v":                                      "",
	}}
	store := New(func(context.Context, string) (string, error) {
		return t.TempDir(), nil
	}, runner)
	snapshot, err := store.Snapshot(context.Background(), "11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if !snapshot.DiffTruncated || len(snapshot.Diff) > maxDiffBytes {
		t.Fatalf("diff truncation = truncated=%v len=%d", snapshot.DiffTruncated, len(snapshot.Diff))
	}
}
