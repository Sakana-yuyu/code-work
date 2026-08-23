package termsession

import "context"

type unavailableHost struct{}

func (unavailableHost) Start(context.Context, StartSpec) (Process, error) {
	return nil, ErrTerminalUnavailable
}

func NewSystemHost() Host {
	host, err := newSystemHost()
	if err != nil {
		return unavailableHost{}
	}
	return host
}
