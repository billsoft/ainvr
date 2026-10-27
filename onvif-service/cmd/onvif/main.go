package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	onvif "ainvr/onvif"
)

func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: ainvr_onvif CONFIG")
	}
	raw, e := os.ReadFile(os.Args[1])
	if e != nil {
		log.Fatal("cannot read bootstrap")
	}
	var c struct {
		Listen string `json:"listen"`
		Token  string `json:"token"`
	}
	if json.Unmarshal(raw, &c) != nil {
		log.Fatal("invalid bootstrap")
	}
	host, _, e := net.SplitHostPort(c.Listen)
	if e != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("management listener must use loopback")
	}
	handler, e := onvif.NewServer(c.Token)
	if e != nil {
		log.Fatal("invalid service credential")
	}
	defer handler.Close()
	srv := &http.Server{Addr: c.Listen, Handler: handler, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 50 * time.Second, IdleTimeout: 20 * time.Second, MaxHeaderBytes: 8192}
	stop, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	go func() {
		<-stop.Done()
		ctx, end := context.WithTimeout(context.Background(), 5*time.Second)
		defer end()
		_ = srv.Shutdown(ctx)
	}()
	log.Print("AINVR ONVIF control service starting")
	if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal("management listener failed")
	}
}
