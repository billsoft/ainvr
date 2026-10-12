// Copyright AINVR. Capture calibration seed tensors through production hardware.
// No model execution, CPU image math or CPU decoder is used by this utility.
#include "stream/source.hpp"
#include "platform/image_preprocessor.hpp"
#include <openssl/sha.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <thread>

namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
std::string Digest(const std::vector<float>& values) {
  unsigned char bytes[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(values.data()),
         values.size()*sizeof(float), bytes);
  std::ostringstream text;
  for (auto b : bytes) text << std::hex << std::setw(2) << std::setfill('0') << int(b);
  return text.str();
}
void SaveReport(const std::filesystem::path& directory, const Json& report) {
  auto temporary = directory/".capture.json.tmp";
  std::ofstream stream(temporary);
  stream << report.dump(2) << '\n'; stream.close();
  if (!stream) throw std::runtime_error("Cannot save calibration report");
  std::filesystem::rename(temporary, directory/"capture.json");
}
}
int main(int argc, char** argv) {
  static_assert(sizeof(float)==4 && std::numeric_limits<float>::is_iec559);
  static_assert(std::endian::native==std::endian::little);
  Json report = {{"passed",false}, {"seed_only",true}, {"hbm_compiled",false},
    {"user_model_accuracy_verified",false}, {"cpu_image_processing",false},
    {"cpu_decode",false}, {"samples",Json::array()}};
  std::filesystem::path directory;
  bool output_owned=false;
  try {
    if (argc!=3) throw std::invalid_argument("Usage: capture specification.json new-output-dir");
    std::ifstream input(argv[1]); Json spec; input >> spec;
    const int count=spec.at("count"), interval=spec.at("interval_ms");
    if(count<1 || count>60 || interval<200 || interval>1000)
      throw std::invalid_argument("Capture is bounded to 1..60 samples, 200..1000 ms apart");
    ainvr::ImageTransform transform;
    transform.height=spec.at("input_size").at(0);
    transform.width=spec.at("input_size").at(1);
    if(transform.height<32 || transform.height>2048 || transform.width<32 || transform.width>2048)
      throw std::invalid_argument("Invalid calibration tensor size");
    transform.mean=spec.at("mean").get<std::array<float,3>>();
    transform.divisor=spec.at("divisor").get<std::array<float,3>>();
    transform.padding=spec.at("padding").get<std::array<float,3>>();
    transform.bgr=spec.at("bgr");
    transform.letterbox=spec.at("letterbox");
    transform.nearest=spec.at("nearest");
    for(int i=0;i<3;++i)
      if(!std::isfinite(transform.mean[i]) || !std::isfinite(transform.divisor[i]) ||
         transform.divisor[i]<=0 || !std::isfinite(transform.padding[i]))
        throw std::invalid_argument("Invalid normalization parameters");
    directory=argv[2];
    if(!std::filesystem::create_directory(directory))
      throw std::runtime_error("Output directory already exists");
    output_owned=true;
    std::filesystem::create_directory(directory/"data_f32");
    report["specification"]=spec;
    report["tensor"]={{"dtype","float32_le"},{"layout","NCHW"},
      {"shape",{1,3,transform.height,transform.width}},{"header_bytes",0}};
    SaveReport(directory, report);
    ai_service::stream::StreamSource source(spec.at("source_url"),"ainvr-calibration-capture",false);
    source.Start();
    ainvr::ImagePreprocessor images({true,true,false});
    const auto started=Clock::now(), deadline=started+std::chrono::seconds(90);
    auto next=started;
    std::optional<int64_t> last_pts;
    while(report["samples"].size()<size_t(count) && Clock::now()<deadline) {
      auto frame=source.PullFrameRef(100);
      if(!frame) {
        if(!source.IsRunning()) throw std::runtime_error("Camera stopped during calibration capture");
        continue;
      }
      if(Clock::now()<next) continue;
      if(last_pts && frame->pts_ns<=*last_pts) continue;
      transform.yuv_bt709=frame->bt709; transform.yuv_full_range=frame->full_range;
      const auto begin=Clock::now();
      auto prepared=images.RunNv12(frame->nv12,transform);
      if(prepared.backend.find("cpu")!=std::string::npos ||
         prepared.chw.size()!=size_t(3)*transform.height*transform.width)
        throw std::runtime_error("Hardware calibration tensor contract mismatch");
      float low=INFINITY, high=-INFINITY;
      for(float value:prepared.chw) {
        if(!std::isfinite(value)) throw std::runtime_error("Non-finite calibration tensor");
        low=std::min(low,value); high=std::max(high,value);
      }
      std::ostringstream filename;
      filename << "frame_" << std::setw(4) << std::setfill('0') << report["samples"].size() << ".bin";
      auto output=directory/"data_f32"/filename.str();
      std::ofstream file(output,std::ios::binary);
      file.write(reinterpret_cast<const char*>(prepared.chw.data()),
                 prepared.chw.size()*sizeof(float)); file.close();
      if(!file) throw std::runtime_error("Cannot write calibration tensor");
      report["samples"].push_back({{"file",filename.str()},{"sha256",Digest(prepared.chw)},
        {"pts_ns",frame->pts_ns},{"source_pts_ns",frame->source_pts_ns.value_or(-1)},
        {"source_width",frame->width},{"source_height",frame->height},
        {"source_bt709",frame->bt709},{"source_full_range",frame->full_range},
        {"backend",prepared.backend},{"hardware_fallback_reasons",prepared.fallback_reasons},
        {"minimum",low},{"maximum",high},{"bytes",prepared.chw.size()*sizeof(float)},
        {"preprocess_ms",std::chrono::duration<double,std::milli>(Clock::now()-begin).count()}});
      last_pts=frame->pts_ns;
      next=Clock::now()+std::chrono::milliseconds(interval);
      SaveReport(directory, report);
    }
    source.Stop();
    if(report["samples"].size()!=size_t(count)) throw std::runtime_error("Calibration capture timed out");
    report["passed"]=true;
    report["elapsed_seconds"]=std::chrono::duration<double>(Clock::now()-started).count();
    SaveReport(directory, report);
    std::cout << "CAPTURED " << count << " real-camera calibration seed tensors\n";
    return 0;
  } catch(const std::exception& error) {
    report["error"]=error.what();
    if(output_owned && std::filesystem::is_directory(directory)) {
      try { SaveReport(directory,report); } catch(...) {}
    }
    std::cerr << error.what() << '\n';
    return 1;
  }
}
