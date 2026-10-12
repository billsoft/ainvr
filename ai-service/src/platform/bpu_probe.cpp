#include "bpu.hpp"
#include "tensor_decode.hpp"
#include <cmath>
#include <chrono>
#include <iostream>
int main(int argc, char** argv) {
  try {
    if (argc < 2 || argc > 3) throw std::invalid_argument("Usage: ainvr_bpu_probe model.hbm [iterations]");
    int iterations = argc == 3 ? std::stoi(argv[2]) : 0;
    if (iterations < 0 || iterations > 10000) throw std::invalid_argument("iterations must be 0..10000");
    ainvr::BpuModel model(argv[1]); auto report = model.Describe();
    std::vector<std::vector<unsigned char>> inputs;
    for (const auto& t : report["inputs"]) inputs.emplace_back(t["aligned_bytes"].get<size_t>(), 0);
    auto start = std::chrono::steady_clock::now();
    size_t output_bytes = 0;
    size_t output_elements = 0;
    for (int i = 0; i < iterations; ++i) {
      auto outputs = model.Run(inputs); output_bytes = 0;
      output_elements=0;
      for (size_t k=0;k<outputs.size();++k) {
        output_bytes += outputs[k].size();
        auto dense=ainvr::DecodeTensor(outputs[k],report["outputs"][k]);
        output_elements+=dense.size();
        for(float x:dense)if(!std::isfinite(x))throw std::runtime_error("Nonfinite model output");
      }
    }
    report["iterations"] = iterations; report["output_bytes"] = output_bytes;
    report["output_elements"] = output_elements;
    report["elapsed_ms"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-start).count();
    report["test_input"] = "zero-filled aligned buffers; execution test, not accuracy evaluation";
    std::cout << report.dump(2) << '\n'; return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
