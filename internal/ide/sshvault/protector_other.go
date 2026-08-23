//go:build !windows

package sshvault

func NewDPAPIProtector() Protector {
	return unavailableProtector{}
}
