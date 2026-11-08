#include "../../ai-service/src/stream/reference_decode.hpp"
#include <cassert>
#include <vector>
using namespace ai_service::stream;
int main(){
 assert(!ReferenceDecodeEnabled(nullptr));assert(!ReferenceDecodeEnabled("0"));assert(ReferenceDecodeEnabled("1"));
 for(auto bad:{"","true","2"," 1"}){bool rejected=false;try{ReferenceDecodeEnabled(bad);}catch(const std::invalid_argument&){rejected=true;}assert(rejected);}

 auto picture=[](uint8_t h){return std::vector<uint8_t>{0,0,0,1,h,0x88,0x80};};
 assert(DiscardableH264Picture(picture(0x01)));
 for(auto h:{0x21,0x41,0x65,0x67,0x68,0x06,0x81,0x14})assert(!DiscardableH264Picture(picture(h)));
 std::vector<uint8_t> multi{0,0,1,9,0x10,0,0,1,1,0x88,0x80,0,0,1,1,0x88,0x80};
 assert(DiscardableH264Picture(multi));multi[14]=0x41;assert(!DiscardableH264Picture(multi));
 for(auto b:{std::vector<uint8_t>{},std::vector<uint8_t>{0,0,1},std::vector<uint8_t>{0,0,1,1},std::vector<uint8_t>{0,0,0,3,1,0x88}})assert(!DiscardableH264Picture(b));
 std::vector<uint8_t> timing{0,0,1,6,1,1,0x42,0x80,0,0,1,1,0x88,0x80};
 assert(DiscardableH264Picture(timing));
 timing[4]=0;assert(!DiscardableH264Picture(timing)); // buffering-period state
 timing[4]=6;assert(!DiscardableH264Picture(timing)); // recovery-point state
 timing[4]=1;timing[5]=30;assert(!DiscardableH264Picture(timing)); // truncated SEI
 // Sparse references must not reduce decode below the planned sampling rate.
 ReferenceDecodeCadence cadence;int kept=0;
 for(int i=0;i<300;i++)if(!cadence.Drop(int64_t(i)*1000000000/30,4.2,i%30!=0))++kept;
 assert(kept>=40&&kept<60);
 // Reference frames are never discarded; all-reference streams stay complete.
 for(int i=0;i<300;i++)assert(!cadence.Drop(int64_t(i)*1000000000/30,4.2,false));
 assert(!cadence.Drop(0,4.2,true));assert(!cadence.Drop(1,0,true));assert(!cadence.Drop(2,30,true));
}
