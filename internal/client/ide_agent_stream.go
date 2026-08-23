package client

import (
	"context"
	"fmt"
	"strings"

	modeladapter "cursor/internal/backend/agent/model"
	serverconfig "cursor/internal/backend/server/config"
	"cursor/internal/ide/agentrun"
)

func (s *ProxyService) streamIDEAgent(ctx context.Context, request agentrun.StreamRequest, emit func(agentrun.Event) error) error {
	if s == nil {
		return agentrun.ErrStreamerMissing
	}
	cfg, err := s.LoadUserConfig()
	if err != nil {
		return err
	}
	adapter, ok := findModelAdapter(cfg.ModelAdapters, request.ModelID)
	if !ok {
		return fmt.Errorf("%w: model %s", agentrun.ErrInvalidRequest, request.ModelID)
	}
	req := modeladapter.StreamRequest{
		RequestID:                   request.RunID,
		RunID:                       request.RunID,
		ModelCallID:                 request.RunID,
		ModelID:                     strings.TrimSpace(adapter.ID),
		Provider:                    strings.TrimSpace(adapter.Type),
		ProtocolMode:                strings.TrimSpace(adapter.ProtocolMode),
		ProtocolGroup:               strings.TrimSpace(adapter.ProtocolGroup),
		BaseURL:                     strings.TrimSpace(adapter.BaseURL),
		APIKey:                      strings.TrimSpace(adapter.APIKey),
		ProviderModelID:             strings.TrimSpace(adapter.ModelID),
		ResolvedChannelID:           strings.TrimSpace(adapter.ID),
		ResolvedChannelName:         strings.TrimSpace(adapter.DisplayName),
		ResolvedContextWindowTokens: adapter.ContextWindowTokens,
		ReasoningEffort:             strings.TrimSpace(adapter.ReasoningEffort),
		OpenAIEndpoint:              strings.TrimSpace(adapter.OpenAIEndpoint),
		OpenAIRequestGroup:          strings.TrimSpace(adapter.OpenAIRequestGroup),
		OpenAIExtraParamsEnabled:    adapter.OpenAIExtraParamsEnabled,
		OpenAIExtraParamsJSON:       strings.TrimSpace(adapter.OpenAIExtraParamsJSON),
		CustomHeadersEnabled:        adapter.CustomHeadersEnabled,
		CustomHeadersJSON:           strings.TrimSpace(adapter.CustomHeadersJSON),
		Messages:                    []modeladapter.Message{{Role: "user", Content: request.Prompt}},
		Stream:                      true,
	}
	sink := func(event modeladapter.ModelEvent) error {
		if event.Kind != modeladapter.ModelEventKindTextDelta || event.Text == "" {
			return nil
		}
		return emit(agentrun.Event{Kind: agentrun.KindDelta, Text: event.Text, ReplaySafe: true})
	}
	switch strings.ToLower(strings.TrimSpace(adapter.Type)) {
	case "anthropic":
		return modeladapter.NewAnthropicAdapter().Stream(ctx, req, sink)
	case "gemini":
		return modeladapter.NewGeminiAdapter().Stream(ctx, req, sink)
	default:
		return modeladapter.NewOpenAIAdapter().Stream(ctx, req, sink)
	}
}

func findModelAdapter(adapters []serverconfig.ModelAdapterConfig, modelID string) (serverconfig.ModelAdapterConfig, bool) {
	modelID = strings.TrimSpace(modelID)
	for _, adapter := range adapters {
		if strings.TrimSpace(adapter.ID) == modelID || strings.TrimSpace(adapter.ModelID) == modelID {
			return adapter, true
		}
	}
	return serverconfig.ModelAdapterConfig{}, false
}
