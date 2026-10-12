// Copyright AINVR. Compressed passthrough; no decoder, encoder, or image processing.
#include "compressed_tap.hpp"
#include <gst/app/gstappsrc.h>
#include <gst/gst.h>
#include <stdexcept>
namespace ainvr {
CompressedTap::CompressedTap(Codec codec,size_t maximum):max_bytes_(maximum){
 if((codec!=Codec::H264&&codec!=Codec::H265)||maximum<1024||maximum>256*1024*1024)
  throw std::invalid_argument("Invalid compressed publisher tap options");
 gst_init(nullptr,nullptr);
 pipeline_=gst_pipeline_new(nullptr);source_=gst_element_factory_make("appsrc",nullptr);
 sink_=gst_element_factory_make("appsink",nullptr);
 if(!pipeline_||!source_||!sink_){
  if(source_)gst_object_unref(source_);if(sink_)gst_object_unref(sink_);
  if(pipeline_)gst_object_unref(pipeline_);pipeline_=source_=sink_=nullptr;
  throw std::runtime_error("GStreamer compressed tap elements unavailable");
 }
 gst_bin_add_many(GST_BIN(pipeline_),source_,sink_,nullptr);
 try {
  auto* caps=gst_caps_new_simple(codec==Codec::H264?"video/x-h264":"video/x-h265",
    "stream-format",G_TYPE_STRING,"byte-stream","alignment",G_TYPE_STRING,"au",nullptr);
  gst_app_src_set_caps(GST_APP_SRC(source_),caps);gst_caps_unref(caps);
  g_object_set(source_,"is-live",TRUE,"format",GST_FORMAT_TIME,"block",FALSE,
    "max-bytes",guint64(maximum),"max-buffers",guint64(64),nullptr);
  g_object_set(sink_,"sync",FALSE,"async",FALSE,"max-buffers",guint(16),
    "drop",FALSE,"enable-last-sample",FALSE,nullptr);
  if(!gst_element_link(source_,sink_)||gst_element_set_state(pipeline_,GST_STATE_PLAYING)==GST_STATE_CHANGE_FAILURE)
   throw std::runtime_error("Cannot start compressed publisher tap");
 }catch(...){Stop();throw;}
}
CompressedTap::~CompressedTap(){Stop();}
std::optional<EncodedStamp> CompressedTap::Feed(const CompressedFrame& packet){
 std::lock_guard<std::mutex> lock(mutex_);
 return FeedLocked(packet,std::nullopt);
}
std::optional<EncodedStamp> CompressedTap::FeedAt(const CompressedFrame& packet,EncodedStamp stamp){
 std::lock_guard<std::mutex> lock(mutex_);
 return FeedLocked(packet,stamp);
}
TapQueueState CompressedTap::QueueState(size_t next)const{
 std::lock_guard<std::mutex> lock(mutex_);
 if(next>max_bytes_)throw std::invalid_argument("Compressed packet exceeds tap limit");
 TapQueueState state;state.max_bytes=max_bytes_;
 if(stopped_){state.full=true;return state;}
 g_object_get(source_,"current-level-bytes",&state.bytes,"current-level-buffers",&state.buffers,nullptr);
 state.full=state.bytes>max_bytes_-next||state.buffers>=state.max_buffers;
 return state;
}
std::optional<EncodedStamp> CompressedTap::FeedLocked(const CompressedFrame& packet,std::optional<EncodedStamp> stamp){
 if(stopped_)throw std::runtime_error("Compressed tap is stopped");
 if(packet.bytes.empty()||packet.bytes.size()>max_bytes_||packet.duration_ns<0)
  throw std::invalid_argument("Invalid compressed tap packet");
 if(external_clock_&&*external_clock_!=stamp.has_value())
  throw std::logic_error("Cannot mix tap clock ownership within one generation");
 guint64 bytes=0,frames=0;g_object_get(source_,"current-level-bytes",&bytes,"current-level-buffers",&frames,nullptr);
 if(bytes>max_bytes_-packet.bytes.size()||frames>=64)return std::nullopt;
 auto mapped=stamp?std::pair<int64_t,int64_t>{stamp->dts_ns,stamp->pts_ns}:clock_.Map(packet.dts_ns,packet.pts_ns);
 auto [dts,pts]=mapped;
 if(dts<0||pts<0)throw std::runtime_error("Negative mapped compressed timestamp");
 if(last_dts_&&dts<*last_dts_)throw std::invalid_argument("Compressed DTS moves backwards");
 auto* buffer=gst_buffer_new_allocate(nullptr,packet.bytes.size(),nullptr);
 if(!buffer)throw std::bad_alloc();
 gst_buffer_fill(buffer,0,packet.bytes.data(),packet.bytes.size());
 GST_BUFFER_DTS(buffer)=dts;GST_BUFFER_PTS(buffer)=pts;GST_BUFFER_DURATION(buffer)=packet.duration_ns;
 if(!packet.key_frame)GST_BUFFER_FLAG_SET(buffer,GST_BUFFER_FLAG_DELTA_UNIT);
 auto flow=gst_app_src_push_buffer(GST_APP_SRC(source_),buffer);
 if(flow!=GST_FLOW_OK)throw std::runtime_error("Compressed tap push failed: "+std::to_string(flow));
 external_clock_=stamp.has_value();last_dts_=dts;
 return EncodedStamp{pts,dts};
}
GstElement* CompressedTap::SinkReference()const{
 std::lock_guard<std::mutex> lock(mutex_);
 return stopped_?nullptr:GST_ELEMENT(gst_object_ref(sink_));
}
void CompressedTap::Stop(){
 GstElement* pipeline=nullptr;
 {std::lock_guard<std::mutex> lock(mutex_);if(stopped_)return;
  stopped_=true;pipeline=pipeline_;pipeline_=source_=sink_=nullptr;}
 if(pipeline){gst_element_set_state(pipeline,GST_STATE_NULL);gst_object_unref(pipeline);}
}
}
