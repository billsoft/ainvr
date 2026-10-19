#include "analytics/webhook_notifier.hpp"
#include <iostream>
int main(int argc,char**argv){
 if(argc!=4)return 2;
 try {
  ai_service::analytics::WebhookNotifier notifier(argv[1]);
  std::atomic<bool> stop{false};
  ai_service::analytics::EventWorker::Context context{std::chrono::steady_clock::now()+std::chrono::milliseconds(std::stoi(argv[3])),stop};
  nlohmann::json event={{"event_id","notification-fixture-1"},{"channel_id","isolated"},{"review_status",argv[2]},
    {"secret","must-not-be-sent"},{"review_request",{{"description","private prompt"}}},
    {"review_job",{{"token","private lease"},{"result",{{"scope","target_presence"},{"temporal_rule_verified",false}}}}}};
  auto result=notifier(event,context);
  std::cout<<nlohmann::json({{"status",result.status},{"details",result.details}}).dump()<<'\n';
 }catch(const std::invalid_argument&){std::cout<<"{\"status\":\"invalid\"}\n";}
}
