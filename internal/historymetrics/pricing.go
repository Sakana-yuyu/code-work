package historymetrics

import "strings"

// PriceRate 表示某个模型渠道的每百万 token 价格。
// 由 bridge 层从当前配置的 ModelAdapterConfig.Pricing 构建，避免 historymetrics 依赖 config 包。
type PriceRate struct {
	Model      string
	Provider   string
	BaseURL    string
	Input      *float64
	Output     *float64
	CacheRead  *float64
	CacheWrite *float64
	Currency   string
	Known      bool
	Source     string
}

// PriceLookup 支持按 (model, provider, baseURL) 及其降级键解析价格。
type PriceLookup struct {
	byKey map[string]PriceRate
}

// NewPriceLookup 依据渠道价格条目构建查询表。
// 同一键位以先出现者为准，且优先保留 Known 的价格。
func NewPriceLookup(rates []PriceRate) *PriceLookup {
	lookup := &PriceLookup{byKey: make(map[string]PriceRate, len(rates)*3)}
	for _, rate := range rates {
		if rate.Input == nil && rate.Output == nil && rate.CacheRead == nil && rate.CacheWrite == nil {
			continue
		}
		for _, key := range priceKeys(rate.Model, rate.Provider, rate.BaseURL) {
			existing, ok := lookup.byKey[key]
			if ok && existing.Known && !rate.Known {
				continue
			}
			if ok && existing.Known == rate.Known {
				// 已有条目则保留先出现者，避免不同渠道相互覆盖。
				continue
			}
			lookup.byKey[key] = rate
		}
	}
	return lookup
}

// Cost 计算一次请求的美元成本。
// 返回 (成本指针, 价格是否已知, 币种)。价格未知时成本为 nil。
func (lookup *PriceLookup) Cost(model, provider, baseURL string, input, output, cacheRead, cacheWrite int64) (*float64, bool, string, string) {
	return lookup.CostForCandidates([]string{model}, provider, baseURL, input, output, cacheRead, cacheWrite)
}

// CostForCandidates 按渠道特异性优先、模型候选次优先解析费用。
// 这让实际 provider model 优先于 UI 显示名称，同时避免宽松别名价格遮蔽精确渠道价格。
func (lookup *PriceLookup) CostForCandidates(candidates []string, provider, baseURL string, input, output, cacheRead, cacheWrite int64) (*float64, bool, string, string) {
	if lookup == nil {
		return nil, false, "", ""
	}
	models := normalizedPriceModelCandidates(candidates)
	provider = strings.ToLower(strings.TrimSpace(provider))
	baseURL = strings.ToLower(strings.TrimSpace(baseURL))
	for _, keys := range [][]string{
		priceCandidateKeys(models, provider, baseURL, true, true),
		priceCandidateKeys(models, provider, "", true, false),
		priceCandidateKeys(models, "", "", false, false),
	} {
		for _, key := range keys {
			rate, ok := lookup.byKey[key]
			if !ok {
				continue
			}
			var total float64
			total += ratePart(rate.Input, input)
			total += ratePart(rate.Output, output)
			total += ratePart(rate.CacheRead, cacheRead)
			total += ratePart(rate.CacheWrite, cacheWrite)
			cost := total / 1_000_000
			return &cost, rate.Known, strings.TrimSpace(rate.Currency), strings.TrimSpace(rate.Source)
		}
	}
	return nil, false, "", ""
}

func normalizedPriceModelCandidates(candidates []string) []string {
	models := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		model := strings.ToLower(strings.TrimSpace(candidate))
		if model == "" {
			continue
		}
		if _, exists := seen[model]; exists {
			continue
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	return models
}

func priceCandidateKeys(models []string, provider, baseURL string, requireProvider, requireBaseURL bool) []string {
	if len(models) == 0 || (requireProvider && provider == "") || (requireBaseURL && baseURL == "") {
		return nil
	}
	keys := make([]string, 0, len(models))
	for _, model := range models {
		switch {
		case requireBaseURL:
			keys = append(keys, model+"|"+provider+"|"+baseURL)
		case requireProvider:
			keys = append(keys, model+"|"+provider+"|")
		default:
			keys = append(keys, model+"||")
		}
	}
	return keys
}

func ratePart(rate *float64, tokens int64) float64 {
	if rate == nil || tokens <= 0 {
		return 0
	}
	return *rate * float64(tokens)
}

// priceKeys 返回从精确到宽松的候选键：
// model|provider|baseURL -> model|provider -> model。
func priceKeys(model, provider, baseURL string) []string {
	model = strings.ToLower(strings.TrimSpace(model))
	provider = strings.ToLower(strings.TrimSpace(provider))
	baseURL = strings.ToLower(strings.TrimSpace(baseURL))
	if model == "" {
		return nil
	}
	keys := make([]string, 0, 3)
	if provider != "" && baseURL != "" {
		keys = append(keys, model+"|"+provider+"|"+baseURL)
	}
	if provider != "" {
		keys = append(keys, model+"|"+provider+"|")
	}
	keys = append(keys, model+"||")
	return keys
}
