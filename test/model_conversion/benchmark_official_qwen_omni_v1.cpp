// Isolated official OELLm reference timing; no AINVR service installation.
#include <chrono>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <unistd.h>
#include <nlohmann/json.hpp>
#include "xlm.h"
using Clock=std::chrono::steady_clock;
using json=nlohmann::json;
struct Context {std::mutex mutex;Clock::time_point started;double first_seconds=-1;bool ended=false,error=false;std::string text;xlm_model_performance_t performance{};};
void callback(xlm_result_t* value,xlm_state_t state,void* userdata){
 if(!userdata)return;
 auto& c=*static_cast<Context*>(userdata);std::lock_guard<std::mutex> lock(c.mutex);
 if(state==XLM_STATE_ERROR)c.error=true;
 if(value){
  c.performance=value->performance;
  if(value->text && (state==XLM_STATE_START || state==XLM_STATE_RUNNING)){
   if(c.first_seconds<0)c.first_seconds=std::chrono::duration<double>(Clock::now()-c.started).count();
   c.text+=value->text;
  }
 }
 if(state==XLM_STATE_END)c.ended=true;
}
int main(int argc,char** argv){
 if(argc<5 || getuid()!=1000)return 2;
 std::string base=argv[1],output=argv[2];if(std::ifstream(output).good())return 3;
 auto param=xlm_create_default_param();
 std::string visual=base+"/model/Qwen2.5_Omni_3B_Visual.hbm",audio=base+"/model/Qwen2.5_Omni_3B_Audio.hbm",text=base+"/model/Qwen2.5_Omni_3B_Text.hbm",embedding=base+"/model/embed_tokens.bin",config=base+"/runtime/config/Qwen2.5_Omni_3B_config";
 param.omni_visual_model_path=visual.c_str();param.omni_audio_model_path=audio.c_str();param.omni_text_model_path=text.c_str();param.embed_tokens=embedding.c_str();param.token_config_path=config.c_str();param.model_type=XLM_MODEL_TYPE_OMNI;param.omni_online_mode=false;param.context_size=2048;
 param.sampling.temp=0;param.sampling.top_k=0;param.sampling.top_p=1;param.sampling.min_p=0;
 json report={{"scope","Official Qwen2.5-Omni-3B S100 HBM API image benchmark;not fire accuracy or LocateAnything parity"},{"uid",getuid()},{"runs",json::array()},{"release_approved",false}};
 auto persist=[&](){std::ofstream file(output);file<<report.dump(2)<<std::endl;};
 xlm_handle_t handle=nullptr;auto started=Clock::now();int code=xlm_init(&param,callback,&handle);
 report["initialization_seconds"]=std::chrono::duration<double>(Clock::now()-started).count();report["init_return"]=code;persist();if(code!=0)return 4;
 bool passed=true;
 for(int index=3;index<argc;index++){
  Context context;context.started=Clock::now();xlm_lm_request_t request{};request.request_id=index-3;request.type=XLM_INPUT_PROMPT;request.new_chat=true;request.prompt_json=argv[index];request.infer_backend=XLM_INFER_BACKEND_BPU_ANY;xlm_input_t input{1,&request};
  code=xlm_omni(handle,&input,&context);double seconds=std::chrono::duration<double>(Clock::now()-context.started).count();
  std::lock_guard<std::mutex> lock(context.mutex);auto p=context.performance;
  report["runs"].push_back({{"index",index-3},{"prompt_path",argv[index]},{"return",code},{"wall_seconds",seconds},{"first_text_callback_seconds",context.first_seconds},{"ended",context.ended},{"error",context.error},{"text",context.text},{"library_performance",{{"vit_cost_ms",p.vit_cost},{"prefill_tokens",p.prefill_token_num},{"prefill_tps",p.prefill_tps},{"decode_tokens",p.decode_token_num},{"decode_tps",p.decode_tps},{"ttft_raw",p.ttft},{"tpot_raw",p.tpot}}}});
  persist();if(code!=0 || context.error || !context.ended){passed=false;break;}
 }
 report["destroy_return"]=xlm_destroy(&handle);report["status"]=passed?"completed":"failed";persist();return passed?0:5;
}
