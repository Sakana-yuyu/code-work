package client

import (
	"context"
	"fmt"

	"cursor/internal/ide/termsession"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const ideTerminalOutputEvent = "ide:terminal-output"

type IDETerminalProfile = termsession.Profile
type IDETerminalSession = termsession.SessionInfo
type IDETerminalOutput = termsession.OutputSnapshot
type IDETerminalOutputEvent = termsession.Event

func (s *ProxyService) ListIDETerminalProfiles() []IDETerminalProfile {
	return termsession.ListProfiles()
}

func (s *ProxyService) OpenIDETerminalSession(workspaceID, profileID string, cols, rows int) (IDETerminalSession, error) {
	if s == nil || s.ideTerminal == nil {
		return IDETerminalSession{}, fmt.Errorf("终端服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return IDETerminalSession{}, err
	}
	info, err := s.ideTerminal.Open(context.Background(), workspaceID, profileID, cols, rows)
	return info, mapIDEWorkspaceError(err)
}

func (s *ProxyService) WriteIDETerminalSession(sessionID, data string) error {
	if s == nil || s.ideTerminal == nil {
		return fmt.Errorf("终端服务未初始化")
	}
	return mapIDEWorkspaceError(s.ideTerminal.Write(context.Background(), sessionID, data))
}

func (s *ProxyService) ResizeIDETerminalSession(sessionID string, cols, rows int) error {
	if s == nil || s.ideTerminal == nil {
		return fmt.Errorf("终端服务未初始化")
	}
	return mapIDEWorkspaceError(s.ideTerminal.Resize(context.Background(), sessionID, cols, rows))
}

func (s *ProxyService) InterruptIDETerminalSession(sessionID string) error {
	if s == nil || s.ideTerminal == nil {
		return fmt.Errorf("终端服务未初始化")
	}
	return mapIDEWorkspaceError(s.ideTerminal.Interrupt(context.Background(), sessionID))
}

func (s *ProxyService) CloseIDETerminalSession(sessionID string) error {
	if s == nil || s.ideTerminal == nil {
		return fmt.Errorf("终端服务未初始化")
	}
	return mapIDEWorkspaceError(s.ideTerminal.Close(context.Background(), sessionID))
}

func (s *ProxyService) GetIDETerminalOutput(sessionID string) (IDETerminalOutput, error) {
	if s == nil || s.ideTerminal == nil {
		return IDETerminalOutput{}, fmt.Errorf("终端服务未初始化")
	}
	snapshot, err := s.ideTerminal.Snapshot(sessionID)
	return snapshot, mapIDEWorkspaceError(err)
}

func emitIDETerminalOutput(event termsession.Event) {
	app := application.Get()
	if app == nil {
		return
	}
	app.Event.Emit(ideTerminalOutputEvent, event)
}
