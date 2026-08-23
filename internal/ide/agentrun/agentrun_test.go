package agentrun

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestStartStreamsPersistsAndReplaysSafeEvents(t *testing.T) {
	t.Parallel()
	manager := New(t.TempDir(), func(ctx context.Context, request StreamRequest, emit func(Event) error) error {
		if request.ModelID != "demo-gpt" || request.Prompt != "总结工作区" {
			t.Fatalf("request = %+v", request)
		}
		if err := emit(Event{Kind: KindDelta, Text: "你好"}); err != nil {
			return err
		}
		return emit(Event{Kind: KindDelta, Text: "世界"})
	})
	run, err := manager.Start(context.Background(), "workspace-1", "demo-gpt", "总结工作区")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	waitStatus(t, manager, run.ID, StatusCompleted)
	events, err := manager.Events(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("Events() error = %v", err)
	}
	if len(events) < 4 {
		t.Fatalf("events = %+v", events)
	}
	raw, err := json.Marshal(events)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if strings.Contains(strings.ToLower(string(raw)), `c:\`) || strings.Contains(string(raw), "/users/") {
		t.Fatalf("events leaked host path: %s", raw)
	}
	replay, err := manager.Replay(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("Replay() error = %v", err)
	}
	for _, event := range replay {
		if !event.ReplaySafe {
			t.Fatalf("replay included unsafe event: %+v", event)
		}
	}
}

func TestCancelStopsActiveRun(t *testing.T) {
	t.Parallel()
	started := make(chan struct{})
	manager := New(t.TempDir(), func(ctx context.Context, request StreamRequest, emit func(Event) error) error {
		close(started)
		<-ctx.Done()
		return ctx.Err()
	})
	run, err := manager.Start(context.Background(), "workspace-1", "demo-gpt", "长时间任务")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("streamer did not start")
	}
	if _, err := manager.Cancel(context.Background(), run.ID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	waitStatus(t, manager, run.ID, StatusCanceled)
}

func TestProposeEffectIsNotReplaySafe(t *testing.T) {
	t.Parallel()
	manager := New(t.TempDir(), func(ctx context.Context, request StreamRequest, emit func(Event) error) error {
		return emit(Event{Kind: KindDelta, Text: "ok"})
	})
	run, err := manager.Start(context.Background(), "workspace-1", "demo-gpt", "改文件")
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	waitStatus(t, manager, run.ID, StatusCompleted)
	effect, err := manager.ProposeEffect(context.Background(), run.ID, Effect{
		Kind: EffectWrite,
		Path: "src/main.go",
		Text: "package main\n",
	})
	if err != nil {
		t.Fatalf("ProposeEffect() error = %v", err)
	}
	if effect.ID == "" {
		t.Fatal("expected effect id")
	}
	replay, err := manager.Replay(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("Replay() error = %v", err)
	}
	for _, event := range replay {
		if event.Kind == KindEffectProposed {
			t.Fatalf("replay included effect: %+v", event)
		}
	}
	events, err := manager.Events(context.Background(), run.ID)
	if err != nil {
		t.Fatalf("Events() error = %v", err)
	}
	found := false
	for _, event := range events {
		if event.Kind == KindEffectProposed && event.Effect != nil && event.Effect.ID == effect.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing proposed effect in events: %+v", events)
	}
}

func TestStartRejectsEmptyPrompt(t *testing.T) {
	t.Parallel()
	manager := New(t.TempDir(), func(ctx context.Context, request StreamRequest, emit func(Event) error) error {
		return nil
	})
	_, err := manager.Start(context.Background(), "workspace-1", "demo-gpt", "  ")
	if !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("Start() error = %v, want ErrInvalidRequest", err)
	}
}

func waitStatus(t *testing.T, manager *Manager, runID, want string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		run, err := manager.Get(context.Background(), runID)
		if err == nil && run.Status == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	run, err := manager.Get(context.Background(), runID)
	t.Fatalf("status = (%+v, %v), want %s", run, err, want)
}
