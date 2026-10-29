// Pure software cache policy tests. No model, SDK, Mongo or network.
#include "../../search-service/src/text_embedding_cache.hpp"
#include <iostream>
#include <limits>

using ainvr::search::BoundedTextEmbeddingCache;
namespace {
size_t checks = 0;
void Check(bool condition, const char* description) {
  ++checks;
  if (!condition) throw std::runtime_error(description);
}
template<class F> void Invalid(F&& function) {
  bool failed = false;
  try { function(); } catch (const std::invalid_argument&) { failed = true; }
  Check(failed, "invalid cache construction accepted");
}
}
int main() {
  using Cache = BoundedTextEmbeddingCache;
  const auto start = Cache::TimePoint{} + std::chrono::hours(24);
  const std::vector<float> unit{0.6f, 0.8f};
  Invalid([] { Cache cache("", 2); });
  Invalid([] { Cache cache("version", 0); });
  Invalid([] { Cache cache("version", 4097); });
  Cache cache("package-tokenizer-hash-one", 2);
  Check(!cache.Get("穿红衣服的人", start), "empty cache hit");
  Check(cache.PutNormalized("穿红衣服的人", unit, start), "valid normalized vector rejected");
  Check(cache.Get("穿红衣服的人", start) == unit, "Chinese exact query miss");
  Check(!cache.Get("穿红衣服的人 ", start), "query bytes silently rewritten");
  Check(!cache.Get("穿红衣服的人", start + Cache::kTtl), "TTL exact boundary hit");
  Check(cache.Size() == 0 && cache.RetainedBytes() == 0, "expiry retained bytes");
  Check(cache.PutNormalized("red jacket", unit, start), "put failed");
  Check(cache.Get("red jacket", start + std::chrono::minutes(4)) == unit, "early TTL miss");
  Check(!cache.Get("red jacket", start + std::chrono::minutes(5)), "read extended TTL");

  for (const auto& bad : std::vector<std::vector<float>>{{}, {1.f}, {0.f, 0.f}, {3.f, 4.f},
       {std::numeric_limits<float>::quiet_NaN(), 0.f}, {std::numeric_limits<float>::infinity(), 0.f}})
    Check(!cache.PutNormalized("bad", bad, start), "invalid vector cached");
  for (const auto& bad : std::vector<std::string>{"", " \t\r\n", std::string(1025, 'x'), std::string("a\0b", 3)})
    Check(!cache.PutNormalized(bad, unit, start), "invalid query cached");
  Check(cache.Size() == 0, "invalid input changed cache");
  Check(cache.PutNormalized(std::string(1024, 'x'), unit, start), "HTTP byte boundary rejected");
  cache.Clear();
  Check(cache.Size() == 0 && cache.RetainedBytes() == 0, "Clear did not release state");

  for (size_t i = 0; i < Cache::kMaxEntries; ++i)
    Check(cache.PutNormalized("query-" + std::to_string(i), unit, start), "entry budget rejected too early");
  Check(cache.Get("query-0", start).has_value(), "LRU initial hit failed");
  Check(cache.PutNormalized("overflow", unit, start), "LRU overflow put failed");
  Check(cache.Size() == Cache::kMaxEntries, "entry cap exceeded");
  Check(cache.Get("query-0", start).has_value(), "recent hit evicted");
  Check(!cache.Get("query-1", start), "least-recent query not evicted");
  Check(cache.PutNormalized("query-0", {0.f, 1.f}, start), "replacement failed");
  Check(cache.Size() == Cache::kMaxEntries, "replacement increased count");
  auto copy = cache.Get("query-0", start); (*copy)[0] = 1.f;
  Check(cache.Get("query-0", start) == std::vector<float>({0.f, 1.f}), "caller mutated cached vector");

  Cache huge("high-dimensional", 4096); const std::vector<float> big(4096, 1.f / 64.f);
  for (size_t i = 0; i < Cache::kMaxEntries + 20; ++i) {
    Check(huge.PutNormalized(std::string(1000, 'a') + std::to_string(i), big, start), "byte capped insert failed");
    Check(huge.RetainedBytes() <= Cache::kMaxBytes && huge.Size() <= Cache::kMaxEntries, "hard byte/count cap exceeded");
  }
  Check(huge.Size() < Cache::kMaxEntries, "byte budget did not evict large entries");
  Cache different("different-package-tokenizer", 2);
  Check(!different.Get("query-0", start), "vector crossed model/tokenizer generation");

  // Integration-shaped policy: the existing engine mutex serializes this
  // sequence. Only a successful Encode+Normalize reaches Put; a hit still
  // executes the scoped lookup and never bypasses an unhealthy encoder.
  Cache integration("fixed-model-space", 2); size_t encodes = 0, scoped_queries = 0;
  bool healthy = true, fail_encode = false;
  auto match = [&](const std::string& query, const std::string& scope) {
    if (!healthy) throw std::runtime_error("unhealthy");
    auto value = integration.Get(query, start);
    if (!value) {
      ++encodes; if (fail_encode) throw std::runtime_error("encoding failed");
      value = unit; integration.PutNormalized(query, *value, start);
    }
    ++scoped_queries;
    return scope; // Fake scoped retrieval, never cached by this component.
  };
  Check(match("same", "allowed-A") == "allowed-A", "first scoped retrieval failed");
  Check(match("same", "allowed-B") == "allowed-B", "cache reused old scope/results");
  Check(encodes == 1 && scoped_queries == 2, "cache did not skip only encoding");
  healthy = false;
  bool rejected = false;
  try { match("same", "revoked"); } catch (const std::runtime_error&) { rejected = true; }
  Check(rejected, "unhealthy cache hit accepted");
  Check(scoped_queries == 2, "unhealthy hit queried index");
  healthy = true; fail_encode = true;
  try { match("never-cached", "allowed-A"); } catch (const std::runtime_error&) {}
  Check(!integration.Get("never-cached", start), "failed encoding cached");
  std::cout << "text_embedding_cache: " << checks << " checks passed; software only\n";
}
