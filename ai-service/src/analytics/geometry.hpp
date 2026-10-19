// Copyright AINVR. Geometry uses normalized source-frame coordinates.
#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <vector>
namespace ai_service::analytics {
using Point = std::array<double, 2>;
inline double Cross(Point a, Point b, Point p) {
  return (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
}
inline bool OnSegment(Point a, Point b, Point p) {
  return std::abs(Cross(a,b,p)) < 1e-10 &&
    p[0]>=std::min(a[0],b[0])-1e-10 && p[0]<=std::max(a[0],b[0])+1e-10 &&
    p[1]>=std::min(a[1],b[1])-1e-10 && p[1]<=std::max(a[1],b[1])+1e-10;
}
inline bool Inside(const std::vector<Point>& polygon, Point p) {
  bool inside=false;
  if(polygon.size()<3) return false;
  for(size_t i=0,j=polygon.size()-1;i<polygon.size();j=i++) {
    auto a=polygon[j],b=polygon[i];
    if(OnSegment(a,b,p)) return true;
    if((a[1]>p[1])!=(b[1]>p[1]) &&
        p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
  }
  return inside;
}
// Only a strict crossing of the finite segment counts. Touching a line does not.
inline bool Crosses(Point a,Point b,Point previous,Point current) {
  double x=Cross(a,b,previous), y=Cross(a,b,current);
  double u=Cross(previous,current,a), v=Cross(previous,current,b);
  return x*y<0 && u*v<=0;
}
inline void ValidatePolygon(const std::vector<Point>& points) {
  if(points.size()<3 || points.size()>32) throw std::invalid_argument("Region requires 3..32 vertices");
  double area=0;
  for(size_t i=0;i<points.size();++i) {
    auto a=points[i], b=points[(i+1)%points.size()];
    for(double c:a) if(!std::isfinite(c)||c<0||c>1)
      throw std::invalid_argument("Region coordinates must be normalized");
    if(a==b) throw std::invalid_argument("Repeated region vertex");
    area+=a[0]*b[1]-b[0]*a[1];
    for(size_t j=i+1;j<points.size();++j) {
      if(j==i+1 || (i==0 && j==points.size()-1)) continue;
      auto c=points[j],d=points[(j+1)%points.size()];
      if(Crosses(a,b,c,d)||OnSegment(a,b,c)||OnSegment(a,b,d)||
          OnSegment(c,d,a)||OnSegment(c,d,b))
        throw std::invalid_argument("Region must not self-intersect");
    }
  }
  if(std::abs(area)<1e-10) throw std::invalid_argument("Region has zero area");
}
} // namespace ai_service::analytics
