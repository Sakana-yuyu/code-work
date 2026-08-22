package appdata

import (
	"fmt"
	"os"
)

func ensureAssistantHome() error {
	if err := os.MkdirAll(RootDir(), 0o755); err != nil {
		return fmt.Errorf("create Code Work home: %w", err)
	}
	if err := os.MkdirAll(DataRootPath(), 0o755); err != nil {
		return fmt.Errorf("create data root: %w", err)
	}
	if err := os.MkdirAll(HistoryRootPath(), 0o755); err != nil {
		return fmt.Errorf("create history root: %w", err)
	}
	if err := os.MkdirAll(RulesRootPath(), 0o755); err != nil {
		return fmt.Errorf("create rules root: %w", err)
	}
	if err := os.MkdirAll(LogsRootPath(), 0o755); err != nil {
		return fmt.Errorf("create logs root: %w", err)
	}
	return nil
}

func EnsureAssistantHome() error {
	return ensureAssistantHome()
}
