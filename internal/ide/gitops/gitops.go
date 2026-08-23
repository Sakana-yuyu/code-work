package gitops

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	KindClone  = "git_clone"
	KindStage  = "git_stage"
	KindCommit = "git_commit"
	KindFetch  = "git_fetch"
	KindPull   = "git_pull"
	KindPush   = "git_push"
	maxMessage = 2048
	maxPaths   = 128
)

var (
	ErrInvalidOperation = errors.New("git operation is invalid")
	ErrGitUnavailable   = errors.New("git unavailable")
	remoteNamePattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	scpURLPattern       = regexp.MustCompile(`^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/+-]+$`)
)

type Runner interface {
	Run(ctx context.Context, dir string, args ...string) (string, error)
}

type Operation struct {
	Kind      string   `json:"kind"`
	RemoteURL string   `json:"remoteUrl,omitempty"`
	Remote    string   `json:"remote,omitempty"`
	Directory string   `json:"directory,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	Message   string   `json:"message,omitempty"`
	StageAll  bool     `json:"stageAll,omitempty"`
}

type Prepared struct {
	Kind      string   `json:"kind"`
	Argv      []string `json:"argv"`
	RemoteURL string   `json:"remoteUrl,omitempty"`
	Remote    string   `json:"remote,omitempty"`
	Directory string   `json:"directory,omitempty"`
	Paths     []string `json:"paths,omitempty"`
	Message   string   `json:"message,omitempty"`
	StageAll  bool     `json:"stageAll,omitempty"`
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

func (store *Store) Prepare(operation Operation) (Prepared, error) {
	normalized, err := normalizeOperation(operation)
	if err != nil {
		return Prepared{}, err
	}
	argv, err := buildArgv(normalized)
	if err != nil {
		return Prepared{}, err
	}
	return Prepared{
		Kind:      normalized.Kind,
		Argv:      argv,
		RemoteURL: normalized.RemoteURL,
		Remote:    normalized.Remote,
		Directory: normalized.Directory,
		Paths:     append([]string(nil), normalized.Paths...),
		Message:   normalized.Message,
		StageAll:  normalized.StageAll,
	}, nil
}

func (store *Store) Execute(ctx context.Context, workspaceID string, operation Operation) error {
	if store == nil || store.resolveRoot == nil || store.runner == nil {
		return fmt.Errorf("%w: store unavailable", ErrGitUnavailable)
	}
	if err := contextErr(ctx); err != nil {
		return err
	}
	prepared, err := store.Prepare(operation)
	if err != nil {
		return err
	}
	root, err := store.resolveRoot(ctx, workspaceID)
	if err != nil {
		return err
	}
	_, err = store.runner.Run(ctx, root, prepared.Argv...)
	return err
}

func normalizeOperation(operation Operation) (Operation, error) {
	switch operation.Kind {
	case KindClone:
		remoteURL, err := normalizeRemoteURL(operation.RemoteURL)
		if err != nil {
			return Operation{}, err
		}
		directory, err := normalizeRelativePath(operation.Directory, true)
		if err != nil {
			return Operation{}, err
		}
		if directory == "" {
			directory = "."
		}
		return Operation{Kind: KindClone, RemoteURL: remoteURL, Directory: directory}, nil
	case KindStage:
		if operation.StageAll {
			if len(operation.Paths) > 0 {
				return Operation{}, fmt.Errorf("%w: stage all does not take paths", ErrInvalidOperation)
			}
			return Operation{Kind: KindStage, StageAll: true}, nil
		}
		paths, err := normalizePaths(operation.Paths)
		if err != nil {
			return Operation{}, err
		}
		return Operation{Kind: KindStage, Paths: paths}, nil
	case KindCommit:
		message, err := normalizeMessage(operation.Message)
		if err != nil {
			return Operation{}, err
		}
		return Operation{Kind: KindCommit, Message: message}, nil
	case KindFetch, KindPull, KindPush:
		remote, err := normalizeRemoteName(operation.Remote)
		if err != nil {
			return Operation{}, err
		}
		return Operation{Kind: operation.Kind, Remote: remote}, nil
	default:
		return Operation{}, fmt.Errorf("%w: kind", ErrInvalidOperation)
	}
}

func buildArgv(operation Operation) ([]string, error) {
	switch operation.Kind {
	case KindClone:
		return []string{"clone", "--", operation.RemoteURL, operation.Directory}, nil
	case KindStage:
		if operation.StageAll {
			return []string{"add", "-A", "--"}, nil
		}
		argv := []string{"add", "--"}
		return append(argv, operation.Paths...), nil
	case KindCommit:
		return []string{"commit", "--no-gpg-sign", "-m", operation.Message}, nil
	case KindFetch:
		return []string{"fetch", "--", operation.Remote}, nil
	case KindPull:
		return []string{"pull", "--ff-only", "--", operation.Remote}, nil
	case KindPush:
		return []string{"push", "--", operation.Remote, "HEAD"}, nil
	default:
		return nil, fmt.Errorf("%w: kind", ErrInvalidOperation)
	}
}

func normalizeRemoteURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || utf8.RuneCountInString(raw) > 512 {
		return "", fmt.Errorf("%w: remote URL", ErrInvalidOperation)
	}
	if err := rejectUnsafeToken(raw); err != nil {
		return "", err
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "file:") || looksLikeLocalPath(raw) {
		return "", fmt.Errorf("%w: local remote", ErrInvalidOperation)
	}
	if scpURLPattern.MatchString(raw) {
		return raw, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%w: remote URL", ErrInvalidOperation)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "ssh" {
		return "", fmt.Errorf("%w: remote scheme", ErrInvalidOperation)
	}
	if parsed.User != nil {
		if _, hasPassword := parsed.User.Password(); hasPassword {
			return "", fmt.Errorf("%w: remote credentials", ErrInvalidOperation)
		}
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func normalizeRemoteName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "origin"
	}
	if !remoteNamePattern.MatchString(name) {
		return "", fmt.Errorf("%w: remote name", ErrInvalidOperation)
	}
	return name, nil
}

func normalizeMessage(message string) (string, error) {
	message = strings.TrimSpace(message)
	if message == "" || utf8.RuneCountInString(message) > maxMessage {
		return "", fmt.Errorf("%w: commit message", ErrInvalidOperation)
	}
	for _, character := range message {
		if character == 0 || (unicode.IsControl(character) && character != '\n' && character != '\t') {
			return "", fmt.Errorf("%w: commit message", ErrInvalidOperation)
		}
	}
	return message, nil
}

func normalizePaths(paths []string) ([]string, error) {
	if len(paths) == 0 || len(paths) > maxPaths {
		return nil, fmt.Errorf("%w: paths", ErrInvalidOperation)
	}
	normalized := make([]string, 0, len(paths))
	seen := map[string]struct{}{}
	for _, item := range paths {
		relative, err := normalizeRelativePath(item, false)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[relative]; exists {
			continue
		}
		seen[relative] = struct{}{}
		normalized = append(normalized, relative)
	}
	if len(normalized) == 0 {
		return nil, fmt.Errorf("%w: paths", ErrInvalidOperation)
	}
	return normalized, nil
}

func normalizeRelativePath(value string, allowDot bool) (string, error) {
	value = strings.TrimSpace(strings.ReplaceAll(value, `\`, "/"))
	if value == "" {
		if allowDot {
			return "", nil
		}
		return "", fmt.Errorf("%w: path", ErrInvalidOperation)
	}
	if value == "." && allowDot {
		return ".", nil
	}
	if path.IsAbs(value) || strings.HasPrefix(value, "/") || strings.Contains(value, ":") {
		return "", fmt.Errorf("%w: path", ErrInvalidOperation)
	}
	parts := strings.Split(value, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("%w: path", ErrInvalidOperation)
		}
		if err := rejectUnsafeToken(part); err != nil {
			return "", err
		}
	}
	return strings.Join(parts, "/"), nil
}

func rejectUnsafeToken(value string) error {
	if strings.IndexByte(value, 0) >= 0 || strings.ContainsAny(value, ";&|<>$`\n\r()!") {
		return fmt.Errorf("%w: unsafe token", ErrInvalidOperation)
	}
	return nil
}

func looksLikeLocalPath(raw string) bool {
	if strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, `\`) {
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
	return strings.Contains(raw, `\`) && !strings.Contains(raw, "://")
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("%w: missing context", ErrGitUnavailable)
	}
	return ctx.Err()
}
