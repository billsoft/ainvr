// Copyright AINVR. GPU image preprocessing with explicit host transfer.
// Explicit GLES backend, not the default hardware selector. Prefer validated
// PYM for supported NV12 scaling and evaluate GDC for geometric maps. Dispatch
// integration is pending; this class does not silently select those backends.
#pragma once
#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <vector>
namespace ainvr {
enum class ImageInterpolation { Bilinear=0, Bicubic=1, Area=2, Lanczos4=3 };
struct ImageTransform {
  int width = 640, height = 640;
  bool letterbox = true, nearest = false, bgr = false;
  bool yuv_bt709 = true, yuv_full_range = false;
  std::array<float,3> mean{0,0,0}, divisor{255,255,255};
  std::array<float,3> padding{114,114,114};
  // ERP panorama -> rectilinear perspective, angles in radians.
  bool erp_perspective = false;
  float yaw = 0, pitch = 0, horizontal_fov = 1.57079632679f;
  // Source pixel-edge coordinates x/y/width/height. Out-of-frame samples
  // replicate the image edge. Mutually exclusive with ERP and letterboxing.
  std::optional<std::array<float,4>> source_region;
  // nearest keeps the established crop sampler. Other filters round resized
  // RGB8 before model normalization, as the original byte-image pipeline does.
  ImageInterpolation interpolation=ImageInterpolation::Bilinear;
};
void ValidateSourceRegion(const ImageTransform& transform);
void ValidateInterpolation(const ImageTransform& transform,int source_width,int source_height);
class GlesPreprocessor {
 public:
  GlesPreprocessor();
  ~GlesPreprocessor();
  GlesPreprocessor(const GlesPreprocessor&) = delete;
  GlesPreprocessor& operator=(const GlesPreprocessor&) = delete;
  // Packed RGBA8 -> planar float32 CHW; all calls on constructing thread.
  std::vector<float> Run(const std::vector<uint8_t>& rgba, int width, int height,
                         const ImageTransform& transform);
  std::vector<float> RunNv12(const std::vector<uint8_t>& nv12, int width, int height,
                            const ImageTransform& transform);
  // Packed RGBA8, for the original archive FrameProvider. Color conversion,
  // region sampling and byte packing execute on Mali, including odd-size ROIs.
  std::vector<uint8_t> RunNv12Rgba(const std::vector<uint8_t>& nv12,int width,int height,
                                  const ImageTransform& transform);
  // Full-range BT.601 NV12 for JPEG. Overrides model normalization/channel order.
  std::vector<uint8_t> RunJpegNv12(const std::vector<uint8_t>& nv12,int width,int height,
                                  const ImageTransform& transform);
  // Packed BGR8 -> full-range BT.601 NV12; source may have odd dimensions.
  // Pixel conversion, chroma averaging, and requested edge padding run on GPU.
  std::vector<uint8_t> RunBgrJpegNv12(const std::vector<uint8_t>& bgr,int width,int height,
                                     const ImageTransform& transform);
  // Packed RGBA8 -> full-range BT.601 NV12. Alpha is ignored on GPU.
  // Archive crops keep RGBA ownership; no CPU RGBA/BGR intermediate is needed.
  std::vector<uint8_t> RunRgbaJpegNv12(const std::vector<uint8_t>& rgba,int width,int height,
                                      const ImageTransform& transform);
 private:
  std::vector<float> RunImpl(const std::vector<uint8_t>& pixels,int width,int height,
                             const ImageTransform& transform,bool nv12,std::vector<uint8_t>* jpeg=nullptr,
                             bool bgr_input=false,std::vector<uint8_t>* rgba_output=nullptr);
  struct State;
  std::unique_ptr<State> state_;
};
}
