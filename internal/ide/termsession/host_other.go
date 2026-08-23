//go:build !windows

package termsession

func newSystemHost() (Host, error) {
	return nil, ErrTerminalUnavailable
}
