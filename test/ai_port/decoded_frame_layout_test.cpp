#include "platform/decoded_frame_layout.hpp"
#include <iostream>
#include <limits>
using namespace ainvr;
int checks=0;
void Check(bool good){++checks;if(!good)throw std::runtime_error("decoded_frame_layout_contract_failed");}
template<class F>void Reject(F action,const char* code="Unsupported decoded frame layout/resolution change"){
  try{action();}catch(const std::exception& error){Check(error.what()==std::string(code));return;}
  throw std::runtime_error("decoded_frame_layout_not_rejected");
}
int main(){try{
  // Exact root-collected JPU metadata: visible 104, allocated 112. Padding is
  // kept exclusively in the copy strides, never in returned frame dimensions.
  const DecodedNv12Layout d{112,320,112,112,53760,{35840,17920},true,true,true,104,320,1};
  for(auto codec:{Codec::Jpeg,Codec::Mjpeg}){
    auto out=ValidateDecodedNv12Layout(codec,d,104,320);
    Check(out.width==104&&out.height==320&&out.luma_stride==112&&out.chroma_stride==112);
    auto b=d;b.buffer_width=b.luma_stride=b.chroma_stride=b.display_width=80;b.total_bytes=38400;b.plane_bytes={25600,12800};
    Check(ValidateDecodedNv12Layout(codec,b,80,320).width==80);
    auto padding=d;padding.buffer_height=336;padding.total_bytes=112*336*3/2;padding.plane_bytes={112*336,112*168};
    Check(ValidateDecodedNv12Layout(codec,padding,104,320).height==320);
    // Default callers remain strict. An explicit JPEG-only consumer receives
    // a minimally even NV12 surface plus the original odd visible extent.
    auto odd=d;odd.display_width=103;odd.display_height=319;
    const auto padded=ValidateDecodedNv12Layout(codec,odd,104,320,JpegOutputLayout::EvenPaddedSurface);
    Check(padded.width==104&&padded.height==320&&padded.visible_width==103&&padded.visible_height==319);
    Reject([&]{ValidateDecodedNv12Layout(codec,odd,104,320);});
    Reject([&]{ValidateDecodedNv12Layout(codec,odd,103,320,JpegOutputLayout::EvenPaddedSurface);});
    Reject([&]{ValidateDecodedNv12Layout(codec,odd,104,319,JpegOutputLayout::EvenPaddedSurface);});
    for(int issue=0;issue<20;++issue){
      auto bad=d;
      switch(issue){
      case 0:bad.display_width=0;break;case 1:bad.display_height=0;break;
      case 2:bad.display_width=103;break;case 3:bad.display_height=319;break;
      case 4:bad.display_width=114;break;case 5:bad.display_height=322;break;
      case 6:bad.luma_present=false;break;case 7:bad.chroma_present=false;break;
      case 8:bad.nv12=false;break;case 9:bad.luma_stride=0;break;
      case 10:bad.chroma_stride=0;break;case 11:bad.luma_stride=104;break;
      case 12:bad.chroma_stride=104;break;case 13:--bad.plane_bytes[0];break;
      case 14:--bad.plane_bytes[1];break;case 15:--bad.total_bytes;break;
      case 16:bad.buffer_width=111;break;case 17:bad.buffer_height=321;break;
      case 18:bad.plane_bytes[0]=UINT64_MAX;break;
      case 19:bad.luma_stride=bad.chroma_stride=std::numeric_limits<int>::max();break;
      }
      Reject([&]{ValidateDecodedNv12Layout(codec,bad,104,320);});
    }
    Reject([&]{ValidateDecodedNv12Layout(codec,d,102,320);});
    Reject([&]{ValidateDecodedNv12Layout(codec,d,104,318);});
    for(const int result:{0,2,-1}){auto bad=d;bad.jpeg_decode_result=result;
      Reject([&]{ValidateDecodedNv12Layout(codec,bad,104,320);},"JPEG decoder reported damaged or unsupported image");}
  }
  // SDK returned a zero layout/decode_result=0 for ERP74: no fabricated crop.
  Reject([]{ValidateDecodedNv12Layout(Codec::Jpeg,{},74,80);},"JPEG decoder reported damaged or unsupported image");
  // Video does not adopt JPEG display fields/status or padded-size admission.
  for(auto codec:{Codec::H264,Codec::H265}){
    Reject([&]{ValidateDecodedNv12Layout(codec,d,104,320);});
    auto video=d;video.luma_stride=video.chroma_stride=0;video.jpeg_decode_result=0;
    video.display_width=video.display_height=0;video.nv12=false;video.total_bytes=0;video.plane_bytes={};
    const auto out=ValidateDecodedNv12Layout(codec,video,112,320);
    Check(out.width==112&&out.height==320&&out.luma_stride==112&&out.chroma_stride==112);
    auto odd=video;odd.buffer_width=111;
    Reject([&]{ValidateDecodedNv12Layout(codec,odd,112,320,JpegOutputLayout::EvenPaddedSurface);});
  }
  std::cout<<checks<<" decoded NV12 layout checks passed; no hardware/CPU image processing\n";
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
