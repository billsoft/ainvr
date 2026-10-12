// Copyright AINVR.
#include "media_memory.hpp"
#include <hb_mem_mgr.h>
#include <stdexcept>
#include <string>
namespace ainvr {
void EnsureMediaMemory() {
  struct Module {
    Module() { int rc=hb_mem_module_open(); if(rc) throw std::runtime_error("open media memory: "+std::to_string(rc)); }
    ~Module() { hb_mem_module_close(); }
  };
  static Module module;
}
}
