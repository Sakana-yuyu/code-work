package sshvault

import (
	"errors"
)

var (
	ErrInvalidName           = errors.New("ssh key name is invalid")
	ErrInvalidKey            = errors.New("ssh private key is invalid")
	ErrKeyNotFound           = errors.New("ssh key not found")
	ErrProtectorUnavailable  = errors.New("ssh vault protector is unavailable")
	ErrVaultInvalid          = errors.New("ssh vault is invalid")
	ErrVaultCapacity         = errors.New("ssh vault capacity reached")
)

type Protector interface {
	Protect(plaintext []byte) ([]byte, error)
	Unprotect(ciphertext []byte) ([]byte, error)
}

type unavailableProtector struct{}

func (unavailableProtector) Protect([]byte) ([]byte, error) {
	return nil, ErrProtectorUnavailable
}

func (unavailableProtector) Unprotect([]byte) ([]byte, error) {
	return nil, ErrProtectorUnavailable
}
