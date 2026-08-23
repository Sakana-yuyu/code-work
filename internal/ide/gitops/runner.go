package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

const (
	gitCommandTimeout = 60 * time.Second
	maxGitOutputBytes = 1 << 20
)

var gitEnvKeys = []string{
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
}

type systemRunner struct{}

func NewSystemRunner() Runner {
	return systemRunner{}
}

func (systemRunner) Run(ctx context.Context, dir string, args ...string) (string, error) {
	if len(args) == 0 {
		return "", fmt.Errorf("%w: empty argv", ErrInvalidOperation)
	}
	for _, arg := range args {
		if strings.IndexByte(arg, 0) >= 0 {
			return "", fmt.Errorf("%w: unsafe token", ErrInvalidOperation)
		}
	}
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("%w: workspace root unavailable", ErrGitUnavailable)
	}
	gitPath, err := exec.LookPath("git")
	if err != nil {
		return "", fmt.Errorf("%w: git executable", ErrGitUnavailable)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithTimeout(ctx, gitCommandTimeout)
	defer cancel()
	command := exec.CommandContext(runCtx, gitPath, args...)
	command.Dir = dir
	command.Env = gitCommandEnv()
	command.Stdin = nil
	var stdout limitedBuffer
	stdout.limit = maxGitOutputBytes
	command.Stdout = &stdout
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		if runCtx.Err() != nil {
			return "", runCtx.Err()
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return stdout.String(), fmt.Errorf("%w: git exited %d", ErrGitUnavailable, exitErr.ExitCode())
		}
		return "", fmt.Errorf("%w: run git", ErrGitUnavailable)
	}
	return stdout.String(), nil
}

func gitCommandEnv() []string {
	env := []string{
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=user.name",
		"GIT_CONFIG_VALUE_0=Code Work",
		"GIT_CONFIG_KEY_1=user.email",
		"GIT_CONFIG_VALUE_1=ide@localhost",
	}
	for _, key := range gitEnvKeys {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	return env
}

type limitedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (buffer *limitedBuffer) Write(payload []byte) (int, error) {
	if buffer.limit <= 0 {
		return len(payload), nil
	}
	remain := buffer.limit - buffer.buf.Len()
	if remain <= 0 {
		return len(payload), nil
	}
	if len(payload) > remain {
		_, _ = buffer.buf.Write(payload[:remain])
		return len(payload), nil
	}
	return buffer.buf.Write(payload)
}

func (buffer *limitedBuffer) String() string {
	return buffer.buf.String()
}
