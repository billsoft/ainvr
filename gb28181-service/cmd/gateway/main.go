package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	gateway "ainvr/gb28181"
)

func main() {
	bootstrap := flag.String("bootstrap", "", "private bootstrap JSON path")
	flag.Parse()
	if *bootstrap == "" {
		fmt.Fprintln(os.Stderr, "bootstrap file required")
		os.Exit(2)
	}
	st, e := os.Stat(*bootstrap)
	if e != nil || st.Mode().Perm()&0077 != 0 {
		fmt.Fprintln(os.Stderr, "bootstrap must exist with private permissions")
		os.Exit(2)
	}
	data, e := os.ReadFile(*bootstrap)
	if e != nil || len(data) > 8192 {
		fmt.Fprintln(os.Stderr, "invalid bootstrap")
		os.Exit(2)
	}
	var cfg struct {
		Listen string `json:"listen"`
		Token  string `json:"token"`
	}
	if json.Unmarshal(data, &cfg) != nil || len(cfg.Token) < 32 {
		fmt.Fprintln(os.Stderr, "invalid bootstrap")
		os.Exit(2)
	}
	host, _, e := net.SplitHostPort(cfg.Listen)
	ip := net.ParseIP(host)
	if e != nil || ip == nil || !ip.IsLoopback() {
		fmt.Fprintln(os.Stderr, "management must bind loopback; use a protected reverse proxy for external access")
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	manager := &gateway.Manager{}
	defer manager.Close()
	server := &http.Server{Addr: cfg.Listen, Handler: manager.Handler(ctx, cfg.Token), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 25 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	go func() {
		<-ctx.Done()
		stop, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		_ = server.Shutdown(stop)
	}()
	if e := server.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		fmt.Fprintln(os.Stderr, "management listener failed")
		os.Exit(1)
	}
}
