// Copyright AINVR.
#pragma once
#include "gles_preprocess.hpp"
#include "vpu_decoder.hpp"
namespace ainvr {
class GdcProjector {
 public:
  // Conservative validated dimensions; views crossing the ERP seam/poles use
  // GLES, since a continuous GDC mesh cannot interpolate across the wrap.
  static bool Supports(int width,int height,const ImageTransform& transform);
  GdcProjector(int width,int height,const ImageTransform& transform);
  ~GdcProjector();
  GdcProjector(const GdcProjector&)=delete;
  GdcProjector& operator=(const GdcProjector&)=delete;
  Nv12Frame Run(const Nv12Frame& input);
  double ConfigurationMilliseconds() const;
 private:
  struct State;std::unique_ptr<State> state_;
};
}
