// Opt-in bounded Qwen search smoke. Reuses production Engine and JPEG/VPU/GLES
// pipeline. No service stop/config changes, CPU inference or image fallback.
#include "engine.hpp"
#include "image_pipeline.hpp"
#include "reservation.hpp"
#include "submission_budget.hpp"
#include "vpu_decoder.hpp"
#include "../../shared/cpp/bpu_reserved_pool.hpp"
#include <chrono>
#include <csignal>
#include <filesystem>
#include <fcntl.h>
#include <fstream>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
namespace fs=std::filesystem;
using Json=nlohmann::json;
using Clock=std::chrono::steady_clock;
using namespace ainvr::llm;
namespace {
constexpr const char* kPackage="/home/sunrise/ainvr/ai-service/models/llm/qwen3vl-4b-review-v3";
volatile std::sig_atomic_t stopped=0;
void Stop(int){stopped=1;}
const char* Usage(){return "Manual only: --run-bpu-search --samples FILE.jsonl --report test/results/NEW.json [--task-timeout-ms 1000..30000] [--total-timeout-ms 1000..300000]\n"
 "JSONL 1..16 rows: {sample_id,jpeg_path,frame_id,query,kind:object|scene,question_scope:visible|temporal,expected_decision:match|mismatch|uncertain|null}.\n"
 "Fixed verified production Qwen package; uses the shared /run/ainvr reservation registry and 256MiB headroom. No automatic service stop.\n"
 "Before-submit deadlines do not free an in-flight task. Existing SDK waits remain bounded at10s; root runner must enforce an outer process timeout and restore any paused LLM.\n"
 "This is a smoke/label comparison, not calibration. --help performs no model/device/sample access.\n";}
void Require(bool ok,const char* code){if(!ok)throw std::runtime_error(code);}
struct Fd{int value=-1;explicit Fd(int fd=-1):value(fd){}~Fd(){if(value>=0)close(value);}Fd(const Fd&)=delete;Fd& operator=(const Fd&)=delete;};
std::vector<uint8_t> ReadBytes(const fs::path& path,size_t maximum){
 Fd file(open(path.c_str(),O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK));Require(file.value>=0,"smoke_input_open_failed");struct stat before{},after{};
 Require(fstat(file.value,&before)==0&&S_ISREG(before.st_mode)&&before.st_size>0&&uint64_t(before.st_size)<=maximum,"smoke_input_size_or_type_invalid");
 std::vector<uint8_t> bytes(size_t(before.st_size));size_t at=0;
 while(at<bytes.size()){const auto n=read(file.value,bytes.data()+at,bytes.size()-at);Require(n>0,"smoke_input_read_failed");at+=size_t(n);}
 Require(fstat(file.value,&after)==0&&before.st_dev==after.st_dev&&before.st_ino==after.st_ino&&before.st_size==after.st_size&&
  before.st_mtim.tv_sec==after.st_mtim.tv_sec&&before.st_mtim.tv_nsec==after.st_mtim.tv_nsec&&
  before.st_ctim.tv_sec==after.st_ctim.tv_sec&&before.st_ctim.tv_nsec==after.st_ctim.tv_nsec,"smoke_input_changed");return bytes;
}
void NewPath(const fs::path& path){
 const auto root=fs::canonical(AINVR_SEARCH_LLM_RESULTS_ROOT),parent=fs::canonical(path.parent_path());const auto relative=parent.lexically_relative(root);
 std::error_code error;const auto type=fs::symlink_status(path,error).type();
 Require(!relative.empty()&&!relative.is_absolute()&&*relative.begin()!=".."&&!path.filename().empty()&&type==fs::file_type::not_found,"smoke_report_requires_new_results_path");
}
void Append(int fd,const Json& row,size_t maximum=65536){
 const auto text=row.dump()+"\n";Require(text.size()<=maximum,"smoke_result_row_too_large");size_t at=0;
 while(at<text.size()){const auto n=write(fd,text.data()+at,text.size()-at);Require(n>0,"smoke_output_write_failed");at+=size_t(n);}
 Require(fsync(fd)==0,"smoke_output_sync_failed");
}
void WriteNew(const fs::path& path,const Json& row){Fd file(open(path.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600));Require(file.value>=0,"smoke_output_create_failed");Append(file.value,row,1048576);}
int Number(const std::string& text,int maximum){size_t end=0;const auto n=std::stoll(text,&end);Require(end==text.size()&&n>=1000&&n<=maximum,"smoke_invalid_timeout");return int(n);}
Json Parse(const std::string& text){
 std::vector<std::set<std::string>> keys;
 return Json::parse(text,[&](int depth,Json::parse_event_t event,Json& value){
  Require(depth<=8,"smoke_input_too_deep");if(event==Json::parse_event_t::object_start)keys.emplace_back();
  if(event==Json::parse_event_t::key)Require(!keys.empty()&&keys.back().insert(value.get<std::string>()).second,"smoke_duplicate_input_key");
  if(event==Json::parse_event_t::object_end)keys.pop_back();
  return true;
 });
}
struct Item{Json input;std::string image_sha,error;size_t tokens=0;};
SearchRequest Request(const Json& row,const std::vector<uint8_t>& jpeg){
 std::string encoded(4*((jpeg.size()+2)/3),'\0');
 Require(EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),jpeg.data(),int(jpeg.size()))==int(encoded.size()),"smoke_base64_failed");
 return ParseSearchRequest({{"request_id",row.at("sample_id")},{"query",row.at("query")},{"question_scope",row.at("question_scope")},
  {"evidence",{{"kind",row.at("kind")},{"frame_id",row.at("frame_id")},{"sha256",SearchHash(jpeg.data(),jpeg.size())}}},
  {"image",{{"jpeg_base64",encoded},{"fit","letterbox"}}}});
}
std::string ErrorCode(const std::exception& error){
 if(const auto* input=dynamic_cast<const InputError*>(&error))return input->code;
 if(dynamic_cast<const Json::exception*>(&error))return "smoke_invalid_sample";
 const std::string code=error.what();
 static const std::set<std::string> resource_errors{"ion_budget_exceeded","large_model_busy","uncoordinated_model_holder","admission_lock_timeout",
  "memory_pool_unknown","memory_module_unavailable","reservation_lock_unavailable"};
 return code.rfind("smoke_",0)==0||resource_errors.count(code)?code:"smoke_runtime_failed";
}
Json Diagnostic(const std::exception& error){
 const std::string text=error.what();
 static const std::map<std::string,std::string> exact{
  {"Invalid access unit size","jpeg_access_unit_exceeds_decoder_buffer"},
  {"Invalid maximum decode dimensions","jpeg_decode_dimensions_invalid"},
  {"Unsupported decoded frame layout/resolution change","jpeg_decoded_layout_unsupported"},
  {"Poll VPU/JPU output readiness failed","jpeg_readiness_poll_failed"},
  {"VPU/JPU readiness fd reported a hardware failure","jpeg_readiness_hardware_failure"},
  {"Unexpected VPU/JPU readiness event","jpeg_readiness_event_invalid"},
  {"Qwen review Mali context unavailable","gles_context_unavailable"},
  {"Mali GLES context unavailable","gles_context_unavailable"},
  {"Cannot activate Qwen review Mali preprocessing","gles_context_activation_failed"},
  {"Cannot activate Mali preprocessing context","gles_context_activation_failed"},
  {"Qwen review GPU output mapping failed","gles_output_mapping_failed"},
  {"Qwen review GPU output invalidated","gles_output_invalidated"},
  {"Qwen review NV12 dimensions/storage invalid","gles_nv12_layout_invalid"},
  {"invalid image dimensions/storage","gles_image_layout_invalid"},
  {"GPU output mapping failed","gles_output_mapping_failed"},
  {"GPU output invalidated","gles_output_invalidated"},
  {"output exceeds GPU storage buffer limit","gles_storage_limit"},
  {"image exceeds GPU texture limit","gles_texture_limit"},
  {"Qwen review image exceeds Mali texture limit","gles_texture_limit"}};
 if(const auto found=exact.find(text);found!=exact.end())return {{"code",found->second}};
 static const std::map<std::string,std::string> numeric{
  {"initialize VPU/JPU: ","jpeg_initialize_failed"},{"configure VPU/JPU: ","jpeg_configure_failed"},
  {"start VPU/JPU: ","jpeg_start_failed"},{"get VPU/JPU output readiness fd: ","jpeg_readiness_fd_failed"},
  {"dequeue compressed buffer: ","jpeg_dequeue_input_failed"},{"submit compressed buffer: ","jpeg_submit_failed"},
  {"query VPU/JPU output status: ","jpeg_output_status_failed"},{"receive decoded frame: ","jpeg_receive_failed"},
  {"Qwen review GLES error ","gles_api_error"},{"GLES error ","gles_api_error"},
  {"open media memory: ","media_memory_open_failed"},{"load HBM: ","bpu_load_failed"},
  {"create task: ","bpu_create_task_failed"},{"submit task: ","bpu_submit_task_failed"},
  {"release task: ","bpu_release_task_failed"},{"flush input: ","bpu_flush_failed"},{"invalidate output: ","bpu_invalidate_failed"}};
 for(const auto& item:numeric)if(text.rfind(item.first,0)==0){
  const auto number=text.substr(item.first.size());const auto begin=!number.empty()&&number[0]=='-'?size_t(1):size_t(0);
  if(number.size()>begin&&number.size()<=11&&std::all_of(number.begin()+begin,number.end(),[](unsigned char c){return c>='0'&&c<='9';})){
   try{const auto value=std::stoll(number);if(value>=INT32_MIN&&value<=INT32_MAX)return {{"code",item.second},{"return_code",value}};}catch(...){}
  }
 }
 return {{"code",ErrorCode(error)}};
}
void Current(Clock::time_point total,Clock::time_point task){
 Require(!stopped,"smoke_cancelled");Require(Clock::now()<total,"smoke_total_deadline");Require(Clock::now()<task,"smoke_task_deadline");
}
}
int main(int argc,char** argv){
 fs::path report,rows_path;bool paths_valid=false;Json resource_context=nullptr;std::string stage="arguments";
 try{
  if(argc==2&&std::string(argv[1])=="--help"){std::cout<<Usage();return 0;}
  if(argc<2||std::string(argv[1])!="--run-bpu-search"){std::cerr<<Usage();return 64;}
  std::map<std::string,std::string> args;for(int n=2;n<argc;n+=2)Require(n+1<argc&&args.emplace(argv[n],argv[n+1]).second,"smoke_invalid_arguments");
  Require(args.count("--samples")&&args.count("--report")&&args.size()<=4,"smoke_invalid_arguments");
  for(const auto& arg:args)Require(arg.first=="--samples"||arg.first=="--report"||arg.first=="--task-timeout-ms"||arg.first=="--total-timeout-ms","smoke_invalid_arguments");
  const int task_ms=args.count("--task-timeout-ms")?Number(args.at("--task-timeout-ms"),30000):20000;
  const int total_ms=args.count("--total-timeout-ms")?Number(args.at("--total-timeout-ms"),300000):120000;
  report=args.at("--report");rows_path=report.parent_path()/(report.stem().string()+"-rows.jsonl");NewPath(report);NewPath(rows_path);paths_valid=true;
  const auto start=Clock::now(),deadline=start+std::chrono::milliseconds(total_ms);
  const auto bytes=ReadBytes(args.at("--samples"),16*16384);std::istringstream lines(std::string(bytes.begin(),bytes.end()));std::string line;
  std::vector<Item> items;std::set<std::string> ids;
  while(std::getline(lines,line)){
   if(!line.empty()&&line.back()=='\r')line.pop_back();
   Require(!line.empty()&&line.size()<=16384&&items.size()<16,"smoke_sample_count_or_line_invalid");
   auto row=Parse(line);SearchShape(row,{"sample_id","jpeg_path","frame_id","query","kind","question_scope","expected_decision"});
   const auto id=SearchRequestId(row.at("sample_id"));Require(ids.insert(id).second,"smoke_duplicate_sample_id");
   const auto image=row.at("jpeg_path").get<std::string>();Require(image.size()<=4096&&fs::path(image).is_absolute()&&
    std::none_of(image.begin(),image.end(),[](unsigned char c){return c<32||c==127;}),"smoke_jpeg_path_invalid");
   Require(row.at("expected_decision").is_null()||(row.at("expected_decision").is_string()&&
    (row.at("expected_decision")=="match"||row.at("expected_decision")=="mismatch"||row.at("expected_decision")=="uncertain")),"smoke_expected_label_invalid");
   items.push_back({std::move(row),"","",0});
  }
  Require(!items.empty(),"smoke_no_samples");
  std::signal(SIGINT,Stop);std::signal(SIGTERM,Stop);
  // Residency declaration comes first and is destroyed last. Engine's verified
  // tokenizer/table constructor performs no BPU load; all Load/GLES/Infer and
  // normal destruction stay on this same explicit main owner thread.
  std::unique_ptr<Reservation> reservation;
  stage="load";auto engine=std::make_unique<Engine>(kPackage);
  std::unique_ptr<ainvr::QwenReviewImagePipeline> image;
  size_t valid_visible=0;
  for(auto& item:items){try{
    Current(deadline,deadline);const auto jpeg=ReadBytes(item.input.at("jpeg_path").get<std::string>(),8*1024*1024);
    const auto request=Request(item.input,jpeg);item.image_sha=request.evidence_sha256;item.tokens=engine->EncodeSearch(request).size();
    if(request.question_scope=="visible")++valid_visible;
   }catch(const std::exception& error){item.error=ErrorCode(error);}}
  if(!valid_visible){
   Json rejected=Json::array();for(const auto& item:items)rejected.push_back({{"sample_id",item.input.at("sample_id")},{"query",item.input.at("query")},
    {"input_tokens",item.tokens},{"jpeg_sha256",item.image_sha},{"error_code",item.error.empty()?"smoke_temporal_only":item.error},{"hardware_inference_executed",false}});
   WriteNew(report,{{"interface_passed",false},{"smoke_only",true},{"accuracy_validated",false},{"model_loaded",false},
    {"error_code","smoke_requires_valid_visible_sample"},{"samples",rejected}});return 1;
  }
  Current(deadline,deadline);const uint64_t headroom=256ULL*1024*1024,pool=ainvr::ReadBpuIonBudgetBytes();
  const auto need=engine->manifest().at("resources").at("ion_bytes_measured").get<uint64_t>();
  resource_context={{"pool_bytes",pool},{"need_bytes",need},{"headroom_bytes",headroom}};
  reservation=std::make_unique<Reservation>("/run/ainvr",need,headroom,pool);
  const auto load_start=Clock::now();engine->Load();Current(deadline,deadline);
  image=std::make_unique<ainvr::QwenReviewImagePipeline>(std::string(kPackage)+"/normalize.f32");
  {DmaBuffer probe(headroom);}reservation->Loaded();Current(deadline,deadline);
  const auto load_ms=std::chrono::duration<double,std::milli>(Clock::now()-load_start).count();
  const auto admission=reservation->Decision().ToJson();const auto package_sha=engine->package_sha256();
  Fd partial(open(rows_path.c_str(),O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600));Require(partial.value>=0,"smoke_rows_create_failed");
  Json results=Json::array();size_t interface_ok=0,labelled=0,label_matches=0,hardware_rows=0;
  size_t submits=0;double submit_seconds=0;SubmissionHistory submissions;
  task_time_observer=[&](double seconds){++submits;submit_seconds+=seconds;submissions.emplace_back(Clock::now(),seconds);};
  struct ResetObserver{~ResetObserver(){task_time_observer={};}} reset_observer;
  for(const auto& item:items){
   const auto began=Clock::now(),task_deadline=std::min(deadline,began+std::chrono::milliseconds(task_ms));
   const auto before_submits=submits;const auto before_seconds=submit_seconds;
   stage="preflight";Json result={{"sample_id",item.input.at("sample_id")},{"query",item.input.at("query")},{"kind",item.input.at("kind")},
    {"question_scope",item.input.at("question_scope")},{"frame_id",item.input.at("frame_id")},{"expected_decision",item.input.at("expected_decision")},
    {"jpeg_sha256",item.image_sha},{"input_tokens",item.tokens},{"interface_passed",false},{"label_match",nullptr},{"hardware_inference_executed",false}};
   try{
    Require(item.error.empty(),"smoke_preflight_rejected");Current(deadline,task_deadline);
    const auto jpeg=ReadBytes(item.input.at("jpeg_path").get<std::string>(),8*1024*1024);
    auto request=Request(item.input,jpeg);Require(request.evidence_sha256==item.image_sha,"smoke_jpeg_changed_after_preflight");
    const auto ids=engine->EncodeSearch(request);Current(deadline,task_deadline);
    std::vector<float> logits;
    if(request.question_scope=="visible"){
     stage="decode";
     ainvr::VpuDecoder decoder(ainvr::Codec::Jpeg,request.width,request.height);
     Require(decoder.Submit(request.jpeg,1,1000),"smoke_jpeg_submit_timeout");const auto frame=decoder.Receive(3000);Require(bool(frame),"smoke_jpeg_receive_timeout");Current(deadline,task_deadline);
     stage="preprocess";auto patches=image->RunNv12(frame->pixels,frame->width,frame->height,false,true,true);Current(deadline,task_deadline);
     result["preprocess_ms"]=std::chrono::duration<double,std::milli>(Clock::now()-began).count();
     result["patch_tensor_sha256"]=SearchHash(reinterpret_cast<const uint8_t*>(patches.data()),patches.size()*sizeof(float));
     result["patch_tensor"]={{"dtype","f32le"},{"shape",Json::array({1568,1536})}};
     stage="infer";logits=engine->Infer(ids,patches,[&]{
      while(true){Current(deadline,task_deadline);if(SubmissionAllowed(submissions,Clock::now(),90))break;
       std::this_thread::sleep_for(std::chrono::milliseconds(20));}
     });Current(deadline,task_deadline);
     result["hardware_inference_executed"]=true;++hardware_rows;
    }
    stage="response";const auto response=SearchResponse(request,logits,engine->manifest().at("decision_vocabulary"),package_sha);
    result["response"]=response;result["interface_passed"]=true;++interface_ok;
    if(!item.input.at("expected_decision").is_null()){
     ++labelled;const bool matched=response.at("decision")==item.input.at("expected_decision");result["label_match"]=matched;if(matched)++label_matches;
    }
   }catch(const std::exception& error){result["error_code"]=item.error.empty()?ErrorCode(error):item.error;result["diagnostic"]=Diagnostic(error);}
   result["stage"]=stage;
   result["elapsed_ms"]=std::chrono::duration<double,std::milli>(Clock::now()-began).count();result["submitted_bpu_tasks"]=submits-before_submits;
   result["bpu_wait_ms"]=(submit_seconds-before_seconds)*1000;
   Append(partial.value,result);results.push_back(std::move(result));
  }
  task_time_observer={};image.reset();engine.reset();reservation.reset();
  const bool passed=interface_ok==items.size();
  WriteNew(report,{{"interface_passed",passed},{"smoke_only",true},{"accuracy_validated",false},{"calibration_passed",false},
   {"model_package_sha256",package_sha},{"template_sha256",SearchTemplateHash()},{"preprocessing_version",kSearchPreprocessing},
   {"decision_policy","abc-visible-v1"},{"score_kind","three_way_softmax_uncalibrated"},{"admission",admission},
   {"load_ms",load_ms},{"task_timeout_ms",task_ms},{"total_timeout_ms",total_ms},{"submit_time_share",{{"window_s",10},{"cap_percent",90}}},
   {"samples",results},{"sample_count",items.size()},
   {"interface_successes",interface_ok},{"hardware_rows",hardware_rows},{"labelled_completed_rows",labelled},{"label_matches",label_matches},
   {"label_match_fraction",labelled?Json(double(label_matches)/labelled):Json(nullptr)},{"partial_rows",rows_path.string()},
   {"neural_program_backend","bpu"},{"cpu_model_fallback",false},{"cpu_image_processing",false},
   {"all_model_operations_on_bpu",false},
   {"existing_host_model_work",Json::array({"bf16_token_embedding_lookup","position_mask_and_cache_assembly"})},
   {"elapsed_ms",std::chrono::duration<double,std::milli>(Clock::now()-start).count()}});
  std::cout<<Json({{"interface_passed",passed},{"accuracy_validated",false},{"samples",items.size()},{"label_matches",label_matches},{"report",report.string()}}).dump()<<'\n';return passed?0:1;
 }catch(const std::exception& error){
  task_time_observer={};const auto code=ErrorCode(error);
  if(paths_valid)try{WriteNew(report,{{"interface_passed",false},{"smoke_only",true},{"accuracy_validated",false},{"error_code",code},
    {"stage",stage},{"diagnostic",Diagnostic(error)},{"resource_context",resource_context},{"partial_rows",rows_path.string()}});}catch(...){}
  std::cerr<<code<<"; models/config/services were not changed\n";return 1;
 }
}
