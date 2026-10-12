// Copyright AINVR. Explicit test oracle; never linked into production services.
#include "output/snapshot_jpeg.hpp"
#include <atomic>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
namespace ai_service::output {
namespace {std::atomic<uint64_t> count{0};}
SnapshotJpegStats GetSnapshotJpegStats(){return {0,count.load(),0,0};}
bool EncodeSnapshotJpeg(const cv::Mat& input,std::vector<uint8_t>& out,int quality){
 if(input.empty()||input.type()!=CV_8UC3||quality<1||quality>100)
  throw std::invalid_argument("Invalid JPEG oracle input");
 bool result=cv::imencode(".jpg",input,out,{cv::IMWRITE_JPEG_QUALITY,quality});
 if(result)++count;return result;
}
bool EncodeSnapshotRgbaJpeg(const cv::Mat& input,std::vector<uint8_t>& out,int quality){
 if(input.empty()||input.type()!=CV_8UC4||quality<1||quality>100)
  throw std::invalid_argument("Invalid RGBA JPEG oracle input");
 cv::Mat bgr;cv::cvtColor(input,bgr,cv::COLOR_RGBA2BGR);
 return EncodeSnapshotJpeg(bgr,out,quality);
}
}
