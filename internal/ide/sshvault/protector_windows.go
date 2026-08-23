//go:build windows

package sshvault

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var dpapiEntropy = []byte("code-work-ssh-vault-v1")

type dpapiProtector struct{}

func NewDPAPIProtector() Protector {
	return dpapiProtector{}
}

func (dpapiProtector) Protect(plaintext []byte) ([]byte, error) {
	return cryptProtect(plaintext)
}

func (dpapiProtector) Unprotect(ciphertext []byte) ([]byte, error) {
	return cryptUnprotect(ciphertext)
}

func cryptProtect(plaintext []byte) ([]byte, error) {
	input, entropy := blobs(plaintext, dpapiEntropy)
	var output windows.DataBlob
	name, err := windows.UTF16PtrFromString("code-work-ssh-key")
	if err != nil {
		return nil, fmt.Errorf("%w: protect name", ErrProtectorUnavailable)
	}
	if err := windows.CryptProtectData(input, name, entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, fmt.Errorf("%w: crypt protect", ErrProtectorUnavailable)
	}
	defer freeBlob(output)
	return copyBlob(output), nil
}

func cryptUnprotect(ciphertext []byte) ([]byte, error) {
	input, entropy := blobs(ciphertext, dpapiEntropy)
	var output windows.DataBlob
	if err := windows.CryptUnprotectData(input, nil, entropy, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &output); err != nil {
		return nil, fmt.Errorf("%w: crypt unprotect", ErrProtectorUnavailable)
	}
	defer freeBlob(output)
	return copyBlob(output), nil
}

func blobs(data, entropy []byte) (*windows.DataBlob, *windows.DataBlob) {
	return dataBlob(data), dataBlob(entropy)
}

func dataBlob(data []byte) *windows.DataBlob {
	if len(data) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
}

func copyBlob(blob windows.DataBlob) []byte {
	if blob.Size == 0 || blob.Data == nil {
		return []byte{}
	}
	copied := make([]byte, blob.Size)
	copy(copied, unsafe.Slice(blob.Data, blob.Size))
	return copied
}

func freeBlob(blob windows.DataBlob) {
	if blob.Data != nil {
		_, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(blob.Data)))
	}
}
