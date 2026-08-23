package gitstatus

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"
)

const maxDiffBytes = 64 << 10

var (
	ErrGitUnavailable = errors.New("git unavailable")
	ErrInvalidGitArgs = errors.New("git arguments are not allowed")
)

var allowedArgv = [][]string{
	{"rev-parse", "--is-inside-work-tree"},
	{"rev-parse", "--abbrev-ref", "HEAD"},
	{"status", "--porcelain=v1"},
	{"status", "--porcelain=v1", "-b", "--untracked-files=all"},
	{"diff", "--no-ext-diff", "--no-color", "-U3", "HEAD"},
	{"remote", "-v"},
	{"rev-list", "--left-right", "--count", "HEAD...@{upstream}"},
}

type Runner interface {
	Run(ctx context.Context, dir string, args ...string) (string, error)
}

type FileChange struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type Remote struct {
	Name string `json:"name"`
	URL  string `json:"url"`
}

type Snapshot struct {
	Available     bool         `json:"available"`
	Branch        string       `json:"branch"`
	Ahead         int          `json:"ahead"`
	Behind        int          `json:"behind"`
	Changes       []FileChange `json:"changes"`
	Diff          string       `json:"diff"`
	DiffTruncated bool         `json:"diffTruncated"`
	Remotes       []Remote     `json:"remotes"`
}

type Store struct {
	resolveRoot func(context.Context, string) (string, error)
	runner      Runner
}

func New(resolveRoot func(context.Context, string) (string, error), runner Runner) *Store {
	if runner == nil {
		runner = NewSystemRunner()
	}
	return &Store{resolveRoot: resolveRoot, runner: runner}
}

func (store *Store) Snapshot(ctx context.Context, workspaceID string) (Snapshot, error) {
	if store == nil || store.resolveRoot == nil || store.runner == nil {
		return Snapshot{}, fmt.Errorf("%w: store unavailable", ErrGitUnavailable)
	}
	root, err := store.resolveRoot(ctx, workspaceID)
	if err != nil {
		return Snapshot{}, err
	}
	inside, err := store.runner.Run(ctx, root, "rev-parse", "--is-inside-work-tree")
	if err != nil {
		if ctx.Err() != nil {
			return Snapshot{}, ctx.Err()
		}
		return unavailableSnapshot(), nil
	}
	if strings.TrimSpace(inside) != "true" {
		return unavailableSnapshot(), nil
	}

	snapshot := unavailableSnapshot()
	snapshot.Available = true
	if branch, branchErr := store.runner.Run(ctx, root, "rev-parse", "--abbrev-ref", "HEAD"); branchErr == nil {
		snapshot.Branch = strings.TrimSpace(branch)
	}
	statusOut, statusErr := store.runner.Run(ctx, root, "status", "--porcelain=v1", "-b", "--untracked-files=all")
	if statusErr == nil {
		parseStatus(&snapshot, statusOut)
	}
	diffOut, diffErr := store.runner.Run(ctx, root, "diff", "--no-ext-diff", "--no-color", "-U3", "HEAD")
	if diffErr == nil {
		snapshot.Diff, snapshot.DiffTruncated = truncateDiff(diffOut)
	}
	remoteOut, remoteErr := store.runner.Run(ctx, root, "remote", "-v")
	if remoteErr == nil {
		snapshot.Remotes = parseRemotes(remoteOut)
	}
	return snapshot, nil
}

func unavailableSnapshot() Snapshot {
	return Snapshot{
		Changes: make([]FileChange, 0),
		Remotes: make([]Remote, 0),
	}
}

func SanitizeRemoteURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.HasPrefix(strings.ToLower(raw), "file:") || looksLikeLocalPath(raw) {
		return "<redacted-local>"
	}
	parsed, err := url.Parse(raw)
	if err == nil && parsed.Scheme != "" && parsed.Host != "" {
		parsed.User = nil
		return parsed.String()
	}
	return raw
}

func validateArgs(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: empty argv", ErrInvalidGitArgs)
	}
	for _, arg := range args {
		if err := validateArgToken(arg); err != nil {
			return err
		}
	}
	for _, allowed := range allowedArgv {
		if argvEqual(args, allowed) {
			return nil
		}
	}
	return fmt.Errorf("%w: command not allowed", ErrInvalidGitArgs)
}

func validateArgToken(arg string) error {
	if arg == "" || strings.IndexByte(arg, 0) >= 0 {
		return fmt.Errorf("%w: empty argument", ErrInvalidGitArgs)
	}
	if strings.ContainsAny(arg, ";&|<>$`\n\r()!") {
		return fmt.Errorf("%w: shell metacharacter", ErrInvalidGitArgs)
	}
	if arg == "-c" || (strings.HasPrefix(arg, "-c") && !strings.HasPrefix(arg, "--")) {
		return fmt.Errorf("%w: git config override", ErrInvalidGitArgs)
	}
	return nil
}

func argvEqual(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func looksLikeLocalPath(raw string) bool {
	if strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "\\") {
		return true
	}
	if len(raw) >= 3 && raw[1] == ':' {
		drive := raw[0]
		if (drive >= 'A' && drive <= 'Z') || (drive >= 'a' && drive <= 'z') {
			if raw[2] == '\\' || raw[2] == '/' {
				return true
			}
		}
	}
	return strings.Contains(raw, "\\") && !strings.Contains(raw, "://")
}

func parseStatus(snapshot *Snapshot, output string) {
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "##") {
			parseBranchLine(snapshot, strings.TrimSpace(strings.TrimPrefix(line, "##")))
			continue
		}
		if len(line) < 4 {
			continue
		}
		path := porcelainPath(line)
		if path == "" {
			continue
		}
		snapshot.Changes = append(snapshot.Changes, FileChange{
			Path:   path,
			Status: changeStatus(line[0], line[1]),
		})
	}
}

func parseBranchLine(snapshot *Snapshot, line string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	if strings.HasPrefix(line, "No commits yet on ") {
		snapshot.Branch = strings.TrimSpace(strings.TrimPrefix(line, "No commits yet on "))
		return
	}
	if strings.HasPrefix(line, "HEAD (no branch)") {
		if snapshot.Branch == "" {
			snapshot.Branch = "HEAD"
		}
		return
	}
	meta := ""
	if start := strings.Index(line, " ["); start >= 0 && strings.HasSuffix(line, "]") {
		meta = strings.TrimSuffix(line[start+2:], "]")
		line = strings.TrimSpace(line[:start])
	}
	branch, _, _ := strings.Cut(line, "...")
	if branch != "" {
		snapshot.Branch = branch
	}
	if meta == "" {
		return
	}
	for _, part := range strings.Split(meta, ",") {
		part = strings.TrimSpace(part)
		switch {
		case strings.HasPrefix(part, "ahead "):
			snapshot.Ahead = parseLeadingInt(strings.TrimPrefix(part, "ahead "))
		case strings.HasPrefix(part, "behind "):
			snapshot.Behind = parseLeadingInt(strings.TrimPrefix(part, "behind "))
		}
	}
}

func porcelainPath(line string) string {
	path := strings.TrimSpace(line[3:])
	if from, to, found := strings.Cut(path, " -> "); found {
		_ = from
		path = to
	}
	return strings.Trim(path, `"`)
}

func changeStatus(indexStatus, worktreeStatus byte) string {
	if indexStatus == '?' && worktreeStatus == '?' {
		return "untracked"
	}
	if indexStatus == 'U' || worktreeStatus == 'U' {
		return "conflict"
	}
	if indexStatus == 'R' || worktreeStatus == 'R' {
		return "renamed"
	}
	if indexStatus == 'C' || worktreeStatus == 'C' {
		return "copied"
	}
	if indexStatus == 'A' || worktreeStatus == 'A' {
		return "added"
	}
	if indexStatus == 'D' || worktreeStatus == 'D' {
		return "deleted"
	}
	if indexStatus == 'M' || worktreeStatus == 'M' {
		return "modified"
	}
	return "modified"
}

func parseRemotes(output string) []Remote {
	remotes := make([]Remote, 0)
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, rest, found := strings.Cut(line, "\t")
		if !found {
			name, rest, found = strings.Cut(line, " ")
		}
		if !found {
			continue
		}
		rawURL := strings.TrimSpace(rest)
		rawURL = strings.TrimSuffix(rawURL, " (fetch)")
		rawURL = strings.TrimSuffix(rawURL, " (push)")
		remote := Remote{Name: strings.TrimSpace(name), URL: SanitizeRemoteURL(rawURL)}
		key := remote.Name + "\n" + remote.URL
		if remote.Name == "" || seen[key] {
			continue
		}
		seen[key] = true
		remotes = append(remotes, remote)
	}
	return remotes
}

func truncateDiff(text string) (string, bool) {
	if len(text) <= maxDiffBytes {
		return text, false
	}
	cut := maxDiffBytes
	for cut > 0 && !utf8.ValidString(text[:cut]) {
		cut--
	}
	return text[:cut], true
}

func parseLeadingInt(raw string) int {
	raw = strings.TrimSpace(raw)
	value := 0
	for _, char := range raw {
		if char < '0' || char > '9' {
			break
		}
		value = value*10 + int(char-'0')
	}
	return value
}
