//go:build wireinject
// +build wireinject

package app

import (
	"github.com/google/wire"

	"omnikube/internal/config"
)

// InitializeApp 由 wire 生成实现（见 wire_gen.go）。
func InitializeApp(cfg *config.Config) (*App, error) {
	wire.Build(ProviderSet)
	return nil, nil
}
