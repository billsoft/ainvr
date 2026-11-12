// Copyright AINVR. Plate geometry and CTC only; no CPU image processing.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>
namespace ainvr::plate {
using Point=std::array<float,2>;
using Quad=std::array<Point,4>; // TL, TR, BR, BL
inline std::array<float,9> Homography(const Quad& q,int width,int height){
  if(width<1||height<1||width>16384||height>16384)throw std::invalid_argument("Invalid plate source size");
  double cross_sign=0;
  for(int i=0;i<4;++i){
    const auto& a=q[i];const auto& b=q[(i+1)%4];const auto& c=q[(i+2)%4];
    if(!std::isfinite(a[0])||!std::isfinite(a[1])||a[0]<0||a[1]<0||a[0]>width||a[1]>height)
      throw std::invalid_argument("Plate corner outside source");
    double cross=(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);
    if(std::abs(cross)<1|| (i&&cross*cross_sign<=0))throw std::invalid_argument("Degenerate or crossed plate corners");
    cross_sign=cross;
  }
  double a[8][9]{};
  for(int i=0;i<4;++i){
    const double u=(i==1||i==2)?1:0,v=i>=2?1:0,x=q[i][0]/double(width),y=q[i][1]/double(height);
    a[2*i][0]=u;a[2*i][1]=v;a[2*i][2]=1;a[2*i][6]=-x*u;a[2*i][7]=-x*v;a[2*i][8]=x;
    a[2*i+1][3]=u;a[2*i+1][4]=v;a[2*i+1][5]=1;a[2*i+1][6]=-y*u;a[2*i+1][7]=-y*v;a[2*i+1][8]=y;
  }
  for(int j=0;j<8;++j){
    int best=j;for(int i=j+1;i<8;++i)if(std::abs(a[i][j])>std::abs(a[best][j]))best=i;
    if(std::abs(a[best][j])<1e-12)throw std::invalid_argument("Singular plate transform");
    for(int k=0;k<9;++k)std::swap(a[j][k],a[best][k]);
    const double scale=a[j][j];for(int k=j;k<9;++k)a[j][k]/=scale;
    for(int i=0;i<8;++i)if(i!=j){double factor=a[i][j];for(int k=j;k<9;++k)a[i][k]-=factor*a[j][k];}
  }
  std::array<float,9> result{};for(int i=0;i<8;++i)result[i]=a[i][8];result[8]=1;
  return result;
}
struct Detection {std::array<float,4> box;Quad corners;float score;bool double_row;};
inline std::vector<Detection> Decode(const std::vector<float>& rows,int width,int height,float threshold=.25f){
  if(rows.size()!=300*14||width<=0||height<=0||width>16384||height>16384||!std::isfinite(threshold)||threshold<0||threshold>1)
    throw std::invalid_argument("Plate detection contract mismatch");
  const double scale=std::min(640./width,640./height);
  const int nw=std::nearbyint(width*scale),nh=std::nearbyint(height*scale);
  if(nw<1||nh<1)throw std::invalid_argument("Plate source aspect ratio unsupported");
  const int left=(640-nw)/2,top=(640-nh)/2;
  auto x=[&](float v){return float((v-left)*width/nw);};auto y=[&](float v){return float((v-top)*height/nh);};
  std::vector<Detection> out;
  for(size_t i=0;i<rows.size();i+=14){const float* r=rows.data()+i;
    if(!std::all_of(r,r+14,[](float v){return std::isfinite(v);})||r[4]<threshold||r[4]>1||(r[5]!=0&&r[5]!=1))continue;
    Detection d{{x(r[0]),y(r[1]),x(r[2]),y(r[3])},{},r[4],r[5]==1};
    if(d.box[2]<=d.box[0]||d.box[3]<=d.box[1])continue;
    for(int j=0;j<4;++j)d.corners[j]={x(r[6+j*2]),y(r[7+j*2])};
    try{Homography(d.corners,width,height);}catch(const std::invalid_argument&){continue;}
    out.push_back(d);
  }
  std::stable_sort(out.begin(),out.end(),[](const auto& a,const auto& b){return a.score>b.score;});
  return out;
}
inline std::vector<std::string> Utf8Symbols(const std::string& text){
  std::vector<std::string> out;
  for(size_t i=0;i<text.size();){unsigned char c=text[i];size_t n=c<128?1:(c>=0xc2&&c<=0xdf)?2:(c>=0xe0&&c<=0xef)?3:(c>=0xf0&&c<=0xf4)?4:0;
    if(!n||i+n>text.size())throw std::invalid_argument("Invalid plate character table");
    for(size_t j=1;j<n;++j)if((static_cast<unsigned char>(text[i+j])&0xc0)!=0x80)throw std::invalid_argument("Invalid UTF8 continuation");
    out.push_back(text.substr(i,n));i+=n;
  }return out;
}
struct Text {std::string value;std::vector<float> character_scores;};
inline Text Ctc(const std::vector<float>& logits,const std::vector<std::string>& alphabet,size_t steps=21){
  if(alphabet.size()!=78||steps!=21||logits.size()!=steps*alphabet.size()||
     !std::all_of(logits.begin(),logits.end(),[](float x){return std::isfinite(x);}))
    throw std::invalid_argument("Plate recognition contract mismatch");
  Text out;size_t previous=0;
  for(size_t t=0;t<steps;++t){auto first=logits.begin()+t*alphabet.size();
    const size_t best=std::max_element(first,first+alphabet.size())-first;
    if(best&&best!=previous){double sum=0;for(size_t k=0;k<alphabet.size();++k)sum+=std::exp(double(first[k])-first[best]);
      out.value+=alphabet[best];out.character_scores.push_back(1./sum);}
    previous=best;
  }return out;
}
} // namespace ainvr::plate
