package delegation

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedulerCancelRetainsSlotUntilExecutorReturns(t *testing.T) {
	startedA := make(chan struct{}, 1)
	startedB := make(chan struct{}, 1)
	releaseA := make(chan struct{})
	var calls atomic.Int32
	scheduler := NewScheduler(Config{MaxConcurrency: 1}, func(_ context.Context, request TaskRequest) TaskResult {
		switch calls.Add(1) {
		case 1:
			startedA <- struct{}{}
			<-releaseA
			return TaskResult{Output: "first"}
		case 2:
			startedB <- struct{}{}
			return TaskResult{Output: "second"}
		default:
			return TaskResult{Output: "unexpected"}
		}
	})
	defer scheduler.Close()

	if _, err := scheduler.Submit(TaskRequest{ID: "task-a", Prompt: "first"}); err != nil {
		t.Fatalf("Submit(task-a) error = %v", err)
	}
	select {
	case <-startedA:
	case <-time.After(time.Second):
		t.Fatal("task-a executor did not start")
	}
	if err := scheduler.Cancel("task-a"); err != nil {
		t.Fatalf("Cancel(task-a) error = %v", err)
	}
	if _, err := scheduler.Submit(TaskRequest{ID: "task-b", Prompt: "second"}); err != nil {
		t.Fatalf("Submit(task-b) error = %v", err)
	}
	select {
	case <-startedB:
		t.Fatal("task-b started before context-ignoring task-a physically returned")
	case <-time.After(100 * time.Millisecond):
	}
	close(releaseA)
	select {
	case <-startedB:
	case <-time.After(time.Second):
		t.Fatal("task-b did not start after task-a returned")
	}
	result, ok := scheduler.Result("task-a")
	if !ok || result.Error != context.Canceled {
		t.Fatalf("canceled task result = %+v, found=%t", result, ok)
	}
}
