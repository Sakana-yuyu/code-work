package agentrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	StatusRunning   = "running"
	StatusCompleted = "completed"
	StatusFailed    = "failed"
	StatusCanceled  = "canceled"

	KindStarted          = "started"
	KindDelta            = "delta"
	KindFinished         = "finished"
	KindCanceled         = "canceled"
	KindError            = "error"
	KindEffectProposed   = "effect_proposed"
	KindEffectCommitted  = "effect_committed"

	EffectWrite = "workspace_write"
	EffectGit   = "git"
	EffectShell = "shell"
	EffectMCP   = "mcp"

	maxPromptRunes = 32_000
	maxRuns        = 64
	metaFileName   = "meta.json"
	eventsFileName = "events.jsonl"
)

var (
	ErrInvalidRequest  = errors.New("agent run request is invalid")
	ErrRunNotFound     = errors.New("agent run not found")
	ErrStoreInvalid    = errors.New("agent run store is invalid")
	ErrEffectInvalid   = errors.New("agent effect is invalid")
	ErrEffectNotFound  = errors.New("agent effect not found")
	ErrCapacity        = errors.New("agent run capacity reached")
	ErrStreamerMissing = errors.New("model streamer is unavailable")
)

type Streamer func(ctx context.Context, request StreamRequest, emit func(Event) error) error

type StreamRequest struct {
	RunID       string
	WorkspaceID string
	ModelID     string
	Prompt      string
}

type Run struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	ModelID     string `json:"modelId"`
	Prompt      string `json:"prompt"`
	Status      string `json:"status"`
	Error       string `json:"error,omitempty"`
	CreatedAtMS int64  `json:"createdAtUnixMs"`
	UpdatedAtMS int64  `json:"updatedAtUnixMs"`
}

type Event struct {
	RunID      string  `json:"runId"`
	Seq        int64   `json:"seq"`
	Kind       string  `json:"kind"`
	Text       string  `json:"text,omitempty"`
	ReplaySafe bool    `json:"replaySafe"`
	Effect     *Effect `json:"effect,omitempty"`
	AtUnixMS   int64   `json:"atUnixMs"`
}

type Effect struct {
	ID              string   `json:"id"`
	Kind            string   `json:"kind"`
	Path            string   `json:"path,omitempty"`
	Text            string   `json:"text,omitempty"`
	ExpectedVersion string   `json:"expectedVersion,omitempty"`
	SessionID       string   `json:"sessionId,omitempty"`
	Server          string   `json:"server,omitempty"`
	GitKind         string   `json:"gitKind,omitempty"`
	RemoteURL       string   `json:"remoteUrl,omitempty"`
	Remote          string   `json:"remote,omitempty"`
	Directory       string   `json:"directory,omitempty"`
	Paths           []string `json:"paths,omitempty"`
	Message         string   `json:"message,omitempty"`
	StageAll        bool     `json:"stageAll,omitempty"`
	Summary         string   `json:"summary,omitempty"`
}

type Manager struct {
	root   string
	stream Streamer
	emit   func(Event)
	mu     sync.Mutex
	runs   map[string]*liveRun
}

type liveRun struct {
	meta   Run
	events []Event
	cancel context.CancelFunc
	done   chan struct{}
}

func New(root string, stream Streamer) *Manager {
	return &Manager{
		root:   strings.TrimSpace(root),
		stream: stream,
		emit:   func(Event) {},
		runs:   map[string]*liveRun{},
	}
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

func (manager *Manager) Start(ctx context.Context, workspaceID, modelID, prompt string) (Run, error) {
	if manager == nil || manager.root == "" {
		return Run{}, ErrStoreInvalid
	}
	if manager.stream == nil {
		return Run{}, ErrStreamerMissing
	}
	if err := requireContext(ctx); err != nil {
		return Run{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	modelID = strings.TrimSpace(modelID)
	prompt = strings.TrimSpace(prompt)
	if workspaceID == "" || modelID == "" || prompt == "" {
		return Run{}, fmt.Errorf("%w: workspace, model, or prompt", ErrInvalidRequest)
	}
	if utf8.RuneCountInString(prompt) > maxPromptRunes {
		return Run{}, fmt.Errorf("%w: prompt too long", ErrInvalidRequest)
	}
	now := time.Now().UTC().UnixMilli()
	run := Run{
		ID:          newPrefixedID("run"),
		WorkspaceID: workspaceID,
		ModelID:     modelID,
		Prompt:      prompt,
		Status:      StatusRunning,
		CreatedAtMS: now,
		UpdatedAtMS: now,
	}
	streamCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	live := &liveRun{meta: run, cancel: cancel, done: make(chan struct{})}
	manager.mu.Lock()
	if err := manager.loadLocked(); err != nil {
		manager.mu.Unlock()
		cancel()
		return Run{}, err
	}
	if len(manager.runs) >= maxRuns {
		manager.mu.Unlock()
		cancel()
		return Run{}, ErrCapacity
	}
	if err := manager.writeMetaLocked(run); err != nil {
		manager.mu.Unlock()
		cancel()
		return Run{}, err
	}
	manager.runs[run.ID] = live
	started := manager.appendLocked(live, Event{Kind: KindStarted, Text: prompt, ReplaySafe: true})
	manager.mu.Unlock()
	manager.emit(started)
	go manager.execute(streamCtx, live)
	return run, nil
}

func (manager *Manager) Cancel(ctx context.Context, runID string) (Run, error) {
	if err := requireContext(ctx); err != nil {
		return Run{}, err
	}
	manager.mu.Lock()
	if err := manager.loadLocked(); err != nil {
		manager.mu.Unlock()
		return Run{}, err
	}
	live, ok := manager.runs[strings.TrimSpace(runID)]
	if !ok {
		manager.mu.Unlock()
		return Run{}, ErrRunNotFound
	}
	cancel := live.cancel
	done := live.done
	manager.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	select {
	case <-ctx.Done():
		return Run{}, ctx.Err()
	case <-done:
	case <-time.After(3 * time.Second):
	}
	return manager.Get(ctx, runID)
}

func (manager *Manager) Get(ctx context.Context, runID string) (Run, error) {
	if err := requireContext(ctx); err != nil {
		return Run{}, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := manager.loadLocked(); err != nil {
		return Run{}, err
	}
	live, ok := manager.runs[strings.TrimSpace(runID)]
	if !ok {
		return Run{}, ErrRunNotFound
	}
	return live.meta, nil
}

func (manager *Manager) List(ctx context.Context, workspaceID string) ([]Run, error) {
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := manager.loadLocked(); err != nil {
		return nil, err
	}
	items := make([]Run, 0, len(manager.runs))
	for _, live := range manager.runs {
		if workspaceID != "" && live.meta.WorkspaceID != workspaceID {
			continue
		}
		items = append(items, live.meta)
	}
	return items, nil
}

func (manager *Manager) Events(ctx context.Context, runID string) ([]Event, error) {
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if err := manager.loadLocked(); err != nil {
		return nil, err
	}
	live, ok := manager.runs[strings.TrimSpace(runID)]
	if !ok {
		return nil, ErrRunNotFound
	}
	out := make([]Event, len(live.events))
	copy(out, live.events)
	return out, nil
}

func (manager *Manager) Replay(ctx context.Context, runID string) ([]Event, error) {
	events, err := manager.Events(ctx, runID)
	if err != nil {
		return nil, err
	}
	safe := make([]Event, 0, len(events))
	for _, event := range events {
		if event.ReplaySafe {
			safe = append(safe, event)
		}
	}
	return safe, nil
}

func (manager *Manager) ProposeEffect(ctx context.Context, runID string, effect Effect) (Effect, error) {
	if err := requireContext(ctx); err != nil {
		return Effect{}, err
	}
	normalized, err := normalizeEffect(effect)
	if err != nil {
		return Effect{}, err
	}
	manager.mu.Lock()
	if err := manager.loadLocked(); err != nil {
		manager.mu.Unlock()
		return Effect{}, err
	}
	live, ok := manager.runs[strings.TrimSpace(runID)]
	if !ok {
		manager.mu.Unlock()
		return Effect{}, ErrRunNotFound
	}
	normalized.ID = newPrefixedID("effect")
	event := manager.appendLocked(live, Event{
		Kind:       KindEffectProposed,
		ReplaySafe: false,
		Effect:     cloneEffect(normalized),
		Text:       normalized.Summary,
	})
	manager.mu.Unlock()
	manager.emit(event)
	return normalized, nil
}

func (manager *Manager) Effect(ctx context.Context, runID, effectID string) (Effect, error) {
	events, err := manager.Events(ctx, runID)
	if err != nil {
		return Effect{}, err
	}
	effectID = strings.TrimSpace(effectID)
	for _, event := range events {
		if event.Effect != nil && event.Effect.ID == effectID {
			return *event.Effect, nil
		}
	}
	return Effect{}, ErrEffectNotFound
}

func (manager *Manager) MarkEffectCommitted(ctx context.Context, runID, effectID string) error {
	if err := requireContext(ctx); err != nil {
		return err
	}
	if _, err := manager.Effect(ctx, runID, effectID); err != nil {
		return err
	}
	manager.mu.Lock()
	live, ok := manager.runs[strings.TrimSpace(runID)]
	if !ok {
		manager.mu.Unlock()
		return ErrRunNotFound
	}
	event := manager.appendLocked(live, Event{
		Kind:       KindEffectCommitted,
		ReplaySafe: false,
		Text:       strings.TrimSpace(effectID),
	})
	manager.mu.Unlock()
	manager.emit(event)
	return nil
}

func (manager *Manager) execute(ctx context.Context, live *liveRun) {
	defer close(live.done)
	err := manager.stream(ctx, StreamRequest{
		RunID:       live.meta.ID,
		WorkspaceID: live.meta.WorkspaceID,
		ModelID:     live.meta.ModelID,
		Prompt:      live.meta.Prompt,
	}, func(event Event) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if strings.TrimSpace(event.Kind) == "" {
			event.Kind = KindDelta
		}
		event.ReplaySafe = event.Kind != KindEffectProposed && event.Kind != KindEffectCommitted
		manager.mu.Lock()
		persisted := manager.appendLocked(live, event)
		manager.mu.Unlock()
		manager.emit(persisted)
		return nil
	})
	manager.mu.Lock()
	defer manager.mu.Unlock()
	status := StatusCompleted
	kind := KindFinished
	text := ""
	if ctx.Err() != nil {
		status = StatusCanceled
		kind = KindCanceled
		text = "已取消"
	} else if err != nil {
		status = StatusFailed
		kind = KindError
		text = err.Error()
		live.meta.Error = text
	}
	live.meta.Status = status
	live.meta.UpdatedAtMS = time.Now().UTC().UnixMilli()
	_ = manager.writeMetaLocked(live.meta)
	finished := manager.appendLocked(live, Event{Kind: kind, Text: text, ReplaySafe: true})
	go manager.emit(finished)
}

func (manager *Manager) appendLocked(live *liveRun, event Event) Event {
	event.RunID = live.meta.ID
	event.Seq = int64(len(live.events) + 1)
	if event.AtUnixMS == 0 {
		event.AtUnixMS = time.Now().UTC().UnixMilli()
	}
	live.events = append(live.events, event)
	live.meta.UpdatedAtMS = event.AtUnixMS
	_ = manager.writeMetaLocked(live.meta)
	_ = manager.writeEventLocked(live.meta.ID, event)
	return event
}

func (manager *Manager) writeMetaLocked(run Run) error {
	dir := filepath.Join(manager.root, run.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("%w: %v", ErrStoreInvalid, err)
	}
	raw, err := json.Marshal(run)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStoreInvalid, err)
	}
	if err := os.WriteFile(filepath.Join(dir, metaFileName), raw, 0o600); err != nil {
		return fmt.Errorf("%w: %v", ErrStoreInvalid, err)
	}
	return nil
}

func (manager *Manager) writeEventLocked(runID string, event Event) error {
	path := filepath.Join(manager.root, runID, eventsFileName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	raw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = file.Write(append(raw, '\n'))
	return err
}

func (manager *Manager) loadLocked() error {
	if manager.runs == nil {
		manager.runs = map[string]*liveRun{}
	}
	if err := os.MkdirAll(manager.root, 0o700); err != nil {
		return fmt.Errorf("%w: %v", ErrStoreInvalid, err)
	}
	entries, err := os.ReadDir(manager.root)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrStoreInvalid, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, exists := manager.runs[entry.Name()]; exists {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(manager.root, entry.Name(), metaFileName))
		if err != nil {
			continue
		}
		var meta Run
		if json.Unmarshal(raw, &meta) != nil || strings.TrimSpace(meta.ID) == "" {
			continue
		}
		live := &liveRun{meta: meta, done: make(chan struct{})}
		close(live.done)
		if events, err := readEvents(filepath.Join(manager.root, entry.Name(), eventsFileName)); err == nil {
			live.events = events
		}
		manager.runs[meta.ID] = live
	}
	return nil
}

func readEvents(path string) ([]Event, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	lines := strings.Split(string(raw), "\n")
	events := make([]Event, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event Event
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		events = append(events, event)
	}
	return events, nil
}

func normalizeEffect(effect Effect) (Effect, error) {
	effect.Kind = strings.TrimSpace(effect.Kind)
	effect.Path = strings.TrimSpace(strings.ReplaceAll(effect.Path, "\\", "/"))
	effect.SessionID = strings.TrimSpace(effect.SessionID)
	effect.Server = strings.TrimSpace(effect.Server)
	effect.GitKind = strings.TrimSpace(effect.GitKind)
	effect.RemoteURL = strings.TrimSpace(effect.RemoteURL)
	effect.Remote = strings.TrimSpace(effect.Remote)
	effect.Directory = strings.TrimSpace(effect.Directory)
	effect.Message = strings.TrimSpace(effect.Message)
	effect.ExpectedVersion = strings.TrimSpace(effect.ExpectedVersion)
	switch effect.Kind {
	case EffectWrite:
		if effect.Path == "" || strings.HasPrefix(effect.Path, "/") || strings.Contains(effect.Path, ":") || strings.Contains(effect.Path, "..") {
			return Effect{}, fmt.Errorf("%w: path", ErrEffectInvalid)
		}
		effect.Summary = "写入 " + effect.Path
	case EffectGit:
		if effect.GitKind == "" {
			return Effect{}, fmt.Errorf("%w: git kind", ErrEffectInvalid)
		}
		effect.Summary = "Git " + effect.GitKind
	case EffectShell:
		if effect.SessionID == "" || strings.TrimSpace(effect.Text) == "" {
			return Effect{}, fmt.Errorf("%w: shell session", ErrEffectInvalid)
		}
		effect.Summary = "终端输入"
	case EffectMCP:
		if effect.Server == "" {
			return Effect{}, fmt.Errorf("%w: mcp server", ErrEffectInvalid)
		}
		effect.Summary = "MCP " + effect.Server
	default:
		return Effect{}, fmt.Errorf("%w: kind", ErrEffectInvalid)
	}
	return effect, nil
}

func cloneEffect(effect Effect) *Effect {
	copied := effect
	if len(effect.Paths) > 0 {
		copied.Paths = append([]string(nil), effect.Paths...)
	}
	return &copied
}

func newPrefixedID(prefix string) string {
	return prefix + "_" + strings.ToLower(strings.ReplaceAll(uuid.NewString(), "-", ""))
}

func requireContext(ctx context.Context) error {
	if ctx == nil {
		return errors.New("context is required")
	}
	return ctx.Err()
}
