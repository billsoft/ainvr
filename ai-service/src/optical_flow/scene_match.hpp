#pragma once
#include "contract.hpp"
#include <array>
#include <random>
#include <numeric>

namespace ainvr::flow {
struct ScenePair { double x,y,u,v; };
using Homography = std::array<double,9>;

inline bool FitScene(const std::vector<ScenePair>& pairs, const std::vector<size_t>& indices, Homography& h) {
  double system[8][9]{};
  for (auto index : indices) {
    const auto& p=pairs[index];
    const double rows[2][9]={{p.x,p.y,1,0,0,0,-p.u*p.x,-p.u*p.y,p.u},
                             {0,0,0,p.x,p.y,1,-p.v*p.x,-p.v*p.y,p.v}};
    for (const auto& row:rows) for(int i=0;i<8;++i) for(int j=0;j<9;++j) system[i][j]+=row[i]*row[j];
  }
  for(int i=0;i<8;++i){
    int pivot=i;
    for(int j=i+1;j<8;++j) if(std::abs(system[j][i])>std::abs(system[pivot][i]))pivot=j;
    if(std::abs(system[pivot][i])<1e-10)return false;
    for(int j=i;j<9;++j)std::swap(system[i][j],system[pivot][j]);
    const double scale=system[i][i];
    for(int j=i;j<9;++j)system[i][j]/=scale;
    for(int k=0;k<8;++k)if(k!=i){const double f=system[k][i];for(int j=i;j<9;++j)system[k][j]-=f*system[i][j];}
  }
  for(int i=0;i<8;++i){h[i]=system[i][8];if(!std::isfinite(h[i]))return false;}
  h[8]=1;return true;
}
inline double SceneError(const ScenePair& p,const Homography& h){
  const double d=h[6]*p.x+h[7]*p.y+1;
  if(d<=0.05)return 1e9;
  return std::hypot(((h[0]*p.x+h[1]*p.y+h[2])/d-p.u)*kWidth,
                    ((h[3]*p.x+h[4]*p.y+h[5])/d-p.v)*kHeight);
}
inline Json FitScenePairs(const std::vector<ScenePair>& pairs){
  Json result={{"schema","ainvr.scene-match.v2"},{"matched",false},{"backend","neuflow-bpu"},
    {"candidateCount",pairs.size()},{"inliers",0},{"coverage",0.0},{"reprojectionErrorPx",0.0}};
  if(pairs.size()<40)return result;
  std::mt19937 random(0x5343454e);
  std::vector<size_t> best;
  Homography h{};
  for(int trial=0;trial<300;++trial){
    std::vector<size_t> sample;
    while(sample.size()<4){auto n=random()%pairs.size();if(std::find(sample.begin(),sample.end(),n)==sample.end())sample.push_back(n);}
    if(!FitScene(pairs,sample,h))continue;
    std::vector<size_t> inliers;
    for(size_t i=0;i<pairs.size();++i)if(SceneError(pairs[i],h)<2.5)inliers.push_back(i);
    if(inliers.size()>best.size())best=std::move(inliers);
  }
  if(best.size()<40||best.size()<pairs.size()*0.65||!FitScene(pairs,best,h))return result;
  std::array<bool,16> cells{};
  double squared=0;
  std::vector<size_t> final;
  double xmin=1,ymin=1,xmax=0,ymax=0;
  for(size_t i=0;i<pairs.size();++i){
    const auto& p=pairs[i];const double error=SceneError(p,h);
    if(error>=2.5)continue;
    final.push_back(i);squared+=error*error;
    cells[std::clamp(int(p.y*4),0,3)*4+std::clamp(int(p.x*4),0,3)]=true;
    xmin=std::min(xmin,p.x);xmax=std::max(xmax,p.x);ymin=std::min(ymin,p.y);ymax=std::max(ymax,p.y);
  }
  const double coverage=std::count(cells.begin(),cells.end(),true)/16.0;
  result["inliers"]=final.size();result["coverage"]=coverage;
  result["reprojectionErrorPx"]=final.empty()?0:std::sqrt(squared/final.size());
  if(final.size()<40||final.size()<pairs.size()*0.65||coverage<0.5||xmax-xmin<0.45||ymax-ymin<0.45)return result;
  // Reject horizons, reflections and collapsed/extreme projections on the full reference plane.
  const double determinant=h[0]*(h[4]-h[5]*h[7])-h[1]*(h[3]-h[5]*h[6])+h[2]*(h[3]*h[7]-h[4]*h[6]);
  if(determinant<=0)return result;
  for(double x:{0.0,1.0})for(double y:{0.0,1.0}){
    const double d=h[6]*x+h[7]*y+1,area=determinant/(d*d*d);
    if(d<0.2||area<0.1||area>10)return result;
  }
  // A global fit cannot authorize an unsupported interior or another parallax
  // plane. Expose conservative local support for the actual saved polygon.
  constexpr int columns=8,rows=6;
  struct Tile {size_t candidates=0,inliers=0;double left=1,top=1,right=0,bottom=0;};
  std::array<Tile,columns*rows> tiles{};
  for(const auto& p:pairs){
    auto& t=tiles[std::clamp(int(p.y*rows),0,rows-1)*columns+std::clamp(int(p.x*columns),0,columns-1)];
    ++t.candidates;
    if(SceneError(p,h)>=2.5)continue;
    ++t.inliers;t.left=std::min(t.left,p.x);t.right=std::max(t.right,p.x);
    t.top=std::min(t.top,p.y);t.bottom=std::max(t.bottom,p.y);
  }
  Json support=Json::array();
  for(const auto& t:tiles)support.push_back(t.inliers>=3 && t.inliers>=0.8*t.candidates &&
    t.right-t.left>=0.025 && t.bottom-t.top>=0.025);
  result["supportGrid"]={{"columns",columns},{"rows",rows},{"cells",support}};
  result["matched"]=true;result["homography"]=h;
  result["supportBounds"]=Json::array({xmin,ymin,xmax,ymax});
  return result;
}

// A bounded search of the target checks for a spatially distinct patch with
// the same structure and compatible colour. Index three quantized GLES values;
// visit every bin intersecting the tolerances, including boundary neighbours.
class SceneDescriptorIndex {
 public:
  explicit SceneDescriptorIndex(const std::vector<uint32_t>& words)
      :words_(words),offsets_(32*32*16+1,0),samples_(kPixels){
    if(words.size()!=4*kPixels)throw Error(503,"scene_descriptor_shape");
    for(int j=0;j<kPixels;++j)++offsets_[Bucket(j)+1];
    std::partial_sum(offsets_.begin(),offsets_.end(),offsets_.begin());
    auto cursor=offsets_;
    for(int j=0;j<kPixels;++j){
      samples_[cursor[Bucket(j)]++]={words[j],words[kPixels+j],words[2*kPixels+j],words[3*kPixels+j],j};
    }
  }
  int Distance(const std::vector<uint32_t>& ref,int i,int j)const{
    return Bits(ref[i],ref[kPixels+i],words_[j],words_[kPixels+j]);
  }
  bool HasAlternative(const std::vector<uint32_t>& ref,int i,int best,int distance)const{
    const uint32_t quadrants=words_[2*kPixels+best],colour=words_[3*kPixels+best];
    const int contrast1=Byte(quadrants,0)-Byte(quadrants,3)+255;
    const int contrast2=Byte(quadrants,1)-Byte(quadrants,2)+255;
    const int mean=Byte(colour,1);
    const int lo=std::max(0,mean-24)/16,hi=std::min(255,mean+24)/16;
    // Adjacent luminance bins are contiguous. A crowded search always failed
    // closed under the posting cap, so count first and avoid walking it.
    std::array<std::pair<int,int>,9> ranges{};
    int count=0,visits=0;
    for(int a=std::max(0,contrast1-12)/16;a<=std::min(510,contrast1+12)/16;++a)
      for(int b=std::max(0,contrast2-12)/16;b<=std::min(510,contrast2+12)/16;++b){
        int base=(a*32+b)*16;
        int first=offsets_[base+lo],end=offsets_[base+hi+1];
        visits+=end-first;
        if(visits>8192)return true;
        ranges[count++]={first,end};
      }
    const auto r0=ref[i],r1=ref[kPixels+i],t0=words_[best],t1=words_[kPixels+best];
    for(int n=0;n<count;++n)for(int idx=ranges[n].first;idx<ranges[n].second;++idx){
      const auto& s=samples_[idx];
      const int delta=Byte(s.colour,1)-mean;
      if(std::abs(delta)>24||std::abs(Byte(s.colour,0)-Byte(colour,0)-delta)>10||
         std::abs(Byte(s.colour,2)-Byte(colour,2)-delta)>10)continue;
      if(std::abs(Byte(s.quads,0)-Byte(quadrants,0)-delta)>6||
         std::abs(Byte(s.quads,1)-Byte(quadrants,1)-delta)>6||
         std::abs(Byte(s.quads,2)-Byte(quadrants,2)-delta)>6||
         std::abs(Byte(s.quads,3)-Byte(quadrants,3)-delta)>6)continue;
      const int dx=s.pos%kWidth-best%kWidth,dy=s.pos/kWidth-best/kWidth;
      if(dx*dx+dy*dy>9 && (Bits(r0,r1,s.w0,s.w1)<=distance+2||Bits(t0,t1,s.w0,s.w1)<=8))return true;
    }
    return false;
  }
 private:
  struct Sample{uint32_t w0,w1,quads,colour;int pos;};
  static int Byte(uint32_t word,int n){return (word>>(8*n))&255;}
  static int Bits(uint32_t a,uint32_t b,uint32_t c,uint32_t d){
    return __builtin_popcount(a^c)+__builtin_popcount(b^d);
  }
  int Bucket(int j)const{
    const uint32_t q=words_[2*kPixels+j];
    return (((Byte(q,0)-Byte(q,3)+255)/16)*32+(Byte(q,1)-Byte(q,2)+255)/16)*16+
           Byte(words_[3*kPixels+j],1)/16;
  }
  const std::vector<uint32_t>& words_;
  std::vector<int> offsets_;
  std::vector<Sample> samples_;
};

inline std::string SceneEvidence(const Homography& h,const std::vector<float>& f,
    const std::vector<float>& b,const std::vector<uint32_t>& ref,const std::vector<uint32_t>& target){
  if(ref.size()!=4*kPixels||f.size()!=2*kPixels||b.size()!=2*kPixels)throw Error(503,"scene_descriptor_shape");
  SceneDescriptorIndex target_index(target),reference_index(ref);
  std::string sites(128*96,'u');
  for(int y=6;y<kHeight-5;y+=4)for(int x=6;x<kWidth-5;x+=4){
    char& site=sites[(y/4)*128+x/4];
    const int i=y*kWidth+x;
    const double u=x+f[i],v=y+f[kPixels+i];
    if(!std::isfinite(u)||!std::isfinite(v)||u<6||v<6||u>=kWidth-6||v>=kHeight-6)continue;
    const int j=std::lround(v)*kWidth+std::lround(u);
    if(!(std::hypot(u-x+b[j],v-y+b[kPixels+j])<=1.5))continue;
    const ScenePair pair{double(x)/kWidth,double(y)/kHeight,u/kWidth,v/kHeight};
    if(SceneError(pair,h)>2.5){site='d';continue;}
    const double w=h[6]*pair.x+h[7]*pair.y+1;
    const double px=(h[0]*pair.x+h[1]*pair.y+h[2])*kWidth/w;
    const double py=(h[3]*pair.x+h[4]*pair.y+h[5])*kHeight/w;
    if(!(px>=7&&px<kWidth-7&&py>=7&&py<kHeight-7))continue;
    const int cx=std::lround(px),cy=std::lround(py);
    const int center=cy*kWidth+cx;
    int best=target_index.Distance(ref,i,center),location=center;
    for(int dy=-1;dy<=1;++dy)for(int dx=-1;dx<=1;++dx){
      const int j=(cy+dy)*kWidth+cx+dx,dist=target_index.Distance(ref,i,j);
      if(dist<best){best=dist;location=j;}
    }
    if(best>12)continue;
    if(target_index.HasAlternative(ref,i,location,best)||reference_index.HasAlternative(ref,i,i,0)){
      site='a';continue;
    }
    // Encode the actual target footprint; rounding plus a blanket 1px halo
    // would discard valid evidence on narrow shelf polygons.
    const int slot=(location/kWidth-cy+1)*3+(location%kWidth-cx+1);
    site=slot==4?'s':char('1'+slot);
  }
  return sites;
}

// Geometry/quality statistics only. Decode, resize, denoise and neural inference run on hardware.
inline Json MatchScene(const std::vector<float>& forward,const std::vector<float>& backward,
                       const std::vector<float>& first,const std::vector<float>& second){
  if(forward.size()!=2*kPixels||backward.size()!=2*kPixels||first.size()!=3*kPixels||second.size()!=3*kPixels)
    throw Error(503,"scene_tensor_contract");
  std::vector<ScenePair> pairs;
  for(int y=12;y<kHeight-12;y+=12)for(int x=12;x<kWidth-12;x+=12){
    const size_t i=y*kWidth+x;
    const double u=x+forward[i],v=y+forward[kPixels+i];
    if(!std::isfinite(u)||!std::isfinite(v)||u<4||v<4||u>=kWidth-4||v>=kHeight-4)continue;
    const int ux=std::lround(u),vy=std::lround(v);const size_t j=vy*kWidth+ux;
    if(!std::isfinite(backward[j])||!std::isfinite(backward[kPixels+j])||
       std::hypot(forward[i]+backward[j],forward[kPixels+i]+backward[kPixels+j])>1.5)continue;
    double contrast=0,residual=0;
    for(size_t c=0;c<3;++c){
      const auto offset=c*kPixels;
      contrast+=std::abs(first[offset+i-3]-first[offset+i+3])+std::abs(first[offset+i-3*kWidth]-first[offset+i+3*kWidth]);
      residual+=std::abs(first[offset+i]-second[offset+j]);
    }
    if(!std::isfinite(contrast)||!std::isfinite(residual)||contrast<45||residual>105)continue;
    pairs.push_back({double(x)/kWidth,double(y)/kHeight,u/kWidth,v/kHeight});
  }
  return FitScenePairs(pairs);
}
}
