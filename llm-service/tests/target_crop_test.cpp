#include "target_crop.hpp"
#include "focus_task.hpp"
#include <cassert>
#include <limits>
int main(){
 const nlohmann::json vocab={{"words",{"是","A","B","C"}}};
 auto scores=ainvr::llm::FocusScores({99,10,0,-5},vocab);
 assert(scores["person"].get<double>()>.99);assert(scores["non_person"].get<double>()<.01);
 auto non=ainvr::llm::FocusScores({99,0,10,-5},vocab);assert(non["non_person"].get<double>()>.99);
 auto unknown=ainvr::llm::FocusScores({99,0,-5,10},vocab);assert(unknown["uncertain"].get<double>()>.99);
 bool rejected=false;try{ainvr::llm::FocusScores({0,1},vocab);}catch(...){rejected=true;}assert(rejected);
 const std::array<float,4> b{.4f,0,.5f,.2f};
 const auto tight=ainvr::TargetCrop(b,1920,1080,true,1.15f);
 const auto wide=ainvr::TargetCrop(b,1920,1080,true,1.6f);
 const auto legacy=ainvr::TargetCrop(b,1920,1080,false);
 assert(std::abs(tight[2]/tight[3]-192.f/216)<1e-5);
 assert(tight[1]<0);
 const auto canvas=ainvr::TargetCanvas(b,1920,1080,1.15f);
 assert(std::abs(canvas[0]+canvas[2]-1)<1e-5);assert(std::abs(canvas[1]+canvas[3]-1)<1e-5);
 const auto visible=ainvr::VisibleCanvas(b,1920,1080,1.15f);
 assert(visible[0]>0&&visible[2]<1&&visible[1]>0);
 auto region=ainvr::RegionCanvas({{.1f,.1f},{.9f,.9f}},b,1920,1080,1.15f);
 assert(region[0][0]<0&&region[1][0]>1); // don't close a cropped polygon at a fake boundary
 assert(ainvr::RegionCanvas({},b,1920,1080,1.15f).empty());
 assert(canvas[0]>0&&canvas[1]>0&&canvas[2]<1&&canvas[3]<1);
 assert(std::abs(tight[0]+tight[2]/2-(wide[0]+wide[2]/2))<1e-4);
 assert(std::abs(tight[1]+tight[3]/2-(wide[1]+wide[3]/2))<1e-4);
 assert(std::abs(legacy[2]/legacy[3]-2)<1e-5);
 assert(tight[2]<legacy[2]);
 for(auto bad: {std::array<float,4>{0,0,0,.5},std::array<float,4>{0,-.1f,.2,.3},std::array<float,4>{0,0,1.1f,1}}){bool failed=false;try{ainvr::TargetCrop(bad,1280,720,true);}catch(...){failed=true;}assert(failed);}
 bool failed=false;try{ainvr::TargetCrop(b,1280,720,true,std::numeric_limits<float>::quiet_NaN());}catch(...){failed=true;}assert(failed);
}
