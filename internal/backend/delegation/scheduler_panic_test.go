package delegation

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSchedulerExecutorPanicReleasesActiveExecution(t *testing.T) {
	scheduler := NewScheduler(Config{MaxConcurrency: 1}, func(context.Context, TaskRequest) TaskResult {
		panic("executor panic")
	})
	defer scheduler.Close()
	if _, err := scheduler.Submit(TaskRequest{ID: "panic-task", Prompt: "test"}); err != nil {
		t.Fatalf("Submit() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := scheduler.WaitForTerminal(ctx, []string{"panic-task"}); err != nil {
		t.Fatalf("WaitForTerminal() error = %v", err)
	}
	snapshot, ok := scheduler.Snapshot("panic-task")
	if !ok || snapshot.Status != TaskFailed || !strings.Contains(snapshot.Error, "panic") {
		t.Fatalf("panic task snapshot = %+v", snapshot)
	}
	scheduler.mu.RLock()
	_, active := scheduler.activeExecutions["panic-task"]
	scheduler.mu.RUnlock()
	if active {
		t.Fatal("panic task leaked active execution ownership")
	}
}
