/* CPU and RAM microbenchmarks. These are not DMIPS or peak DDR benchmarks. */
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static double now(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}
static __attribute__((noinline)) uint64_t mix(uint64_t x) {
  for (int i = 0; i < 200000; i++) {
    x ^= x >> 12; x ^= x << 25; x ^= x >> 27;
    x *= UINT64_C(2685821657736338717);
  }
  return x;
}
struct worker { int cpu; double seconds,elapsed; uint64_t count, checksum; int ok, affinity; };
static void *work(void *arg) {
  struct worker *w = arg;
  cpu_set_t set; CPU_ZERO(&set); CPU_SET(w->cpu, &set);
  w->affinity = pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
  /* Volatile input prevents GCC from hoisting the identical pure function out
   * of the timed loop. Every counted batch must perform the integer work. */
  volatile uint64_t seed = 1234567;
  uint64_t reference = mix(seed);
  double start = now();
  w->ok = 1;
  do {
    uint64_t v = mix(seed);
    if (v != reference) w->ok = 0;
    w->checksum = v; w->count++;
  } while (now() - start < w->seconds);
  w->elapsed = now() - start;
  return NULL;
}
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (!strcmp(argv[1], "cpu")) {
    double seconds = argc > 2 ? atof(argv[2]) : 2;
    cpu_set_t allowed; if (sched_getaffinity(0, sizeof(allowed), &allowed)) return 1;
    struct worker workers[CPU_SETSIZE]; pthread_t threads[CPU_SETSIZE]; int n = 0;
    for (int cpu = 0; cpu < CPU_SETSIZE; cpu++) if (CPU_ISSET(cpu, &allowed)) {
      workers[n] = (struct worker){.cpu=cpu, .seconds=seconds}; n++;
    }
    if (n < 1 || n > 64) return 2;
    for (int i = 0; i < n; i++) {
      struct worker single = {.cpu=workers[i].cpu,.seconds=seconds / n};
      work(&single);
      if (!single.ok || single.affinity) return 1;
      printf("HWJSON {\"mode\":\"single-core\",\"cpu\":%d,\"batches\":%lu,\"seconds\":%.6f,\"mix_iterations_per_second\":%.0f,\"checksum\":%lu}\n",
             single.cpu, single.count, single.elapsed,single.count*200000.0/single.elapsed,single.checksum);
    }
    double start = now();
    for (int i = 0; i < n; i++) if (pthread_create(&threads[i], NULL, work, &workers[i])) return 1;
    uint64_t total = 0;
    for (int i = 0; i < n; i++) {
      pthread_join(threads[i], NULL);
      if (!workers[i].ok || workers[i].affinity) return 1;
      total += workers[i].count;
    }
    double elapsed = now() - start;
    printf("HWJSON {\"mode\":\"all-cores\",\"cores\":%d,\"seconds\":%.6f,\"mix_iterations_per_second\":%.0f,\"checksum\":%lu}\n",
           n, elapsed, total * 200000.0 / elapsed, workers[0].checksum);
    return 0;
  }
  if (!strcmp(argv[1], "memory")) {
    const size_t size = 64 * 1024 * 1024;
    unsigned char *a = malloc(size), *b = malloc(size);
    if (!a || !b) return 1;
    for (size_t i = 0; i < size; i++) a[i] = (unsigned char)((i * 17 + (i >> 12)) & 255);
    memset(b, 0, size);
    int loops = 40; double start = now();
    for (int i = 0; i < loops; i++) {
      memcpy(b, a, size);
      __asm__ volatile("" : : "r"(b) : "memory");
    }
    double elapsed = now() - start;
    if (memcmp(a, b, size)) return 1;
    for (size_t i = 0; i < size; i++) if (b[i] != (unsigned char)((i * 17 + (i >> 12)) & 255)) return 1;
    printf("HWJSON {\"bytes\":%zu,\"copies\":%d,\"seconds\":%.6f,\"payload_copy_GBps\":%.3f,\"verified_bytes\":%zu}\n",
           size, loops, elapsed, size * (double)loops / elapsed / 1e9, size);
    free(a); free(b); return 0;
  }
  return 2;
}
