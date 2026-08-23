package termsession

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	ProfilePowerShell = "powershell"
	ProfileCmd        = "cmd"
	defaultCols       = 80
	defaultRows       = 24
	maxOutputBytes    = 64 << 10
	maxSessions       = 8
)

var (
	ErrInvalidProfile      = errors.New("terminal profile is invalid")
	ErrSessionNotFound     = errors.New("terminal session not found")
	ErrTerminalUnavailable = errors.New("terminal unavailable")
	ErrSessionCapacity     = errors.New("terminal session capacity reached")
)

type Profile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type SessionInfo struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	ProfileID   string `json:"profileId"`
	ProfileName string `json:"profileName"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	State       string `json:"state"`
}

type OutputSnapshot struct {
	SessionID string `json:"sessionId"`
	Data      string `json:"data"`
	Seq       int64  `json:"seq"`
	Exited    bool   `json:"exited"`
}

type Event struct {
	SessionID   string `json:"sessionId"`
	WorkspaceID string `json:"workspaceId"`
	Chunk       string `json:"chunk"`
	Seq         int64  `json:"seq"`
	Exited      bool   `json:"exited,omitempty"`
}

type StartSpec struct {
	Program string
	Args    []string
	Dir     string
	Cols    uint16
	Rows    uint16
}

type Process interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Resize(cols, rows uint16) error
	Interrupt() error
	Kill() error
}

type Host interface {
	Start(ctx context.Context, spec StartSpec) (Process, error)
}

type Manager struct {
	resolveRoot func(context.Context, string) (string, error)
	host        Host
	lookPath    func(string) (string, error)
	emit        func(Event)
	mu          sync.Mutex
	sessions    map[string]*session
}

type session struct {
	info SessionInfo
	proc Process
	mu   sync.Mutex
	buf  bytes.Buffer
	seq  int64
}

func New(resolveRoot func(context.Context, string) (string, error), host Host) *Manager {
	if host == nil {
		host = NewSystemHost()
	}
	return &Manager{
		resolveRoot: resolveRoot,
		host:        host,
		lookPath:    exec.LookPath,
		emit:        func(Event) {},
		sessions:    map[string]*session{},
	}
}

func (manager *Manager) SetLookPath(lookPath func(string) (string, error)) {
	if manager == nil {
		return
	}
	manager.lookPath = lookPath
}

func (manager *Manager) SetEmitter(emit func(Event)) {
	if manager == nil {
		return
	}
	if emit == nil {
		emit = func(Event) {}
	}
	manager.emit = emit
}

func ListProfiles() []Profile {
	return []Profile{
		{ID: ProfilePowerShell, Name: "PowerShell"},
		{ID: ProfileCmd, Name: "命令提示符"},
	}
}

func (manager *Manager) Open(ctx context.Context, workspaceID, profileID string, cols, rows int) (SessionInfo, error) {
	if manager == nil || manager.resolveRoot == nil || manager.host == nil {
		return SessionInfo{}, fmt.Errorf("%w: manager unavailable", ErrTerminalUnavailable)
	}
	if err := ctx.Err(); err != nil {
		return SessionInfo{}, err
	}
	profile, program, args, err := manager.resolveProfile(profileID)
	if err != nil {
		return SessionInfo{}, err
	}
	root, err := manager.resolveRoot(ctx, workspaceID)
	if err != nil {
		return SessionInfo{}, err
	}
	if cols <= 0 {
		cols = defaultCols
	}
	if rows <= 0 {
		rows = defaultRows
	}
	manager.mu.Lock()
	if len(manager.sessions) >= maxSessions {
		manager.mu.Unlock()
		return SessionInfo{}, ErrSessionCapacity
	}
	manager.mu.Unlock()
	proc, err := manager.host.Start(ctx, StartSpec{
		Program: program,
		Args:    args,
		Dir:     root,
		Cols:    uint16(cols),
		Rows:    uint16(rows),
	})
	if err != nil {
		return SessionInfo{}, fmt.Errorf("%w", ErrTerminalUnavailable)
	}
	item := &session{
		info: SessionInfo{
			ID:          uuid.NewString(),
			WorkspaceID: workspaceID,
			ProfileID:   profile.ID,
			ProfileName: profile.Name,
			Cols:        cols,
			Rows:        rows,
			State:       "running",
		},
		proc: proc,
	}
	manager.mu.Lock()
	manager.sessions[item.info.ID] = item
	manager.mu.Unlock()
	go manager.readLoop(item)
	return item.info, nil
}

func (manager *Manager) Write(ctx context.Context, sessionID, data string) error {
	item, err := manager.lookup(sessionID)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	_, err = item.proc.Write([]byte(data))
	if err != nil {
		return fmt.Errorf("%w", ErrTerminalUnavailable)
	}
	return nil
}

func (manager *Manager) Resize(ctx context.Context, sessionID string, cols, rows int) error {
	item, err := manager.lookup(sessionID)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if cols <= 0 || rows <= 0 {
		return fmt.Errorf("%w: size", ErrInvalidProfile)
	}
	if err := item.proc.Resize(uint16(cols), uint16(rows)); err != nil {
		return fmt.Errorf("%w", ErrTerminalUnavailable)
	}
	item.mu.Lock()
	item.info.Cols = cols
	item.info.Rows = rows
	item.mu.Unlock()
	return nil
}

func (manager *Manager) Interrupt(ctx context.Context, sessionID string) error {
	item, err := manager.lookup(sessionID)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := item.proc.Interrupt(); err != nil {
		return fmt.Errorf("%w", ErrTerminalUnavailable)
	}
	return nil
}

func (manager *Manager) Close(ctx context.Context, sessionID string) error {
	_ = ctx
	manager.mu.Lock()
	item, ok := manager.sessions[sessionID]
	if ok {
		delete(manager.sessions, sessionID)
	}
	manager.mu.Unlock()
	if !ok {
		return ErrSessionNotFound
	}
	_ = item.proc.Kill()
	item.mu.Lock()
	item.info.State = "exited"
	item.mu.Unlock()
	return nil
}

func (manager *Manager) CloseWorkspace(workspaceID string) {
	if manager == nil {
		return
	}
	manager.mu.Lock()
	var ids []string
	for id, item := range manager.sessions {
		if item.info.WorkspaceID == workspaceID {
			ids = append(ids, id)
		}
	}
	manager.mu.Unlock()
	for _, id := range ids {
		_ = manager.Close(context.Background(), id)
	}
}

func (manager *Manager) Snapshot(sessionID string) (OutputSnapshot, error) {
	item, err := manager.lookup(sessionID)
	if err != nil {
		return OutputSnapshot{}, err
	}
	item.mu.Lock()
	defer item.mu.Unlock()
	return OutputSnapshot{
		SessionID: item.info.ID,
		Data:      item.buf.String(),
		Seq:       item.seq,
		Exited:    item.info.State == "exited",
	}, nil
}

func (manager *Manager) Session(sessionID string) (SessionInfo, error) {
	item, err := manager.lookup(sessionID)
	if err != nil {
		return SessionInfo{}, err
	}
	item.mu.Lock()
	defer item.mu.Unlock()
	return item.info, nil
}

func (manager *Manager) lookup(sessionID string) (*session, error) {
	if manager == nil {
		return nil, fmt.Errorf("%w: manager unavailable", ErrTerminalUnavailable)
	}
	manager.mu.Lock()
	item, ok := manager.sessions[sessionID]
	manager.mu.Unlock()
	if !ok {
		return nil, ErrSessionNotFound
	}
	return item, nil
}

func (manager *Manager) resolveProfile(profileID string) (Profile, string, []string, error) {
	lookPath := manager.lookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	switch profileID {
	case ProfilePowerShell:
		program, err := firstLookPath(lookPath, "pwsh", "powershell")
		if err != nil {
			return Profile{}, "", nil, fmt.Errorf("%w", ErrTerminalUnavailable)
		}
		return Profile{ID: ProfilePowerShell, Name: "PowerShell"}, program, []string{"-NoLogo"}, nil
	case ProfileCmd:
		program, err := lookPath("cmd")
		if err != nil {
			return Profile{}, "", nil, fmt.Errorf("%w", ErrTerminalUnavailable)
		}
		return Profile{ID: ProfileCmd, Name: "命令提示符"}, program, []string{"/K"}, nil
	default:
		return Profile{}, "", nil, fmt.Errorf("%w: %s", ErrInvalidProfile, profileID)
	}
}

func firstLookPath(lookPath func(string) (string, error), names ...string) (string, error) {
	var last error
	for _, name := range names {
		path, err := lookPath(name)
		if err == nil && path != "" {
			return path, nil
		}
		last = err
	}
	if last == nil {
		last = errors.New("not found")
	}
	return "", last
}

func (manager *Manager) readLoop(item *session) {
	buf := make([]byte, 4096)
	for {
		n, err := item.proc.Read(buf)
		if n > 0 {
			chunk := string(buf[:n])
			item.mu.Lock()
			item.buf.WriteString(chunk)
			if item.buf.Len() > maxOutputBytes {
				overflow := item.buf.Len() - maxOutputBytes
				item.buf.Next(overflow)
			}
			item.seq++
			seq := item.seq
			workspaceID := item.info.WorkspaceID
			sessionID := item.info.ID
			item.mu.Unlock()
			manager.emit(Event{
				SessionID:   sessionID,
				WorkspaceID: workspaceID,
				Chunk:       chunk,
				Seq:         seq,
			})
		}
		if err != nil {
			item.mu.Lock()
			item.info.State = "exited"
			item.seq++
			seq := item.seq
			workspaceID := item.info.WorkspaceID
			sessionID := item.info.ID
			item.mu.Unlock()
			manager.emit(Event{SessionID: sessionID, WorkspaceID: workspaceID, Seq: seq, Exited: true})
			if !errors.Is(err, io.EOF) {
				time.Sleep(10 * time.Millisecond)
			}
			return
		}
	}
}
